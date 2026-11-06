'use strict';
/**
 * The person's own subject assertion on VIP's money calls (ADR-003, the 2026-11-06 amendment; plan H1).
 *
 * VIP names the member it acts for and Billing believes it. On a money route (a membership bought
 * from the member's Vibes, an entitlement read) that is only VIP's word, so VIP asks Network to sign
 * the person's own token into a 60-second assertion and carries it on. Without the person's token
 * there is nothing to sign, and the call travels the old way — which Billing's
 * BILLING_REQUIRE_SUBJECT_ASSERTION flag decides on.
 */
const assert = require('assert');
const { boot, harness } = require('./helpers/app');

const { test, run } = harness('subject-assertion');

/** The claims of an assertion (the stub signs one; the signature is not what this test is about). */
const claimsOf = (assertion) => JSON.parse(Buffer.from(String(assertion).split('.')[1], 'base64url').toString('utf8'));

(async () => {
    const t = await boot();
    const creator = t.network.newUser('lena', { role: 'streamer' });
    const buyer = t.network.newUser('milo');
    const plan = (await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Front row', publish: true } })).json.plan;
    t.billing.state.credit.set(buyer.subject, 10000);   // the member has Vibes to spend

    test('a checkout for a person carries the person\'s own assertion', async () => {
        const r = await t.call('POST', '/api/v1/checkout', { user: buyer, body: { plan_id: plan.id, provider: 'credit' } });
        assert.strictEqual(r.status, 201, r.text);
        const c = t.billing.calls.filter((x) => x.path === '/api/v1/subscriptions').pop();
        assert.ok(c, 'the checkout reached Billing');
        assert.ok(c.assertion, 'the call carried an assertion');
        const claims = claimsOf(c.assertion);
        assert.strictEqual(claims.sub, buyer.subject, 'the assertion names the member');
        assert.deepStrictEqual(claims.aud, ['openvibe.billing']);
        assert.strictEqual(claims.act, 'svc:vip', 'VIP is the service it was minted for');
    });

    test('a service that checks out for a member carries no assertion (it has no member token)', async () => {
        const other = t.network.newUser('nora');
        t.billing.state.credit.set(other.subject, 10000);
        const before = t.billing.calls.length;
        const r = await t.call('POST', '/api/v1/checkout', {
            cap: ['vip.membership.checkout'], sub: 'svc:live',
            body: { plan_id: plan.id, provider: 'credit', subject: { type: 'user', id: other.subject } },
        });
        assert.strictEqual(r.status, 201, r.text);
        const c = t.billing.calls.slice(before).filter((x) => x.path === '/api/v1/subscriptions').pop();
        assert.ok(c);
        assert.strictEqual(c.assertion, null, 'no assertion without the member\'s own token');
        assert.strictEqual(c.body.subscriber.id, other.subject, 'the member is still named in the body');
    });

    test('two checkouts get two assertions (a replayed one is refused)', async () => {
        const other = t.network.newUser('oscar');
        const before = t.billing.calls.length;
        await t.call('POST', '/api/v1/checkout', { user: other, body: { plan_id: plan.id, provider: 'stripe' } });
        await t.call('POST', '/api/v1/checkout', { user: other, body: { plan_id: plan.id, provider: 'stripe' } });
        const c = t.billing.calls.slice(before).filter((x) => x.path === '/api/v1/intents');
        assert.strictEqual(c.length, 2);
        assert.ok(c[0].assertion && c[1].assertion);
        assert.notStrictEqual(c[0].assertion, c[1].assertion, 'each call has its own assertion');
    });

    run();
})().catch((err) => { console.error(err); process.exit(1); });
