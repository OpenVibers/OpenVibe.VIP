'use strict';

/**
 * OpenVibe.VIP — process entry. `node server/index.js`
 * Listens on PORT (4620) behind nginx (openvibe.vip); see deploy/.
 *
 * Background jobs (VIP_JOBS=off disables them): re-confirming with Billing the projections products
 * are using before they go stale, pruning sent outbox rows, and the events outbox relay when
 * EVENTS_URL is set.
 */
const { loadConfig } = require('./config');
const { createApp } = require('./app');

const config = loadConfig();
if (config.isProduction && !config.formSecret) {
    console.error('[VIP] VIP_FORM_SECRET must be set in production (it signs the pages\' anti-forgery tokens)');
    process.exit(1);
}
(async () => {
const app = await createApp({ config });
const { domain, keys, outbox, metrics } = app.locals;
keys.start();

const timers = [];
if (config.jobs.enabled) {
    const every = (ms, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).catch((e) => console.warn('[VIP] job:', e.message)); }, ms); t.unref(); timers.push(t); };
    every(config.jobs.refreshIntervalMs, async () => await domain.entitlements.refreshDue());
    every(6 * 3600 * 1000, async () => await outbox.outbox.prune());
    outbox.start();
}

const server = app.listen(config.port, config.host, () => {
    console.log(`[VIP] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${domain.db.store})`);
    console.log(`[VIP] billing ${config.billing.url}; events relay ${outbox.enabled ? `→ ${config.events.url}` : 'off (outbox accumulates)'}; billing events ${config.events.webhookSecrets.length ? 'accepted' : 'not accepted (VIP_EVENTS_SECRET unset)'}`);
});
server.keepAliveTimeout = 65_000;

function shutdown(signal) {
    console.log(`[VIP] ${signal} — closing`);
    timers.forEach(clearInterval);
    outbox.stop();
    keys.stop();
    if (metrics && metrics.stop) metrics.stop();
    server.close(() => { Promise.resolve().then(() => domain.db.close()).catch(() => {}).finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
})().catch((err) => { console.error('[VIP] failed to start:', err); process.exit(1); });
