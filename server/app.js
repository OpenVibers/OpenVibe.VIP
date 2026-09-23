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
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createKeyProvider, createUserAuth } = require('./network');
const { createBillingClient } = require('./billing-client');
const { createVipOutbox } = require('./events/outbox');
const { consumerRouter } = require('./events/consumer');
const { createDomain } = require('./domain');
const { createApiAuth } = require('./api/auth');
const { v1Router } = require('./api/v1');
const { createSessionRoutes } = require('./web/session');
const { createWebRoutes } = require('./web/routes');
const { createEmbedRoutes } = require('./web/embeds');
const { createLayout, assetVersion } = require('./web/layout');
const { createVipReadiness } = require('./observability');
const pages = require('./web/pages');

const VERSION = require('../package.json').version;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp(opts = {}) {
    const config = opts.config || loadConfig();
    const db = opts.db || openDb(config.dbPath);
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const log = opts.log || console;
    const now = opts.now || (() => Date.now());
    const keys = opts.keys || createKeyProvider(config, { fetchImpl, log });
    const userAuth = createUserAuth(config, keys);
    const billing = opts.billing || createBillingClient(config, { fetchImpl });
    const outbox = opts.outbox || createVipOutbox({ db, config, fetchImpl: opts.eventsFetch, now, log });
    const domain = createDomain({ db, config, outbox, billing, now, log });
    const apiAuth = createApiAuth({ config, keys, userAuth });
    const release = require('openvibe-shared/release').createRelease({ service: 'vip', root: path.join(__dirname, '..') });
    const layout = createLayout({ config, release });

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    // HTTP golden signals by route template, process metrics, release_info; GET /metrics answers
    // direct loopback callers only (Track O). Gauges: outbox backlog and projection staleness.
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'vip', release: release.release });
    metrics.registry.gauge({ name: 'vip_outbox_pending', help: 'Events waiting in the outbox', collect: () => outbox.outbox.pending() });
    metrics.registry.gauge({
        name: 'vip_projection_rows', help: 'Entitlement projection rows by freshness', labelNames: ['state'],
        collect: () => {
            const t = now();
            const r = db.prepare('SELECT SUM(CASE WHEN valid_until >= ? THEN 1 ELSE 0 END) AS fresh, SUM(CASE WHEN valid_until < ? THEN 1 ELSE 0 END) AS stale FROM vip_entitlement_projection').get(t, t);
            return [{ labels: { state: 'fresh' }, value: r.fresh || 0 }, { labels: { state: 'stale' }, value: r.stale || 0 }];
        },
    });
    app.use(http.middleware());
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Content-Security-Policy', [
            "default-src 'self'", "script-src 'self' 'unsafe-inline' https://openvibe.network", "style-src 'self' 'unsafe-inline' https://openvibe.network",
            "img-src 'self' data: https:", "connect-src 'self' https://openvibe.network", "frame-src 'self' https://openvibe.network",
            "frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self' https://openvibe.network https:",
        ].join('; '));
        next();
    });
    // Embeds come before the cookie parser: they are the same for everyone and never read a cookie.
    app.use('/embed', createEmbedRoutes({ domain, config }));
    app.use(cookieParser());

    app.get('/api/health', (req, res) => res.json({ ok: true, service: 'vip', version: VERSION, release: release.release, events: outbox.status() }));
    const readiness = createVipReadiness({ db, keys, config, outbox, now, release: release.release, fetchImpl });
    app.get('/api/ready', readiness.handler);
    // GET /release.json (ADR-016) and POST /release-metrics: open tabs' update reports into /metrics.
    release.mount(app, { registry: metrics.registry });

    const consumer = consumerRouter({ domain, config, log });
    app.use('/internal', consumer.router);
    app.use('/api/v1', express.json({ limit: '64kb' }), (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, apiAuth.middleware, v1Router({ domain, apiAuth }));
    app.use('/auth', createSessionRoutes(config, userAuth, { fetchImpl }));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'vip', service: 'vip', host: 'openvibe.vip', name: 'OpenVibe.VIP', profile: 'ugc' })); }

    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', v && v === assetVersion(rel) ? 'public, max-age=31536000, immutable' : 'no-cache');
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

    Object.assign(app.locals, { config, db, domain, keys, outbox, billing, consumer, metrics });
    return app;
}

module.exports = { createApp, VERSION };
