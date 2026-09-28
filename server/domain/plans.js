'use strict';

/**
 * vip_plans, vip_plan_versions, vip_plan_perks.
 *
 * Plans are versioned. Terms (name, description, benefits, perks, the Billing product) live in
 * immutable vip_plan_versions rows; an edit ALWAYS creates version N+1 and never touches an earlier
 * row (SQLite triggers refuse it). A published plan's edit is published at once and becomes what new
 * members buy; members who joined earlier keep the version they bought (vip_memberships).
 *
 * Prices are not plan terms here: Billing prices and charges a subscription, and records what each
 * period cost. A plan says which Billing product it is sold as (billing_kind), and Billing sells one
 * channel subscription per (member, creator) today, so a creator has at most one published plan
 * bound to it. A plan with no Billing product (a network plan today) can be published as terms, but
 * has no checkout until Billing sells it.
 */
const crypto = require('crypto');
const { fail, prefixedId, iso, text, slug, slugify, json } = require('../util');

const BILLING_KINDS = ['channel_subscription'];

function createPlans({ db, now, outbox, creators, perks }) {
    const byId = async (id) => await db.prepare('SELECT * FROM vip_plans WHERE id = ?').get(id) || null;
    const version = async (id) => await db.prepare('SELECT * FROM vip_plan_versions WHERE id = ?').get(id) || null;
    const latestVersion = async (planId) => await db.prepare('SELECT * FROM vip_plan_versions WHERE plan_id = ? ORDER BY version DESC LIMIT 1').get(planId) || null;
    const versions = async (planId) => await db.prepare('SELECT * FROM vip_plan_versions WHERE plan_id = ? ORDER BY version DESC').all(planId);
    const versionPerks = async (versionId) => await db.prepare('SELECT * FROM vip_plan_perks WHERE plan_version_id = ? ORDER BY position').all(versionId);

    function cleanBenefits(v) {
        if (v == null) return null;
        const arr = Array.isArray(v) ? v : String(v).split('\n');
        const out = arr.map((b) => text(b, 'benefit', 200)).filter(Boolean);
        if (out.length > 20) fail(422, 'vip.invalid_input', 'at most 20 benefits');
        return out;
    }

    /** Insert version N+1 of a plan from complete terms. Inside a transaction. */
    async function insertVersion(plan, { name, description, benefits, perkRows, changeNote, actor, publish }) {
        const n = plan.latest_version + 1;
        const at = iso(now());
        const id = prefixedId('vpv', now());
        const perkSnap = perkRows.map((p) => ({ key: p.key, name: p.name, kind: p.kind, scope: p.creator_id === 'network' ? 'network' : 'creator' }));
        const terms = { name, description, benefits, perks: perkSnap, billing_kind: plan.billing_kind, price: plan.billing_kind ? 'set and charged by OpenVibe.Billing' : null };
        terms.digest = crypto.createHash('sha256').update(JSON.stringify([terms.name, terms.description, terms.benefits, terms.perks, terms.billing_kind])).digest('hex').slice(0, 16);
        await db.prepare(`INSERT INTO vip_plan_versions (id, plan_id, version, name, description, benefits, terms, change_note, created_by, created_at, published_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, plan.id, n, name, description, JSON.stringify(benefits), JSON.stringify(terms), changeNote || null, actor, at, publish ? at : null);
        const ins = db.prepare('INSERT INTO vip_plan_perks (plan_version_id, perk_id, perk_key, perk_name, position) VALUES (?, ?, ?, ?, ?)');
        for (const [i, p] of perkRows.entries()) await ins.run(id, p.id, p.key, p.name, i);
        await db.prepare(`UPDATE vip_plans SET latest_version = ?, current_version_id = CASE WHEN ? THEN ? ELSE current_version_id END, updated_at = ? WHERE id = ?`)
            .run(n, publish ? 1 : 0, id, at, plan.id);
        return await version(id);
    }

    async function emitPublished(plan, v, traceparent) {
        const creator = await creators.byId(plan.creator_id);
        outbox.emit('vip.plan.published', { type: 'plan', id: plan.id, revision: v.version }, {
            plan_id: plan.id, slug: plan.slug, version: v.version, version_id: v.id,
            creator: creators.present(creator), billing_kind: plan.billing_kind,
            terms: json(v.terms, {}), published_at: v.published_at,
        }, { visibility: 'public', traceparent });
    }

    function publishConflict(e) {
        // PostgreSQL unique_violation (23505) on the one-published-plan-per-billing-kind index of vip_plans.
        if (e && e.code === '23505' && e.table === 'vip_plans' && /\(creator_id, billing_kind\)/.test(e.detail || '')) {
            fail(409, 'vip.plan.billing_product_taken', 'this creator already has a published plan sold as a channel subscription; Billing sells one per member and creator today, so archive the other plan first');
        }
        throw e;
    }

    async function create({ creatorId, slug: s, name, description, benefits, perks: perkRefs, billingKind, publish = false, changeNote, actor = null, traceparent }) {
        const creator = await creators.byId(creatorId);
        if (!creator) fail(404, 'vip.creator_not_found', `no creator ${creatorId}`);
        const kind = billingKind === undefined ? (creator.kind === 'network' ? null : 'channel_subscription') : (billingKind || null);
        if (kind && !BILLING_KINDS.includes(kind)) fail(422, 'vip.invalid_input', `billing_kind must be one of ${BILLING_KINDS.join(', ')} or null`);
        if (kind && creator.kind === 'network') fail(422, 'vip.invalid_input', 'Billing has no network membership product yet; a network plan has billing_kind null');
        const cleanName = text(name, 'name', 80, { required: true });
        const planSlug = s ? slug(s) : slugify(cleanName);
        if (await db.prepare('SELECT 1 FROM vip_plans WHERE creator_id = ? AND slug = ?').get(creatorId, planSlug)) fail(409, 'vip.plan_exists', `a plan ${planSlug} already exists`);
        const perkRows = await perks.resolveForPlan(creatorId, perkRefs || []);
        const at = iso(now());
        const id = prefixedId('vpl', now());
        try {
            return await db.tx(async () => {
                await db.prepare(`INSERT INTO vip_plans (id, creator_id, slug, status, billing_kind, current_version_id, latest_version, created_by, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)`).run(id, creatorId, planSlug, publish ? 'published' : 'draft', kind, actor, at, at);
                const v = await insertVersion(await byId(id), {
                    name: cleanName, description: text(description, 'description', 2000), benefits: cleanBenefits(benefits) || [],
                    perkRows, changeNote: changeNote || 'created', actor, publish,
                });
                if (publish) await emitPublished(await byId(id), v, traceparent);
                return await byId(id);
            });
        } catch (e) { return publishConflict(e); }
    }

    /** An edit: version N+1 from the latest terms plus the changes. Published plans publish it. */
    async function update(planId, { name, description, benefits, perks: perkRefs, changeNote, actor = null, traceparent }) {
        const plan = await byId(planId);
        if (!plan) fail(404, 'vip.plan_not_found', `no plan ${planId}`);
        if (plan.status === 'archived') fail(409, 'vip.plan_archived', 'an archived plan cannot be edited');
        const last = await latestVersion(planId);
        const next = {
            name: name !== undefined ? text(name, 'name', 80, { required: true }) : last.name,
            description: description !== undefined ? text(description, 'description', 2000) : last.description,
            benefits: benefits !== undefined ? cleanBenefits(benefits) : json(last.benefits, []),
        };
        const perkRows = perkRefs !== undefined ? await perks.resolveForPlan(plan.creator_id, perkRefs) : (await Promise.all((await versionPerks(last.id)).map(async (pp) => await perks.byId(pp.perk_id)))).filter((p) => p && p.status === 'active');
        const same = next.name === last.name && next.description === last.description && JSON.stringify(next.benefits) === last.benefits
            && JSON.stringify(perkRows.map((p) => p.id)) === JSON.stringify((await versionPerks(last.id)).map((pp) => pp.perk_id));
        if (same) return { plan, version: last, unchanged: true };
        const publish = plan.status === 'published';
        return await db.tx(async () => {
            const v = await insertVersion(plan, { ...next, perkRows, changeNote: text(changeNote, 'change_note', 300), actor, publish });
            if (publish) await emitPublished(await byId(planId), v, traceparent);
            return { plan: await byId(planId), version: v, unchanged: false };
        });
    }

    async function publish(planId, { traceparent } = {}) {
        const plan = await byId(planId);
        if (!plan) fail(404, 'vip.plan_not_found', `no plan ${planId}`);
        if (plan.status === 'published') return { plan, replay: true };
        if (plan.status === 'archived') fail(409, 'vip.plan_archived', 'an archived plan cannot be published again; create a new plan');
        try {
            return await db.tx(async () => {
                const v = await latestVersion(planId);
                const at = iso(now());
                await db.prepare('UPDATE vip_plan_versions SET published_at = ? WHERE id = ? AND published_at IS NULL').run(at, v.id);
                await db.prepare("UPDATE vip_plans SET status = 'published', current_version_id = ?, updated_at = ? WHERE id = ?").run(v.id, at, planId);
                await emitPublished(await byId(planId), await version(v.id), traceparent);
                return { plan: await byId(planId), replay: false };
            });
        } catch (e) { return publishConflict(e); }
    }

    /** No new members; existing members keep their terms until Billing ends their membership. */
    async function archive(planId) {
        const plan = await byId(planId);
        if (!plan) fail(404, 'vip.plan_not_found', `no plan ${planId}`);
        if (plan.status === 'archived') return plan;
        const at = iso(now());
        await db.prepare("UPDATE vip_plans SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").run(at, at, planId);
        return await byId(planId);
    }

    async function list({ creatorId, includeDrafts = false, includeArchived = false }) {
        const st = ['published'];
        if (includeDrafts) st.push('draft');
        if (includeArchived) st.push('archived');
        return await db.prepare(`SELECT * FROM vip_plans WHERE creator_id = ? AND status IN (${st.map(() => '?').join(',')}) ORDER BY sort, created_at`).all(creatorId, ...st);
    }

    /** What a new member of this creator buys through Billing's product `kind`. */
    const purchasable = async (creatorId, kind = 'channel_subscription') => await db.prepare("SELECT * FROM vip_plans WHERE creator_id = ? AND billing_kind = ? AND status = 'published'").get(creatorId, kind) || null;

    async function presentVersion(v) {
        if (!v) return null;
        return {
            id: v.id, version: v.version, name: v.name, description: v.description || null, benefits: json(v.benefits, []),
            perks: (await versionPerks(v.id)).map((p) => ({ id: p.perk_id, key: p.perk_key, name: p.perk_name })),
            terms: json(v.terms, {}), change_note: v.change_note || null, created_at: v.created_at, published_at: v.published_at || null,
        };
    }

    async function present(plan, { withVersions = false } = {}) {
        if (!plan) return null;
        const current = plan.current_version_id ? await version(plan.current_version_id) : null;
        const latest = await latestVersion(plan.id);
        return {
            id: plan.id, creator_id: plan.creator_id, slug: plan.slug, status: plan.status, billing_kind: plan.billing_kind,
            purchasable: plan.status === 'published' && !!plan.billing_kind,
            current_version: await presentVersion(current),
            draft_version: latest && (!current || latest.version > current.version) ? await presentVersion(latest) : null,
            versions: withVersions ? (await Promise.all((await versions(plan.id)).map(presentVersion))) : undefined,
            created_at: plan.created_at, updated_at: plan.updated_at, archived_at: plan.archived_at || null,
        };
    }

    return { byId, version, latestVersion, versions, versionPerks, create, update, publish, archive, list, purchasable, present, presentVersion, BILLING_KINDS };
}

module.exports = { createPlans };
