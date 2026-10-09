'use strict';
/**
 * ADR-033: VIP's part of an account export and of an account deletion, through the signed /internal/events route with
 * a stand-in Network. A member's memberships, preferences, entitlement cache and checkouts go and their paid periods
 * stay (Billing's books); a creator's row is suspended without its name, their plans lose created_by, and the plan
 * versions members joined under stay whole. Each deletion is confirmed once.
 */
const assert = require('assert');
const http = require('http');
const { boot, harness } = require('./helpers/app');
const { createNetworkSender } = require('openvibe-sdk/account-data');

const { test, run } = harness('account-data');

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_vip', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

const envelope = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), actor: { type: 'service', id: 'network' }, subject: { type: 'account', id: payload.subject }, visibility: 'internal', payload });

(async () => {
    const stub = await startNetworkStub();
    const t = await boot({ accountSend: createNetworkSender({ networkInternalUrl: stub.url, clientId: 'vip', clientSecret: 'shh' }) });
    const db = t.domain.db;
    const count = async (sql, args) => Number(await db.value(sql, args));
    const creator = t.network.newUser('rena', { role: 'streamer' });
    const member = t.network.newUser('mona');
    const other = t.network.newUser('otto');
    let plan;
    let creatorId;

    test('a creator publishes a plan and two members pay for it', async () => {
        plan = (await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Crew', publish: true } })).json.plan;
        assert.ok(plan && plan.id);
        creatorId = await db.value('SELECT id FROM vip_creators WHERE subject = $1', [creator.subject]);
        await t.deliverAll(t.billing.pay(member.subject, creator.subject).events);
        await t.deliverAll(t.billing.pay(other.subject, creator.subject).events);
        await db.exec(`INSERT INTO vip_member_preferences (member_subject, creator_id, show_badge, listed, updated_at) VALUES ($1, $2, 1, 1, $3)
            ON CONFLICT (member_subject, creator_id) DO NOTHING`, [member.subject, creatorId, new Date().toISOString()]);
        assert.strictEqual(await count('SELECT count(*) FROM vip_membership_periods WHERE member_subject = $1', [member.subject]), 1);
        assert.strictEqual(await count('SELECT count(*) FROM vip_entitlement_projection WHERE member_subject = $1', [member.subject]), 1);
    });

    test('the member\'s export carries their memberships, entitlements and paid periods, and nobody else\'s', async () => {
        const r = await t.deliver(envelope('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX1', subject: member.subject }));
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        const part = stub.calls.find((c) => c.url === '/internal/account-exports/exp_01JZ0000000000000000000EX1/parts');
        assert.strictEqual(part.auth, 'Bearer tok_vip');
        const names = part.body.files.map((f) => f.name);
        for (const f of ['entitlements.json', 'paid-periods.json', 'preferences.json']) assert.ok(names.includes(f), `${f} in ${names}`);
        assert.ok(!JSON.stringify(part.body).includes(other.subject));
    });

    test('deleting the member removes their memberships, preferences and cache, keeps the paid period, and confirms once', async () => {
        const body = envelope('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: 'del_01JZ0000000000000000000DE1', subject: member.subject });
        assert.strictEqual((await t.deliver(body)).status, 200);
        const m = [member.subject];
        assert.strictEqual(await count('SELECT count(*) FROM vip_memberships WHERE member_subject = $1', m), 0);
        assert.strictEqual(await count('SELECT count(*) FROM vip_member_preferences WHERE member_subject = $1', m), 0);
        assert.strictEqual(await count('SELECT count(*) FROM vip_entitlement_projection WHERE member_subject = $1', m), 0);
        assert.strictEqual(await count('SELECT count(*) FROM vip_checkouts WHERE member_subject = $1', m), 0);
        assert.strictEqual(await count('SELECT count(*) FROM vip_membership_periods WHERE member_subject = $1', m), 1, 'the paid period stays for Billing\'s books');
        assert.strictEqual(await count('SELECT count(*) FROM vip_entitlement_projection WHERE member_subject = $1', [other.subject]), 1, 'otto keeps his');
        const conf = stub.calls.filter((c) => c.url === '/internal/account-deletions/del_01JZ0000000000000000000DE1/confirmations');
        assert.strictEqual(conf.length, 1);
        assert.strictEqual(conf[0].body.retained.vip_membership_periods, 1);
        assert.strictEqual(conf[0].body.erased.vip_entitlement_projection, 1);
        assert.strictEqual((await t.deliver(body)).json.outcome, 'unchanged');
    });

    test('deleting the creator suspends their row without its name, keeps the plan versions, and leaves members\' periods', async () => {
        const r = await t.deliver(envelope('evt_01JZ0000000000000000000D02', 'network.account.deleted', { deletion_id: 'del_01JZ0000000000000000000DE2', subject: creator.subject }));
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        const row = await db.maybe('SELECT * FROM vip_creators WHERE id = $1', [creatorId]);
        assert.deepStrictEqual([row.status, row.username, row.display_name, row.bio], ['suspended', null, null, null]);
        assert.strictEqual(await count('SELECT count(*) FROM vip_plans WHERE creator_id = $1 AND created_by IS NULL', [creatorId]), 1);
        assert.ok(await count('SELECT count(*) FROM vip_plan_versions WHERE plan_id = $1', [plan.id]) >= 1, 'the terms members joined under stay');
        assert.strictEqual(await count('SELECT count(*) FROM vip_membership_periods WHERE member_subject = $1', [other.subject]), 1);
        const conf = stub.calls.filter((c) => c.url === '/internal/account-deletions/del_01JZ0000000000000000000DE2/confirmations');
        assert.strictEqual(conf.length, 1);
        assert.strictEqual(conf[0].body.retained.vip_creators, 1);
    });

    try { await run(); } finally { await t.close(); await stub.close(); }
})();
