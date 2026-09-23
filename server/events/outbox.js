'use strict';

/**
 * VIP → OpenVibe.Events through the openvibe-sdk transactional outbox (ADR-004).
 *
 *   vip.plan.published       a plan version became what new members buy (publish, or an edit of a
 *                            published plan); payload carries the version's full terms
 *   vip.membership.changed   a member's standing with a creator changed, as projected from Billing
 *                            (granted, renewed, cancel scheduled, expired, refunded, …); payload
 *                            names the plan version the membership was bought under
 *
 * emit() runs inside the SQLite transaction that makes the change, so an event exists if and only
 * if its change committed. Envelopes are validated against events.event-envelope@1 first. The relay
 * publishes with VIP's service token (events.event.publish, audience openvibe.events) only when
 * EVENTS_URL and OV_OAUTH_CLIENT_SECRET are set; otherwise rows wait in event_outbox.
 */
const { validate } = require('openvibe-contracts');
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createOutbox } = require('openvibe-sdk/events');

const ACTOR = { type: 'service', id: 'vip' };

function createVipOutbox({ db, config, fetchImpl, now = () => Date.now(), log = console }) {
    const enabled = !!(config.events.url && config.oauth.clientSecret);
    const clientOpts = { baseUrls: { events: config.events.url || 'http://127.0.0.1:4300' }, retries: 0 };
    if (fetchImpl) clientOpts.fetch = fetchImpl;
    if (enabled) {
        clientOpts.tokenProvider = createServiceTokenClient({
            tokenUrl: `${config.network.internalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
            scope: { 'openvibe.events': 'events.event.publish' }, ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
    } else {
        clientOpts.getToken = async () => { throw new Error('events relay disabled (EVENTS_URL / OV_OAUTH_CLIENT_SECRET unset)'); };
    }
    const events = createEventsClient(createClient(clientOpts), { source: 'vip' });
    let lastError = null;
    const outbox = createOutbox(db, {
        events,
        intervalMs: config.events.intervalMs,
        now,
        onError: (err) => {
            const msg = err && err.message;
            if (msg !== lastError) log.warn('[VIP] event publish failed (will retry):', msg);
            lastError = msg;
        },
    });
    outbox.ensureSchema();

    /** Inside the caller's transaction. */
    function emit(eventType, subject, payload, { visibility = 'internal', priority = 'important', traceparent } = {}) {
        const env = events.prepare({ event_type: eventType, actor: ACTOR, subject, payload, visibility, priority }, { now: now() });
        const v = validate('events.event-envelope@1', env);
        if (!v.valid) throw new Error(`outbox: invalid envelope for ${eventType}: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
        return outbox.enqueue(env, { traceparent });
    }

    return {
        emit,
        outbox,
        enabled,
        start() { if (enabled) outbox.start(); },
        stop: () => outbox.stop(),
        kick() { if (enabled) outbox.kick(); },
        status: () => ({ enabled, pending: outbox.pending(), rejected: outbox.rejected(), last_error: lastError }),
    };
}

module.exports = { createVipOutbox };
