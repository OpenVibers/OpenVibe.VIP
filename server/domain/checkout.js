'use strict';

/**
 * Checkout hand-off and cancellation — both done BY Billing (ADR-012); VIP only records which plan
 * version the member chose so the membership Billing grants is filed under those terms.
 *
 *   start()   provider 'credit'      Billing POST /subscriptions (source credit): the period is paid
 *                                    from the member's Vibes credit at once
 *             any other provider    Billing POST /intents (kind subscription): Billing returns the
 *                                    provider checkout (a URL, or a PowerChat checkout_ref); the
 *                                    membership starts when Billing's settlement event arrives
 *   cancel()  Billing POST /subscriptions/:id/cancel (at period end)
 *
 * Both first ask Billing directly (a sensitive action never trusts the projection). Idempotency
 * keys come from VIP's own ids, so a retried call returns Billing's first answer.
 */
const { fail, prefixedId, iso } = require('../util');
const { BillingCallError } = require('../billing-client');

function billingProblem(err) {
    if (!(err instanceof BillingCallError)) throw err;
    const code = err.code || '';
    if (code === 'billing.frozen') fail(503, 'vip.billing_frozen', 'payments are paused right now; please try again later');
    if (code === 'billing.insufficient_funds') fail(409, 'vip.checkout.insufficient_credit', 'your Vibes credit does not cover this membership');
    if (code === 'billing.provider_disabled' || code === 'billing.invalid_input') fail(409, 'vip.checkout.provider_unavailable', 'that payment method is not available right now');
    if (code === 'billing.self_dealing') fail(422, 'vip.checkout.self', 'you cannot join your own plan');
    if (err.status === 403 || err.status === 401) fail(503, 'vip.billing_unavailable', 'VIP is not allowed to reach Billing for this yet');
    fail(503, 'vip.billing_unavailable', 'Billing is not answering right now; nothing was charged');
}

function createCheckout({ db, now, config, billing, creators, plans, entitlements }) {
    const byId = (id) => db.prepare('SELECT * FROM vip_checkouts WHERE id = ?').get(id) || null;

    async function start({ member, planId, provider, successUrl, cancelUrl, autoRenew = true, traceparent }) {
        const plan = plans.byId(String(planId || ''));
        if (!plan || plan.status !== 'published') fail(404, 'vip.plan_not_found', 'no published plan with that id');
        if (!plan.billing_kind) fail(409, 'vip.checkout.unavailable', 'this plan is not sold through Billing yet');
        const creator = creators.byId(plan.creator_id);
        if (!creator || creator.status !== 'active' || !creator.subject) fail(409, 'vip.checkout.unavailable', 'this creator is not taking new members');
        if (creator.subject === member) fail(422, 'vip.checkout.self', 'you cannot join your own plan');
        const p = String(provider || '').toLowerCase();
        if (!config.billing.providers.includes(p)) fail(422, 'vip.checkout.provider_unavailable', `provider must be one of ${config.billing.providers.join(', ') || '(none configured)'}`);

        // Sensitive: ask Billing, not the projection. An active member renews through Billing, not here.
        let current;
        try { current = await entitlements.authoritative(member, creator.subject, { traceparent }); } catch (e) { billingProblem(e); }
        if (current && current.active && current.expires_at && Date.parse(current.expires_at) > now()) {
            fail(409, 'vip.already_member', 'you are already a member; your membership renews through Billing');
        }

        const at = iso(now());
        const id = prefixedId('vco', now());
        db.prepare(`INSERT INTO vip_checkouts (id, member_subject, creator_id, plan_id, plan_version_id, provider, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?)`).run(id, member, creator.id, plan.id, plan.current_version_id, p, at, at);
        const mark = (fields) => {
            const cols = Object.keys(fields);
            db.prepare(`UPDATE vip_checkouts SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @updated_at WHERE id = @id`).run({ ...fields, updated_at: iso(now()), id });
        };

        if (p === 'credit') {
            let out;
            try {
                out = await billing.subscribeWithCredit({ subscriber: member, creator: creator.subject, autoRenew, key: `vip:checkout:${id}`, traceparent });
            } catch (e) { mark({ status: 'failed', error: String(e.code || e.message).slice(0, 200) }); billingProblem(e); }
            const sub = out.subscription || {};
            const ent = out.entitlement || {};
            mark({ status: 'paid', billing_subscription_id: sub.id || null });
            entitlements.apply({
                member, creator: creator.subject, active: !!ent.active, expiresAt: ent.expires_at || sub.current_period_end || null,
                cancelAtPeriodEnd: !!sub.cancel_at_period_end, subscriptionId: sub.id || null, subscriptionStatus: sub.status || null,
                reason: 'granted', source: 'billing_check', asOf: now(), checkoutId: id, traceparent,
            });
            return { checkout: present(byId(id)), membership_started: !!ent.active, checkout_url: null, checkout_ref: null };
        }

        let out;
        try {
            out = await billing.createIntent({
                provider: p, subject: member, creator: creator.subject, autoRenew,
                successUrl: successUrl || `${config.baseUrl}/me?joined=${encodeURIComponent(creator.username || '')}`,
                cancelUrl: cancelUrl || `${config.baseUrl}/${encodeURIComponent(creator.username || '')}`,
                key: `vip:checkout:${id}`, traceparent,
            });
        } catch (e) { mark({ status: 'failed', error: String(e.code || e.message).slice(0, 200) }); billingProblem(e); }
        const intent = out.intent || {};
        let url = out.checkout_url || null;
        if (!url && intent.checkout_ref && config.billing.powerchatLinkTemplate) {
            url = config.billing.powerchatLinkTemplate.replace('{ref}', encodeURIComponent(intent.checkout_ref)).replace('{cents}', String(intent.amount_cents || ''));
        }
        // Only ever send a member to an http(s) page (never javascript:/data: from a bad answer).
        if (url && !/^https?:\/\//i.test(url)) url = null;
        mark({ status: 'handed_off', billing_intent_id: intent.id || null, checkout_url: url, checkout_ref: intent.checkout_ref || null });
        return { checkout: present(byId(id)), membership_started: false, checkout_url: url, checkout_ref: intent.checkout_ref || null, amount_cents: intent.amount_cents || null };
    }

    /** Cancel at period end, through Billing. Only the member themself. */
    async function cancel({ member, creatorId, traceparent }) {
        const creator = creators.byId(creatorId);
        if (!creator || !creator.subject) fail(404, 'vip.creator_not_found', `no creator ${creatorId}`);
        let row;
        try { row = await entitlements.authoritative(member, creator.subject, { traceparent }); } catch (e) { billingProblem(e); }
        if (!row || !row.active || !row.subscription_id) fail(404, 'vip.membership_not_found', 'there is no active membership to cancel');
        if (row.cancel_at_period_end) return { already: true, expires_at: row.expires_at };
        let sub;
        try {
            const s = await billing.getSubscription(row.subscription_id);
            sub = s.subscription;
        } catch (e) { billingProblem(e); }
        if (!sub || !sub.subscriber || sub.subscriber.id !== member) fail(403, 'vip.not_yours', 'that membership is not yours');
        let out;
        try {
            out = await billing.cancelSubscription({ id: sub.id, key: `vip:cancel:${sub.id}:${sub.current_period_end || 'open'}`, traceparent });
        } catch (e) { billingProblem(e); }
        const s = (out && out.subscription) || {};
        entitlements.applyCanceled({
            member, creator: creator.subject, subscriptionId: s.id || sub.id, subscriptionStatus: s.status || 'active',
            currentPeriodEnd: s.current_period_end || null, asOf: now(), traceparent, source: 'billing_check',
        });
        return { already: false, expires_at: row.expires_at, provider_sync: out && out.provider_sync };
    }

    function present(c) {
        if (!c) return null;
        return {
            id: c.id, member: { type: 'user', id: c.member_subject }, creator_id: c.creator_id, plan_id: c.plan_id, plan_version_id: c.plan_version_id,
            provider: c.provider, status: c.status, billing_intent_id: c.billing_intent_id, billing_subscription_id: c.billing_subscription_id,
            checkout_url: c.checkout_url, checkout_ref: c.checkout_ref, created_at: c.created_at,
        };
    }

    return { start, cancel, byId, present };
}

module.exports = { createCheckout, billingProblem };
