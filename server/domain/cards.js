'use strict';

/**
 * The public face of a creator's memberships, reused by other products and other sites (roadmap
 * §11.3 "reusable membership badge/card/widget endpoints"; rendered by server/web/embeds.js):
 *
 *   card(creator)    plan names and terms (the current published version), perks, the join and
 *                    terms links, Billing's price, the member count, and the badge and widget URLs
 *   badge(creator)   what a member's badge reads: the name of the badge perk in the plan new members
 *                    buy ("Subscriber badge" → "Subscriber"), else "Member"
 *
 * Only public things: published plans (never drafts or archived ones), public terms, perk names and
 * kinds (never product binding configs), and a member COUNT (never who), which the creator can switch
 * off (vip_creators.show_member_count). A creator with no published plan has no card.
 *
 * The member count is Billing's (active subscriptions to the creator), reused for
 * config.embeds.memberCountTtlMs; when Billing does not answer the last count is kept (flagged
 * stale), or none is shown. VIP's projection is not used for it: it only holds members someone asked
 * about recently.
 */
const BADGE_SUFFIX = /\s+badge$/i;

function createCards({ db, config, creators, plans, perks, billing, now, log = console }) {
    const counts = new Map();   // creator id → { at, count, stale, pending }
    let rates = { at: -Infinity, value: null };

    /** Billing's rates (the price new members pay), cached like the plan pages do. */
    async function price() {
        if (now() - rates.at >= config.billing.ratesTtlMs) {
            try { rates = { at: now(), value: await billing.rates() }; } catch { rates = { at: now() - config.billing.ratesTtlMs + 30_000, value: rates.value }; }
        }
        const sub = rates.value && rates.value.subscription;
        return sub && sub.price_cents ? sub : null;
    }

    /**
     * { count, shown, stale }: Billing's count of active members, or count null when the creator hides
     * it or nothing is known yet. One Billing call at a time per creator; after a failure the last
     * count is served (stale) and Billing is asked again 30 s later.
     */
    async function memberCount(c) {
        if (!c || c.kind !== 'creator' || !c.show_member_count) return { count: null, shown: false, stale: false };
        const hit = counts.get(c.id);
        if (hit && hit.pending) return hit.pending;
        if (hit && now() - hit.at < config.embeds.memberCountTtlMs) return { count: hit.count, shown: true, stale: hit.stale };
        const pending = billing.listSubscriptions({ streamer: c.subject, status: 'active' })
            .then((out) => {
                const count = new Set((out.subscriptions || []).map((x) => x.subscriber && x.subscriber.id).filter(Boolean)).size;
                counts.set(c.id, { at: now(), count, stale: false });
                return { count, shown: true, stale: false };
            })
            .catch((e) => {
                log.warn(`[VIP] member count for ${c.id}: ${e.message}`);
                const count = hit ? hit.count : null;
                counts.set(c.id, { at: now() - config.embeds.memberCountTtlMs + 30_000, count, stale: count != null });
                return { count, shown: true, stale: count != null };
            });
        counts.set(c.id, { ...(hit || { at: -Infinity, count: null, stale: false }), pending });
        return pending;
    }

    const kindOf = (perkId) => { const p = perks.byId(perkId); return p ? p.kind : 'other'; };

    /** The published plans of a creator, each at the version new members buy. */
    function publicPlans(c) {
        return plans.list({ creatorId: c.id }).map((p) => plans.present(p)).filter((p) => p.current_version);
    }

    function badge(c, list = publicPlans(c)) {
        const plan = list.find((p) => p.purchasable) || list[0];
        const v = plan && plan.current_version;
        const perk = v && v.perks.find((x) => kindOf(x.id) === 'badge');
        const label = perk ? perk.name.replace(BADGE_SUFFIX, '').trim() || perk.name : 'Member';
        return { label: label.slice(0, 24) };
    }

    const urls = (c) => {
        const u = encodeURIComponent(c.username);
        return {
            page: `${config.baseUrl}/${u}`, badge: `${config.baseUrl}/embed/${u}/badge.svg`,
            widget: `${config.baseUrl}/embed/${u}/widget`, card: `${config.baseUrl}/embed/${u}/card.json`,
        };
    };

    /** The public card of a creator row, or null when it has none (no handle, suspended, no published plan). */
    async function card(c) {
        if (!c || c.kind !== 'creator' || c.status !== 'active' || !c.username) return null;
        const list = publicPlans(c);
        if (!list.length) return null;
        const u = urls(c);
        const joiningOpen = config.billing.providers.length > 0 && list.some((p) => p.purchasable);
        const [members, sub] = await Promise.all([memberCount(c), list.some((p) => p.purchasable) ? price() : null]);
        return {
            creator: { username: c.username, display_name: c.display_name || c.username, url: u.page },
            plans: list.map((p) => {
                const v = p.current_version;
                return {
                    id: p.id, slug: p.slug, name: v.name, description: v.description, benefits: v.benefits, version: v.version,
                    perks: v.perks.map((x) => ({ key: x.key, name: x.name, kind: kindOf(x.id) })),
                    purchasable: p.purchasable,
                    join_url: `${u.page}#plan-${encodeURIComponent(p.slug)}`,
                    terms_url: `${u.page}/plans/${encodeURIComponent(p.slug)}`,
                };
            }),
            join_url: u.page,
            joining_open: joiningOpen,
            price: sub ? { price_cents: sub.price_cents, period_days: sub.period_days, charged_by: 'OpenVibe.Billing' } : null,
            members: { count: members.count, shown: members.shown, stale: members.stale },
            badge: { ...badge(c, list), svg_url: u.badge },
            widget_url: u.widget,
            card_url: u.card,
        };
    }

    return { card, badge, memberCount, publicPlans, urls };
}

module.exports = { createCards };
