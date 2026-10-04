# Cutover note: migration 0002 (renewal periods and grace)

`migrations/0002_renewal_periods.sql` is **additive** (`-- phase: expand`):

- a new table `vip_membership_periods` (one row per paid period, `UNIQUE (billing_transaction_id)`),
- a nullable column `vip_entitlement_projection.grace_until`.

Nothing is renamed, dropped or rewritten.

## Order

1. Apply the migration **before** the code that uses it deploys. VIP applies `migrations/` at boot as the owner
   role (`DATABASE_DIRECT_URL`), so deploying the release applies it first; the previous release ignores both
   additions, so the order only matters if the migration is run by hand.
2. Deploy the release. Period rows fill from the next `billing.entitlement.changed` (granted/renewed with a
   `transaction_id`), `billing.transaction.reversed` and credit checkout. Existing active rows are not
   back-filled; the audit does not look at a pair until a payment event names it, so nothing is doubted at deploy.
3. The grace answer (`grace: { until, reason: "renewal_failed" }`) appears only once Billing sends `past_due`
   events (Billing's grace is off by default until its own step turns it on). Until then `grace` is `null`.

## Rollback

Roll the code back; leave the table and the column in place, unused. The previous release neither reads nor writes
them. Do not drop `vip_membership_periods`: it is the record that each paid period had a charge.

## Watch

- `vip_period_audit_offenders` (gauge, `/metrics`) and the log line `[VIP] period audit:` after the first renewals.
  A persistent non-zero value means Billing says a member is active for a period VIP has no paid charge for
  (a lost grant event, or a reversal that did not shorten the membership).
