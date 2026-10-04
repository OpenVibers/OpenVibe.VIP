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
const { gracefulStop } = require('openvibe-sdk/service');

/**
 * The process stop (openvibe-sdk/service, plan T1): the job timers and relays stop taking new work
 * (they ran before the old server.close), the HTTP drain runs (defaults 4000/5000), then the domain
 * database closes; past the deadline the process exits 0, as the hand-rolled 5 s timer did. Exported
 * so a test can inject `exit` and `signals: false`.
 */
function createLifecycle({ server, app, timers = [], exit, signals } = {}) {
    const { domain, keys, outbox, metrics } = app.locals;
    return gracefulStop({
        name: 'VIP', server, deadlineExitCode: 0, exit, signals,
        stop: [
            () => timers.forEach(clearInterval),
            () => outbox.stop(),
            () => keys.stop(),
            () => { if (metrics && metrics.stop) metrics.stop(); },
        ],
        close: [() => domain.db.close()],
    });
}

async function start() {
    const config = loadConfig();
    if (config.isProduction && !config.formSecret) {
        console.error('[VIP] VIP_FORM_SECRET must be set in production (it signs the pages\' anti-forgery tokens)');
        process.exit(1);
    }

    const app = await createApp({ config });
    const { domain, keys, outbox } = app.locals;
    keys.start();

    const timers = [];
    if (config.jobs.enabled) {
        const every = (ms, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).catch((e) => console.warn('[VIP] job:', e.message)); }, ms); t.unref(); timers.push(t); };
        every(config.jobs.refreshIntervalMs, async () => {
            await domain.periods.audit();   // doubts what has no paid period record, so refreshDue asks Billing about it now
            await domain.entitlements.refreshDue();
        });
        every(6 * 3600 * 1000, async () => await outbox.outbox.prune());
        outbox.start();
    }

    const server = app.listen(config.port, config.host, () => {
        console.log(`[VIP] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${domain.db.store})`);
        console.log(`[VIP] billing ${config.billing.url}; events relay ${outbox.enabled ? `→ ${config.events.url}` : 'off (outbox accumulates)'}; billing events ${config.events.webhookSecrets.length ? 'accepted' : 'not accepted (VIP_EVENTS_SECRET unset)'}`);
    });
    server.keepAliveTimeout = 65_000;

    createLifecycle({ server, app, timers });
    return { server, app };
}

if (require.main === module) {
    start().catch((err) => { console.error('[VIP] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
