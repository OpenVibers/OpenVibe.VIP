'use strict';

/**
 * vip_memberships: VIP's record of WHICH PLAN VERSION a membership was bought under, plus member
 * preferences. Whether the membership is active is never stored here — that is Billing's
 * entitlement (projected in vip_entitlement_projection, re-checked with Billing when stale).
 *
 * Version rules (plan terms are never rewritten):
 *   - a new membership (first grant, or a grant after the previous one lapsed) takes the version of
 *     the member's own checkout hand-off when there is one, else the creator's current purchasable
 *     version (a subscription bought elsewhere, e.g. on Live before its cutover);
 *   - a renewal keeps the version the membership already has, however often the plan was edited;
 *   - a membership Billing grants for a creator with no VIP plan is recorded with no plan.
 */
const { prefixedId, iso, json } = require('../util');

const CHECKOUT_WINDOW_MS = 14 * 86_400_000;

function createMemberships({ db, now, creators, plans }) {
    const get = (member, creatorId) => db.prepare('SELECT * FROM vip_memberships WHERE member_subject = ? AND creator_id = ?').get(member, creatorId) || null;
    const byId = (id) => db.prepare('SELECT * FROM vip_memberships WHERE id = ?').get(id) || null;

    function pendingCheckout(member, creatorId) {
        const since = iso(now() - CHECKOUT_WINDOW_MS);
        return db.prepare(`SELECT * FROM vip_checkouts WHERE member_subject = ? AND creator_id = ? AND status IN ('handed_off', 'paid')
            AND created_at >= ? ORDER BY created_at DESC LIMIT 1`).get(member, creatorId, since) || null;
    }

    /** Record the version a membership is under. Inside the projection's transaction. */
    function onProjection({ prev, next, reason, origin = null, checkoutId = null }) {
        const creator = creators.bySubject(next.creator_subject) || creators.ensure({ subject: next.creator_subject, origin: 'system' });
        const member = next.member_subject;
        let m = get(member, creator.id);
        const at = iso(now());
        if (!next.active) return { membership: m, creator };
        // A membership that exists keeps its version unless this is a NEW purchase after a lapse:
        // Billing says 'granted' after we saw it inactive, or the member's own checkout settled.
        const pending = checkoutId ? null : pendingCheckout(member, creator.id);
        const lapsed = prev && !prev.active;
        const newPurchase = !!checkoutId || (lapsed && (reason === 'granted' || (reason !== 'renewed' && !!pending)));
        if (m && !newPurchase) {
            if (next.subscription_id && next.subscription_id !== m.billing_subscription_id) {
                db.prepare('UPDATE vip_memberships SET billing_subscription_id = ?, updated_at = ? WHERE id = ?').run(next.subscription_id, at, m.id);
                m = get(member, creator.id);
            }
            return { membership: m, creator };
        }
        // A new membership, or a new purchase after a lapse: which terms did the member buy?
        let planId = null;
        let versionId = null;
        let how = origin || 'billing';
        const checkout = checkoutId ? db.prepare('SELECT * FROM vip_checkouts WHERE id = ?').get(checkoutId) : pending;
        if (checkout) {
            planId = checkout.plan_id; versionId = checkout.plan_version_id; how = 'checkout';
            db.prepare("UPDATE vip_checkouts SET status = 'used', billing_subscription_id = COALESCE(billing_subscription_id, ?), updated_at = ? WHERE id = ?").run(next.subscription_id || null, at, checkout.id);
        } else {
            const plan = plans.purchasable(creator.id, next.kind === 'channel_subscription' ? 'channel_subscription' : next.kind);
            if (plan) { planId = plan.id; versionId = plan.current_version_id; }
        }
        if (m) {
            db.prepare(`UPDATE vip_memberships SET plan_id = ?, plan_version_id = ?, billing_subscription_id = COALESCE(?, billing_subscription_id), origin = ?,
                terms_since = ?, updated_at = ? WHERE id = ?`).run(planId, versionId, next.subscription_id || null, how, at, at, m.id);
        } else {
            db.prepare(`INSERT INTO vip_memberships (id, member_subject, creator_id, plan_id, plan_version_id, billing_subscription_id, origin, joined_at, terms_since, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(prefixedId('vms', now()), member, creator.id, planId, versionId, next.subscription_id || null, how, at, at, at);
        }
        return { membership: get(member, creator.id), creator };
    }

    function preferences(member, creatorId) {
        const p = db.prepare('SELECT * FROM vip_member_preferences WHERE member_subject = ? AND creator_id = ?').get(member, creatorId);
        return { show_badge: p ? !!p.show_badge : true, listed: p ? !!p.listed : false };
    }
    function setPreferences(member, creatorId, { showBadge, listed }) {
        const cur = preferences(member, creatorId);
        const sb = showBadge === undefined ? cur.show_badge : !!showBadge;
        const li = listed === undefined ? cur.listed : !!listed;
        db.prepare(`INSERT INTO vip_member_preferences (member_subject, creator_id, show_badge, listed, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (member_subject, creator_id) DO UPDATE SET show_badge = excluded.show_badge, listed = excluded.listed, updated_at = excluded.updated_at`)
            .run(member, creatorId, sb ? 1 : 0, li ? 1 : 0, iso(now()));
        return preferences(member, creatorId);
    }

    const forMember = (member) => db.prepare('SELECT * FROM vip_memberships WHERE member_subject = ? ORDER BY joined_at DESC').all(member);
    const forCreator = (creatorId) => db.prepare('SELECT * FROM vip_memberships WHERE creator_id = ? ORDER BY joined_at DESC').all(creatorId);

    /** The perk keys a membership's version grants (its own snapshot, never the plan's latest). */
    function perkKeys(m) {
        if (!m || !m.plan_version_id) return [];
        return plans.versionPerks(m.plan_version_id).map((p) => p.perk_key);
    }

    function present(m) {
        if (!m) return null;
        const v = m.plan_version_id ? plans.version(m.plan_version_id) : null;
        return {
            id: m.id, member: { type: 'user', id: m.member_subject }, creator_id: m.creator_id,
            plan_id: m.plan_id, plan_version: v ? { id: v.id, version: v.version, name: v.name, terms: json(v.terms, {}) } : null,
            perks: perkKeys(m), origin: m.origin, joined_at: m.joined_at, terms_since: m.terms_since,
        };
    }

    return { get, byId, onProjection, pendingCheckout, preferences, setPreferences, forMember, forCreator, perkKeys, present };
}

module.exports = { createMemberships };
