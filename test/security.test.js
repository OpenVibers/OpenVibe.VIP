'use strict';
/**
 * Security review regressions (Track S):
 *   - a person's checkout cannot hand Billing (and so the payment provider) a return URL off this
 *     site: a provider-hosted checkout link must not become an open redirect;
 *   - a crafted ?ok= / ?error= link cannot put text of its choosing on a VIP page; VIP's own
 *     redirects still show their notices.
 */
const assert = require('assert');
const { boot, harness } = require('./helpers/app');

const { test, run } = harness('security');

(async () => {
    const t = await boot();
    const creator = t.network.newUser('sec_creator', { role: 'streamer' });
    const buyer = t.network.newUser('sec_buyer');
    let plan;
    const intentBodies = () => t.billing.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/intents').map((c) => c.body);

    test('setup: a published plan', async () => {
        plan = (await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Club', description: 'Members', benefits: ['Badge'], publish: true } })).json.plan;
        assert.ok(plan && plan.purchasable);
    });

    test('a person cannot send the checkout\'s return URLs off-site', async () => {
        const before = intentBodies().length;
        for (const [field, url] of [['success_url', 'https://evil.example/phish'], ['cancel_url', 'https://evil.example/phish'], ['success_url', 'javascript:alert(1)'], ['cancel_url', '//evil.example/x']]) {
            const r = await t.call('POST', '/api/v1/checkout', { user: buyer, body: { plan_id: plan.id, provider: 'stripe', [field]: url } });
            assert.strictEqual(r.status, 422, `${field}=${url} → ${r.status} ${r.text}`);
        }
        assert.strictEqual(intentBodies().length, before, 'nothing reached Billing');
    });

    test('same-site return URLs and the defaults still work', async () => {
        const r = await t.call('POST', '/api/v1/checkout', { user: buyer, body: { plan_id: plan.id, provider: 'stripe', success_url: 'http://vip.test/me?joined=1', cancel_url: 'http://vip.test/sec_creator' } });
        assert.strictEqual(r.status, 201, r.text);
        const sent = intentBodies().pop();
        assert.strictEqual(sent.success_url, 'http://vip.test/me?joined=1');
        assert.strictEqual(sent.cancel_url, 'http://vip.test/sec_creator');
        const d = await t.call('POST', '/api/v1/checkout', { user: buyer, body: { plan_id: plan.id, provider: 'stripe' } });
        assert.strictEqual(d.status, 201, d.text);
        assert.match(intentBodies().pop().success_url, /^http:\/\/vip\.test\//);
    });

    test('a crafted ?ok= / ?error= link shows nothing', async () => {
        const spoof = 'Your membership was suspended — send 5000 Vibes to @scammer to restore it';
        for (const kind of ['ok', 'error']) {
            const p = await t.page(`/sec_creator?${kind}=${encodeURIComponent(spoof)}`);
            assert.strictEqual(p.status, 200);
            assert.ok(!p.text.includes('send 5000 Vibes'), `${kind} notice rendered from the query string`);
            const forged = await t.page(`/me?${kind}=${encodeURIComponent(spoof)}&ns=AAAAAAAAAAAAAAAAAAAAAA`, { user: buyer });
            assert.ok(!forged.text.includes('send 5000 Vibes'), `${kind} notice rendered with a forged signature`);
        }
    });

    test('VIP\'s own notices still render', async () => {
        const r = await t.page('/sec_creator/join', { user: buyer, method: 'POST', form: { plan_id: plan.id, provider: 'stripe', _csrf: 'stale' } });
        assert.strictEqual(r.status, 303);
        const shown = await t.page(r.location, { user: buyer });
        assert.match(shown.text, /That form expired/);
    });

    await run();
})().catch((e) => { console.error(e); process.exit(1); });
