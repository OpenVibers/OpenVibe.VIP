'use strict';

/**
 * A creator's tier prices, kept by OpenVibe.Billing (billing.tier.manage, openvibe-contracts 0.201.0; ADR-012: Billing
 * prices, VIP never does). Each plan sold through Billing names its tier (plans.billing_tier); the creator sets that
 * tier's monthly price here and Billing charges it. Tier 1 without a price is sold at Billing's default price; a
 * higher tier without one is not for sale until the creator prices it.
 *
 *   forCreator(subject)        { tiers: Map(tier → { price_cents, status }), defaultCents, minCents, maxCents } or
 *                              null when Billing does not answer (pages then say the price is shown at checkout).
 *                              Cached per creator (config.billing.ratesTtlMs), dropped when the creator sets one.
 *   priceOf(table, tier)       the price new members pay for a tier, or null when it is not for sale
 *   set(creator, plan, cents)  set the plan's tier price on Billing
 */
const { fail, prefixedId } = require('../util');
const { BillingCallError } = require('../billing-client');

function createPrices({ config, billing, now }) {
    const cache = new Map();

    async function forCreator(subject) {
        if (!subject) return null;
        const hit = cache.get(subject);
        if (hit && now() - hit.at < config.billing.ratesTtlMs) return hit.value;
        let value = null;
        try {
            const out = await billing.listTiers(subject);
            value = {
                tiers: new Map((out.tiers || []).map((t) => [Number(t.tier), { price_cents: Number(t.price_cents), status: t.status }])),
                defaultCents: Number(out.default_price_cents) || null, minCents: Number(out.min_price_cents) || null, maxCents: Number(out.max_price_cents) || null,
            };
            cache.set(subject, { at: now(), value });
        } catch {
            // Billing did not answer: keep the last answer a little longer rather than show nothing.
            value = hit ? hit.value : null;
            cache.set(subject, { at: now() - config.billing.ratesTtlMs + 30_000, value });
        }
        return value;
    }

    function priceOf(table, tier) {
        if (!table) return null;
        const t = Number(tier) || 1;
        const row = table.tiers.get(t);
        if (row) return row.status === 'active' ? row.price_cents : null;
        return t === 1 ? table.defaultCents : null;
    }

    /** Presented plans with `price_cents` (null when unknown or unpriced); a higher tier without a price is not purchasable. */
    async function withPrices(creatorSubject, plans) {
        const table = await forCreator(creatorSubject);
        return plans.map((p) => {
            if (!p || !p.billing_kind) return p;
            const price = priceOf(table, p.tier);
            const unpriced = !!table && price == null;
            return { ...p, price_cents: price, purchasable: p.purchasable && !unpriced };
        });
    }

    /** The creator sets their plan's tier price (USD cents a month). */
    async function set(creator, plan, priceCents, { traceparent } = {}) {
        if (!plan || !plan.billing_kind) fail(409, 'vip.plan.not_sold', 'this plan is not sold through Billing, so it has no price');
        if (!creator || !creator.subject) fail(409, 'vip.plan.not_sold', 'this creator cannot sell through Billing');
        const cents = Number(priceCents);
        if (!Number.isSafeInteger(cents) || cents <= 0) fail(422, 'vip.invalid_input', 'price must be an amount in dollars and cents, like 4.99');
        try {
            // A fresh key per change: the same price set twice is two calls, and a retry of one call is the same call.
            const out = await billing.setTier({ creator: creator.subject, tier: Number(plan.billing_tier) || 1, priceCents: cents, key: `vip:tier:${prefixedId('vtp', now())}`, traceparent });
            cache.delete(creator.subject);
            return out.tier;
        } catch (e) {
            if (!(e instanceof BillingCallError)) throw e;
            if (e.code === 'billing.invalid_amount' || e.code === 'billing.invalid_input') fail(422, 'vip.invalid_input', (e.body && e.body.detail) || 'Billing refused that price');
            if (e.code === 'billing.frozen') fail(503, 'vip.billing_frozen', 'payments are paused right now; please try again later');
            if (e.status === 403 || e.status === 401) fail(503, 'vip.billing_unavailable', 'VIP is not allowed to set prices on Billing yet');
            fail(503, 'vip.billing_unavailable', 'Billing is not answering right now; the price did not change');
        }
    }

    /** "$4.99" from cents, and cents from "4.99" / "$4.99" / "5" (null when it is not an amount). */
    const centsFromDollars = (v) => {
        const m = /^\s*\$?\s*(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(String(v == null ? '' : v));
        return m ? Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0')) : null;
    };

    return { forCreator, priceOf, withPrices, set, centsFromDollars };
}

module.exports = { createPrices };
