'use strict';
/**
 * Track O: truthful readiness for GET /api/ready (openvibe-shared/ready).
 *
 *   db            required  a real query on VIP's SQLite (the schema is there and answers)
 *   network_jwks  optional  the Network signing key has loaded. Without it public plan pages still
 *                           render, but no service or user token can be verified (API calls and
 *                           sign-in answer 503), so it degrades rather than fails
 *   billing       optional  Billing answers /api/health. Without it the projection still answers
 *                           while fresh; checkout, cancel, members lists and authoritative checks
 *                           fail closed (never "yes")
 *
 * `details` reports the outbox and the projection's size and staleness (counts only, no subjects).
 * Request metrics come from openvibe-shared/metrics in app.js; gauges for the outbox and projection
 * are registered there too.
 */
const { createReadiness } = require('openvibe-shared/ready');

function createVipReadiness({ db, keys, config, outbox, now, release = null, fetchImpl = globalThis.fetch }) {
    return createReadiness({
        service: 'vip',
        release,
        checks: [
            { name: 'db', required: true, check: () => db.prepare('SELECT COUNT(*) AS n FROM vip_creators').get().n >= 1 || 'database has no network creator row' },
            {
                name: 'network_jwks', required: false,
                check: () => (keys.get() ? true : 'Network signing key not loaded yet: tokens cannot be verified'),
            },
            {
                name: 'billing', required: false, cacheMs: 15_000, timeoutMs: 2500,
                check: async () => {
                    const res = await fetchImpl(`${config.billing.url}/api/health`, { signal: AbortSignal.timeout(2000), headers: { Accept: 'application/json' } });
                    try { await res.body?.cancel(); } catch { /* not needed */ }
                    return res.ok ? { ok: true, detail: { http_status: res.status } } : { ok: false, error: `answered HTTP ${res.status}` };
                },
            },
        ],
        details: (body) => {
            if (body.checks.db.status !== 'ok') return {};
            const t = now();
            const p = db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN valid_until < ? THEN 1 ELSE 0 END) AS stale FROM vip_entitlement_projection').get(t);
            return {
                events: outbox.status(),
                billing_events_accepted: config.events.webhookSecrets.length > 0,
                projection: { rows: p.n || 0, past_valid_until: p.stale || 0, max_age_ms: config.projection.maxAgeMs, grace_ms: config.projection.graceMs },
            };
        },
    });
}

module.exports = { createVipReadiness };
