'use strict';
/**
 * openvibe-sdk/service (plan T1): VIP's error half is the kit's wrap/sendError with VIP's options, so a
 * VipError answers its own status/code/detail with `extra` nested as { details } below 500, and anything
 * else answers 500 vip.internal with 'internal error'. The kit's JSON parser (wired the way a service
 * adopts it) answers 413 request.too_large / 400 request.invalid_json / 415 request.unsupported_encoding;
 * VIP's own app keeps express.json, so its current codes are pinned unchanged. The entry point's graceful
 * stop runs its stop and close steps in order, then exits 0.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const svc = require('openvibe-sdk/service');
const { boot, harness } = require('./helpers/app');
const { wrap } = require('../server/api/v1');
const { VipError } = require('../server/util');

const { test, run } = harness('service-kit');

(async () => {
    const t = await boot();

    // A service-shaped app on the kit's parser + VIP's wrap, the way the recipe wires it.
    const app = express();
    app.post('/echo', svc.jsonBody({ limit: '64kb' }), wrap(async (req, res) => { res.json({ ok: true }); }));
    app.post('/refuse', wrap(async () => { throw new VipError(422, 'vip.test_refusal', 'that is not allowed', { field: 'provider' }); }));
    app.post('/gone', wrap(async () => { throw new VipError(503, 'vip.billing_unavailable', 'Billing is not answering right now; nothing was charged'); }));
    app.post('/boom', wrap(async () => { throw new Error('boom'); }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    const read = async (r) => { const text = await r.text(); return { status: r.status, headers: r.headers, text, json: JSON.parse(text) }; };

    test('the kit parser: a JSON body over 64 kB is 413 request.too_large', async () => {
        const r = await read(await post('/echo', JSON.stringify({ padding: 'y'.repeat(70 * 1024) })));
        assert.strictEqual(r.status, 413, r.text);
        assert.strictEqual(r.json.code, 'request.too_large');
    });

    test('the kit parser: malformed JSON is 400 request.invalid_json', async () => {
        const r = await read(await post('/echo', '{oops'));
        assert.strictEqual(r.status, 400, r.text);
        assert.strictEqual(r.json.code, 'request.invalid_json');
    });

    test('the kit parser: an unreadable Content-Encoding is 415 request.unsupported_encoding', async () => {
        const r = await read(await post('/echo', '{}', { 'content-encoding': 'xz' }));
        assert.strictEqual(r.status, 415, r.text);
        assert.strictEqual(r.json.code, 'request.unsupported_encoding');
    });

    test('VIP\'s app keeps its own parser answers: over 64 kB 413 request.too_large, malformed 400 request.malformed_json', async () => {
        const big = await read(await fetch(`${t.base}/api/v1/plans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'y'.repeat(70 * 1024) }) }));
        assert.strictEqual(big.status, 413, big.text);
        assert.strictEqual(big.json.code, 'request.too_large');
        const bad = await read(await fetch(`${t.base}/api/v1/plans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' }));
        assert.strictEqual(bad.status, 400, bad.text);
        assert.strictEqual(bad.json.code, 'request.malformed_json');
    });

    test('a VipError answers its own status/code/detail and nests extra as { details } below 500', async () => {
        const r = await read(await post('/refuse', '{}'));
        assert.strictEqual(r.status, 422, r.text);
        assert.strictEqual(r.json.code, 'vip.test_refusal');
        assert.strictEqual(r.json.detail, 'that is not allowed');
        assert.deepStrictEqual(r.json.details, { field: 'provider' });
        assert.strictEqual(r.json.error, 'that is not allowed');
    });

    test('a 503 VipError keeps its detail (the fallback detail is only for an unexpected 500)', async () => {
        const r = await read(await post('/gone', '{}'));
        assert.strictEqual(r.status, 503, r.text);
        assert.strictEqual(r.json.code, 'vip.billing_unavailable');
        assert.strictEqual(r.json.detail, 'Billing is not answering right now; nothing was charged');
        assert.strictEqual(r.json.details, undefined);
    });

    test('an unexpected throw answers 500 vip.internal with \'internal error\'', async () => {
        const r = await read(await post('/boom', '{}'));
        assert.strictEqual(r.status, 500, r.text);
        assert.strictEqual(r.json.code, 'vip.internal');
        assert.strictEqual(r.json.detail, 'internal error');
    });

    test('the entry point stop runs its stop and close steps in order, then exits 0', async () => {
        const steps = [];
        const spy = (obj, method, label) => { const orig = obj[method].bind(obj); obj[method] = (...a) => { steps.push(label); return orig(...a); }; };
        spy(t.app.locals.outbox, 'stop', 'outbox.stop');
        spy(t.app.locals.keys, 'stop', 'keys.stop');
        const stopsMetrics = !!(t.app.locals.metrics && typeof t.app.locals.metrics.stop === 'function');
        if (stopsMetrics) spy(t.app.locals.metrics, 'stop', 'metrics.stop');
        spy(t.app.locals.domain.db, 'close', 'domain.db.close');

        const stopServer = http.createServer(t.app);
        await new Promise((resolve) => stopServer.listen(0, '127.0.0.1', resolve));

        const { createLifecycle } = require('../server/index');
        const exits = [];
        const lifecycle = createLifecycle({ server: stopServer, app: t.app, timers: [], exit: (code) => exits.push(code), signals: false });
        const code = await lifecycle.stop('SIGTERM');

        const expected = ['outbox.stop', 'keys.stop'];
        if (stopsMetrics) expected.push('metrics.stop');
        expected.push('domain.db.close');
        assert.strictEqual(code, 0);
        assert.deepStrictEqual(exits, [0]);
        assert.deepStrictEqual(steps, expected);
        assert.strictEqual(stopServer.listening, false);
    });

    await run().finally(async () => {
        server.close();
        try { await t.close(); } catch { /* the lifecycle above already closed the db */ }
    });
})();
