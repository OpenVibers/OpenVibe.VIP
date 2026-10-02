'use strict';
/**
 * One cache rule for every header (openvibe-shared/cache-policy, plan T11 lane D): a static asset
 * served with the version it was built at (`?v=<hash>`) is immutable for a year; one served without
 * a matching ?v= gets the short public window with stale-while-revalidate. An HTML page takes the
 * HTML policy, and an API/JSON response keeps its own value.
 */
const assert = require('assert');
const { boot, harness } = require('./helpers/app');
const { assetVersion } = require('../server/web/layout');

const { test, run } = harness('asset-cache');

(async () => {
    const t = await boot();
    const get = async (p) => {
        const r = await fetch(t.base + p, { redirect: 'manual' });
        return { status: r.status, headers: r.headers, text: await r.text() };
    };

    test('a static asset under its current ?v= is immutable for a year', async () => {
        const v = assetVersion('css/vip.css');
        const r = await get(`/css/vip.css?v=${v}`);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    });

    test('a static asset with a wrong or missing ?v= gets the short public window', async () => {
        const wrong = await get('/css/vip.css?v=deadbeefdeadbeef');
        assert.strictEqual(wrong.status, 200, wrong.text);
        assert.strictEqual(wrong.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400');
        const none = await get('/css/vip.css');
        assert.strictEqual(none.status, 200, none.text);
        assert.strictEqual(none.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400');
    });

    test('an HTML widget takes the HTML policy', async () => {
        const r = await get('/embed/nobody/widget');
        assert.strictEqual(r.status, 404, r.text);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60, stale-while-revalidate=3600');
    });

    test('card.json stays a public API window', async () => {
        const r = await get('/embed/nobody/card.json');
        assert.strictEqual(r.status, 404, r.text);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
    });

    await run();
})().catch((e) => { console.error(e); process.exit(1); });
