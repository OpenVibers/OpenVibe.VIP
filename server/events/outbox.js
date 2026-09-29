'use strict';

/**
 * VIP → OpenVibe.Events through openvibe-sdk/events createServiceOutbox (ADR-004).
 *
 *   vip.plan.published       a plan version became what new members buy (publish, or an edit of a
 *                            published plan); payload carries the version's full terms
 *   vip.membership.changed   a member's standing with a creator changed, as projected from Billing
 *                            (granted, renewed, cancel scheduled, expired, refunded, …); payload
 *                            names the plan version the membership was bought under
 *
 * emit() runs inside the PostgreSQL transaction that makes the change, so an event exists if and only
 * if its change committed. Envelopes are validated against events.event-envelope@1 first. The relay
 * publishes with VIP's service token (events.event.publish, audience openvibe.events) only when
 * EVENTS_URL and OV_OAUTH_CLIENT_SECRET are set; otherwise rows wait in event_outbox.
 */
const { validate } = require('openvibe-contracts');
const { createServiceOutbox } = require('openvibe-sdk/events');

module.exports = {
    createVipOutbox: ({ db, config, fetchImpl, now, log }) => createServiceOutbox({
        db, source: 'vip', eventsUrl: config.events.url, networkInternalUrl: config.network.internalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, intervalMs: config.events.intervalMs,
        now, fetch: fetchImpl, log, validate: (env) => validate('events.event-envelope@1', env),
    }),
};
