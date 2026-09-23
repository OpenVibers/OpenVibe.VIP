'use strict';
/**
 * The entitlement projection: Billing events converge cancel / renew / refund; lost events converge
 * through valid_until and the authoritative fallback; a stale projection never authorizes past
 * valid_until (+ grace); ordering and duplicates are safe. Injected clock throughout.
 */
const assert = require('assert');
const { signDelivery } = require('openvibe-sdk/events');
const { boot, harness } = require('./helpers/app');
const { DAY } = require('./helpers/stubs');

const { test, run } = harness('entitlements');
const MIN = 60_000;

(async () => {
    const t = await boot();
    const creator = t.network.newUser('dora', { role: 'streamer' });
    const svc = { cap: ['vip.entitlement.check'] };
    const check = async (member, mode) => (await t.call('POST', '/api/v1/entitlements/check', { ...svc, body: { subject: { type: 'user', id: member.subject }, creator: { type: 'user', id: creator.subject }, mode } })).json;
    await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Crew', publish: true } });

    test('a grant event makes the member active from the projection, without asking Billing', async () => {
        const m = t.network.newUser('m1');
        const [settled, ent] = t.billing.pay(m.subject, creator.subject).events;
        assert.strictEqual((await t.deliver(settled)).json.outcome, 'ignored:type');
        const r = await t.deliver(ent);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.outcome, 'changed');
        const calls = t.billing.entitlementCalls();
        const e = await check(m);
        assert.strictEqual(e.status, 'active');
        assert.strictEqual(e.active, true);
        assert.strictEqual(e.source, 'projection');
        assert.strictEqual(e.membership.plan_version.version, 1);
        assert.strictEqual(t.billing.entitlementCalls(), calls);
        const changed = t.outboxEvents('vip.membership.changed').filter((x) => x.payload.member.id === m.subject);
        assert.strictEqual(changed.length, 1);
        assert.strictEqual(changed[0].payload.active, true);
        assert.strictEqual(changed[0].payload.reason, 'granted');
        assert.strictEqual(changed[0].payload.plan_version, 1);
    });

    test('a redelivered event is applied once', async () => {
        const m = t.network.newUser('m2');
        const ent = t.billing.pay(m.subject, creator.subject).events[1];
        assert.strictEqual((await t.deliver(ent)).json.duplicate, false);
        assert.strictEqual((await t.deliver(ent)).json.duplicate, true);
        assert.strictEqual(t.outboxEvents('vip.membership.changed').filter((x) => x.payload.member.id === m.subject).length, 1);
    });

    test('deliveries must be signed; only Billing is believed', async () => {
        const m = t.network.newUser('m3');
        const ent = t.billing.pay(m.subject, creator.subject).events[1];
        assert.strictEqual((await t.deliver(ent, { secret: 'x'.repeat(48) })).status, 401);
        const forged = { ...ent, event_id: t.billing.envelope('x.y.z', { type: 'x', id: '1' }, {}).event_id, source: 'live' };
        assert.strictEqual((await t.deliver(forged)).json.outcome, 'ignored:source');
        assert.strictEqual(t.domain.entitlements.getRow(m.subject, creator.subject), null);
        const raw = JSON.stringify({ event: ent, seq: 1 });
        const res = await fetch(`${t.base}/internal/events`, { method: 'POST', body: raw, headers: { 'X-OpenVibe-Signature': signDelivery(raw + ' ', t.EVENTS_SECRET) } });
        assert.strictEqual(res.status, 401);
    });

    test('cancel: the period still runs, then the member converges to inactive', async () => {
        const m = t.network.newUser('m4');
        const { sub, events } = t.billing.pay(m.subject, creator.subject);
        await t.deliverAll(events);
        t.clock.advance(5 * DAY);
        await t.deliverAll(t.billing.cancel(sub.id).events);
        let e = await check(m);
        assert.strictEqual(e.active, true);
        assert.strictEqual(e.cancel_at_period_end, true);
        const ev = t.outboxEvents('vip.membership.changed').filter((x) => x.payload.member.id === m.subject);
        assert.strictEqual(ev[ev.length - 1].payload.reason, 'cancel_scheduled');
        t.clock.advance(26 * DAY);
        await t.deliverAll(t.billing.expire(sub.id, 'canceled').events);
        e = await check(m, 'projection');
        assert.strictEqual(e.status, 'inactive');
        assert.strictEqual(e.active, false);
        t.clock.advance(-31 * DAY);
    });

    test('cancel with the expiry event lost: past the period end VIP asks Billing and answers inactive', async () => {
        const m = t.network.newUser('m5');
        const { sub, events } = t.billing.pay(m.subject, creator.subject);
        await t.deliverAll(events);
        await t.deliverAll(t.billing.cancel(sub.id).events);
        t.clock.advance(31 * DAY);
        t.billing.expire(sub.id, 'canceled');   // event never delivered
        const calls = t.billing.entitlementCalls();
        const e = await check(m);
        assert.strictEqual(e.status, 'inactive');
        assert.strictEqual(e.source, 'billing');
        assert.strictEqual(t.billing.entitlementCalls(), calls + 1);
        t.clock.advance(-31 * DAY);
    });

    test('renew: the renewal event extends the membership past the old period end', async () => {
        const m = t.network.newUser('m6');
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        t.clock.advance(30 * DAY - 5 * MIN);
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);   // renewed 5 minutes before the end
        t.clock.advance(10 * MIN);                                              // the old period is over
        const e = await check(m, 'projection');
        assert.strictEqual(e.active, true);
        assert.strictEqual(e.stale, false);
        assert.strictEqual(Date.parse(e.expires_at), Date.parse(t.billing.entitlement(m.subject, creator.subject).expires_at));
        const ev = t.outboxEvents('vip.membership.changed').filter((x) => x.payload.member.id === m.subject);
        assert.strictEqual(ev[ev.length - 1].payload.reason, 'renewed');
        t.clock.advance(-(30 * DAY + 5 * MIN));
    });

    test('renew with the event lost: the projection stops answering; Billing confirms the renewal', async () => {
        const m = t.network.newUser('m7');
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        t.clock.advance(29 * DAY);
        await check(m, 'authoritative');                       // fresh row synced on day 29
        t.billing.pay(m.subject, creator.subject);             // renewal event never delivered
        t.clock.advance(1 * DAY + 2 * MIN);                    // past the old period end + grace
        assert.strictEqual((await check(m, 'projection')).status, 'unknown');
        const e = await check(m);
        assert.strictEqual(e.status, 'active');
        assert.strictEqual(e.source, 'billing');
        assert.strictEqual((await check(m, 'projection')).status, 'active');
        t.clock.advance(-(30 * DAY + 2 * MIN));
    });

    test('refund: the refund events revoke at once', async () => {
        const m = t.network.newUser('m8');
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        const out = await t.deliverAll(t.billing.refund(m.subject, creator.subject).events);
        assert.deepStrictEqual(out.map((o) => o.json.outcome), ['doubt', 'changed']);
        const e = await check(m, 'projection');
        assert.strictEqual(e.active, false);
        const ev = t.outboxEvents('vip.membership.changed').filter((x) => x.payload.member.id === m.subject);
        assert.strictEqual(ev[ev.length - 1].payload.reason, 'refund');
        assert.strictEqual(ev[ev.length - 1].payload.active, false);
    });

    test('refund with only the reversal delivered: the projection is in doubt and Billing decides', async () => {
        const m = t.network.newUser('m9');
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        const [reversed] = t.billing.refund(m.subject, creator.subject).events;
        await t.deliver(reversed);
        t.clock.advance(2 * MIN);
        assert.strictEqual((await check(m, 'projection')).status, 'unknown');
        const e = await check(m);
        assert.strictEqual(e.status, 'inactive');
        assert.strictEqual(e.source, 'billing');
        t.clock.advance(-2 * MIN);
    });

    test('refund with every event lost: the stale "yes" ends at valid_until (max age), never later', async () => {
        const m = t.network.newUser('m10');
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        t.billing.refund(m.subject, creator.subject);      // nothing delivered
        const row = t.domain.entitlements.getRow(m.subject, creator.subject);
        assert.strictEqual(row.valid_until - row.synced_at, t.config.projection.maxAgeMs);
        t.clock.advance(t.config.projection.maxAgeMs + t.config.projection.graceMs + 1);
        assert.strictEqual((await check(m, 'projection')).active, false);
        assert.strictEqual((await check(m, 'projection')).status, 'unknown');
        const e = await check(m);
        assert.strictEqual(e.status, 'inactive');
        t.clock.advance(-(t.config.projection.maxAgeMs + t.config.projection.graceMs + 1));
    });

    test('a stale projection cannot authorize past valid_until + grace, even with Billing down', async () => {
        const m = t.network.newUser('m11');
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        t.billing.state.down = true;
        try {
            t.clock.advance(t.config.projection.maxAgeMs + 10_000);          // stale, inside grace
            let e = await check(m);
            assert.strictEqual(e.status, 'active');
            assert.strictEqual(e.stale, true);
            assert.strictEqual(e.reason, 'billing_unavailable');
            assert.strictEqual((await check(m, 'authoritative')).status, 'unknown');
            t.clock.advance(t.config.projection.graceMs);                     // past grace
            e = await check(m);
            assert.strictEqual(e.status, 'unknown');
            assert.strictEqual(e.active, false);
            assert.strictEqual((await check(m, 'projection')).status, 'unknown');
            // A hundred days later it is still "unknown", never "yes".
            t.clock.advance(100 * DAY);
            assert.strictEqual((await check(m)).active, false);
        } finally {
            t.billing.state.down = false;
            t.clock.advance(-(t.config.projection.maxAgeMs + 10_000 + t.config.projection.graceMs + 100 * DAY));
        }
        assert.strictEqual((await check(m)).status, 'active');
    });

    test('authoritative mode always asks Billing', async () => {
        const m = t.network.newUser('m12');
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        const calls = t.billing.entitlementCalls();
        const e = await check(m, 'authoritative');
        assert.strictEqual(e.source, 'billing');
        assert.strictEqual(e.active, true);
        assert.strictEqual(t.billing.entitlementCalls(), calls + 1);
    });

    test('an unknown member with Billing down is "unknown", not "no" and never "yes"', async () => {
        const m = t.network.newUser('m13');
        t.billing.state.down = true;
        try {
            const e = await check(m);
            assert.strictEqual(e.status, 'unknown');
            assert.strictEqual(e.active, false);
        } finally { t.billing.state.down = false; }
    });

    test('out of order: an older grant after a newer revocation is ignored; an older revocation after a newer grant puts the row in doubt', async () => {
        const m = t.network.newUser('m14');
        const grant = t.billing.pay(m.subject, creator.subject).events[1];
        t.clock.advance(1000);
        const revoke = t.billing.refund(m.subject, creator.subject).events[1];
        await t.deliver(revoke);
        assert.strictEqual((await t.deliver(grant)).json.outcome, 'stale_ignored');
        assert.strictEqual((await check(m, 'projection')).active, false);

        const m2 = t.network.newUser('m15');
        const g1 = t.billing.pay(m2.subject, creator.subject).events[1];
        t.clock.advance(1000);
        const r1 = t.billing.refund(m2.subject, creator.subject).events[1];
        t.clock.advance(1000);
        const g2 = t.billing.pay(m2.subject, creator.subject).events[1];
        await t.deliver(g1);
        await t.deliver(g2);
        assert.strictEqual((await t.deliver(r1)).json.outcome, 'doubt');
        t.clock.advance(2 * MIN);
        assert.strictEqual((await check(m2, 'projection')).status, 'unknown');
        assert.strictEqual((await check(m2)).status, 'active');     // Billing: the newer grant stands
    });

    test('the refresh job re-confirms projections in use before they go stale', async () => {
        const m = t.network.newUser('m16');
        await t.deliverAll(t.billing.pay(m.subject, creator.subject).events);
        await check(m, 'projection');                                          // marks it used
        t.clock.advance(t.config.projection.maxAgeMs - MIN);
        const out = await t.domain.entitlements.refreshDue();
        assert.ok(out.checked >= 1 && out.ok >= 1);
        const row = t.domain.entitlements.getRow(m.subject, creator.subject);
        assert.strictEqual(row.source, 'billing_check');
        assert.ok(row.valid_until > t.clock.now() + 10 * MIN);
    });

    test('a user checks only their own entitlement; services need the capability', async () => {
        const m = t.network.newUser('m17');
        const other = t.network.newUser('m18');
        const own = await t.call('GET', `/api/v1/entitlements/check?creator=${creator.subject}`, { user: m });
        assert.strictEqual(own.status, 200);
        assert.strictEqual(own.json.member.id, m.subject);
        const theirs = await t.call('GET', `/api/v1/entitlements/check?creator=${creator.subject}&subject=${other.subject}`, { user: m });
        assert.strictEqual(theirs.status, 403);
        const noCap = await t.call('POST', '/api/v1/entitlements/check', { cap: ['vip.plan.list'], body: { subject: m.subject, creator: creator.subject } });
        assert.strictEqual(noCap.status, 403);
        const byName = await t.call('POST', '/api/v1/entitlements/check', { ...svc, body: { subject: m.subject, creator: 'dora' } });
        assert.strictEqual(byName.status, 200, byName.text);
    });

    await run().finally(() => t.close());
})();
