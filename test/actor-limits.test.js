'use strict';
/**
 * Per-actor rate limits on /api/v1 (server/api/actor-limits.js, roadmap WS-R task 4): past its limit one
 * caller gets 429 problem+json `rate_limited` with Retry-After, before the route does any work, while
 * another caller still passes; the window reopens on the clock. A checkout past the limit never reaches
 * Billing; a product's entitlement checks have their own, larger budget. Health, ready, release.json,
 * metrics and the Events deliveries are never limited; refusals are logged (no token) and counted.
 */
const assert = require('assert');
const { boot, harness } = require('./helpers/app');
const { actor } = require('../server/api/actor-limits');

const { test, run } = harness('actor-limits');

(async () => {
    const t = await boot({ env: { VIP_LIMITS_MINUTE: '3', VIP_LIMITS_HOUR: '100' } });
    // The injected clock, 15 s into a minute: the minute window has 45 s left.
    const minute = (n) => Math.floor(Date.now() / 60_000) * 60_000 + n * 60_000;
    t.clock.t = minute(0) + 15_000;
    const creator = t.network.newUser('lena', { role: 'streamer' });
    const buyer = t.network.newUser('milo');
    const other = t.network.newUser('nora');

    test('a read: 3 a minute per person, then 429 rate_limited with Retry-After; another caller passes', async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.call('GET', '/api/v1/creators/network', { user: buyer })).status, 200);
        const r = await t.call('GET', '/api/v1/creators/network', { user: buyer });
        assert.strictEqual(r.status, 429, r.text);
        assert.strictEqual(r.headers.get('retry-after'), '45');
        assert.strictEqual(r.headers.get('content-type'), 'application/problem+json');
        assert.deepStrictEqual([r.json.code, r.json.status, r.json.retry_after_seconds], ['rate_limited', 429, 45]);
        assert.ok(r.json.detail.includes('vip.read'), r.json.detail);
        assert.strictEqual((await t.call('GET', '/api/v1/creators/network', { user: other })).status, 200, 'another person still passes');
        assert.strictEqual((await t.call('GET', '/api/v1/creators/network')).status, 200, 'a service is its own caller');
        assert.strictEqual((await t.call('GET', '/api/v1/creators/network', { token: 'not.a.token' })).status, 401, 'a bad token: 401 from auth, never a 429');
        t.clock.advance(45_000);
        assert.strictEqual((await t.call('GET', '/api/v1/creators/network', { user: buyer })).status, 200, 'the next minute opens the window again');
    });

    test('entitlement checks: a product asks about many people on its own budget; a person meets the defaults', async () => {
        t.clock.t = minute(2);
        const q = (subject) => `/api/v1/entitlements/check?creator=${creator.subject}&subject=${subject}`;
        for (let i = 0; i < 10; i++) {
            const r = await t.call('GET', q(i % 2 ? buyer.subject : other.subject), { sub: 'svc:chat', cap: ['vip.entitlement.check'] });
            assert.strictEqual(r.status, 200, r.text);
        }
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.call('GET', q(buyer.subject), { user: buyer })).status, 200);
        const r = await t.call('GET', q(buyer.subject), { user: buyer });
        assert.deepStrictEqual([r.status, r.json.code], [429, 'rate_limited']);
        assert.ok(r.json.detail.includes('vip.entitlement.check'), r.json.detail);
    });

    test('checkout: 10 a minute per person, the 11th refused before Billing hears of it', async () => {
        t.clock.t = minute(4);
        const plan = (await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Front row', benefits: ['Badge in chat'], publish: true } })).json.plan;
        assert.ok(plan && plan.purchasable);
        for (let i = 0; i < 10; i++) {
            const r = await t.call('POST', '/api/v1/checkout', { user: buyer, body: { plan_id: plan.id, provider: 'stripe' } });
            assert.strictEqual(r.status, 201, `checkout ${i + 1}: ${r.text}`);
        }
        const intents = t.billing.calls.filter((c) => c.path === '/api/v1/intents').length;
        const r = await t.call('POST', '/api/v1/checkout', { user: buyer, body: { plan_id: plan.id, provider: 'stripe' } });
        assert.deepStrictEqual([r.status, r.json.code, r.headers.get('retry-after')], [429, 'rate_limited', '60']);
        assert.strictEqual(t.billing.calls.filter((c) => c.path === '/api/v1/intents').length, intents, 'Billing never heard of it');
        assert.strictEqual((await t.call('POST', '/api/v1/checkout', { user: other, body: { plan_id: plan.id, provider: 'stripe' } })).status, 201, 'another person still checks out');
    });

    test('health, ready, release.json, metrics and the Events deliveries are never limited', async () => {
        for (let i = 0; i < 6; i++) {
            assert.strictEqual((await t.call('GET', '/api/health', { token: null })).status, 200);
            assert.notStrictEqual((await t.call('GET', '/api/ready', { token: null })).status, 429);
            assert.strictEqual((await t.call('GET', '/release.json', { token: null })).status, 200);
            assert.strictEqual((await fetch(`${t.base}/metrics`)).status, 200);
            assert.notStrictEqual((await t.deliver({ event_id: `evt_limits_${i}`, event_type: 'test.nothing', version: 1 }, { seq: i + 1 })).status, 429);
        }
    });

    test('refusals are logged (the caller, never a token) and counted in vip_rate_limited_total', async () => {
        assert.ok(t.logs.includes(`[VIP] limit vip.read: user:${buyer.subject} refused, over 3 per minute`), t.logs.join('\n'));
        assert.ok(t.logs.includes(`[VIP] limit vip.checkout: user:${buyer.subject} refused, over 10 per minute`));
        assert.ok(!t.logs.some((l) => /Bearer|eyJ/.test(l)), 'no token in the log');
        const m = await (await fetch(`${t.base}/metrics`)).text();
        assert.match(m, /vip_rate_limited_total\{limit="vip.read",window="minute"\} 1/);
        assert.match(m, /vip_rate_limited_total\{limit="vip.checkout",window="minute"\} 1/);
    });

    test('who is counted', () => {
        assert.strictEqual(actor({ principal: { kind: 'service', sub: 'svc:chat' } }), 'svc:chat');
        assert.strictEqual(actor({ principal: { kind: 'user', subject: 'usr_a' } }), 'user:usr_a');
        assert.strictEqual(actor({ principal: { kind: 'anonymous' }, ip: '203.0.113.9' }), 'ip:203.0.113.9');
    });

    test('close', async () => { await t.close(); });

    await run();
})();
