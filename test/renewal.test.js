'use strict';
/**
 * Renewals, failed renewals, refunds and reversals converge on Billing (T5 step 11), money path:
 *
 *   one period row per Billing transaction, however often an event is replayed or re-sent
 *   renew then refund                      the period is reversed, the membership ends
 *   reversal before the grant event        a tombstone; the grant that follows leaves it reversed and grants nothing
 *   past_due (renewal failed)              inactive with grace { until, reason }, never authorized
 *   grace_ended                            inactive, no grace; a later paid renewal restores it
 *   audit                                  an active row without a paid period record, or on a reversed one, is doubted
 *
 * Real VIP over stub Network and Billing, one injected clock.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, harness } = require('./helpers/app');

const { test, run } = harness('renewal');
const DAY = 86_400_000;

(async () => {
    const t = await boot();
    const { periods, entitlements, db } = t.domain;
    const creator = t.network.newUser('rena', { role: 'streamer' });
    const plan = (await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Crew', publish: true } })).json.plan;

    const rows = async (m) => await db.prepare('SELECT * FROM vip_membership_periods WHERE member_subject = ? ORDER BY recorded_at, id').all(m.subject);
    const ask = async (m) => await entitlements.check(m.subject, creator.subject, { mode: 'projection' });
    const txnId = () => `txn_${ids.ulid(t.clock.now())}${Math.random().toString(36).slice(2, 5).toUpperCase()}`.slice(0, 30);
    const entEvent = (m, payload) => t.billing.envelope('billing.entitlement.changed',
        { type: 'entitlement', id: `${m.subject}:channel_subscription:${creator.subject}` },
        { subject: { type: 'user', id: m.subject }, streamer: { type: 'user', id: creator.subject }, kind: 'channel_subscription', ...payload });
    const reversal = (m, reverses, extra = {}) => {
        const id = txnId();
        return { id, event: t.billing.envelope('billing.transaction.reversed', { type: 'transaction', id }, { transaction_id: id, type: 'refund', test: false, from_subject: creator.subject, to_subject: m.subject, provider: null, metadata: {}, reverses_txn: reverses, entitlements_revoked: 1, ...extra }) };
    };
    const sub = (id, status, extra = {}) => ({ id, status, auto_renew: true, cancel_at_period_end: false, provider: 'credit', ...extra });

    test('a replayed or re-sent renewal records one period per transaction', async () => {
        const m = t.network.newUser('r1');
        const first = t.billing.pay(m.subject, creator.subject);
        await t.deliverAll(first.events);
        t.clock.advance(31 * DAY);
        const renew = t.billing.pay(m.subject, creator.subject);
        await t.deliverAll(renew.events);
        assert.deepStrictEqual((await rows(m)).map((r) => [r.billing_transaction_id, r.status]), [[first.txn, 'paid'], [renew.txn, 'paid']]);
        const again = await t.deliverAll(renew.events);                       // same event ids: the inbox says duplicate
        assert.ok(again.every((r) => r.json.duplicate), 'replay is a no-op');
        // Billing re-sends the same charge under a new event id: still one row for the transaction
        const resent = t.billing.envelope('billing.entitlement.changed', renew.events[1].subject, renew.events[1].payload);
        await t.deliver(resent);
        const all = await rows(m);
        assert.strictEqual(all.length, 2);
        assert.strictEqual(all[1].billing_subscription_id, renew.sub.id);
        assert.strictEqual(all[1].period_end, renew.events[1].payload.expires_at);
        assert.strictEqual((await ask(m)).status, 'active');
        assert.strictEqual((await t.outboxEvents('vip.membership.changed')).filter((e) => e.payload.member.id === m.subject && e.payload.reason === 'renewed').length, 1);
    });

    test('renew then refund: the period is reversed and the membership ends', async () => {
        const m = t.network.newUser('r2');
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        t.clock.advance(31 * DAY);
        const renew = t.billing.pay(m.subject, creator.subject);
        await t.deliverAll(renew.events);
        assert.strictEqual((await ask(m)).active, true);
        const out = t.billing.refund(m.subject, creator.subject);
        await t.deliverAll(out.events);
        const [, second] = await rows(m);
        assert.strictEqual(second.billing_transaction_id, renew.txn);
        assert.strictEqual(second.status, 'reversed');
        assert.strictEqual(second.reversed_by, out.events[0].payload.transaction_id);
        const a = await ask(m);
        assert.strictEqual(a.active, false);
        assert.strictEqual(a.status, 'inactive');
        const dup = await t.deliverAll(out.events);                           // replayed refund
        assert.ok(dup.every((r) => r.json.duplicate));
        assert.strictEqual((await rows(m)).length, 2);
    });

    test('a reversal before the grant event ends reversed and grants nothing', async () => {
        const m = t.network.newUser('r3');
        const paid = t.billing.pay(m.subject, creator.subject);
        const rev = reversal(m, paid.txn);
        const first = await t.deliver(rev.event);                           // no projection yet
        assert.strictEqual(first.json.outcome, 'no_projection');
        let [tomb] = await rows(m);
        assert.strictEqual(tomb.status, 'reversed');
        assert.strictEqual(tomb.billing_transaction_id, paid.txn);
        assert.strictEqual(tomb.period_end, null);
        await t.deliverAll(paid.events);                                    // the (now stale) grant arrives: active as of its time
        const all = await rows(m);
        assert.strictEqual(all.length, 1);
        [tomb] = all;
        assert.strictEqual(tomb.status, 'reversed');
        assert.strictEqual(tomb.billing_subscription_id, paid.sub.id, 'the grant fills in the details');
        assert.strictEqual(tomb.period_end, paid.events[1].payload.expires_at);
        const a = await ask(m);
        assert.strictEqual(a.active, false, 'a reversed period never grants');
        assert.notStrictEqual(a.status, 'active');
        // And a replay of the reversal under a new event id changes nothing
        await t.deliver(t.billing.envelope('billing.transaction.reversed', rev.event.subject, rev.event.payload));
        assert.strictEqual((await rows(m)).length, 1);
    });

    test('a credit refund of a subscription period (no entitlements_revoked count) reverses the period too', async () => {
        const m = t.network.newUser('r3b');
        const paid = t.billing.pay(m.subject, creator.subject);
        await t.deliverAll(paid.events);
        const rev = reversal(m, paid.txn, { entitlements_revoked: undefined, metadata: { original_type: 'subscription', subscription_id: paid.sub.id } });
        assert.strictEqual((await t.deliver(rev.event)).json.outcome, 'doubt');
        assert.strictEqual((await rows(m))[0].status, 'reversed');
        // A reversal of something that is no subscription period is still ignored
        const donation = reversal(m, txnId(), { entitlements_revoked: undefined, type: 'refund', metadata: { original_type: 'donation' } });
        assert.strictEqual((await t.deliver(donation.event)).json.outcome, 'ignored:no_entitlement');
        assert.strictEqual((await rows(m)).length, 1);
    });

    test('failed renewal: past_due is inactive with a grace, never authorized', async () => {
        const m = t.network.newUser('r4');
        const paid = t.billing.pay(m.subject, creator.subject);
        await t.deliverAll(paid.events);
        const end = paid.events[1].payload.expires_at;
        t.clock.advance(31 * DAY);
        const until = new Date(t.clock.now() + 3 * DAY).toISOString();
        // Billing says inactive; even an event that claims active while past_due must not authorize
        for (const active of [false, true]) {
            t.clock.advance(1000);
            const r = await t.deliver(entEvent(m, { active, expires_at: end, subscription: sub(paid.sub.id, 'past_due'), reason: 'renewal_failed', grace_until: until, renewal_period_end: until }));
            assert.strictEqual(r.status, 200);
            const a = await ask(m);
            assert.strictEqual(a.active, false, `active:${active} past_due`);
            assert.strictEqual(a.status, 'inactive');
            assert.deepStrictEqual(a.grace, { until, reason: 'renewal_failed' });
            for (const mode of ['auto', 'projection']) assert.strictEqual((await entitlements.check(m.subject, creator.subject, { mode })).active, false);
            const route = await t.call('GET', `/api/v1/entitlements/check?creator=${creator.subject}&mode=projection`, { user: m });
            assert.strictEqual(route.json.active, false);
            assert.deepStrictEqual(route.json.grace, { until, reason: 'renewal_failed' });
        }
        const row = await entitlements.getRow(m.subject, creator.subject);
        assert.strictEqual(row.subscription_status, 'past_due');
        assert.strictEqual(row.grace_until, until);
        const changed = (await t.outboxEvents('vip.membership.changed')).filter((e) => e.payload.member.id === m.subject).pop();
        assert.strictEqual(changed.payload.reason, 'renewal_failed');
        assert.strictEqual(changed.payload.active, false);
        assert.strictEqual((await rows(m)).length, 1, 'a failed renewal records no period');
        // An older event cannot undo it (ordering still holds)
        const stale = entEvent(m, { active: true, expires_at: end, subscription: sub(paid.sub.id, 'active'), reason: 'renewed', transaction_id: txnId() });
        stale.timestamp = new Date(t.clock.now() - 40 * DAY).toISOString();
        await t.deliver(stale);
        assert.strictEqual((await ask(m)).active, false);
        // Past the grace the answer carries no grace
        t.clock.advance(4 * DAY);
        assert.strictEqual((await ask(m)).grace, null);
    });

    test('grace ended: inactive, no grace; a later paid renewal restores the membership on the same version', async () => {
        const m = t.network.newUser('r5');
        const paid = t.billing.pay(m.subject, creator.subject);
        await t.deliverAll(paid.events);
        const end = paid.events[1].payload.expires_at;
        const versionBefore = (await ask(m)).membership.plan_version_id;
        t.clock.advance(31 * DAY);
        await t.deliver(entEvent(m, { active: false, expires_at: end, subscription: sub(paid.sub.id, 'past_due'), reason: 'renewal_failed', grace_until: new Date(t.clock.now() + 3 * DAY).toISOString() }));
        t.clock.advance(3 * DAY + 1000);
        await t.deliver(entEvent(m, { active: false, expires_at: end, subscription: sub(paid.sub.id, 'expired'), reason: 'grace_ended' }));
        let a = await ask(m);
        assert.strictEqual(a.active, false);
        assert.strictEqual(a.grace, null);
        assert.strictEqual((await entitlements.getRow(m.subject, creator.subject)).grace_until, null);
        assert.strictEqual((await t.outboxEvents('vip.membership.changed')).filter((e) => e.payload.member.id === m.subject).pop().payload.reason, 'grace_ended');
        assert.ok(await t.domain.memberships.present(await t.domain.db.prepare('SELECT * FROM vip_memberships WHERE member_subject = ?').get(m.subject)), 'the membership row is kept');
        // Billing renews (after a top-up, say): the membership is back, on the version it already had
        const renew = t.billing.pay(m.subject, creator.subject);
        await t.deliverAll(renew.events);
        a = await ask(m);
        assert.strictEqual(a.active, true);
        assert.strictEqual(a.grace, null);
        assert.strictEqual(a.membership.plan_version_id, versionBefore);
        assert.strictEqual((await rows(m)).length, 2);
    });

    test('the credit checkout records its period, and Billing\'s event for it adds no second row', async () => {
        const m = t.network.newUser('r6');
        t.billing.state.credit.set(m.subject, 1000);
        const ok = await t.call('POST', '/api/v1/checkout', { user: m, body: { plan_id: plan.id, provider: 'credit' } });
        assert.strictEqual(ok.status, 201, ok.text);
        let all = await rows(m);
        assert.strictEqual(all.length, 1);
        assert.strictEqual(all[0].status, 'paid');
        assert.ok(all[0].billing_subscription_id && all[0].period_end);
        await t.deliverAll(t.billing.state.lastEvents);
        all = await rows(m);
        assert.strictEqual(all.length, 1, 'the same transaction');
        assert.strictEqual((await periods.audit()).offenders.filter((o) => o.member === m.subject).length, 0);
    });

    test('audit: an active row without a paid period record, or on a reversed one, is doubted', async () => {
        const good = t.network.newUser('r7');
        await t.deliverAll(t.billing.pay(good.subject, creator.subject).events);
        // granted with no transaction: nothing records a charge
        const bare = t.network.newUser('r8');
        const p = t.billing.pay(bare.subject, creator.subject);
        await t.deliver(t.billing.envelope('billing.entitlement.changed', p.events[1].subject, { ...p.events[1].payload, transaction_id: undefined }));
        // a recorded period that a reversal marked reversed while the row still runs to its end
        const rev = t.network.newUser('r9');
        const q = t.billing.pay(rev.subject, creator.subject);
        await t.deliverAll(q.events);
        await db.prepare("UPDATE vip_membership_periods SET status = 'reversed' WHERE billing_transaction_id = ?").run(q.txn);
        const out = await periods.audit();
        const mine = out.offenders.filter((o) => [good, bare, rev].some((u) => u.subject === o.member));
        assert.deepStrictEqual(mine.map((o) => [o.member, o.problem]).sort(), [[bare.subject, 'no_paid_period'], [rev.subject, 'period_reversed']].sort());
        assert.strictEqual(periods.stats.offenders, out.offenders.length);
        for (const u of [bare, rev]) assert.strictEqual((await entitlements.getRow(u.subject, creator.subject)).valid_until, 0);
        assert.ok((await entitlements.getRow(good.subject, creator.subject)).valid_until > t.clock.now(), 'a recorded paid period is left alone');
        // doubted: the next check asks Billing, which still says active for the unrecorded one
        const a = await entitlements.check(bare.subject, creator.subject, { mode: 'auto' });
        assert.strictEqual(a.source, 'billing');
    });

    await run().finally(async () => await t.close());
})();
