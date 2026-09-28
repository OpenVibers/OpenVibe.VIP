'use strict';

/**
 * VIP's own PostgreSQL database (ADR-007: one database per service; ADR-035): the schema is migrations/NNNN_*.sql, applied at boot.
 *
 * Authority tables (the nine the charter names; VIP is their only writer):
 *   vip_creators               a creator (or the network) that offers memberships
 *   vip_plans                  a plan: status, which Billing product it is sold as, current version
 *   vip_plan_versions          IMMUTABLE plan terms, one row per edit (triggers refuse UPDATE/DELETE
 *                              of anything but the one-time publish stamp)
 *   vip_perks                  a perk definition (creator or network scope)
 *   vip_plan_perks             IMMUTABLE: which perks a plan VERSION includes (snapshot of key/name)
 *   vip_product_bindings       how a perk shows up in a product (live chat badge, chat room, …)
 *   vip_member_preferences     a member's preferences per creator (badge display, listing)
 *   vip_gated_resource_rules   "resource R in product P needs membership / perk K of creator C"
 *   vip_migration_maps         legacy source row → VIP target, with status and reason
 *
 * Operational tables (not authority for anything outside VIP):
 *   vip_memberships            which plan VERSION a membership was bought under (VIP's record of
 *                              terms; active/expired is never stored here — that is Billing's)
 *   vip_entitlement_projection a cache of Billing's entitlements, fed by Billing events and direct
 *                              checks, with valid_until; never authorizes past it
 *   vip_checkouts              checkout hand-offs to Billing (which version the member chose)
 *   event_outbox, idempotency_receipts   openvibe-sdk outbox and inbox
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

/**
 * The serving handle (ADR-035): DATABASE_URL through PgBouncer; in development without it, an embedded PGlite database
 * in data/pglite. Migrations run first, as the owner (DATABASE_DIRECT_URL), or on the embedded handle; they also seed
 * the settings row and the network creator.
 */
async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh vip)');
        log.warn(`[VIP] DATABASE_URL unset: embedded PGlite database in ${DEV_PGLITE} (development only, one process)`);
        fs.mkdirSync(DEV_PGLITE, { recursive: true });
        const db = createDb({ pglite: DEV_PGLITE, service: 'vip', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'vip-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'vip', registry, log });
}

module.exports = { openDb, MIGRATIONS };
