'use strict';

/**
 * Billing → VIP: POST /internal/events, the endpoint of VIP's OpenVibe.Events subscriptions
 * (scripts/subscribe.js): billing.entitlement.*, billing.subscription.*, billing.transaction.reversed.
 *
 *   billing.entitlement.changed    the projection takes Billing's { active, expires_at, subscription }
 *                                  (granted, renewed, canceled, expired, refund, chargeback, …); a granted/renewed
 *                                  event with a transaction_id also records the paid period (domain/periods.js);
 *                                  renewal_failed (past_due, grace_until) and grace_ended are stored, never authorize
 *   billing.subscription.canceled  cancel at period end: the flag changes, the period still runs
 *   billing.transaction.reversed   a reversal that revoked subscription periods puts the pair's
 *                                  projection in doubt at once (the next check asks Billing), even
 *                                  before — or without — the matching entitlement event; the period that
 *                                  transaction paid is marked reversed (a tombstone when it is not recorded yet)
 *
 * Exactly once: the openvibe-sdk inbox claims (consumer, event_id) in the same PostgreSQL transaction as
 * the change. Order: rows remember the Billing time they reflect; see domain/entitlements.js.
 * The signature (X-OpenVibe-Signature, HMAC-SHA256 of the raw body with VIP_EVENTS_SECRET) is
 * verified with openvibe-sdk's parseDelivery. Only events whose source is `billing` are applied.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { parseDelivery, createPgInbox } = require('openvibe-sdk/events');
const { isUserSubject } = require('../util');

const { TOPICS: ACCOUNT_TOPICS } = require('openvibe-sdk/account-data');

const CONSUMER = 'vip-billing';

/**
 * accountData + accountSend: network.account.export_requested and network.account.deleted (ADR-033, subscribed at
 * boot) go to domain/account-data.js, outside the billing inbox: openvibe-sdk/account-data keeps its own receipt per
 * export and deletion id and throws when Network should be asked again (answered 500, so Events redelivers).
 */
function consumerRouter({ domain, config, log = console, accountData = null, accountSend = null }) {
    const router = express.Router();
    const inbox = createPgInbox(domain.db, { now: domain.now });   // idempotency_receipts: migrations/0001_initial.sql
    const { entitlements, periods } = domain;

    async function handle(event) {
        const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
        const asOf = Date.parse(event.timestamp);
        if (!Number.isFinite(asOf)) return 'ignored:bad_timestamp';
        if (event.event_type === 'billing.entitlement.changed') {
            const member = p.subject && p.subject.id;
            const creator = p.streamer && p.streamer.id;
            if (!isUserSubject(member) || !isUserSubject(creator)) return 'ignored:bad_subjects';
            if (p.kind && p.kind !== entitlements.KIND) return 'ignored:kind';
            const sub = p.subscription || null;
            let reversed = false;
            if (p.transaction_id && periods.PAID_REASONS.has(p.reason)) {
                // A renewal starts where the paid period ends, or now when it already ended.
                const prev = await entitlements.getRow(member, creator);
                const prevEnd = prev && prev.expires_at && Date.parse(prev.expires_at) > asOf ? prev.expires_at : event.timestamp;
                // A period already reversed (its reversal came first) grants nothing, whatever this event says.
                reversed = (await periods.recordPaid({
                    member, creator, subscriptionId: sub ? sub.id : null, transactionId: p.transaction_id,
                    periodStart: prevEnd, periodEnd: p.expires_at || null, reason: p.reason,
                })).outcome === 'reversed';
            }
            const out = await entitlements.apply({
                member, creator, active: !!p.active && !reversed, expiresAt: p.expires_at || null,
                cancelAtPeriodEnd: sub ? !!sub.cancel_at_period_end : undefined, subscriptionId: sub ? sub.id : undefined,
                subscriptionStatus: sub ? sub.status : undefined, graceUntil: p.grace_until || undefined, reason: p.reason || null, source: 'event', eventId: event.event_id, asOf,
            });
            if (reversed) await entitlements.doubt(member, creator);
            return out.outcome;
        }
        if (event.event_type === 'billing.subscription.canceled') {
            const s = p.subscription || {};
            const member = s.subscriber && s.subscriber.id;
            const creator = s.streamer && s.streamer.id;
            if (!isUserSubject(member) || !isUserSubject(creator)) return 'ignored:bad_subjects';
            return (await entitlements.applyCanceled({
                member, creator, subscriptionId: s.id || null, subscriptionStatus: s.status || null,
                currentPeriodEnd: s.current_period_end || null, eventId: event.event_id, asOf,
            })).outcome;
        }
        if (event.event_type === 'billing.transaction.reversed') {
            // A provider reversal says how many periods it revoked; a credit refund of a subscription period says what it reversed.
            const meta = p.metadata && typeof p.metadata === 'object' ? p.metadata : {};
            const ofSubscription = meta.original_type === 'subscription' || typeof meta.subscription_id === 'string';
            if (!(Number(p.entitlements_revoked) > 0) && !ofSubscription) return 'ignored:no_entitlement';
            // The reversal runs streamer → subscriber (from/to of the original swapped).
            const member = p.to_subject;
            const creator = p.from_subject;
            if (!isUserSubject(member) || !isUserSubject(creator)) return 'ignored:bad_subjects';
            await periods.recordReversed({ member, creator, reversesTxn: p.reverses_txn, reversedBy: p.transaction_id || null, reason: p.type || null });
            return await entitlements.doubt(member, creator) ? 'doubt' : 'no_projection';
        }
        return 'ignored:type';
    }

    /** Apply one envelope (also used by tests). Returns { duplicate, outcome }. */
    async function apply(event) {
        if (ACCOUNT_TOPICS.includes(event.event_type)) {
            if (!accountData || !accountSend) throw new Error('account export and deletion are not configured');
            return { duplicate: false, outcome: await accountData.apply(event, { send: accountSend }) };
        }
        const r = await inbox.once(CONSUMER, event.event_id, async () => (event.source !== 'billing' ? 'ignored:source' : await handle(event)));
        return r.duplicate ? { duplicate: true, outcome: null } : { duplicate: false, outcome: r.result };
    }

    router.post('/events', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
        const secrets = config.events.webhookSecrets;
        if (!secrets.length) return http.sendProblem(res, 503, 'vip.webhook_disabled', { detail: 'VIP_EVENTS_SECRET is not set', ctx: req.ov });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let delivery = null;
        // Signature v2 only: HMAC over "<t>.<raw body>" with t within ±300 s; a v1-only (v2 stripped) or stale delivery is refused.
        for (const s of secrets) { delivery = parseDelivery(raw, req.headers, s, { requireV2: true }); if (delivery) break; }
        if (!delivery) return http.sendProblem(res, 401, 'vip.bad_signature', { detail: 'X-OpenVibe-Signature does not verify', ctx: req.ov });
        const event = delivery.event;
        if (!event || typeof event.event_id !== 'string' || !/^evt_[0-9A-HJKMNP-TV-Z]{26}$/.test(event.event_id)) {
            return http.sendProblem(res, 400, 'vip.bad_delivery', { detail: 'body must be { event: <envelope>, seq }', ctx: req.ov });
        }
        let out;
        try {
            out = await apply(event);
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
