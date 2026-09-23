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
 *                                GET  /api/v1/subscriptions[?streamer&subscriber&status], /:id
 *
 * Every POST carries an Idempotency-Key derived from VIP's own record, so a retry after a lost
 * response returns Billing's original result instead of acting twice.
 *
 * Errors: a Billing problem+json becomes a BillingCallError with .status/.code; a network failure or
 * timeout has no status (retryable, and for an entitlement check it means "unknown", never "yes").
 */
const { serviceAuth } = require('openvibe-contracts');

class BillingCallError extends Error {
    constructor(message, { status = null, code = null, body = null } = {}) {
        super(message);
        this.name = 'BillingCallError';
        this.status = status;
        this.code = code;
        this.body = body;
    }
    get retryable() { return this.status == null || this.status >= 500 || this.status === 429 || this.status === 401 || this.code === 'billing.frozen'; }
}

const CAPS = {
    intent: 'billing.intent.create',
    subscription: 'billing.subscription.manage',
    entitlement: 'billing.entitlement.check',
};

function createBillingClient(config, { fetchImpl = globalThis.fetch, tokenClients = null } = {}) {
    const base = config.billing.url;
    const clients = new Map();
    const tokensFor = (cap) => {
        if (tokenClients && tokenClients[cap]) return tokenClients[cap];
        if (!clients.has(cap)) {
            clients.set(cap, serviceAuth.createTokenClient({
                tokenUrl: `${config.network.internalUrl}/oauth/token`,
                clientId: config.oauth.clientId,
                clientSecret: config.oauth.clientSecret,
                audience: config.billing.audience,
                scope: cap,
                fetchImpl,
            }));
        }
        return clients.get(cap);
    };

    async function call(cap, method, path, { body, key, traceparent, retried = false } = {}) {
        let auth;
        try { auth = await tokensFor(cap).authHeaders(); } catch (e) { throw new BillingCallError(`token (${cap}): ${e.message}`); }
        const headers = { Accept: 'application/json', ...auth };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (key) headers['Idempotency-Key'] = key;
        if (traceparent) headers.traceparent = traceparent;
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(config.billing.timeoutMs),
            });
        } catch (e) {
            throw new BillingCallError(`Billing unreachable: ${e.message}`);
        }
        if (res.status === 401 && !retried) { tokensFor(cap).invalidate(); return call(cap, method, path, { body, key, traceparent, retried: true }); }
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const code = (data && (data.code || data.error)) || `http_${res.status}`;
            throw new BillingCallError(`Billing ${res.status} ${code}: ${(data && data.detail) || ''}`.trim(), { status: res.status, code, body: data });
        }
        return data;
    }
    const user = (id) => ({ type: 'user', id });
    const qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v != null && v !== '') p.set(k, v); const s = p.toString(); return s ? `?${s}` : ''; };

    return {
        /** { intent, checkout_url } — a subscription checkout for `subject` to `creator`. */
        createIntent: ({ provider, subject, creator, autoRenew, successUrl, cancelUrl, key, traceparent }) => call(CAPS.intent, 'POST', '/api/v1/intents', {
            body: { provider, kind: 'subscription', subject: user(subject), streamer: user(creator), auto_renew: !!autoRenew, success_url: successUrl, cancel_url: cancelUrl },
            key, traceparent,
        }),
        /** { subscription, entitlement, transaction } — one period paid from the member's credit. */
        subscribeWithCredit: ({ subscriber, creator, autoRenew, key, traceparent }) => call(CAPS.subscription, 'POST', '/api/v1/subscriptions', {
            body: { subscriber: user(subscriber), streamer: user(creator), source: 'credit', auto_renew: autoRenew !== false },
            key, traceparent,
        }),
        cancelSubscription: ({ id, key, traceparent }) => call(CAPS.subscription, 'POST', `/api/v1/subscriptions/${encodeURIComponent(id)}/cancel`, { body: {}, key, traceparent }),
        getSubscription: (id) => call(CAPS.entitlement, 'GET', `/api/v1/subscriptions/${encodeURIComponent(id)}`),
        listSubscriptions: ({ streamer, subscriber, status } = {}) => call(CAPS.entitlement, 'GET', `/api/v1/subscriptions${qs({ streamer, subscriber, status })}`),
        /** { active, expires_at, subscription } — the authoritative answer. */
        entitlement: (subject, creator) => call(CAPS.entitlement, 'GET', `/api/v1/entitlements/${encodeURIComponent(subject)}${qs({ streamer: creator })}`),
        rates: () => call(CAPS.entitlement, 'GET', '/api/v1/rates'),
        baseUrl: () => base,
    };
}

module.exports = { createBillingClient, BillingCallError, CAPS };
