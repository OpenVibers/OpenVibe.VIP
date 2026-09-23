'use strict';

/**
 * The entitlement projection: a short-lived cache of OpenVibe.Billing's entitlements (Billing holds
 * the truth, ADR-012), fed by Billing's events (billing.entitlement.changed,
 * billing.subscription.canceled, billing.transaction.reversed) and by direct authoritative checks.
 *
 * A stale projection can never authorize indefinitely:
 *   valid_until = min(paid period end, last word from Billing + maxAge)   (a "no" is kept maxAge)
 *   now <= valid_until                   the projection answers
 *   valid_until < now <= valid_until+grace  mode 'projection' answers, flagged stale; mode 'auto' asks
 *                                        Billing first and only falls back to the stale answer when
 *                                        Billing cannot be reached
 *   later                                "unknown" (active: false) until Billing confirms again
 * Mode 'authoritative' (sensitive actions) always asks Billing and answers "unknown" when it cannot.
 *
 * Ordering: every row remembers the Billing time it reflects (billing_as_of). An older event that
 * would grant is ignored; an older event that would revoke puts the row in doubt (valid_until = 0),
 * so the next check goes to Billing — out-of-order delivery can deny briefly, never grant wrongly.
 */
const { iso, userRef } = require('../util');

const KIND = 'channel_subscription';

function createEntitlements({ db, now, config, billing, outbox, memberships, plans, log = console }) {
    const { maxAgeMs, graceMs } = config.projection;
    const getRow = (member, creator, kind = KIND) => db.prepare('SELECT * FROM vip_entitlement_projection WHERE member_subject = ? AND creator_subject = ? AND kind = ?').get(member, creator, kind) || null;

    function validUntil(at, active, expiresAt) {
        const cap = at + maxAgeMs;
        if (!active) return cap;
        const end = expiresAt ? Date.parse(expiresAt) : NaN;
        return Number.isFinite(end) ? Math.min(cap, end) : at;
    }

    function emitChanged(row, prev, { reason, membership }, traceparent) {
        const v = membership && membership.plan_version_id ? plans.version(membership.plan_version_id) : null;
        outbox.emit('vip.membership.changed', { type: 'membership', id: `${row.member_subject}:${row.creator_subject}` }, {
            member: userRef(row.member_subject), creator: userRef(row.creator_subject), kind: row.kind,
            active: !!row.active, expires_at: row.expires_at, cancel_at_period_end: !!row.cancel_at_period_end,
            previous: prev ? { active: !!prev.active, expires_at: prev.expires_at, cancel_at_period_end: !!prev.cancel_at_period_end } : null,
            reason: reason || null, source: row.source, billing_event_id: row.billing_event_id || null,
            membership_id: membership ? membership.id : null, plan_id: membership ? membership.plan_id : null,
            plan_version_id: membership ? membership.plan_version_id : null, plan_version: v ? v.version : null,
            subscription_id: row.subscription_id || null,
        }, { traceparent });
    }

    /**
     * Apply what Billing said about (member, creator). Runs in a transaction (joins the caller's).
     * input: { member, creator, kind?, active, expiresAt, cancelAtPeriodEnd?, subscriptionId?,
     *          subscriptionStatus?, reason, source: 'event'|'billing_check'|'import', eventId?, asOf (ms),
     *          origin?, checkoutId?, traceparent? }
     */
    function apply(input) {
        return db.transaction(() => {
            const kind = input.kind || KIND;
            const prev = getRow(input.member, input.creator, kind);
            const at = now();
            if (prev && input.asOf < prev.billing_as_of) {
                if (!input.active && prev.active) {
                    db.prepare('UPDATE vip_entitlement_projection SET valid_until = 0 WHERE member_subject = ? AND creator_subject = ? AND kind = ?').run(input.member, input.creator, kind);
                    return { outcome: 'doubt', changed: false };
                }
                return { outcome: 'stale_ignored', changed: false };
            }
            const next = {
                member_subject: input.member, creator_subject: input.creator, kind,
                active: input.active ? 1 : 0, expires_at: input.expiresAt || null,
                cancel_at_period_end: input.cancelAtPeriodEnd !== undefined ? (input.cancelAtPeriodEnd ? 1 : 0) : (prev ? prev.cancel_at_period_end : 0),
                subscription_id: input.subscriptionId !== undefined ? input.subscriptionId : (prev ? prev.subscription_id : null),
                subscription_status: input.subscriptionStatus !== undefined ? input.subscriptionStatus : (prev ? prev.subscription_status : null),
                source: input.source, last_reason: input.reason || null, billing_event_id: input.eventId || null,
                billing_as_of: input.asOf, synced_at: at, valid_until: validUntil(at, input.active, input.expiresAt),
                last_used_at: prev ? prev.last_used_at : null,
            };
            db.prepare(`INSERT INTO vip_entitlement_projection (member_subject, creator_subject, kind, active, expires_at, cancel_at_period_end, subscription_id,
                    subscription_status, source, last_reason, billing_event_id, billing_as_of, synced_at, valid_until, last_used_at)
                VALUES (@member_subject, @creator_subject, @kind, @active, @expires_at, @cancel_at_period_end, @subscription_id, @subscription_status,
                    @source, @last_reason, @billing_event_id, @billing_as_of, @synced_at, @valid_until, @last_used_at)
                ON CONFLICT (member_subject, creator_subject, kind) DO UPDATE SET active = excluded.active, expires_at = excluded.expires_at,
                    cancel_at_period_end = excluded.cancel_at_period_end, subscription_id = excluded.subscription_id,
                    subscription_status = excluded.subscription_status, source = excluded.source, last_reason = excluded.last_reason,
                    billing_event_id = excluded.billing_event_id, billing_as_of = excluded.billing_as_of, synced_at = excluded.synced_at,
                    valid_until = excluded.valid_until`).run(next);
            const { membership } = memberships.onProjection({ prev, next, reason: input.reason, origin: input.origin, checkoutId: input.checkoutId });
            // A first look that finds no membership is not a change anyone needs to hear about.
            const changed = prev
                ? (!!prev.active !== !!next.active || prev.expires_at !== next.expires_at || !!prev.cancel_at_period_end !== !!next.cancel_at_period_end)
                : !!next.active;
            if (changed) emitChanged(next, prev, { reason: input.reason, membership }, input.traceparent);
            return { outcome: changed ? 'changed' : 'unchanged', changed, row: getRow(input.member, input.creator, kind), membership };
        })();
    }

    /** A cancellation scheduled at Billing: the period still runs; only the flag changes. */
    function applyCanceled({ member, creator, subscriptionId, subscriptionStatus, currentPeriodEnd, eventId, asOf, traceparent, source = 'event' }) {
        return db.transaction(() => {
            const prev = getRow(member, creator);
            if (!prev) return { outcome: 'no_projection', changed: false };
            if (asOf < prev.billing_as_of) return { outcome: 'stale_ignored', changed: false };
            const active = subscriptionStatus === 'active' ? !!prev.active : false;
            return apply({
                member, creator, active, expiresAt: active ? (prev.expires_at || currentPeriodEnd) : prev.expires_at, cancelAtPeriodEnd: true,
                subscriptionId, subscriptionStatus, reason: 'cancel_scheduled', source, eventId, asOf, traceparent,
            });
        })();
    }

    /** Something happened that Billing will describe in detail (a refund): stop trusting the row. */
    function doubt(member, creator, kind = KIND) {
        return db.prepare('UPDATE vip_entitlement_projection SET valid_until = 0 WHERE member_subject = ? AND creator_subject = ? AND kind = ?').run(member, creator, kind).changes > 0;
    }

    function answer(row, source, { stale = false, membership } = {}) {
        const t = now();
        const active = !!row.active && !!row.expires_at && Date.parse(row.expires_at) > t;
        return {
            member: userRef(row.member_subject), creator: userRef(row.creator_subject), kind: row.kind,
            status: active ? 'active' : 'inactive', active, expires_at: row.expires_at, cancel_at_period_end: !!row.cancel_at_period_end,
            source, stale, valid_until: iso(Math.max(0, row.valid_until)), checked_at: iso(t),
            membership: membership ? memberships.present(membership) : null,
        };
    }
    function unknown(member, creator, reason) {
        return {
            member: userRef(member), creator: userRef(creator), kind: KIND, status: 'unknown', active: false, expires_at: null,
            cancel_at_period_end: false, source: 'none', stale: false, valid_until: null, checked_at: iso(now()), reason, membership: null,
        };
    }

    const membershipOf = (member, creatorSubject) => {
        const row = db.prepare('SELECT m.* FROM vip_memberships m JOIN vip_creators c ON c.id = m.creator_id WHERE m.member_subject = ? AND c.subject = ?').get(member, creatorSubject);
        return row || null;
    };

    /** Ask Billing and project the answer. Throws BillingCallError when Billing cannot answer. */
    async function authoritative(member, creator, { traceparent } = {}) {
        const e = await billing.entitlement(member, creator);
        const sub = e && e.subscription;
        const out = apply({
            member, creator, active: !!(e && e.active), expiresAt: (e && e.expires_at) || null,
            cancelAtPeriodEnd: sub ? !!sub.cancel_at_period_end : undefined, subscriptionId: sub ? sub.id : undefined,
            subscriptionStatus: sub ? sub.status : undefined, reason: 'checked', source: 'billing_check', asOf: now(), traceparent,
        });
        return out.row || getRow(member, creator);
    }

    /**
     * check(member, creator, { mode: 'auto' | 'projection' | 'authoritative' }) → answer.
     * `active` is true only for status 'active'; 'unknown' never authorizes.
     */
    async function check(member, creator, { mode = 'auto', traceparent } = {}) {
        if (member === creator) return { ...unknown(member, creator, 'self'), status: 'inactive', reason: 'a creator is not a member of their own plans' };
        const t = now();
        let row = getRow(member, creator);
        if (row) db.prepare('UPDATE vip_entitlement_projection SET last_used_at = ? WHERE member_subject = ? AND creator_subject = ? AND kind = ?').run(t, member, creator, KIND);
        const fresh = row && t <= row.valid_until;
        const withinGrace = row && t <= row.valid_until + graceMs;
        if (mode === 'projection') {
            if (fresh) return answer(row, 'projection', { membership: membershipOf(member, creator) });
            if (withinGrace) return answer(row, 'projection', { stale: true, membership: membershipOf(member, creator) });
            return unknown(member, creator, row ? 'projection_expired' : 'no_projection');
        }
        if (mode === 'auto' && fresh) return answer(row, 'projection', { membership: membershipOf(member, creator) });
        try {
            row = await authoritative(member, creator, { traceparent });
            return answer(row, 'billing', { membership: membershipOf(member, creator) });
        } catch (err) {
            log.warn(`[VIP] authoritative entitlement check failed (${member} → ${creator}): ${err.message}`);
            if (mode === 'auto' && withinGrace) return { ...answer(row, 'projection', { stale: true, membership: membershipOf(member, creator) }), reason: 'billing_unavailable' };
            return unknown(member, creator, 'billing_unavailable');
        }
    }

    /**
     * Keep projections that products are actually using confirmed before they go stale (job).
     * Rows unused for an hour simply expire into "unknown" and are re-checked on demand.
     */
    async function refreshDue({ limit = 50 } = {}) {
        const t = now();
        const rows = db.prepare(`SELECT member_subject, creator_subject FROM vip_entitlement_projection
            WHERE kind = ? AND last_used_at >= ? AND valid_until <= ? ORDER BY valid_until LIMIT ?`).all(KIND, t - 3600_000, t + 120_000, limit);
        let ok = 0; let failed = 0;
        for (const r of rows) {
            try { await authoritative(r.member_subject, r.creator_subject); ok++; } catch { failed++; }
        }
        return { checked: rows.length, ok, failed };
    }

    /** Members of a creator according to the projection (fresh rows only; never past valid_until). */
    function projectedMembers(creator) {
        const t = now();
        return db.prepare(`SELECT * FROM vip_entitlement_projection WHERE creator_subject = ? AND kind = ? AND active = 1 AND valid_until >= ? AND expires_at > ?
            ORDER BY expires_at DESC`).all(creator, KIND, t, iso(t));
    }

    return { apply, applyCanceled, doubt, check, authoritative, refreshDue, projectedMembers, getRow, KIND };
}

module.exports = { createEntitlements, KIND };
