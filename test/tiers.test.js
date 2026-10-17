'use strict';
/**
 * Tiers (owner's ask: creator memberships with tiers; openvibe-contracts 0.201.0). A creator publishes one plan per
 * tier and sets each tier's monthly price on Billing (VIP never keeps a price). Pages, the card and the API show each
 * plan's price; a tier above 1 without a price cannot be joined; a checkout buys the plan's tier; a subscription made
 * elsewhere (Live's, tier 1) is filed under the tier-1 plan, and Billing's tier decides the plan when no checkout did.
 */
const assert = require('assert');
const { boot, harness } = require('./helpers/app');
const { test, run } = harness('tiers');

(async () => {
    const t = await boot();
    const creator = t.network.newUser('tierra', { role: 'streamer' });
    const fan = t.network.newUser('fanny');
    const live = t.network.newUser('lively');
    let basic;
    let superfan;

    test('a creator publishes two tiers and prices them on Billing (tier 1 at the default until set)', async () => {
        const one = await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Supporter', benefits: ['Badge'], publish: true } });
        assert.strictEqual(one.status, 201, one.text);
        basic = one.json.plan;
        assert.deepStrictEqual([basic.tier, basic.price_cents, basic.purchasable], [1, 499, true], 'tier 1 without a price sells at Billing\'s default');
        const two = await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Superfan', benefits: ['Badge', 'Monthly call'], tier: 2, publish: true } });
        assert.strictEqual(two.status, 201, two.text);
        superfan = two.json.plan;
        assert.deepStrictEqual([superfan.tier, superfan.price_cents, superfan.purchasable], [2, null, false], 'tier 2 is not for sale until priced');
        const priced = await t.call('PATCH', `/api/v1/plans/${superfan.id}`, { user: creator, body: { price_cents: 1500 } });
        assert.strictEqual(priced.status, 200, priced.text);
        assert.deepStrictEqual([priced.json.plan.price_cents, priced.json.plan.purchasable, priced.json.unchanged], [1500, true, true], 'a price is not a plan term: no new version');
        assert.deepStrictEqual(t.billing.state.tiers.get(creator.subject).get(2), { price_cents: 1500, status: 'active' });
        const bad = await t.call('PATCH', `/api/v1/plans/${superfan.id}`, { user: creator, body: { price_cents: 50 } });
        assert.strictEqual(bad.status, 422);
        const other = await t.call('PATCH', `/api/v1/plans/${superfan.id}`, { user: fan, body: { price_cents: 100 } });
        assert.strictEqual(other.status, 403, 'only the creator prices their tiers');
    });

    test('the dashboard sets a price from "$3" and refuses a non-amount', async () => {
        const d = await t.page('/dashboard', { user: creator });
        assert.match(d.text, /Tier 2, sold through OpenVibe\.Billing as a channel subscription at <b>\$15\.00<\/b> a month/);
        const token = t.csrf(d.text);
        const ok = await t.page(`/dashboard/plans/${basic.id}/price`, { user: creator, method: 'POST', form: { _csrf: token, price: '$3' } });
        assert.match(decodeURIComponent(ok.location), /Price set: \$3\.00 a month/);
        assert.strictEqual(t.billing.state.tiers.get(creator.subject).get(1).price_cents, 300);
        const no = await t.page(`/dashboard/plans/${basic.id}/price`, { user: creator, method: 'POST', form: { _csrf: token, price: 'three' } });
        assert.match(no.location, /error=/);
    });

    test('the creator page and the card show each tier and its price', async () => {
        const page = await t.page(`/${creator.username}`);
        assert.match(page.text, /Supporter <span class="pill">Tier 1<\/span>/);
        assert.match(page.text, /<b>\$3\.00<\/b> every/);
        assert.match(page.text, /<b>\$15\.00<\/b> every/);
        const card = await t.call('GET', `/api/v1/creators/${creator.username}/card`);
        assert.strictEqual(card.status, 200, card.text);
        assert.deepStrictEqual(card.json.card.plans.map((p) => [p.tier, p.price_cents, p.purchasable]), [[1, 300, true], [2, 1500, true]]);
        assert.strictEqual(card.json.card.price.price_cents, 300, 'the card\'s headline price is the lowest tier');
    });

    test('a checkout buys the plan\'s tier at its price and files the member under that plan', async () => {
        t.billing.state.credit.set(fan.subject, 2000);
        const co = await t.call('POST', '/api/v1/checkout', { user: fan, body: { plan_id: superfan.id, provider: 'credit' } });
        assert.strictEqual(co.status, 201, co.text);
        const sent = t.billing.calls.filter((c) => c.path === '/api/v1/subscriptions' && c.method === 'POST').pop();
        assert.strictEqual(sent.body.tier, 2);
        assert.strictEqual(t.billing.state.credit.get(fan.subject), 500, 'charged the tier-2 price');
        const m = await t.domain.memberships.get(fan.subject, (await t.domain.creators.bySubject(creator.subject)).id);
        assert.strictEqual(m.plan_id, superfan.id);
        const pc = await t.call('POST', '/api/v1/checkout', { user: t.network.newUser('pc'), body: { plan_id: superfan.id, provider: 'powerchat' } });
        assert.strictEqual(pc.status, 201, pc.text);
        const intent = t.billing.calls.filter((c) => c.path === '/api/v1/intents').pop();
        assert.strictEqual(intent.body.tier, 2);
    });

    test('a subscription made elsewhere is filed under the plan of Billing\'s tier', async () => {
        await t.deliverAll(t.billing.pay(live.subject, creator.subject).events);   // Live's subscribe button: tier 1
        const c = await t.domain.creators.bySubject(creator.subject);
        assert.strictEqual((await t.domain.memberships.get(live.subject, c.id)).plan_id, basic.id);
        const vipper = t.network.newUser('vipper');
        await t.deliverAll(t.billing.pay(vipper.subject, creator.subject, { tier: 2, priceCents: 1500 }).events);
        assert.strictEqual((await t.domain.memberships.get(vipper.subject, c.id)).plan_id, superfan.id, 'Billing said tier 2');
    });

    test('a tier with no price cannot be joined, and says so', async () => {
        const three = await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Patron', tier: 3, publish: true } });
        assert.strictEqual(three.status, 201, three.text);
        const page = await t.page(`/${creator.username}`);
        assert.match(page.text, /This plan has no price yet, so it cannot be joined\./);
        const co = await t.call('POST', '/api/v1/checkout', { user: t.network.newUser('early'), body: { plan_id: three.json.plan.id, provider: 'credit' } });
        assert.strictEqual(co.status, 409);
        assert.strictEqual(co.json.code, 'vip.checkout.unavailable');
    });

    await run();
})().catch((e) => { console.error(e); process.exit(1); });
