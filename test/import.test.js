'use strict';
/**
 * scripts/import-live.js: Live's subscription offering → creators, the subscriber-badge perk and a
 * v1 "Channel subscription" plan; memberships from Billing (never from Live's rows); every Live row
 * reconciled; idempotent; holds released on a later run; dry run keeps nothing.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { boot, harness } = require('./helpers/app');

const { test, run } = harness('import');

function liveSnapshot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-live-'));
    const file = path.join(dir, 'live.db');
    const db = new Database(file);
    db.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT DEFAULT 'user');
        CREATE TABLE subscriptions (id INTEGER PRIMARY KEY, subscriber_id INTEGER, streamer_id INTEGER, tier INTEGER DEFAULT 1, is_active INTEGER,
            started_at TEXT, expires_at TEXT, status TEXT, current_period_end TEXT, provider TEXT);
        CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO site_settings VALUES ('sub_price_usd', '4.99'), ('sub_streamer_share_pct', '70'), ('sub_site_route_fee_pct', '10');
        INSERT INTO users VALUES (1, 'japaneseoldguy', 'Japanese Old Guy', 'streamer'), (2, 'viewer1', 'Viewer One', 'user'),
            (3, 'viewer2', NULL, 'user'), (4, 'newstreamer', NULL, 'streamer'), (5, 'casual', NULL, 'user'), (6, 'selfmade', 'Self Made', 'streamer');
        INSERT INTO subscriptions VALUES (1, 2, 1, 1, 1, '2026-09-01 10:00:00', NULL, 'active', '2026-10-01 10:00:00', 'bucks'),
            (2, 3, 1, 1, 0, '2026-07-01 10:00:00', NULL, 'expired', '2026-08-01 10:00:00', 'stripe'),
            (3, 2, 5, 1, 1, '2026-09-10 10:00:00', NULL, 'active', '2026-10-10 10:00:00', 'bucks');
    `);
    db.close();
    return { file, dir };
}

(async () => {
    const t = await boot();
    const { importLive, billingApiSource } = require('../server/importer/live');
    const { createIdentity } = require('../server/network');
    const identity = createIdentity(t.config);
    const snap = liveSnapshot();
    const live = new Database(snap.file, { readonly: true, fileMustExist: true });

    // Network knows every Live user but #4 (held); Billing imported Live's subscriptions already.
    const S = {};
    for (const [id, name] of [[1, 'japaneseoldguy'], [2, 'viewer1'], [3, 'viewer2'], [5, 'casual'], [6, 'selfmade']]) S[id] = t.network.mapLive(id, name);
    t.billing.pay(S[2], S[1], { legacyLiveId: 1 });
    const expired = t.billing.pay(S[3], S[1], { legacyLiveId: 2, provider: 'stripe' }).sub;
    t.billing.expire(expired.id, 'expired');
    t.billing.pay(S[2], S[5], { legacyLiveId: 3 });
    // #6 already made their own plan on VIP before the import.
    const selfmade = { subject: S[6], username: 'selfmade', role: 'streamer' };
    const own = (await t.call('POST', '/api/v1/plans', { user: selfmade, body: { name: 'My own plan', publish: true } })).json.plan;

    const doImport = (opts = {}) => importLive(t.domain, { live, billingSource: billingApiSource(t.domain.billing), resolveLiveUsers: identity.resolveLiveUsers, log: null, ...opts });
    const snapshotCounts = () => Object.fromEntries(['vip_creators', 'vip_plans', 'vip_plan_versions', 'vip_perks', 'vip_memberships', 'vip_migration_maps', 'vip_entitlement_projection', 'event_outbox']
        .map((x) => [x, t.domain.db.prepare(`SELECT COUNT(*) AS n FROM ${x}`).get().n]));

    test('a dry run reports everything and keeps nothing', async () => {
        const before = snapshotCounts();
        const r = await doImport({ dryRun: true });
        assert.strictEqual(r.dry_run, true);
        assert.strictEqual(r.counts.plans.created, 2);
        assert.deepStrictEqual(snapshotCounts(), before);
    });

    let first;
    test('the first run imports the offering, files Billing memberships and reconciles every Live row', async () => {
        first = await doImport();
        assert.strictEqual(first.ok, true, JSON.stringify(first.billing_errors));
        assert.strictEqual(first.live_offering.sub_price_usd, '4.99');
        assert.deepStrictEqual(first.counts.live, { users: 6, creators: 4, subscriptions: 3 });
        assert.deepStrictEqual(first.counts.creators, { imported: 3, unchanged: 0, held: 1, released: 0 });
        assert.deepStrictEqual(first.counts.plans, { created: 2, linked: 1, unchanged: 0 });
        assert.deepStrictEqual(first.counts.memberships, { imported: 2, unchanged: 0, excluded: 1 });
        assert.deepStrictEqual(first.counts.live_subscriptions, { linked: 3, held: 0, unchanged: 0 });
        assert.ok(first.holds.some((h) => h.live_user === 4));

        const perk = t.domain.perks.byKey('network', 'subscriber-badge');
        assert.deepStrictEqual(t.domain.perks.bindingsOf(perk.id).map((b) => `${b.product}:${b.binding}`).sort(), ['chat:badge', 'live:ai_context', 'live:chat_badge', 'live:powerchat_overlay']);
        const jog = t.domain.creators.bySubject(S[1]);
        assert.strictEqual(jog.username, 'japaneseoldguy');
        assert.strictEqual(jog.display_name, 'Japanese Old Guy');
        const plan = t.domain.plans.purchasable(jog.id);
        assert.strictEqual(plan.slug, 'channel-subscription');
        assert.strictEqual(plan.latest_version, 1);
        assert.deepStrictEqual(t.domain.plans.versionPerks(plan.current_version_id).map((p) => p.perk_key), ['subscriber-badge']);
        const terms = JSON.parse(t.domain.plans.version(plan.current_version_id).terms);
        assert.strictEqual(terms.price, 'set and charged by OpenVibe.Billing');
        assert.doesNotMatch(JSON.stringify(terms), /\bfree\b|\$0|no ads/i);

        const m = t.domain.memberships.get(S[2], jog.id);
        assert.strictEqual(m.origin, 'import');
        assert.strictEqual(m.plan_version_id, plan.current_version_id);
        assert.strictEqual(t.domain.memberships.get(S[3], jog.id), null, 'an expired Billing subscription is not a membership');
        assert.strictEqual(t.domain.plans.purchasable(t.domain.creators.bySubject(S[6]).id).id, own.id, 'the creator\'s own plan is linked, not replaced');
        const e = await t.call('GET', `/api/v1/entitlements/check?creator=${S[1]}&mode=projection`, { user: { subject: S[2], username: 'viewer1' } });
        assert.strictEqual(e.json.status, 'active');

        const maps = t.domain.db.prepare("SELECT status, COUNT(*) AS n FROM vip_migration_maps WHERE source = 'live' AND source_table = 'subscriptions' GROUP BY status").all();
        assert.deepStrictEqual(maps, [{ status: 'linked', n: 3 }]);
        const expiredRow = t.domain.db.prepare("SELECT * FROM vip_migration_maps WHERE source = 'live' AND source_table = 'subscriptions' AND source_id = '2'").get();
        assert.strictEqual(expiredRow.target_type, 'billing_subscription');
        assert.strictEqual(t.outboxEvents('vip.plan.published').length, 3);
    });

    test('a second run changes nothing', async () => {
        const before = snapshotCounts();
        const again = await doImport();
        assert.deepStrictEqual(snapshotCounts(), before);
        assert.deepStrictEqual(again.counts.plans, { created: 0, linked: 0, unchanged: 3 });
        assert.deepStrictEqual(again.counts.memberships, { imported: 0, unchanged: 3, excluded: 0 });
        assert.deepStrictEqual(again.counts.live_subscriptions, { linked: 0, held: 0, unchanged: 3 });
        assert.strictEqual(again.counts.creators.held, 1);
    });

    test('a creator\'s edits after the import are never overwritten', async () => {
        const jog = t.domain.creators.bySubject(S[1]);
        const plan = t.domain.plans.purchasable(jog.id);
        t.domain.plans.update(plan.id, { name: 'Japanese Old Guy club', actor: S[1] });
        await doImport();
        assert.strictEqual(t.domain.plans.latestVersion(plan.id).version, 2);
        assert.strictEqual(t.domain.plans.latestVersion(plan.id).name, 'Japanese Old Guy club');
    });

    test('a held creator is released once the Network knows them', async () => {
        S[4] = t.network.mapLive(4, 'newstreamer');
        const r = await doImport();
        assert.strictEqual(r.counts.creators.released, 1);
        assert.strictEqual(r.counts.creators.held, 0);
        assert.strictEqual(r.counts.plans.created, 1);
        assert.strictEqual(t.domain.db.prepare("SELECT status FROM vip_migration_maps WHERE source = 'live' AND source_table = 'users' AND source_id = '4'").get().status, 'imported');
    });

    test('Billing unreachable: the run says so, holds what it could not reconcile and never invents memberships', async () => {
        const x = t.network.mapLive(7, 'late');
        const db2 = new Database(snap.file);
        db2.exec("INSERT INTO users VALUES (7, 'late', NULL, 'streamer'); INSERT INTO subscriptions VALUES (4, 2, 7, 1, 1, '2026-09-20 10:00:00', NULL, 'active', '2026-10-20 10:00:00', 'bucks');");
        db2.close();
        t.billing.pay(S[2], x);
        t.billing.state.down = true;
        let r;
        try { r = await doImport(); } finally { t.billing.state.down = false; }
        assert.strictEqual(r.ok, false);
        assert.ok(r.billing_errors.length >= 1);
        assert.strictEqual(t.domain.memberships.get(S[2], t.domain.creators.bySubject(x).id), null);
        const row = t.domain.db.prepare("SELECT * FROM vip_migration_maps WHERE source = 'live' AND source_table = 'subscriptions' AND source_id = '4'").get();
        assert.strictEqual(row.status, 'held');
        assert.match(row.reason, /Billing was not reachable/);
        const r2 = await doImport();
        assert.strictEqual(r2.ok, true);
        assert.strictEqual(t.domain.db.prepare("SELECT status FROM vip_migration_maps WHERE source = 'live' AND source_table = 'subscriptions' AND source_id = '4'").get().status, 'linked');
        assert.ok(t.domain.memberships.get(S[2], t.domain.creators.bySubject(x).id));
    });

    await run().finally(() => { live.close(); fs.rmSync(snap.dir, { recursive: true, force: true }); return t.close(); });
})();
