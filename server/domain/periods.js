'use strict';

/**
 * The per-period charge ledger: one row per paid membership period, keyed by the OpenVibe.Billing
 * transaction that paid it (UNIQUE billing_transaction_id), so a replayed or retried event never records
 * a period twice. Billing charges once per (subscription, period); VIP only records what Billing says.
 *
 *   recordPaid      billing.entitlement.changed granted/renewed with a transaction_id, or the credit checkout answer
 *   recordReversed  billing.transaction.reversed: the period whose transaction was reversed. A reversal that
 *                   arrives BEFORE the grant event writes a tombstone (status reversed); the grant that follows
 *                   fills in the details and leaves it reversed.
 *   audit           active, fresh projection rows whose paid period has no 'paid' record, or whose period was
 *                   reversed, are offenders: they are logged, counted and put in doubt (valid_until = 0) so the
 *                   next check asks Billing
 */
const { iso, prefixedId } = require('../util');

const KIND = 'channel_subscription';
const PAID_REASONS = new Set(['granted', 'renewed']);

function createPeriods({ db, now, log = console }) {
    const stats = { runs: 0, offenders: 0, offenders_total: 0 };

    const byTransaction = async (txn) => await db.prepare('SELECT * FROM vip_membership_periods WHERE billing_transaction_id = ?').get(txn) || null;

    /** Record the period a transaction paid. Idempotent on the transaction; never un-reverses a period. */
    async function recordPaid({ member, creator, subscriptionId = null, transactionId, periodStart = null, periodEnd = null, reason = null }) {
        if (!transactionId) return { outcome: 'no_transaction' };
        return await db.tx(async () => {
            const prev = await byTransaction(transactionId);
            const at = iso(now());
            await db.prepare(`INSERT INTO vip_membership_periods (id, member_subject, creator_subject, billing_subscription_id, billing_transaction_id,
                    period_start, period_end, status, reason, recorded_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?)
                ON CONFLICT (billing_transaction_id) DO UPDATE SET member_subject = excluded.member_subject, creator_subject = excluded.creator_subject,
                    billing_subscription_id = COALESCE(excluded.billing_subscription_id, vip_membership_periods.billing_subscription_id),
                    period_start = COALESCE(vip_membership_periods.period_start, excluded.period_start),
                    period_end = COALESCE(excluded.period_end, vip_membership_periods.period_end),
                    reason = COALESCE(excluded.reason, vip_membership_periods.reason), updated_at = excluded.updated_at`)
                .run(prefixedId('vmp', now()), member, creator, subscriptionId, transactionId, periodStart, periodEnd, reason, at, at);
            const row = await byTransaction(transactionId);
            return { outcome: !prev ? 'recorded' : (row.status === 'reversed' ? 'reversed' : 'replayed'), row };
        });
    }

    /** Mark the period paid by `reversesTxn` reversed by `reversedBy`; a tombstone when it is not recorded yet. */
    async function recordReversed({ member, creator, reversesTxn, reversedBy = null, reason = null }) {
        if (!reversesTxn) return { outcome: 'no_transaction' };
        return await db.tx(async () => {
            const prev = await byTransaction(reversesTxn);
            const at = iso(now());
            await db.prepare(`INSERT INTO vip_membership_periods (id, member_subject, creator_subject, billing_transaction_id, status, reversed_by, reason, recorded_at, updated_at)
                VALUES (?, ?, ?, ?, 'reversed', ?, ?, ?, ?)
                ON CONFLICT (billing_transaction_id) DO UPDATE SET status = 'reversed',
                    reversed_by = COALESCE(vip_membership_periods.reversed_by, excluded.reversed_by), updated_at = excluded.updated_at`)
                .run(prefixedId('vmp', now()), member, creator, reversesTxn, reversedBy, reason, at, at);
            return { outcome: !prev ? 'tombstone' : (prev.status === 'reversed' ? 'replayed' : 'reversed'), row: await byTransaction(reversesTxn) };
        });
    }

    const forPair = async (member, creator) => await db.prepare(`SELECT * FROM vip_membership_periods WHERE member_subject = ? AND creator_subject = ?
        ORDER BY period_end DESC`).all(member, creator);

    /**
     * Rows that claim a paid period (the last word was a payment, or the pair already has ledger rows) without a
     * 'paid' record that reaches their expires_at, or whose covering period was reversed. A pair VIP only ever
     * learned from a Billing check (an import, a shadow entitlement) is not audited until a payment event names it.
     */
    async function audit({ limit = 500 } = {}) {
        const t = now();
        const rows = await db.prepare(`SELECT p.* FROM vip_entitlement_projection p
            WHERE p.kind = ? AND p.active = 1 AND p.valid_until >= ? AND p.expires_at > ?
              AND (p.last_reason IN ('granted', 'renewed') OR EXISTS (SELECT 1 FROM vip_membership_periods q
                    WHERE q.member_subject = p.member_subject AND q.creator_subject = p.creator_subject))
            ORDER BY p.valid_until LIMIT ?`).all(KIND, t, iso(t), limit);
        const offenders = [];
        for (const r of rows) {
            const paid = await db.prepare(`SELECT 1 AS ok FROM vip_membership_periods WHERE member_subject = ? AND creator_subject = ?
                AND status = 'paid' AND period_end >= ? LIMIT 1`).get(r.member_subject, r.creator_subject, r.expires_at);
            if (paid) continue;
            const reversed = await db.prepare(`SELECT billing_transaction_id FROM vip_membership_periods WHERE member_subject = ? AND creator_subject = ?
                AND status = 'reversed' AND (period_end IS NULL OR period_end >= ?) ORDER BY recorded_at DESC LIMIT 1`).get(r.member_subject, r.creator_subject, r.expires_at);
            offenders.push({
                member: r.member_subject, creator: r.creator_subject, expires_at: r.expires_at,
                problem: reversed ? 'period_reversed' : 'no_paid_period', billing_transaction_id: reversed ? reversed.billing_transaction_id : null,
            });
            await db.prepare('UPDATE vip_entitlement_projection SET valid_until = 0 WHERE member_subject = ? AND creator_subject = ? AND kind = ?').run(r.member_subject, r.creator_subject, KIND);
        }
        stats.runs++;
        stats.offenders = offenders.length;
        stats.offenders_total += offenders.length;
        if (offenders.length) log.warn(`[VIP] period audit: ${offenders.length} active membership(s) without a paid period record; doubted: ${offenders.slice(0, 5).map((o) => `${o.member}→${o.creator} ${o.problem}`).join(', ')}`);
        return { checked: rows.length, offenders };
    }

    return { recordPaid, recordReversed, byTransaction, forPair, audit, stats, PAID_REASONS };
}

module.exports = { createPeriods };
