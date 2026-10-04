'use strict';

/**
 * OpenVibe.Billing client — Billing holds subscriptions, charges, renewals, cancellations, refunds
 * and the canonical entitlements (ADR-012). VIP holds a client-credentials token for audience
 * openvibe.billing, one token per capability so a missing grant only disables what needs it:
 *
 *   billing.intent.create        POST /api/v1/intents              checkout hand-off (kind subscription)
 *   billing.subscription.manage  POST /api/v1/subscriptions         pay a period from the member's credit
 *                                POST /api/v1/subscriptions/:id/cancel   cancel at period end
 *   billing.entitlement.check    GET  /api/v1/entitlements/:subject?streamer=   the authoritative check
 *                                GET  /api/v1/subscriptions[?streamer&subscriber&status], /:id, /api/v1/rates
 *
 * The HTTP shape lives in openvibe-sdk/commerce, shared with Tips: every POST carries the
 * Idempotency-Key derived from VIP's own record (sent unchanged on the one retry after a 401), so a
 * retry after a lost response returns Billing's original result instead of acting twice.
 *
 * Errors: a Billing problem+json becomes a BillingCallError (the SDK's CommerceError) with
 * .status/.code; a network failure or timeout has no status (retryable, and for an entitlement check
 * it means "unknown", never "yes").
 */
const { createCommerceClient, CommerceError } = require('openvibe-sdk/commerce');

const BillingCallError = CommerceError;

const CAPS = {
    intent: 'billing.intent.create',
    subscription: 'billing.subscription.manage',
    entitlement: 'billing.entitlement.check',
};

function createBillingClient(config, { fetchImpl = globalThis.fetch, tokenClients = null } = {}) {
    const commerce = createCommerceClient(config, {
        fetchImpl,
        caps: { intent: CAPS.intent, subscription: CAPS.subscription, entitlement: CAPS.entitlement },
        tokenClients,
    });

    return {
        /** { intent, checkout_url } — a subscription checkout for `subject` to `creator`. */
        createIntent: async ({ provider, subject, creator, autoRenew, successUrl, cancelUrl, key, traceparent }) => await commerce.createIntent({
            provider, kind: 'subscription', subject, creator, autoRenew, successUrl, cancelUrl, key, traceparent,
        }),
        /** { subscription, entitlement, transaction } — one period paid from the member's credit. */
        subscribeWithCredit: async ({ subscriber, creator, autoRenew, key, traceparent }) => await commerce.subscribeWithCredit({ subscriber, creator, autoRenew, key, traceparent }),
        cancelSubscription: async ({ id, key, traceparent }) => await commerce.cancelSubscription({ id, key, traceparent }),
        getSubscription: async (id) => await commerce.getSubscription(id),
        listSubscriptions: async ({ streamer, subscriber, status } = {}) => await commerce.listSubscriptions({ streamer, subscriber, status }),
        /** { active, expires_at, subscription } — the authoritative answer. */
        entitlement: async (subject, creator) => await commerce.entitlement(subject, creator),
        rates: async () => await commerce.rates(),
        baseUrl: () => commerce.baseUrl(),
    };
}

module.exports = { createBillingClient, BillingCallError, CAPS };
