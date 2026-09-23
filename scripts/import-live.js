#!/usr/bin/env node
'use strict';
/**
 * Import OpenVibe.Live's subscription offering into VIP (creators, the network subscriber-badge perk,
 * one "Channel subscription" plan per creator) and file OpenVibe.Billing's active subscriptions as
 * memberships under it. Live's own subscription rows are reconciled, never used as membership truth.
 *
 *   node scripts/import-live.js --live-db <live snapshot> [--billing-db <billing snapshot>] [--dry-run] [--json]
 *
 * The Live database must be a COPY (`sqlite3 live.db ".backup live-snapshot.db"`); it is opened
 * read-only. Run it AFTER Billing's Live import. Memberships come from Billing's API with VIP's
 * client credentials (billing.entitlement.check), or from a read-only Billing snapshot with
 * --billing-db. Live user ids are resolved through the Network (identity.subject.resolve).
 * Exit code 1 when Billing could not be read for some creator (the report lists them). Safe to re-run.
 */
const path = require('path');
const Database = require('better-sqlite3');
const { loadConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { createIdentity } = require('../server/network');
const { createBillingClient } = require('../server/billing-client');
const { createVipOutbox } = require('../server/events/outbox');
const { createDomain } = require('../server/domain');
const { importLive, billingApiSource, billingSnapshotSource } = require('../server/importer/live');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const flag = (name) => args.includes(`--${name}`);

async function main() {
    const livePath = opt('live-db');
    if (!livePath) { console.error('usage: import-live.js --live-db <snapshot> [--billing-db <snapshot>] [--dry-run] [--json]'); process.exit(2); }
    const config = loadConfig();
    for (const p of [livePath, opt('billing-db')].filter(Boolean)) if (path.resolve(p) === path.resolve(config.dbPath)) throw new Error(`${p} is the VIP database`);
    const live = new Database(livePath, { readonly: true, fileMustExist: true });
    const bdb = opt('billing-db') ? new Database(opt('billing-db'), { readonly: true, fileMustExist: true }) : null;
    const db = openDb(config.dbPath);
    const billing = createBillingClient(config);
    const outbox = createVipOutbox({ db, config });
    const domain = createDomain({ db, config, outbox, billing });
    const identity = createIdentity(config);
    const report = await importLive(domain, {
        live, billingSource: bdb ? billingSnapshotSource(bdb) : billingApiSource(billing), resolveLiveUsers: identity.resolveLiveUsers, dryRun: flag('dry-run'),
    });
    if (flag('json')) console.log(JSON.stringify(report, null, 2));
    else {
        const c = report.counts;
        console.log(`import ${report.run_id}${report.dry_run ? ' (DRY RUN — nothing kept)' : ''} · billing source: ${report.billing_source}`);
        console.log(`  live snapshot: ${JSON.stringify(c.live)}; offering ${JSON.stringify(report.live_offering)}`);
        console.log(`  creators ${JSON.stringify(c.creators)}; plans ${JSON.stringify(c.plans)}`);
        console.log(`  memberships ${JSON.stringify(c.memberships)}; live subscriptions ${JSON.stringify(c.live_subscriptions)}`);
        for (const h of report.holds) console.log(`    held: ${JSON.stringify(h)}`);
        for (const x of report.excluded) console.log(`    excluded: ${JSON.stringify(x)}`);
        for (const e of report.billing_errors) console.log(`    billing error: ${JSON.stringify(e)}`);
    }
    live.close();
    if (bdb) bdb.close();
    db.close();
    if (!report.ok) process.exit(1);
}

main().catch((err) => { console.error(`import failed: ${err.message}`); process.exit(1); });
