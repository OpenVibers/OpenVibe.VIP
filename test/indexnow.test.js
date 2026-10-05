'use strict';
/**
 * IndexNow (openvibe-shared/indexnow): INDEXNOW_KEY unset → the feature is off (no key route,
 * nothing sent). With a key, the key file is served at /<key>.txt as text/plain and publishing,
 * editing or archiving a plan pings the engines with the creator's page, the plan's terms page and
 * the sitemap. A draft, an unchanged edit and a replay never ping.
 */
const assert = require('assert');
const { boot, harness } = require('./helpers/app');

const { test, run } = harness('indexnow');
const KEY = 'k'.repeat(32);

(async () => {
    const off = await boot();
    const on = await boot({ env: { INDEXNOW_KEY: KEY } });

    // A spy in place of the module's HTTP send: records every pingSoon batch.
    const pings = [];
    const spy = {
        enabled: true,
        keyFile: (_req, _res, next) => next(),
        pingSoon: (urls) => { const a = Array.isArray(urls) ? urls : [urls]; pings.push(...a); return a.length; },
        ping: async () => ({ sent: 0, status: 0 }),
        flush: async () => ({ sent: 0, status: 0 }),
    };
    const t = await boot({ indexnow: spy });
    const creator = t.network.newUser('alice', { role: 'streamer' });
    let plan;

    test('without a key IndexNow is off: no key route and nothing sent', async () => {
        assert.strictEqual(off.app.locals.indexnow.enabled, false);
        const res = await off.call('GET', `/${KEY}.txt`, { token: null });
        assert.strictEqual(res.status, 404, res.text);
    });

    test('with a key the key file answers text/plain with the key, before static', async () => {
        assert.strictEqual(on.app.locals.indexnow.enabled, true);
        const res = await on.call('GET', `/${KEY}.txt`, { token: null });
        assert.strictEqual(res.status, 200, res.text);
        assert.match(res.headers.get('content-type'), /^text\/plain/);
        assert.strictEqual(res.headers.get('cache-control'), 'public, max-age=3600');
        assert.strictEqual(res.text, KEY);
    });

    test('a draft never pings', async () => {
        const res = await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'First light' } });
        assert.strictEqual(res.status, 201, res.text);
        plan = res.json.plan;
        assert.deepStrictEqual(pings, []);
    });

    test('publishing pings the creator page, the terms page and the sitemap', async () => {
        const res = await t.call('POST', `/api/v1/plans/${plan.id}/publish`, { user: creator });
        assert.strictEqual(res.status, 200, res.text);
        assert.ok(pings.includes('http://vip.test/alice'), JSON.stringify(pings));
        assert.ok(pings.includes(`http://vip.test/alice/plans/${plan.slug}`), JSON.stringify(pings));
        assert.ok(pings.includes('http://vip.test/sitemap.xml'), JSON.stringify(pings));
    });

    test('an unchanged edit does not ping; a real edit of a published plan does', async () => {
        pings.length = 0;
        await t.call('PATCH', `/api/v1/plans/${plan.id}`, { user: creator, body: { name: 'First light' } });
        assert.deepStrictEqual(pings, [], 'an unchanged edit is not a change');
        const res = await t.call('PATCH', `/api/v1/plans/${plan.id}`, { user: creator, body: { description: 'Now with more.' } });
        assert.strictEqual(res.status, 200, res.text);
        assert.ok(pings.includes('http://vip.test/alice'), JSON.stringify(pings));
        assert.ok(pings.includes(`http://vip.test/alice/plans/${plan.slug}`), JSON.stringify(pings));
    });

    test('archiving pings the creator page and the sitemap', async () => {
        pings.length = 0;
        const res = await t.call('POST', `/api/v1/plans/${plan.id}/archive`, { user: creator });
        assert.strictEqual(res.status, 200, res.text);
        assert.ok(pings.includes('http://vip.test/alice'), JSON.stringify(pings));
        assert.ok(pings.includes('http://vip.test/sitemap.xml'), JSON.stringify(pings));
    });

    await run().finally(async () => { await t.close(); await on.close(); await off.close(); });
})();
