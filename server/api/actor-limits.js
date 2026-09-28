'use strict';

/**
 * Per-actor rate limits at /api/v1 (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * Counted by who calls, as api/auth.js resolved req.principal: a service by its principal (svc:chat), a
 * person by their subject (user:usr_…), anyone else by address. Past a limit the route answers 429
 * problem+json `rate_limited` with Retry-After before it does any work (before Billing is asked); the
 * refusal is logged once and counted in vip_rate_limited_total{limit,window}. Reads get
 * VIP_LIMITS_MINUTE / VIP_LIMITS_HOUR (120 and 3000); entitlement checks, policy evaluation, checkout
 * and catalog changes set their own numbers in api/v1.js. Counters live in this process: a restart
 * forgets them.
 *
 * Never limited: /api/health, /api/ready, /release.json, /metrics, the public card, badge and widget
 * (/embed, public pages behind nginx), and the signed Events deliveries at /internal/events (Billing's membership changes:
 * Events pushes at its own pace, and a 429 would only make it retry and fall behind).
 */
const { createActorLimiter, createValkeyLimitStore, defaultActor } = require('openvibe-sdk/limits');

function actor(req) {
    const p = req.principal;
    if (p && p.kind === 'service' && p.sub) return p.sub;
    if (p && p.kind === 'user' && p.subject) return `user:${p.subject}`;
    return defaultActor(req);
}

/**
 * limits(name, own) middleware for one app, plus limits.reads(name, skip): the defaults on GET/HEAD
 * requests, except those `skip(req)` names (routes that set their own).
 */
function createActorLimits({ config, now = () => Date.now(), registry = null, log = console, valkey = null }) {
    const refused = registry
        ? registry.counter({ name: 'vip_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.actorLimits.minute, hour: config.actorLimits.hour },
        actor,
        now,
        // Shared across processes on Valkey (ADR-035) when VALKEY_URL is set; in-process otherwise.
        ...(valkey ? { store: createValkeyLimitStore(valkey) } : {}),
        onLimited(e) {
            // The actor is a principal, a subject id or an address, never a token.
            log.warn(`[VIP] limit ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name, skip = () => false) => {
        const limit = limiter(name);
        return (req, res, next) => ((req.method === 'GET' || req.method === 'HEAD') && !skip(req) ? limit(req, res, next) : next());
    };
    return limiter;
}

module.exports = { createActorLimits, actor };
