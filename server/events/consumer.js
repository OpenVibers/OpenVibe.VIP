'use strict';

/**
 * Billing → VIP: POST /internal/events, the endpoint of VIP's OpenVibe.Events subscriptions
 * (scripts/subscribe.js): billing.entitlement.*, billing.subscription.*, billing.transaction.reversed.
 *
 *   billing.entitlement.changed    the projection takes Billing's { active, expires_at, subscription }
 *                                  (granted, renewed, canceled, expired, refund, chargeback, …)
 *   billing.subscription.canceled  cancel at period end: the flag changes, the period still runs
 *   billing.transaction.reversed   a reversal that revoked subscription periods puts the pair's
 *                                  projection in doubt at once (the next check asks Billing), even
 *                                  before — or without — the matching entitlement event
 *
 * Exactly once: the openvibe-sdk inbox claims (consumer, event_id) in the same SQLite transaction as
 * the change. Order: rows remember the Billing time they reflect; see domain/entitlements.js.
 * The signature (X-OpenVibe-Signature, HMAC-SHA256 of the raw body with VIP_EVENTS_SECRET) is
 * verified with openvibe-sdk's parseDelivery. Only events whose source is `billing` are applied.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { parseDelivery, createInbox } = require('openvibe-sdk/events');
const { isUserSubject } = require('../util');

const CONSUMER = 'vip-billing';

function consumerRouter({ domain, config, log = console }) {
    const router = express.Router();
    const inbox = createInbox(domain.db, { now: domain.now });
    inbox.ensureSchema();
    const { entitlements } = domain;

    function handle(event) {
        const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
        const asOf = Date.parse(event.timestamp);
        if (!Number.isFinite(asOf)) return 'ignored:bad_timestamp';
        if (event.event_type === 'billing.entitlement.changed') {
            const member = p.subject && p.subject.id;
            const creator = p.streamer && p.streamer.id;
            if (!isUserSubject(member) || !isUserSubject(creator)) return 'ignored:bad_subjects';
            if (p.kind && p.kind !== entitlements.KIND) return 'ignored:kind';
            const sub = p.subscription || null;
            return entitlements.apply({
                member, creator, active: !!p.active, expiresAt: p.expires_at || null,
                cancelAtPeriodEnd: sub ? !!sub.cancel_at_period_end : undefined, subscriptionId: sub ? sub.id : undefined,
                subscriptionStatus: sub ? sub.status : undefined, reason: p.reason || null, source: 'event', eventId: event.event_id, asOf,
            }).outcome;
        }
        if (event.event_type === 'billing.subscription.canceled') {
            const s = p.subscription || {};
            const member = s.subscriber && s.subscriber.id;
            const creator = s.streamer && s.streamer.id;
            if (!isUserSubject(member) || !isUserSubject(creator)) return 'ignored:bad_subjects';
            return entitlements.applyCanceled({
                member, creator, subscriptionId: s.id || null, subscriptionStatus: s.status || null,
                currentPeriodEnd: s.current_period_end || null, eventId: event.event_id, asOf,
            }).outcome;
        }
        if (event.event_type === 'billing.transaction.reversed') {
            if (!(Number(p.entitlements_revoked) > 0)) return 'ignored:no_entitlement';
            // The reversal runs streamer → subscriber (from/to of the original swapped).
            const member = p.to_subject;
            const creator = p.from_subject;
            if (!isUserSubject(member) || !isUserSubject(creator)) return 'ignored:bad_subjects';
            return entitlements.doubt(member, creator) ? 'doubt' : 'no_projection';
        }
        return 'ignored:type';
    }

    /** Apply one envelope (also used by tests). Returns { duplicate, outcome }. */
    function apply(event) {
        const r = inbox.once(CONSUMER, event.event_id, () => (event.source !== 'billing' ? 'ignored:source' : handle(event)));
        return r.duplicate ? { duplicate: true, outcome: null } : { duplicate: false, outcome: r.result };
    }

    router.post('/events', express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
        const secrets = config.events.webhookSecrets;
        if (!secrets.length) return http.sendProblem(res, 503, 'vip.webhook_disabled', { detail: 'VIP_EVENTS_SECRET is not set', ctx: req.ov });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let delivery = null;
        for (const s of secrets) { delivery = parseDelivery(raw, req.headers, s); if (delivery) break; }
        if (!delivery) return http.sendProblem(res, 401, 'vip.bad_signature', { detail: 'X-OpenVibe-Signature does not verify', ctx: req.ov });
        const event = delivery.event;
        if (!event || typeof event.event_id !== 'string' || !/^evt_[0-9A-HJKMNP-TV-Z]{26}$/.test(event.event_id)) {
            return http.sendProblem(res, 400, 'vip.bad_delivery', { detail: 'body must be { event: <envelope>, seq }', ctx: req.ov });
        }
        let out;
        try {
            out = apply(event);
        } catch (e) {
            // Not acknowledged: Events retries it, and the inbox claim rolled back with the change.
            log.error(`[VIP] event ${event.event_id} (${event.event_type}) failed:`, e.message);
            return http.sendProblem(res, 500, 'vip.event_failed', { detail: 'processing failed; it will be retried', ctx: req.ov });
        }
        res.status(200).json({ event_id: event.event_id, duplicate: out.duplicate, outcome: out.outcome });
    });

    return { router, apply, CONSUMER };
}

module.exports = { consumerRouter, CONSUMER };
