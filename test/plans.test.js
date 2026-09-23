'use strict';
/**
 * Plans are versioned: an edit creates a new version, historical terms are never rewritten, and a
 * membership keeps the version it was bought under (renewals too); a new purchase after a lapse
 * takes the current version.
 */
const assert = require('assert');
const { boot, harness } = require('./helpers/app');
const { DAY } = require('./helpers/stubs');

const { test, run } = harness('plans');

(async () => {
    const t = await boot();
    const creator = t.network.newUser('alice', { role: 'streamer' });
    const early = t.network.newUser('bob');
    const late = t.network.newUser('carol');
    let plan;

    test('a creator defines perks and publishes a plan (v1) with them', async () => {
        const perk = await t.call('POST', '/api/v1/perks', { user: creator, body: { name: 'Members emotes', key: 'emotes', kind: 'emote', bindings: [{ product: 'chat', binding: 'emote_set', config: { set: 'alice' } }] } });
        assert.strictEqual(perk.status, 201, perk.text);
        assert.deepStrictEqual(perk.json.perk.bindings, [{ product: 'chat', binding: 'emote_set', config: { set: 'alice' } }]);
        const perk2 = await t.call('POST', '/api/v1/perks', { user: creator, body: { name: 'Supporter role', key: 'supporter-role', kind: 'role' } });
        assert.strictEqual(perk2.status, 201);
        const res = await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Inner circle', description: 'Monthly support', benefits: ['Emotes', 'A role'], perks: ['emotes', 'supporter-role'], publish: true } });
        assert.strictEqual(res.status, 201, res.text);
        plan = res.json.plan;
        assert.strictEqual(plan.status, 'published');
        assert.strictEqual(plan.billing_kind, 'channel_subscription');
        assert.strictEqual(plan.current_version.version, 1);
        assert.deepStrictEqual(plan.current_version.perks.map((p) => p.key), ['emotes', 'supporter-role']);
        const ev = t.outboxEvents('vip.plan.published');
        assert.strictEqual(ev.length, 1);
        assert.strictEqual(ev[0].subject.id, plan.id);
        assert.strictEqual(ev[0].payload.version, 1);
        assert.strictEqual(ev[0].visibility, 'public');
    });

    test('a member who joins under v1 is filed under v1', async () => {
        await t.deliverAll(t.billing.pay(early.subject, creator.subject).events);
        const m = t.domain.memberships.get(early.subject, t.domain.creators.bySubject(creator.subject).id);
        assert.strictEqual(m.plan_version_id, plan.current_version.id);
    });

    test('editing a published plan creates v2, publishes it, and never touches v1', async () => {
        const before = t.domain.plans.version(plan.current_version.id);
        const res = await t.call('PATCH', `/api/v1/plans/${plan.id}`, { user: creator, body: { name: 'Inner circle', perks: ['supporter-role'], benefits: ['A role'], change_note: 'emotes moved to a separate plan' } });
        assert.strictEqual(res.status, 200, res.text);
        assert.strictEqual(res.json.version.version, 2);
        assert.strictEqual(res.json.plan.current_version.version, 2);
        const after = t.domain.plans.version(plan.current_version.id);
        assert.deepStrictEqual(after, before, 'v1 row unchanged');
        const versions = await t.call('GET', `/api/v1/plans/${plan.id}/versions`, { token: null });
        assert.deepStrictEqual(versions.json.versions.map((v) => v.version), [2, 1]);
        assert.deepStrictEqual(versions.json.versions[1].perks.map((p) => p.key), ['emotes', 'supporter-role']);
        assert.strictEqual(t.outboxEvents('vip.plan.published').length, 2);
    });

    test('the database refuses to rewrite or delete a version', () => {
        assert.throws(() => t.domain.db.prepare("UPDATE vip_plan_versions SET name = 'rewritten' WHERE id = ?").run(plan.current_version.id), /immutable/);
        assert.throws(() => t.domain.db.prepare("UPDATE vip_plan_versions SET terms = '{}' WHERE id = ?").run(plan.current_version.id), /immutable/);
        assert.throws(() => t.domain.db.prepare('DELETE FROM vip_plan_versions WHERE id = ?').run(plan.current_version.id), /immutable/);
        assert.throws(() => t.domain.db.prepare("UPDATE vip_plan_perks SET perk_name = 'x' WHERE plan_version_id = ?").run(plan.current_version.id), /immutable/);
    });

    test('an edit that changes nothing creates no version', async () => {
        const res = await t.call('PATCH', `/api/v1/plans/${plan.id}`, { user: creator, body: { name: 'Inner circle' } });
        assert.strictEqual(res.json.unchanged, true);
        assert.strictEqual(res.json.plan.current_version.version, 2);
    });

    test('renaming a perk does not change published terms', async () => {
        const perk = t.domain.perks.byKey(t.domain.creators.bySubject(creator.subject).id, 'emotes');
        await t.call('PATCH', `/api/v1/perks/${perk.id}`, { user: creator, body: { name: 'Renamed emotes' } });
        const v1 = (await t.call('GET', `/api/v1/plans/${plan.id}/versions`, { token: null })).json.versions[1];
        assert.strictEqual(v1.perks.find((p) => p.key === 'emotes').name, 'Members emotes');
    });

    test('old members keep old terms; new members get the new version', async () => {
        await t.deliverAll(t.billing.pay(late.subject, creator.subject).events);
        const cid = t.domain.creators.bySubject(creator.subject).id;
        const mEarly = t.domain.memberships.get(early.subject, cid);
        const mLate = t.domain.memberships.get(late.subject, cid);
        assert.strictEqual(t.domain.plans.version(mEarly.plan_version_id).version, 1);
        assert.strictEqual(t.domain.plans.version(mLate.plan_version_id).version, 2);
        assert.deepStrictEqual(t.domain.memberships.perkKeys(mEarly), ['emotes', 'supporter-role']);
        assert.deepStrictEqual(t.domain.memberships.perkKeys(mLate), ['supporter-role']);
        const status = await t.call('GET', `/api/v1/memberships/${early.subject}`, { user: early });
        assert.strictEqual(status.status, 200);
        assert.strictEqual(status.json.memberships[0].plan_version.version, 1);
        assert.strictEqual(status.json.memberships[0].entitlement.status, 'active');
    });

    test('a renewal keeps the version the membership was bought under', async () => {
        t.clock.advance(29 * DAY);
        await t.deliverAll(t.billing.pay(early.subject, creator.subject).events);   // reason: renewed
        const m = t.domain.memberships.get(early.subject, t.domain.creators.bySubject(creator.subject).id);
        assert.strictEqual(t.domain.plans.version(m.plan_version_id).version, 1);
    });

    test('a new purchase after the membership lapsed takes the current version', async () => {
        const sub = t.billing.byPair(late.subject, creator.subject);
        await t.deliverAll(t.billing.cancel(sub.id).events);
        t.clock.advance(2 * DAY);   // late's period (30 days from day 0) ended on day 30
        await t.deliverAll(t.billing.expire(sub.id, 'canceled').events);
        await t.call('PATCH', `/api/v1/plans/${plan.id}`, { user: creator, body: { benefits: ['A role', 'Monthly Q&A'], change_note: 'added Q&A' } });
        await t.deliverAll(t.billing.pay(late.subject, creator.subject).events);   // reason: granted
        const m = t.domain.memberships.get(late.subject, t.domain.creators.bySubject(creator.subject).id);
        assert.strictEqual(t.domain.plans.version(m.plan_version_id).version, 3);
    });

    test('Billing sells one channel subscription per creator: a second published plan is refused', async () => {
        const res = await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Second', publish: true } });
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.json.code, 'vip.plan.billing_product_taken');
        const draft = await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Second' } });
        assert.strictEqual(draft.status, 201);
        assert.strictEqual((await t.call('POST', `/api/v1/plans/${draft.json.plan.id}/publish`, { user: creator })).status, 409);
        assert.strictEqual((await t.call('POST', `/api/v1/plans/${plan.id}/archive`, { user: creator })).status, 200);
        const pub = await t.call('POST', `/api/v1/plans/${draft.json.plan.id}/publish`, { user: creator });
        assert.strictEqual(pub.status, 200, pub.text);
    });

    test('archived plans keep their members on their terms and cannot be edited', async () => {
        const m = t.domain.memberships.get(early.subject, t.domain.creators.bySubject(creator.subject).id);
        assert.strictEqual(m.plan_id, plan.id);
        const res = await t.call('PATCH', `/api/v1/plans/${plan.id}`, { user: creator, body: { name: 'x' } });
        assert.strictEqual(res.status, 409);
    });

    test('only the creator (or a service holding the capability) manages a plan', async () => {
        const other = await t.call('PATCH', `/api/v1/plans/${plan.id}`, { user: early, body: { name: 'hijack' } });
        assert.strictEqual(other.status, 403);
        const svcNo = await t.call('POST', '/api/v1/plans', { cap: ['vip.plan.list'], body: { creator: { type: 'user', id: creator.subject }, name: 'x' } });
        assert.strictEqual(svcNo.status, 403);
        assert.strictEqual(svcNo.json.code, 'capability.denied');
        const svc = await t.call('POST', '/api/v1/plans', { cap: ['vip.plan.create'], body: { creator: { type: 'user', id: creator.subject }, name: 'Via Live' } });
        assert.strictEqual(svc.status, 201, svc.text);
        assert.strictEqual(svc.json.plan.status, 'draft');
        const anon = await t.call('POST', '/api/v1/plans', { token: null, body: { name: 'x' } });
        assert.strictEqual(anon.status, 401);
    });

    test('network plans are staff-only and have no Billing product yet', async () => {
        const staff = t.network.newUser('root', { role: 'admin' });
        const no = await t.call('POST', '/api/v1/plans', { user: creator, body: { creator: 'network', name: 'Network pass' } });
        assert.strictEqual(no.status, 403);
        const yes = await t.call('POST', '/api/v1/plans', { user: staff, body: { creator: 'network', name: 'Network pass', publish: true } });
        assert.strictEqual(yes.status, 201, yes.text);
        assert.strictEqual(yes.json.plan.billing_kind, null);
        assert.strictEqual(yes.json.plan.purchasable, false);
        const co = await t.call('POST', '/api/v1/checkout', { user: early, body: { plan_id: yes.json.plan.id, provider: 'stripe' } });
        assert.strictEqual(co.status, 409);
        assert.strictEqual(co.json.code, 'vip.checkout.unavailable');
    });

    test('drafts are hidden from the public', async () => {
        const drafts = t.domain.plans.list({ creatorId: t.domain.creators.bySubject(creator.subject).id, includeDrafts: true }).filter((p) => p.status === 'draft');
        const res = await t.call('GET', `/api/v1/plans/${drafts[0].id}`, { token: null });
        assert.strictEqual(res.status, 404);
        const own = await t.call('GET', `/api/v1/plans/${drafts[0].id}`, { user: creator });
        assert.strictEqual(own.status, 200);
    });

    await run().finally(() => t.close());
})();
