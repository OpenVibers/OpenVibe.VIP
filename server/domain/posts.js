'use strict';

/**
 * vip_member_posts: the posts a creator writes for the members of their tiers.
 *
 * A post names the tiers it is for (Billing's tiers of that creator, vip_plans.billing_tier) and carries
 * the title, the Markdown body with its safe HTML, and an optional image (a Media object). Who may read
 * it is never stored: it is answered by the entitlement check (Billing's truth, projected by
 * server/domain/entitlements.js) together with the tier the member holds.
 *
 * Reading rules:
 *   - the list of posts never carries a body; the body is served only after the entitlement check;
 *   - a member reads a post written for their tier or for a lower one (a higher tier includes the lower);
 *   - a signed-out visitor, a non-member and a member of another tier get the title, the tiers it needs
 *     and a way to join — never the body;
 *   - a hidden post is not served at all (not its body, not its title).
 */
const { fail, prefixedId, iso, json, text } = require('../util');
const { renderMarkdown } = require('./markdown');

const MAX_TIERS = 10;

function createPosts({ db, now, creators, plans, memberships, entitlements }) {
    const byId = async (id) => (id ? await db.prepare('SELECT * FROM vip_member_posts WHERE id = ?').get(id) || null : null);
    const rows = async ({ creatorId, includeHidden = false }) => {
        const st = includeHidden ? ['published', 'hidden'] : ['published'];
        const marks = st.map(() => '?').join(',');
        return await db.prepare('SELECT * FROM vip_member_posts WHERE creator_id = ? AND status IN (' + marks +
            ') ORDER BY published_at DESC, created_at DESC').all(creatorId, ...st);
    };
    const recent = async ({ limit = 50 } = {}) =>
        await db.prepare('SELECT * FROM vip_member_posts ORDER BY created_at DESC LIMIT ?').all(limit);

    /** The tiers this creator sells (their published plans' Billing tiers). */
    const offeredTiers = async (creatorId) => (await db.prepare(
        "SELECT DISTINCT billing_tier FROM vip_plans WHERE creator_id = ? AND status = 'published' AND billing_kind IS NOT NULL ORDER BY billing_tier"
    ).all(creatorId)).map((r) => Number(r.billing_tier));

    /** The tiers of one post, as numbers. */
    const tiersOf = (post) => {
        const list = json(post && post.tiers, []);
        return Array.isArray(list) ? list.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= MAX_TIERS) : [];
    };

    /**
     * The tier a member holds: the plan their membership was bought under (VIP's record of the terms
     * they joined); a subscription made elsewhere (Billing sells those at tier 1) is tier 1.
     */
    async function memberTier(memberSubject, creatorId) {
        const m = await memberships.get(memberSubject, creatorId);
        if (!m || !m.plan_id) return 1;
        const plan = await plans.byId(m.plan_id);
        if (!plan || !plan.billing_kind) return 1;
        return Number(plan.billing_tier) || 1;
    }

    /**
     * May this reader read this post? → { unlocked, reason, tier }.
     * The entitlement is Billing's (projected, then confirmed when stale); anything VIP cannot confirm is
     * refused, so a membership that ended never opens a post.
     */
    async function access({ post, memberSubject, creatorSubject, creatorId, mode = 'auto', traceparent, entitlement = null }) {
        const tiers = tiersOf(post);
        if (!memberSubject) return { unlocked: false, reason: 'signed_out', tier: null };
        // The entitlement may be the one the page already has (Billing's truth, projected); otherwise it is asked for.
        const ent = entitlement || await entitlements.check(memberSubject, creatorSubject, { mode, traceparent });
        if (!ent || ent.status !== 'active') return { unlocked: false, reason: 'not_a_member', tier: null, entitlement: ent };
        const tier = await memberTier(memberSubject, creatorId);
        if (!tiers.length || !tiers.some((t) => tier >= t)) return { unlocked: false, reason: 'other_tier', tier, entitlement: ent };
        return { unlocked: true, reason: 'member', tier, entitlement: ent };
    }

    /** The post as it is shown, with the body only when the reader may read it. */
    function present(post, { unlocked = false, tier = null } = {}) {
        const tiers = tiersOf(post);
        const shown = {
            id: post.id, creator_id: post.creator_id, title: post.title, tiers, status: post.status,
            image: post.image_id ? { id: post.image_id, url: post.image_url } : null,
            created_at: post.created_at, updated_at: post.updated_at, published_at: post.published_at || null,
            hidden_at: post.hidden_at || null, hidden_by: post.hidden_by || null, hide_reason: post.hide_reason || null,
            locked: !unlocked, reader_tier: tier,
        };
        if (unlocked) { shown.body = post.body; shown.body_html = post.body_html; }
        return shown;
    }

    /**
     * Write a post for the members of one or more of the creator's tiers.
     * tiers: the numbers to write for; they must be tiers the creator sells, so every member of a tier can
     * join it and a "Become a member" link always leads somewhere.
     */
    async function create({ creatorId, title, body, tiers, image = null, actor = null, traceparent }) {
        const creator = await creators.byId(creatorId);
        if (!creator) fail(404, 'vip.creator_not_found', 'no creator ' + creatorId);
        if (creator.kind !== 'creator') fail(422, 'vip.invalid_input', 'members-only posts belong to a creator');
        const cleanTitle = text(title, 'title', 140, { required: true });
        const cleanBody = text(body, 'body', 20000, { required: true });
        const wanted = Array.isArray(tiers) ? tiers : (tiers == null || tiers === '' ? [] : [tiers]);
        const numbers = [...new Set(wanted.map((t) => Number(t)).filter((t) => Number.isInteger(t) && t >= 1 && t <= MAX_TIERS))]
            .sort((a, b) => a - b);
        if (!numbers.length) fail(422, 'vip.invalid_input', 'choose at least one tier for the post');
        const offered = await offeredTiers(creatorId);
        if (!offered.length) fail(422, 'vip.post_no_tiers', 'publish a plan first: a post is written for the members of a tier');
        const unknown = numbers.filter((t) => !offered.includes(t));
        if (unknown.length) fail(422, 'vip.post_unknown_tier', 'you do not sell tier ' + unknown.join(', '));
        const at = iso(now());
        const id = prefixedId('vmp', now());
        await db.prepare('INSERT INTO vip_member_posts (id, creator_id, title, body, body_html, tiers, image_id, image_url, ' +
            "status, created_by, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?)").run(
            id, creatorId, cleanTitle, cleanBody, renderMarkdown(cleanBody), JSON.stringify(numbers),
            image && image.id ? image.id : null, image && image.url ? image.url : null, actor, at, at, at);
        return await byId(id);
    }

    /** Hide a post (the creator's own call, or a staff moderation): it is not served at all any more. */
    async function hide(id, { actor = null, reason = null } = {}) {
        const post = await byId(id);
        if (!post) fail(404, 'vip.post_not_found', 'no post ' + id);
        if (post.status === 'hidden') return post;
        const at = iso(now());
        await db.prepare("UPDATE vip_member_posts SET status = 'hidden', hidden_at = ?, hidden_by = ?, hide_reason = ?, updated_at = ? WHERE id = ?")
            .run(at, actor, reason ? String(reason).slice(0, 300) : null, at, id);
        return await byId(id);
    }

    /** Show a hidden post again: the staff may always, a creator only the posts they hid themselves. */
    async function unhide(id, { actor = null, staff = false } = {}) {
        const post = await byId(id);
        if (!post) fail(404, 'vip.post_not_found', 'no post ' + id);
        if (post.status !== 'hidden') return post;
        if (!staff && post.hidden_by && actor && post.hidden_by !== actor) {
            fail(403, 'vip.not_yours', 'a post hidden by staff stays hidden');
        }
        const at = iso(now());
        await db.prepare("UPDATE vip_member_posts SET status = 'published', hidden_at = NULL, hidden_by = NULL, hide_reason = NULL, updated_at = ? WHERE id = ?")
            .run(at, id);
        return await byId(id);
    }

    return { byId, rows, recent, create, hide, unhide, present, access, memberTier, offeredTiers, tiersOf };
}

module.exports = { createPosts };
