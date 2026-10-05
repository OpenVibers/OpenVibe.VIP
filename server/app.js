'use strict';

/**
 * OpenVibe.VIP — memberships: plans, versioned plan terms, perks, product bindings and gated-resource
 * policy. OpenVibe.Billing holds subscriptions, charges, renewals, refunds and the canonical
 * entitlements (ADR-012); VIP projects them and never authorizes past the projection's validity.
 * Express app factory; server/index.js listens, tests build their own instance.
 *
 *   GET  /api/health, /api/ready, /release.json, /metrics (loopback only)
 *   /api/v1/*                     API (service tokens + user tokens, see api/v1.js)
 *   POST /internal/events         Billing events from OpenVibe.Events (signed webhook + inbox)
 *   /auth/*                       Network SSO session for the pages
 *   /embed/:username/card.json|badge.svg|widget   public card, badge and widget (no cookies, see web/embeds.js)
 *   /, /me, /dashboard, /:username …  server-rendered pages
 *
 * createApp({ config, db, keys, billing, outbox, now, fetchImpl, eventsFetch, log }) — all injectable.
 */
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { http } = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');
const { createIndexNow } = require('openvibe-shared/indexnow');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createKeyProvider, createUserAuth } = require('./network');
const { createBillingClient } = require('./billing-client');
const { createVipOutbox } = require('./events/outbox');
const { consumerRouter } = require('./events/consumer');
const { createDomain } = require('./domain');
const { createApiAuth } = require('./api/auth');
const { v1Router } = require('./api/v1');
const { createActorLimits } = require('./api/actor-limits');
const { createSessionRoutes } = require('./web/session');
const { createWebRoutes } = require('./web/routes');
const { createEmbedRoutes } = require('./web/embeds');
const { createLayout, assetVersion, setRelease } = require('./web/layout');
const { createVipReadiness } = require('./observability');
const pages = require('./web/pages');

const VERSION = require('../package.json').version;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

async function createApp(opts = {}) {
    const config = opts.config || loadConfig();
    const log0 = opts.log || console;
    // PostgreSQL (ADR-035): opened and migrated here unless the caller (a test, a script) hands in a migrated handle.
    const db = opts.db || await openDb(config, { log: log0 });
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const log = opts.log || console;
    const now = opts.now || (() => Date.now());
    const keys = opts.keys || createKeyProvider(config, { fetchImpl, log });
    const userAuth = createUserAuth(config, keys);
    const billing = opts.billing || createBillingClient(config, { fetchImpl });
    const outbox = opts.outbox || createVipOutbox({ db, config, fetchImpl: opts.eventsFetch, now, log });
    // IndexNow (openvibe-shared/indexnow): created once at boot from INDEXNOW_KEY. Unset → off, no key
    // file, nothing sent; a published plan tells the engines its page changed. Tests inject a spy.
    const indexnow = opts.indexnow !== undefined ? opts.indexnow : createIndexNow({
        host: config.baseUrl, key: config.indexnow.key, fetch: fetchImpl, log,
    });
    const domain = createDomain({ db, config, outbox, billing, now, log, indexnow });
    const apiAuth = createApiAuth({ config, keys, userAuth });
    const release = require('openvibe-shared/release').createRelease({ service: 'vip', root: path.join(__dirname, '..') });
    setRelease(release.release);
    const layout = createLayout({ config, release });

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    // HTTP golden signals by route template, process metrics, release_info; GET /metrics answers
    // direct loopback callers only (Track O). Gauges: outbox backlog and projection staleness.
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'vip', release: release.release });
    metrics.registry.gauge({ name: 'vip_outbox_pending', help: 'Events waiting in the outbox', collect: async () => await outbox.outbox.pending() });
    metrics.registry.gauge({
        name: 'vip_projection_rows', help: 'Entitlement projection rows by freshness', labelNames: ['state'],
        collect: async () => {
            const t = now();
            const r = await db.prepare('SELECT SUM(CASE WHEN valid_until >= ? THEN 1 ELSE 0 END) AS fresh, SUM(CASE WHEN valid_until < ? THEN 1 ELSE 0 END) AS stale FROM vip_entitlement_projection').get(t, t);
            return [{ labels: { state: 'fresh' }, value: r.fresh || 0 }, { labels: { state: 'stale' }, value: r.stale || 0 }];
        },
    });
    metrics.registry.gauge({ name: 'vip_period_audit_offenders', help: 'Active memberships the last period audit found without a paid period record', collect: () => domain.periods.stats.offenders });
    app.use(http.middleware());
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        // connect-src events.openvibe.network: release notifications (release-watch's EventSource, openvibe-shared 1.17).
        res.setHeader('Content-Security-Policy', [
            "default-src 'self'", "script-src 'self' 'unsafe-inline' https://openvibe.network", "style-src 'self' 'unsafe-inline' https://openvibe.network",
            "img-src 'self' data: https:", "connect-src 'self' https://openvibe.network https://events.openvibe.network", "frame-src 'self' https://openvibe.network",
            "frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self' https://openvibe.network https:",
        ].join('; '));
        next();
    });
    // Embeds come before the cookie parser: they are the same for everyone and never read a cookie.
    app.use('/embed', createEmbedRoutes({ domain, config }));
    app.use(cookieParser());

    app.get('/api/health', async (req, res) => res.json({ ok: true, service: 'vip', version: VERSION, release: release.release, events: await outbox.status() }));
    // Valkey (ADR-035): shared, never-authoritative state (per-actor limit counters). Optional.
    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    const readiness = createVipReadiness({ db, keys, config, outbox, now, release: release.release, fetchImpl, valkey });
    app.get('/api/ready', readiness.handler);
    // GET /release.json (ADR-016) and POST /release-metrics: open tabs' update reports into /metrics.
    release.mount(app, { registry: metrics.registry });

    const consumer = consumerRouter({ domain, config, log });
    app.use('/internal', consumer.router);
    // Per-actor limits on /api/v1 (api/actor-limits.js), counted once apiAuth resolved the caller.
    // opts.limitsNow: the limiter's clock (tests).
    const limits = createActorLimits({ config, now: opts.limitsNow || now, registry: metrics.registry, log, valkey });
    app.use('/api/v1', express.json({ limit: '64kb' }), (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, apiAuth.middleware, v1Router({ domain, apiAuth, limits }));
    app.use('/auth', createSessionRoutes(config, userAuth, { fetchImpl }));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'vip', service: 'vip', host: 'openvibe.vip', name: 'OpenVibe.VIP', profile: 'ugc' })); }

    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
    // GET /<key>.txt — the IndexNow key file (mounted only when a key is configured; it serves itself
    // and steps aside for every other path). Before static, so the key can never be shadowed by a file.
    if (indexnow.enabled) app.use(indexnow.keyFile);
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: v && v === assetVersion(rel) }));
        },
    }));
    app.use(createWebRoutes({ domain, config, layout, userAuth }));

    app.use((req, res) => {
        if (req.path.startsWith('/api/') || req.path.startsWith('/internal/')) return http.sendProblem(res, 404, 'not_found', { ctx: req.ov });
        return res.status(404).type('html').send(layout.page({ title: 'Not found', robots: 'noindex', body: pages.errorPage({ status: 404, title: 'Nothing here', message: 'That page does not exist.' }) }));
    });
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err && err.type === 'entity.parse.failed') return http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (err && err.type === 'entity.too.large') return http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov });
        log.error('[VIP] unhandled error:', err);
        if (res.headersSent) return undefined;
        if (req.path.startsWith('/api/')) return http.sendProblem(res, 500, 'vip.internal', { ctx: req.ov });
        return res.status(500).type('html').send(layout.page({ title: 'Error', robots: 'noindex', body: pages.errorPage({ status: 500, title: 'Something went wrong', message: 'This one is on us. Please try again.' }) }));
    });

    Object.assign(app.locals, { config, db, domain, keys, outbox, billing, consumer, metrics, indexnow });
    return app;
}

module.exports = { createApp, VERSION };
