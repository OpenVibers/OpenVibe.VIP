'use strict';

/**
 * vip_gated_resource_rules: "resource R of product P is for members of creator C" — optionally for
 * members of one plan, or for members whose plan VERSION includes perk K. A product stores the
 * resource; VIP stores only the typed reference (EntityRef) and the rule.
 *
 * A rule belongs to one creator, and several creators may each hold a rule for the same reference:
 * VIP cannot tell who owns a product's resource, so the PRODUCT names the owner when it asks
 * (evaluate's `owner`) and only that creator's rule applies. Otherwise anyone could claim a
 * reference first — blocking the real owner (409) and gating it to their own members.
 *
 * evaluate() FAILS CLOSED: no owner, no rule, a disabled rule, a suspended creator, an entitlement Billing
 * cannot confirm ("unknown"), a missing perk or any error → allow: false with the reason. Rules
 * marked sensitive always ask Billing directly (never the projection).
 */
const { fail, prefixedId, iso, entityRef, isUserSubject, text } = require('../util');

function createPolicies({ db, now, creators, plans, perks, memberships, entitlements }) {
    const byId = (id) => db.prepare('SELECT * FROM vip_gated_resource_rules WHERE id = ?').get(id) || null;
    const forResource = (r, creatorId) => db.prepare(`SELECT * FROM vip_gated_resource_rules WHERE resource_service = ? AND resource_type = ? AND resource_id = ? AND creator_id = ? AND status = 'active'`)
        .get(r.service, r.type, r.id, creatorId) || null;
    /** The creator a product names as a resource's owner: SubjectRef, usr_ id, or 'network'. */
    function ownerCreator(owner) {
        if (owner === 'network') return creators.network();
        const s = owner && typeof owner === 'object' ? owner.id : owner;
        return isUserSubject(String(s || '')) ? creators.bySubject(String(s)) : null;
    }

    /** Create or replace the active rule for a resource. */
    function set({ creatorId, resource, requirement = 'member', planId = null, perkKey = null, sensitive = false, actor = null }) {
        const creator = creators.byId(creatorId);
        if (!creator || creator.kind !== 'creator') fail(404, 'vip.creator_not_found', 'gated resources belong to a creator');
        const r = entityRef(resource);
        if (!['member', 'plan', 'perk'].includes(requirement)) fail(422, 'vip.invalid_input', 'requirement must be member, plan or perk');
        if (requirement === 'plan') {
            const p = plans.byId(String(planId || ''));
            if (!p || p.creator_id !== creatorId) fail(422, 'vip.plan_not_found', 'plan_id must be one of this creator\'s plans');
        } else planId = null;
        if (requirement === 'perk') {
            perkKey = text(perkKey, 'perk_key', 48, { required: true });
            if (!perks.byKey(creatorId, perkKey) && !perks.byKey('network', perkKey)) fail(422, 'vip.perk_not_found', `no perk ${perkKey} for this creator`);
        } else perkKey = null;
        const existing = forResource(r, creatorId);
        const at = iso(now());
        const id = prefixedId('vgr', now());
        db.transaction(() => {
            if (existing) db.prepare("UPDATE vip_gated_resource_rules SET status = 'disabled', updated_at = ? WHERE id = ?").run(at, existing.id);
            db.prepare(`INSERT INTO vip_gated_resource_rules (id, creator_id, resource_service, resource_type, resource_id, requirement, plan_id, perk_key, sensitive, status, created_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`).run(id, creatorId, r.service, r.type, r.id, requirement, planId, perkKey, sensitive ? 1 : 0, actor, at, at);
        })();
        return byId(id);
    }

    function disable(id) {
        const rule = byId(id);
        if (!rule) fail(404, 'vip.rule_not_found', `no rule ${id}`);
        db.prepare("UPDATE vip_gated_resource_rules SET status = 'disabled', updated_at = ? WHERE id = ?").run(iso(now()), id);
        return byId(id);
    }

    const list = (creatorId) => db.prepare("SELECT * FROM vip_gated_resource_rules WHERE creator_id = ? AND status = 'active' ORDER BY created_at DESC").all(creatorId);

    function present(rule) {
        if (!rule) return null;
        const c = creators.byId(rule.creator_id);
        return {
            id: rule.id, creator: c && c.subject ? { type: 'user', id: c.subject } : null, creator_id: rule.creator_id,
            resource: { service: rule.resource_service, type: rule.resource_type, id: rule.resource_id },
            requirement: rule.requirement, plan_id: rule.plan_id || null, perk_key: rule.perk_key || null,
            sensitive: !!rule.sensitive, status: rule.status, updated_at: rule.updated_at,
        };
    }

    const deny = (reason, extra = {}) => ({ allow: false, reason, ...extra });

    /**
     * May `subject` see `resource`, owned (says the product) by creator `owner`? { allow, reason, rule,
     * entitlement }. `ruleId` pins the rule the product believes applies (a mismatch denies).
     * mode: 'auto' (default) or 'authoritative'.
     */
    async function evaluate({ subject, resource, owner = null, ruleId = null, mode = 'auto', traceparent }) {
        let r;
        try { r = entityRef(resource); } catch { return deny('invalid_resource'); }
        if (!owner) return deny('owner_required');
        const oc = ownerCreator(owner);
        if (!oc) return deny('no_rule');
        const rule = ruleId ? byId(String(ruleId)) : forResource(r, oc.id);
        if (!rule) return deny('no_rule');
        if (ruleId && (rule.resource_service !== r.service || rule.resource_type !== r.type || rule.resource_id !== r.id)) return deny('rule_mismatch', { rule: present(rule) });
        if (rule.creator_id !== oc.id) return deny('owner_mismatch', { rule: present(rule) });
        if (rule.status !== 'active') return deny('rule_disabled', { rule: present(rule) });
        const creator = creators.byId(rule.creator_id);
        if (!creator || creator.status !== 'active' || !creator.subject) return deny('creator_unavailable', { rule: present(rule) });
        if (!subject) return deny('not_signed_in', { rule: present(rule) });
        if (!isUserSubject(subject)) return deny('not_a_member', { rule: present(rule) });
        // The creator always sees their own gated resources.
        if (subject === creator.subject) return { allow: true, reason: 'owner', rule: present(rule), entitlement: null };
        let ent;
        try {
            ent = await entitlements.check(subject, creator.subject, { mode: rule.sensitive ? 'authoritative' : (mode === 'authoritative' ? 'authoritative' : 'auto'), traceparent });
        } catch { return deny('entitlement_unknown', { rule: present(rule) }); }
        if (ent.status === 'unknown') return deny('entitlement_unknown', { rule: present(rule), entitlement: ent });
        if (!ent.active) return deny('not_a_member', { rule: present(rule), entitlement: ent });
        const m = memberships.get(subject, creator.id);
        if (rule.requirement === 'plan' && (!m || m.plan_id !== rule.plan_id)) return deny('plan_required', { rule: present(rule), entitlement: ent });
        if (rule.requirement === 'perk' && !memberships.perkKeys(m).includes(rule.perk_key)) return deny('perk_missing', { rule: present(rule), entitlement: ent });
        return { allow: true, reason: 'member', rule: present(rule), entitlement: ent };
    }

    return { byId, forResource, ownerCreator, set, disable, list, present, evaluate };
}

module.exports = { createPolicies };
