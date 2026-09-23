'use strict';
/**
 * Boots VIP against the stubs on a random port with a temp database and an injected clock shared
 * with the Billing stub. Jobs are off: tests drive refreshes explicitly.
 *
 *   t.call(method, path, { body, user, cap, sub, token })   user → Bearer user JWT; else a service token with `cap`
 *   t.deliver(envelope)                                     a signed OpenVibe.Events delivery to /internal/events
 *   t.page(path, { user, method, form })                    an SSR page (cookie session), form posts
 *   t.clock.advance(ms)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { signDelivery } = require('openvibe-sdk/events');
const { startNetwork, startBilling } = require('./stubs');

const EVENTS_SECRET = 'e'.repeat(48);

async function boot(opts = {}) {
    const network = await startNetwork();
    const clock = { t: Date.now(), now() { return this.t; }, advance(ms) { this.t += ms; } };
    clock.now = clock.now.bind(clock);
    const billing = await startBilling(network, clock);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-test-'));
    const env = {
        NODE_ENV: 'test',
        VIP_DB_PATH: path.join(dir, 'vip.db'),
        BASE_URL: 'http://vip.test',
        OV_NETWORK_URL: network.url,
        OV_NETWORK_INTERNAL_URL: network.url,
        OV_NETWORK_ISSUER: network.url,
        OV_NETWORK_PUBLIC_KEY: network.publicPem,
        OV_OAUTH_CLIENT_ID: 'vip',
        OV_OAUTH_CLIENT_SECRET: 'shh',
        VIP_FORM_SECRET: 'form-secret-for-tests',
        BILLING_URL: billing.url,
        VIP_BILLING_TIMEOUT_MS: '1500',
        VIP_CHECKOUT_PROVIDERS: 'powerchat,stripe,credit',
        VIP_EVENTS_SECRET: EVENTS_SECRET,
        VIP_JOBS: 'off',
        VIP_PROJECTION_MAX_AGE_MS: String(15 * 60 * 1000),
        VIP_PROJECTION_GRACE_MS: String(60 * 1000),
        ...(opts.env || {}),
    };
    for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}server${path.sep}`)) delete require.cache[k];
    const { loadConfig } = require('../../server/config');
    const { createApp } = require('../../server/app');
    const config = loadConfig(env);
    const logs = [];
    const log = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')), debug() {} };
    const app = createApp({ config, now: clock.now, log });
    const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const domain = app.locals.domain;

    async function call(method, p, { body, user, cap = [], sub = 'svc:live', token, headers = {} } = {}) {
        const h = { ...headers };
        if (token !== null) h.Authorization = `Bearer ${token || (user ? network.signUser(user) : network.signService({ sub, cap }))}`;
        if (body !== undefined) h['Content-Type'] = 'application/json';
        const res = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* html */ }
        return { status: res.status, headers: res.headers, json, text };
    }

    async function deliver(event, { secret = EVENTS_SECRET, seq = 1 } = {}) {
        const raw = JSON.stringify({ event, seq });
        const res = await fetch(`${base}/internal/events`, {
            method: 'POST', body: raw,
            headers: { 'Content-Type': 'application/json', 'X-OpenVibe-Signature': signDelivery(raw, secret), 'X-OpenVibe-Seq': String(seq) },
        });
        return { status: res.status, json: await res.json().catch(() => null) };
    }
    async function deliverAll(events) { const out = []; for (const e of events) out.push(await deliver(e)); return out; }

    /** An SSR request as a signed-in person (ov_token cookie) or anonymous. */
    async function page(p, { user, method = 'GET', form } = {}) {
        const headers = {};
        if (user) headers.Cookie = `ov_token=${network.signUser(user)}`;
        let bodyStr;
        if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; bodyStr = new URLSearchParams(form).toString(); }
        const res = await fetch(base + p, { method, headers, body: bodyStr, redirect: 'manual' });
        return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    }
    const csrf = (html) => { const m = /name="_csrf" value="([^"]+)"/.exec(html); return m ? m[1] : null; };

    const outboxEvents = (type) => domain.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope)).filter((e) => !type || e.event_type === type);

    async function close() {
        await new Promise((r) => server.close(r));
        app.locals.outbox.stop();
        await billing.close();
        await network.close();
        try { domain.db.close(); } catch { /* */ }
        fs.rmSync(dir, { recursive: true, force: true });
    }

    return { app, base, config, domain, network, billing, clock, logs, call, deliver, deliverAll, page, csrf, outboxEvents, close, EVENTS_SECRET };
}

/** Tiny test harness: sequential async tests, a summary, exit code. */
function harness(name) {
    const tests = [];
    const test = (title, fn) => tests.push({ title, fn });
    async function run() {
        let failed = 0;
        for (const t of tests) {
            try { await t.fn(); console.log(`  ✓ ${t.title}`); } catch (e) { failed++; console.log(`  ✗ ${t.title}\n${e.stack}`); }
        }
        console.log(`${name}: ${tests.length - failed}/${tests.length} passed`);
        process.exit(failed ? 1 : 0);
    }
    return { test, run };
}

module.exports = { boot, harness, EVENTS_SECRET };
