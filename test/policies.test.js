'use strict';
/**
 * Gated-resource policy: "may subject S see resource R?" — and every doubt is a no (fail closed).
 * Also the consumer seam (openvibe-vip/client), which turns every failure into a denial.
 */
const assert = require('assert');
const { boot, harness } = require('./helpers/app');
const { createVipClient } = require('../client/vip-client');

const { test, run } = harness('policies');

(async () => {
    const t = await boot();
    const creator = t.network.newUser('erin', { role: 'streamer' });
    const member = t.network.newUser('finn');
    const oldMember = t.network.newUser('gus');
    const stranger = t.network.newUser('hal');
    const blog = { cap: ['vip.resource.policy.evaluate'], sub: 'svc:blog' };
    const post = { service: 'blog', type: 'post', id: '42' };
    const evaluate = async (subject, resource = post, extra = {}) => (await t.call('POST', '/api/v1/policies/evaluate', { ...blog, body: { subject, resource, ...extra } })).json;
    let plan;

    await t.call('POST', '/api/v1/perks', { user: creator, body: { name: 'Backstage posts', key: 'backstage', kind: 'gated_content', bindings: [{ product: 'blog', binding: 'gated_post' }] } });
    plan = (await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Backstage', perks: ['backstage'], publish: true } })).json.plan;
    await t.deliverAll(t.billing.pay(oldMember.subject, creator.subject).events);        // joins under v1 (with the perk)
    await t.call('PATCH', `/api/v1/plans/${plan.id}`, { user: creator, body: { perks: [] } });   // v2 drops it
    await t.deliverAll(t.billing.pay(member.subject, creator.subject).events);           // joins under v2

    test('no rule for a resource → denied', async () => {
        const d = await evaluate(member.subject);
        assert.deepStrictEqual([d.allow, d.reason], [false, 'no_rule']);
    });

    test('a creator gates a resource; members pass, others are refused', async () => {
        const r = await t.call('POST', '/api/v1/policies', { user: creator, body: { resource: post, requirement: 'member' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.deepStrictEqual(r.json.rule.resource, post);
        let d = await evaluate(member.subject);
        assert.deepStrictEqual([d.allow, d.reason], [true, 'member']);
        d = await evaluate(stranger.subject);
        assert.deepStrictEqual([d.allow, d.reason], [false, 'not_a_member']);
        d = await evaluate(null);
        assert.deepStrictEqual([d.allow, d.reason], [false, 'not_signed_in']);
        d = await evaluate('gst_01J0000000000000000000000Z');
        assert.strictEqual(d.allow, false);
        d = await evaluate(creator.subject);
        assert.deepStrictEqual([d.allow, d.reason], [true, 'owner']);
    });

    test('a perk rule follows the version the member bought: v1 has the perk, v2 does not', async () => {
        const res = { service: 'blog', type: 'post', id: 'backstage-1' };
        await t.call('POST', '/api/v1/policies', { user: creator, body: { resource: res, requirement: 'perk', perk_key: 'backstage' } });
        assert.strictEqual((await evaluate(oldMember.subject, res)).allow, true);
        const d = await evaluate(member.subject, res);
        assert.deepStrictEqual([d.allow, d.reason], [false, 'perk_missing']);
    });

    test('a plan rule admits members of that plan only', async () => {
        const res = { service: 'wiki', type: 'page', id: 'p1' };
        const r = await t.call('POST', '/api/v1/policies', { user: creator, body: { resource: res, requirement: 'plan', plan_id: plan.id } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual((await evaluate(member.subject, res)).allow, true);
        assert.strictEqual((await evaluate(stranger.subject, res)).allow, false);
    });

    test('an entitlement VIP cannot confirm is a denial (Billing down, no fresh projection)', async () => {
        const newcomer = t.network.newUser('ivy');
        t.billing.state.down = true;
        try {
            const d = await evaluate(newcomer.subject);
            assert.deepStrictEqual([d.allow, d.reason], [false, 'entitlement_unknown']);
            t.clock.advance(t.config.projection.maxAgeMs + t.config.projection.graceMs + 1);
            const d2 = await evaluate(member.subject);
            assert.deepStrictEqual([d2.allow, d2.reason], [false, 'entitlement_unknown']);
        } finally {
            t.billing.state.down = false;
            t.clock.advance(-(t.config.projection.maxAgeMs + t.config.projection.graceMs + 1));
        }
    });

    test('a sensitive rule always asks Billing: with Billing down even a fresh member is refused', async () => {
        const res = { service: 'community', type: 'space', id: 'vault' };
        await t.call('POST', '/api/v1/policies', { user: creator, body: { resource: res, requirement: 'member', sensitive: true } });
        const calls = t.billing.entitlementCalls();
        assert.strictEqual((await evaluate(member.subject, res)).allow, true);
        assert.strictEqual(t.billing.entitlementCalls(), calls + 1);
        t.billing.state.down = true;
        try {
            const d = await evaluate(member.subject, res);
            assert.deepStrictEqual([d.allow, d.reason], [false, 'entitlement_unknown']);
            assert.strictEqual((await evaluate(member.subject, post)).allow, true, 'a non-sensitive rule still uses the fresh projection');
        } finally { t.billing.state.down = false; }
    });

    test('a refunded member loses access as soon as the refund arrives', async () => {
        const res = { service: 'blog', type: 'post', id: 'refund-check' };
        await t.call('POST', '/api/v1/policies', { user: creator, body: { resource: res } });
        const x = t.network.newUser('jay');
        await t.deliverAll(t.billing.pay(x.subject, creator.subject).events);
        assert.strictEqual((await evaluate(x.subject, res)).allow, true);
        await t.deliverAll(t.billing.refund(x.subject, creator.subject).events);
        assert.strictEqual((await evaluate(x.subject, res)).allow, false);
    });

    test('rule pinning, disabled rules, malformed resources and unknown rules all deny', async () => {
        const rule = (await t.call('GET', `/api/v1/policies?service=blog&type=post&id=42`, { cap: ['vip.resource.policy.get'] })).json.rule;
        assert.ok(rule && rule.id);
        assert.strictEqual((await evaluate(member.subject, post, { rule_id: rule.id })).allow, true);
        assert.strictEqual((await evaluate(member.subject, { service: 'blog', type: 'post', id: 'other' }, { rule_id: rule.id })).reason, 'rule_mismatch');
        assert.strictEqual((await evaluate(member.subject, { service: 'blog' })).reason, 'invalid_resource');
        assert.strictEqual((await evaluate(member.subject, post, { rule_id: 'vgr_nope' })).reason, 'no_rule');
        const del = await t.call('DELETE', `/api/v1/policies/${rule.id}`, { user: creator });
        assert.strictEqual(del.status, 200);
        assert.strictEqual((await evaluate(member.subject, post, { rule_id: rule.id })).reason, 'rule_disabled');
        assert.strictEqual((await evaluate(member.subject, post)).reason, 'no_rule');
    });

    test('only the creator sets rules; another creator cannot take over a gated resource', async () => {
        const res = { service: 'blog', type: 'post', id: 'mine' };
        await t.call('POST', '/api/v1/policies', { user: creator, body: { resource: res } });
        const other = t.network.newUser('kim', { role: 'streamer' });
        const r = await t.call('POST', '/api/v1/policies', { user: other, body: { resource: res } });
        assert.strictEqual(r.status, 409);
        const svcNo = await t.call('POST', '/api/v1/policies', { cap: ['vip.resource.policy.evaluate'], body: { creator: { type: 'user', id: creator.subject }, resource: res } });
        assert.strictEqual(svcNo.status, 403);
        const evalNo = await t.call('POST', '/api/v1/policies/evaluate', { cap: ['vip.entitlement.check'], body: { subject: member.subject, resource: res } });
        assert.strictEqual(evalNo.status, 403);
        const self = await t.call('POST', '/api/v1/policies/evaluate', { user: member, body: { resource: res } });
        assert.strictEqual(self.json.allow, true);
        const spy = await t.call('POST', '/api/v1/policies/evaluate', { user: stranger, body: { subject: member.subject, resource: res } });
        assert.strictEqual(spy.status, 403);
    });

    test('the consumer client: allows members, and fails closed on every failure', async () => {
        const res = { service: 'blog', type: 'post', id: 'mine' };
        const tokenClient = { authHeaders: async () => ({ Authorization: `Bearer ${t.network.signService({ sub: 'svc:blog', cap: ['vip.resource.policy.evaluate', 'vip.entitlement.check'] })}` }) };
        const vip = createVipClient({ baseUrl: t.base, tokenClient });
        assert.strictEqual((await vip.evaluate({ subject: member.subject, resource: res })).allow, true);
        assert.strictEqual((await vip.evaluate({ subject: stranger.subject, resource: res })).allow, false);
        assert.strictEqual(await vip.isMember(member.subject, creator.subject), true);
        assert.strictEqual(await vip.isMember(stranger.subject, creator.subject), false);

        const down = createVipClient({ baseUrl: 'http://127.0.0.1:9', tokenClient, timeoutMs: 500 });
        const d = await down.evaluate({ subject: member.subject, resource: res });
        assert.deepStrictEqual([d.allow, d.reason], [false, 'vip_unavailable']);
        assert.strictEqual(await down.isMember(member.subject, creator.subject), false);

        const noCap = createVipClient({ baseUrl: t.base, tokenClient: { authHeaders: async () => ({ Authorization: `Bearer ${t.network.signService({ sub: 'svc:blog', cap: [] })}` }) } });
        assert.strictEqual((await noCap.evaluate({ subject: member.subject, resource: res })).allow, false);
        const badToken = createVipClient({ baseUrl: t.base, getToken: async () => 'not-a-token' });
        assert.strictEqual((await badToken.evaluate({ subject: member.subject, resource: res })).allow, false);
        const tokenFails = createVipClient({ baseUrl: t.base, getToken: async () => { throw new Error('no grant'); } });
        assert.strictEqual((await tokenFails.checkEntitlement({ subject: member.subject, creator: creator.subject })).status, 'unknown');
        const garbage = createVipClient({ baseUrl: t.base, tokenClient, fetch: async () => new Response('{"allow":"yes"}', { status: 200 }) });
        assert.strictEqual((await garbage.evaluate({ subject: member.subject, resource: res })).allow, false, 'only a literal true allows');
    });

    await run().finally(() => t.close());
})();
