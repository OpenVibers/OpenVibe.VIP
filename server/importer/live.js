'use strict';

/**
 * Import OpenVibe.Live's subscription OFFERING into VIP, from a SNAPSHOT COPY of Live's database
 * (opened read-only). Memberships come from OpenVibe.Billing's entitlements (Billing already
 * imported Live's subscriptions, ADR-012), never from Live's rows.
 *
 * What Live offers today: every channel can be subscribed to, monthly, at the site-wide price in
 * site_settings (sub_price_usd, now Billing's rate), and a subscriber gets a star "Subscriber" badge
 * (Live chat, the PowerChat overlay relay, the stream AI's context flag). So:
 *
 *   1. perk      one network perk `subscriber-badge` with product bindings for those three places
 *                and OpenVibe.Chat's badge
 *   2. creators  every Live user who is a streamer (role streamer / global_mod / admin) or has ever
 *                been subscribed to → a VIP creator for their Network subject (resolve-batch). A Live
 *                user with no subject yet is HELD (vip_migration_maps), never dropped; a later run
 *                picks it up
 *   3. plans     per creator, plan `channel-subscription` v1 "Channel subscription" (published, sold
 *                as Billing's channel_subscription) with the badge perk — unless the creator already
 *                has a published plan sold that way (then that plan is linked, nothing is created)
 *   4. members   per creator, Billing's subscriptions (billing.entitlement.check): each ACTIVE one
 *                becomes a VIP membership under the plan version above and a projection row from
 *                Billing's entitlement; inactive ones are recorded excluded with the reason
 *   5. live rows every row of Live's `subscriptions` table is reconciled: linked to the VIP
 *                membership / Billing subscription for the same pair, or held with the reason
 *
 * Idempotent: every source row is keyed in vip_migration_maps; a re-run creates nothing twice,
 * never edits a plan a creator has changed since, and releases what was held when it can.
 * --dry-run does everything inside a transaction that is rolled back.
 */
const { iso } = require('../util');

const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const columns = (db, t) => (tableExists(db, t) ? db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name) : []);
const CREATOR_ROLES = ['streamer', 'global_mod', 'admin'];
const PLAN_SLUG = 'channel-subscription';
const PERK_KEY = 'subscriber-badge';
const ACTOR = 'svc:vip-import';

class DryRun extends Error {}

/** Billing through its API (VIP's service token, billing.entitlement.check). */
function billingApiSource(billing) {
    return {
        name: 'billing api',
        listSubscriptions: async (creator) => ((await billing.listSubscriptions({ streamer: creator })).subscriptions || []),
        entitlement: (member, creator) => billing.entitlement(member, creator),
    };
}

/** Billing from a read-only SNAPSHOT of billing.db (operator tool, for dry runs without a token). */
function billingSnapshotSource(bdb, { now = () => Date.now() } = {}) {
    const subs = bdb.prepare('SELECT * FROM subscriptions WHERE streamer = ? ORDER BY created_at');
    return {
        name: 'billing snapshot',
        listSubscriptions: async (creator) => subs.all(creator).map((s) => ({
            id: s.id, subscriber: { type: 'user', id: s.subscriber }, streamer: { type: 'user', id: s.streamer }, status: s.status,
            auto_renew: !!s.auto_renew, cancel_at_period_end: !!s.cancel_at_period_end, current_period_end: s.current_period_end, legacy_live_id: s.legacy_live_id ?? null,
        })),
        entitlement: async (member, creator) => {
            const at = iso(now());
            const rows = bdb.prepare(`SELECT starts_at, ends_at FROM entitlements WHERE subject = ? AND kind = 'channel_subscription' AND scope = ?
                AND revoked_at IS NULL AND ends_at > ? ORDER BY starts_at`).all(member, creator, at);
            const active = rows.some((r) => r.starts_at <= at);
            const sub = bdb.prepare('SELECT * FROM subscriptions WHERE subscriber = ? AND streamer = ?').get(member, creator);
            return {
                active, expires_at: active ? rows.reduce((m, r) => (r.ends_at > m ? r.ends_at : m), '') : null,
                subscription: sub ? { id: sub.id, status: sub.status, auto_renew: !!sub.auto_renew, cancel_at_period_end: !!sub.cancel_at_period_end } : null,
            };
        },
    };
}

async function importLive(domain, { live, billingSource, resolveLiveUsers, dryRun = false, log = console }) {
    const { db, creators, perks, plans, entitlements } = domain;
    const started = domain.now();
    const runId = `vimp_${started}`;
    const at = iso(started);
    const report = {
        run_id: runId, dry_run: !!dryRun, started_at: at, source: 'openvibe-live snapshot', billing_source: billingSource ? billingSource.name : null,
        live_offering: null,
        counts: {
            creators: { imported: 0, unchanged: 0, held: 0, released: 0 }, plans: { created: 0, linked: 0, unchanged: 0 },
            memberships: { imported: 0, unchanged: 0, excluded: 0 }, live_subscriptions: { linked: 0, held: 0, unchanged: 0 },
        },
        holds: [], excluded: [], billing_errors: [],
    };

    // ── Read the snapshot ────────────────────────────────────
    const hasUsers = tableExists(live, 'users');
    const userCols = columns(live, 'users');
    const users = hasUsers ? live.prepare(`SELECT id, username, display_name${userCols.includes('role') ? ', role' : ", 'user' AS role"} FROM users`).all() : [];
    const byLiveId = new Map(users.map((u) => [String(u.id), u]));
    const subCols = columns(live, 'subscriptions');
    const liveSubs = subCols.length ? live.prepare('SELECT * FROM subscriptions ORDER BY id').all() : [];
    if (tableExists(live, 'site_settings')) {
        const get = (k) => { const r = live.prepare('SELECT value FROM site_settings WHERE key = ?').get(k); return r ? r.value : null; };
        report.live_offering = {
            sub_price_usd: get('sub_price_usd'), sub_streamer_share_pct: get('sub_streamer_share_pct'), sub_site_route_fee_pct: get('sub_site_route_fee_pct'),
            note: 'recorded for reference only: OpenVibe.Billing prices and charges subscriptions; VIP plan terms carry no price',
        };
    }
    const creatorIds = new Set(users.filter((u) => CREATOR_ROLES.includes(u.role)).map((u) => String(u.id)));
    for (const s of liveSubs) if (s.streamer_id != null) creatorIds.add(String(s.streamer_id));
    const allIds = new Set(creatorIds);
    for (const s of liveSubs) if (s.subscriber_id != null) allIds.add(String(s.subscriber_id));
    report.counts.live = { users: users.length, creators: creatorIds.size, subscriptions: liveSubs.length };

    // ── Identities ───────────────────────────────────────────
    const map = allIds.size ? await resolveLiveUsers([...allIds]) : new Map();
    const subjectOf = (id) => { const v = id == null ? null : map.get(String(id)); return v ? (typeof v === 'string' ? v : v.subject) : null; };
    const handleOf = (id) => { const v = map.get(String(id)); const u = byLiveId.get(String(id)); return (v && typeof v === 'object' && v.username) || (u && u.username) || null; };

    // ── Billing (async, before the transaction) ──────────────
    const billingSubs = new Map();   // creator subject → [subscription]
    const ents = new Map();          // `${member}:${creator}` → entitlement
    for (const id of creatorIds) {
        const s = subjectOf(id);
        if (!s || billingSubs.has(s)) continue;
        if (!billingSource) { billingSubs.set(s, null); continue; }
        try {
            const list = await billingSource.listSubscriptions(s);
            billingSubs.set(s, list);
            for (const sub of list) {
                if (sub.status !== 'active') continue;
                ents.set(`${sub.subscriber.id}:${s}`, await billingSource.entitlement(sub.subscriber.id, s));
            }
        } catch (e) {
            billingSubs.set(s, null);
            report.billing_errors.push({ creator: s, error: e.message });
        }
    }

    const mapRow = db.prepare('SELECT * FROM vip_migration_maps WHERE source = ? AND source_table = ? AND source_id = ?');
    const upsertMap = db.prepare(`INSERT INTO vip_migration_maps (source, source_table, source_id, target_type, target_id, status, reason, run_id, created_at, updated_at)
        VALUES (@source, @table, @id, @target_type, @target_id, @status, @reason, @run, @at, @at)
        ON CONFLICT (source, source_table, source_id) DO UPDATE SET target_type = excluded.target_type, target_id = excluded.target_id, status = excluded.status,
            reason = excluded.reason, run_id = excluded.run_id, updated_at = excluded.updated_at`);
    const record = (source, table, id, fields) => upsertMap.run({ source, table, id: String(id), target_type: null, target_id: null, reason: null, run: runId, at, ...fields });

    const run = () => {
        // ── 1. The network perk ──────────────────────────────
        let perk = perks.byKey('network', PERK_KEY);
        if (!perk) {
            perk = perks.create({
                creatorId: 'network', key: PERK_KEY, name: 'Subscriber badge', kind: 'badge', actor: ACTOR,
                description: 'A star badge next to your name in the creator\'s chat, as channel subscribers had on OpenVibe.Live.',
                bindings: [
                    { product: 'live', binding: 'chat_badge', config: { badge: 'subscriber' } },
                    { product: 'live', binding: 'powerchat_overlay', config: { is_subscriber: true } },
                    { product: 'live', binding: 'ai_context', config: { flag: 'subscriber' } },
                    { product: 'chat', binding: 'badge', config: { badge: 'subscriber' } },
                ],
            });
            record('live', 'offering', 'subscriber_badge', { target_type: 'perk', target_id: perk.id, status: 'imported' });
        }

        // ── 2 + 3. Creators and their plan ───────────────────
        for (const id of [...creatorIds].sort((a, b) => Number(a) - Number(b))) {
            const prev = mapRow.get('live', 'users', id);
            const subject = subjectOf(id);
            const u = byLiveId.get(id);
            if (!subject) {
                const reason = `Live user ${id}${u ? ` (${u.username})` : ''} has no Network subject yet`;
                record('live', 'users', id, { status: 'held', reason });
                report.counts.creators.held++; report.holds.push({ live_user: Number(id), reason });
                continue;
            }
            const existed = creators.bySubject(subject);
            const c = creators.ensure({ subject, username: handleOf(id), displayName: u ? u.display_name : null, origin: existed ? existed.origin : 'import' });
            if (prev && prev.status !== 'held') report.counts.creators.unchanged++;
            else { report.counts.creators[prev ? 'released' : 'imported']++; }
            record('live', 'users', id, { target_type: 'creator', target_id: c.id, status: 'imported', reason: prev && prev.status === 'held' ? 'released from hold' : null });

            const offer = mapRow.get('live', 'offering', `channel_subscription:${id}`);
            if (offer && offer.target_id && plans.byId(offer.target_id)) { report.counts.plans.unchanged++; continue; }
            const own = plans.purchasable(c.id);
            if (own) {
                record('live', 'offering', `channel_subscription:${id}`, { target_type: 'plan', target_id: own.id, status: 'linked', reason: 'the creator already publishes a plan sold as the channel subscription' });
                report.counts.plans.linked++;
                continue;
            }
            const existingSlug = db.prepare('SELECT * FROM vip_plans WHERE creator_id = ? AND slug = ?').get(c.id, PLAN_SLUG);
            if (existingSlug) {
                record('live', 'offering', `channel_subscription:${id}`, { target_type: 'plan', target_id: existingSlug.id, status: 'linked', reason: `plan ${PLAN_SLUG} already exists (status ${existingSlug.status})` });
                report.counts.plans.linked++;
                continue;
            }
            const name = c.display_name || c.username || 'this creator';
            const plan = plans.create({
                creatorId: c.id, slug: PLAN_SLUG, name: 'Channel subscription',
                description: `A monthly subscription to ${name}'s channel, carried over from OpenVibe.Live.`,
                benefits: [`A subscriber badge next to your name in ${name}'s chat`],
                perks: [PERK_KEY], billingKind: 'channel_subscription', publish: true, changeNote: 'imported from OpenVibe.Live', actor: ACTOR,
            });
            record('live', 'offering', `channel_subscription:${id}`, { target_type: 'plan', target_id: plan.id, status: 'imported' });
            report.counts.plans.created++;
        }

        // ── 4. Memberships from Billing ──────────────────────
        for (const [creatorSubject, list] of billingSubs) {
            if (!list) continue;
            for (const sub of list) {
                const member = sub.subscriber && sub.subscriber.id;
                const prev = mapRow.get('billing', 'subscriptions', sub.id);
                if (sub.status !== 'active') {
                    if (!prev) {
                        const reason = `Billing subscription is ${sub.status}: no current membership to file terms for`;
                        record('billing', 'subscriptions', sub.id, { status: 'excluded', reason });
                        report.counts.memberships.excluded++; report.excluded.push({ billing_subscription: sub.id, reason });
                    } else report.counts.memberships.unchanged++;
                    continue;
                }
                const e = ents.get(`${member}:${creatorSubject}`) || { active: false, expires_at: null };
                const out = entitlements.apply({
                    member, creator: creatorSubject, active: !!e.active, expiresAt: e.expires_at || null,
                    cancelAtPeriodEnd: !!sub.cancel_at_period_end, subscriptionId: sub.id, subscriptionStatus: sub.status,
                    reason: 'imported', source: 'import', origin: 'import', asOf: domain.now(),
                });
                const m = out.membership;
                if (!e.active || !m) {
                    const reason = 'Billing lists the subscription as active but its entitlement is not active now';
                    record('billing', 'subscriptions', sub.id, { status: 'excluded', reason });
                    report.counts.memberships.excluded++; report.excluded.push({ billing_subscription: sub.id, reason });
                    continue;
                }
                if (prev && prev.status === 'imported' && prev.target_id === m.id) report.counts.memberships.unchanged++;
                else report.counts.memberships.imported++;
                record('billing', 'subscriptions', sub.id, { target_type: 'membership', target_id: m.id, status: 'imported' });
            }
        }

        // ── 5. Live's subscriptions rows ─────────────────────
        const membershipFor = db.prepare('SELECT m.id FROM vip_memberships m JOIN vip_creators c ON c.id = m.creator_id WHERE m.member_subject = ? AND c.subject = ?');
        for (const s of liveSubs) {
            const prev = mapRow.get('live', 'subscriptions', String(s.id));
            const member = subjectOf(s.subscriber_id);
            const creator = subjectOf(s.streamer_id);
            let fields;
            if (!member || !creator) {
                fields = { status: 'held', reason: `${!member ? `subscriber (Live user ${s.subscriber_id})` : `creator (Live user ${s.streamer_id})`} has no Network subject yet` };
            } else {
                const m = membershipFor.get(member, creator);
                const bsub = (billingSubs.get(creator) || []).find((x) => x.subscriber && x.subscriber.id === member);
                if (m) fields = { status: 'linked', target_type: 'membership', target_id: m.id };
                else if (bsub) fields = { status: 'linked', target_type: 'billing_subscription', target_id: bsub.id, reason: `Billing holds it (status ${bsub.status}); no current membership` };
                else if (billingSubs.get(creator) === null) fields = { status: 'held', reason: 'Billing was not reachable for this creator in this run' };
                else fields = { status: 'held', reason: 'Billing has no subscription for this pair (run Billing\'s Live import first)' };
            }
            if (prev && prev.status === fields.status && prev.target_id === (fields.target_id || null)) { report.counts.live_subscriptions.unchanged++; continue; }
            record('live', 'subscriptions', s.id, fields);
            report.counts.live_subscriptions[fields.status === 'held' ? 'held' : 'linked']++;
            if (fields.status === 'held') report.holds.push({ live_subscription: s.id, reason: fields.reason });
        }
        if (dryRun) throw new DryRun();
    };

    try {
        db.transaction(run)();
    } catch (e) {
        if (!(e instanceof DryRun)) throw e;
    }
    report.finished_at = iso(domain.now());
    report.ok = report.billing_errors.length === 0;
    if (!billingSource) report.note = 'no Billing source: memberships were not imported';
    if (log && log.debug) log.debug(report);
    return report;
}

module.exports = { importLive, billingApiSource, billingSnapshotSource, PLAN_SLUG, PERK_KEY };
