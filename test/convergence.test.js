'use strict';
/**
 * Consumer convergence (roadmap Wave 10 exit): when a membership changes — Billing emits
 * billing.entitlement.changed, VIP applies it and emits vip.membership.changed — every product's
 * cache (openvibe-vip/client createVipCache, the cache Chat, Community and Blog put in front of VIP)
 * stops granting within a bounded time:
 *
 *   event handed to the product's cache      at once (handleEvent drops the pair)
 *   VIP has the event, the product does not  ≤ ttlMs (the product's cache lifetime for a "yes")
 *   every event lost, VIP included           ≤ VIP_PROJECTION_MAX_AGE_MS + ttlMs (VIP re-asks Billing
 *                                            once its projection is past valid_until)
 *   the paid period ends (cancel at period end)  never past expires_at (a "yes" is not cached beyond it)
 *   VIP unreachable                          ≤ ttlMs, then every answer is a denial (fail closed)
 *
 * Real VIP (stub Network and Billing, one injected clock shared by VIP, Billing and the cache).
 */
const assert = require('assert');
const { boot, harness } = require('./helpers/app');
const { createVipClient, createVipCache } = require('../client/vip-client');

const { test, run } = harness('convergence');
const TTL = 30_000;

(async () => {
    const t = await boot();
    const creator = t.network.newUser('cora', { role: 'streamer' });
    await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Crew', publish: true } });
    const tokenClient = { authHeaders: async () => ({ Authorization: `Bearer ${t.network.signService({ sub: 'svc:community', cap: ['vip.entitlement.check', 'vip.resource.policy.evaluate'] })}` }) };
    let vipDown = false;
    const fetchVia = (url, init) => (vipDown ? Promise.reject(new Error('connect ECONNREFUSED')) : fetch(url, init));
    const vip = createVipClient({ baseUrl: t.base, tokenClient, fetch: fetchVia });
    const newCache = () => createVipCache({ vip, ttlMs: TTL, denyTtlMs: 10_000, unavailableTtlMs: 2_000, now: t.clock.now });
    const space = { service: 'community', type: 'space', id: 'crew' };
    const fallback = { requirement: 'member', binding: 'community:members_only' };
    const grants = async (cache, m) => {
        const e = await cache.entitlement({ subject: m.subject, creator: creator.subject, product: 'chat' });
        const d = await cache.evaluate({ subject: m.subject, resource: space, owner: creator.subject, fallback });
        assert.strictEqual(e.active, d.allow, `entitlement and evaluate agree (${e.status} / ${d.reason})`);
        return d.allow;
    };
    const lastChanged = (m) => t.outboxEvents('vip.membership.changed').filter((e) => e.payload.member.id === m.subject).pop();

    test('VIP emits vip.membership.changed; a cache given the event stops granting at once', async () => {
        const m = t.network.newUser('m1');
        const cache = newCache();
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        assert.strictEqual(await grants(cache, m), true);
        await t.deliverAll(t.billing.refund(m.subject, creator.subject).events);
        const ev = lastChanged(m);
        assert.strictEqual(ev.payload.active, false);
        assert.strictEqual(await grants(cache, m), true, 'still the cached yes (the event has not reached the product)');
        assert.strictEqual(cache.handleEvent(ev), true);
        assert.strictEqual(await grants(cache, m), false, 'no clock movement needed');
    });

    test('billing.entitlement.changed straight from Billing converges the cache too', async () => {
        const m = t.network.newUser('m2');
        const cache = newCache();
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        assert.strictEqual(await grants(cache, m), true);
        const refunded = t.billing.refund(m.subject, creator.subject).events;
        await t.deliverAll(refunded);
        const changed = refunded.find((e) => e.event_type === 'billing.entitlement.changed');
        assert.strictEqual(cache.handleEvent({ event: changed, seq: 7 }), true, 'a raw Events delivery body is understood');
        assert.strictEqual(await grants(cache, m), false);
    });

    test('VIP has the change, the product does not: the cached yes ends within ttlMs', async () => {
        const m = t.network.newUser('m3');
        const cache = newCache();
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        assert.strictEqual(await grants(cache, m), true);
        await t.deliverAll(t.billing.refund(m.subject, creator.subject).events);
        t.clock.advance(TTL - 1);
        assert.strictEqual(await grants(cache, m), true, 'inside the bound the product may still grant');
        t.clock.advance(2);
        assert.strictEqual(await grants(cache, m), false, 'past ttlMs it has asked VIP again');
    });

    test('every event lost: VIP re-asks Billing past valid_until, the product follows within ttlMs', async () => {
        const m = t.network.newUser('m4');
        const cache = newCache();
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        assert.strictEqual(await grants(cache, m), true);
        t.billing.refund(m.subject, creator.subject);                 // events dropped on the floor
        t.clock.advance(TTL + 1);
        assert.strictEqual(await grants(cache, m), true, 'VIP\'s projection is still fresh and says yes');
        t.clock.advance(t.config.projection.maxAgeMs + TTL);
        assert.strictEqual(await grants(cache, m), false, 'bound: VIP_PROJECTION_MAX_AGE_MS + ttlMs');
    });

    test('cancel at period end: the member keeps access to the end of the paid period, not a moment past it', async () => {
        const m = t.network.newUser('m5');
        const cache = newCache();
        const { sub, events } = t.billing.pay(m.subject, creator.subject);
        await t.deliverAll(events);
        await t.deliverAll(t.billing.cancel(sub.id).events);
        const end = Date.parse(sub.current_period_end);
        t.clock.t = end - 10_000;                                      // keep VIP's projection answering
        await t.deliverAll(t.billing.cancel(sub.id).events);
        assert.strictEqual(await grants(cache, m), true);
        t.clock.t = end + 1;
        assert.strictEqual(await grants(cache, m), false, 'the cached yes was capped at expires_at');
        t.clock.t = Date.now();
    });

    test('VIP unreachable: the cached yes is not extended; after ttlMs every answer is a denial', async () => {
        const m = t.network.newUser('m6');
        const cache = newCache();
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        assert.strictEqual(await grants(cache, m), true);
        vipDown = true;
        try {
            t.clock.advance(TTL + 1);
            const e = await cache.entitlement({ subject: m.subject, creator: creator.subject, product: 'chat' });
            assert.deepStrictEqual([e.active, e.reason], [false, 'vip_unavailable']);
            const d = await cache.evaluate({ subject: m.subject, resource: space, owner: creator.subject, fallback });
            assert.deepStrictEqual([d.allow, d.reason], [false, 'vip_unavailable']);
            assert.strictEqual(cache.peekEntitlement({ subject: m.subject, creator: creator.subject, product: 'chat' }).active, false);
        } finally { vipDown = false; }
        t.clock.advance(2_001);
        assert.strictEqual(await grants(cache, m), true, 'a failure is cached only briefly');
    });

    test('an answer fetched while an invalidation arrives is not stored', async () => {
        const m = t.network.newUser('m7');
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        let release;
        const gate = new Promise((r) => { release = r; });
        const slow = createVipClient({ baseUrl: t.base, tokenClient, fetch: async (u, i) => { const r = await fetch(u, i); await gate; return r; } });
        const cache = createVipCache({ vip: slow, ttlMs: TTL, now: t.clock.now });
        const pending = cache.entitlement({ subject: m.subject, creator: creator.subject });
        await new Promise((r) => setTimeout(r, 50));
        cache.handleEvent({ event_type: 'vip.membership.changed', payload: { member: { type: 'user', id: m.subject }, creator: { type: 'user', id: creator.subject } } });
        release();
        assert.strictEqual((await pending).active, true, 'the caller gets the answer it asked for');
        assert.strictEqual(cache.size, 0, 'but the cache does not keep an answer older than the invalidation');
    });

    test('peekEntitlement never waits: a miss answers undefined and warms the cache', async () => {
        const m = t.network.newUser('m8');
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        const cache = newCache();
        const args = { subject: m.subject, creator: creator.subject, product: 'chat' };
        assert.strictEqual(cache.peekEntitlement(args), undefined);
        await cache.entitlement(args);                                // joins the in-flight fetch
        assert.strictEqual(cache.peekEntitlement(args).active, true);
        assert.strictEqual(cache.handleEvent({ event_type: 'something.else', payload: {} }), false);
        assert.deepStrictEqual(cache.bounds, { grantMs: TTL, denyMs: 10_000, unavailableMs: 2_000 });
    });

    await run().finally(() => t.close());
})();
