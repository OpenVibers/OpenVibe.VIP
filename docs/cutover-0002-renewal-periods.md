# Cutover: migration 0002 (renewal periods and grace)

This is the cutover runbook for `migrations/0002_renewal_periods.sql` (PR #8, T5 step 11). The migration is
**additive** (`-- phase: expand`):

- a new table `vip_membership_periods` (one row per paid period, `UNIQUE (billing_transaction_id)`),
- a nullable column `vip_entitlement_projection.grace_until`.

Nothing is renamed, dropped or rewritten, so the previous release keeps running against the new shape.

## Order

1. **Backup first** (see below), so there is a way back even if the apply is interrupted.
2. Apply the migration **before** the code that uses it deploys. VIP applies `migrations/` at boot as the owner
   role (`DATABASE_DIRECT_URL`), so deploying the release applies it first; the previous release ignores both
   additions, so the order only matters if the migration is run by hand.
3. Deploy the release. Period rows fill from the next `billing.entitlement.changed` (granted/renewed with a
   `transaction_id`), `billing.transaction.reversed` and credit checkout. Existing active rows are not
   back-filled; the audit does not look at a pair until a payment event names it, so nothing is doubted at deploy.
4. The grace answer (`grace: { until, reason: "renewal_failed" }`) appears only once Billing sends `past_due`
   events (Billing's grace is off by default until its own step turns it on). Until then `grace` is `null`.

## Backup

Before the migration runs, take a full custom-format dump of the VIP database with the owner (direct) URL:

```sh
pg_dump -Fc "$DATABASE_DIRECT_URL" -f vip-before-0002.dump
```

Keep the dump until the first renewal with a charge has landed and `vip_period_audit_offenders` has been read
once. Because the migration only adds objects, this backup is the way back for a partial or wrong apply, not for
routine code rollback (see below).

## Verification

Read-only checks against the migrated database, before and after the deploy:

```sh
psql "$DATABASE_DIRECT_URL" -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM vip_membership_periods WHERE false" \
  -c "SELECT grace_until FROM vip_entitlement_projection WHERE false"
psql "$DATABASE_DIRECT_URL" -c "\d vip_membership_periods"
```

Then, once payment events flow:

- `vip_period_audit_offenders` (gauge, `/metrics`) and the log line `[VIP] period audit:` after the first
  renewals. A persistent non-zero value means Billing says a member is active for a period VIP has no paid
  charge for (a lost grant event, or a reversal that did not shorten the membership).
- `psql "$DATABASE_DIRECT_URL" -c "SELECT status, count(*) FROM vip_membership_periods GROUP BY status"` — the
  counts should grow with the payments Billing acknowledges, and a reversed period must not raise the audit's
  offenders.

The same shape is verified without production data by the rehearsal below: main's migrations, this PR's
migration, then the checks on a scratch PostgreSQL.

```rehearse
# The scratch base is main's migrations (migrations/0001_initial.sql); the repository has no fixtures.
# ds-rehearse applies migrations/0002_renewal_periods.sql (twice: a second run must apply nothing), then these.

# 1. Both additions exist; either would error here if the apply was incomplete.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM vip_membership_periods WHERE false" -c "SELECT grace_until FROM vip_entitlement_projection WHERE false"

# 2. The table accepts exactly the rows server/domain/periods.js writes (paid and reversed), then cleans up.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO vip_membership_periods (id, member_subject, creator_subject, billing_transaction_id, status, recorded_at, updated_at) VALUES ('rehearse-ok', 'm', 'c', 'rehearse-tx-ok', 'paid', 't', 't'), ('rehearse-rev', 'm', 'c', 'rehearse-tx-rev', 'reversed', 't', 't')" -c "DELETE FROM vip_membership_periods WHERE id LIKE 'rehearse-%'"

# 3. The constraints themselves: an unknown status and a replayed transaction are both refused.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DO \$do\$ BEGIN BEGIN INSERT INTO vip_membership_periods (id, member_subject, creator_subject, billing_transaction_id, status, recorded_at, updated_at) VALUES ('rehearse-bad', 'm', 'c', 'rehearse-tx-0', 'bogus', 't', 't'); RAISE EXCEPTION 'the status CHECK on vip_membership_periods is missing'; EXCEPTION WHEN check_violation THEN NULL; END; BEGIN INSERT INTO vip_membership_periods (id, member_subject, creator_subject, billing_transaction_id, status, recorded_at, updated_at) VALUES ('rehearse-1', 'm', 'c', 'rehearse-tx-1', 'paid', 't', 't'); INSERT INTO vip_membership_periods (id, member_subject, creator_subject, billing_transaction_id, status, recorded_at, updated_at) VALUES ('rehearse-2', 'm', 'c', 'rehearse-tx-1', 'paid', 't', 't'); RAISE EXCEPTION 'UNIQUE (billing_transaction_id) is missing'; EXCEPTION WHEN unique_violation THEN NULL; END; END \$do\$;"
```

## Rollback and restore

**Way back (normal).** Roll the code back; leave the table and the column in place, unused. The previous
release neither reads nor writes them. Do not drop `vip_membership_periods` once it holds rows: it is the
record that each paid period had a charge.

**Restore (only if the apply itself must be undone).** The additions are inert, so a restore is needed only if
a hand-run apply was wrong or interrupted. Restore the backup into a fresh database and point the service at it:

```sh
createdb vip_restore
pg_restore -d "$RESTORE_DATABASE_URL" vip-before-0002.dump
```

Verify the restored copy with the read-only checks above before switching `DATABASE_URL` / `DATABASE_DIRECT_URL`
over. Dropping `vip_membership_periods` and the `grace_until` column by hand is the last resort and only when
the table is still empty (no paid-period charge has been recorded).
