'use strict';

/**
 * VIP's own SQLite database (ADR-007: one database per service), WAL, created on boot, idempotent.
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
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vip_creators (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('creator', 'network')),
    subject       TEXT UNIQUE,
    username      TEXT,
    username_lc   TEXT UNIQUE,
    display_name  TEXT,
    bio           TEXT,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    origin        TEXT NOT NULL DEFAULT 'self' CHECK (origin IN ('self', 'service', 'import', 'staff', 'system')),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    CHECK ((kind = 'network' AND subject IS NULL) OR (kind = 'creator' AND subject IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS vip_plans (
    id                  TEXT PRIMARY KEY,
    creator_id          TEXT NOT NULL REFERENCES vip_creators(id),
    slug                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    billing_kind        TEXT CHECK (billing_kind IS NULL OR billing_kind IN ('channel_subscription')),
    current_version_id  TEXT,
    latest_version      INTEGER NOT NULL DEFAULT 0,
    sort                INTEGER NOT NULL DEFAULT 0,
    created_by          TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    archived_at         TEXT,
    UNIQUE (creator_id, slug)
);
-- Billing sells one channel subscription per (subscriber, creator) today, so a creator can have at
-- most one published plan bound to it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_plans_one_billing_product
    ON vip_plans (creator_id, billing_kind) WHERE status = 'published' AND billing_kind IS NOT NULL;

CREATE TABLE IF NOT EXISTS vip_plan_versions (
    id            TEXT PRIMARY KEY,
    plan_id       TEXT NOT NULL REFERENCES vip_plans(id),
    version       INTEGER NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT,
    benefits      TEXT NOT NULL DEFAULT '[]',
    terms         TEXT NOT NULL,
    change_note   TEXT,
    created_by    TEXT,
    created_at    TEXT NOT NULL,
    published_at  TEXT,
    UNIQUE (plan_id, version)
);
CREATE TRIGGER IF NOT EXISTS vip_plan_versions_no_rewrite BEFORE UPDATE ON vip_plan_versions
WHEN NEW.id IS NOT OLD.id OR NEW.plan_id IS NOT OLD.plan_id OR NEW.version IS NOT OLD.version
  OR NEW.name IS NOT OLD.name OR NEW.description IS NOT OLD.description OR NEW.benefits IS NOT OLD.benefits
  OR NEW.terms IS NOT OLD.terms OR NEW.change_note IS NOT OLD.change_note OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at OR (OLD.published_at IS NOT NULL AND NEW.published_at IS NOT OLD.published_at)
BEGIN SELECT RAISE(ABORT, 'vip_plan_versions are immutable: edit a plan by creating a new version'); END;
CREATE TRIGGER IF NOT EXISTS vip_plan_versions_no_delete BEFORE DELETE ON vip_plan_versions
BEGIN SELECT RAISE(ABORT, 'vip_plan_versions are immutable: edit a plan by creating a new version'); END;

CREATE TABLE IF NOT EXISTS vip_perks (
    id           TEXT PRIMARY KEY,
    creator_id   TEXT NOT NULL REFERENCES vip_creators(id),
    key          TEXT NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT,
    kind         TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('badge', 'emote', 'gated_content', 'room', 'role', 'other')),
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
    created_by   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    UNIQUE (creator_id, key)
);

CREATE TABLE IF NOT EXISTS vip_plan_perks (
    plan_version_id  TEXT NOT NULL REFERENCES vip_plan_versions(id),
    perk_id          TEXT NOT NULL REFERENCES vip_perks(id),
    perk_key         TEXT NOT NULL,
    perk_name        TEXT NOT NULL,
    position         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (plan_version_id, perk_id)
);
CREATE INDEX IF NOT EXISTS idx_vip_plan_perks_key ON vip_plan_perks (plan_version_id, perk_key);
CREATE TRIGGER IF NOT EXISTS vip_plan_perks_no_update BEFORE UPDATE ON vip_plan_perks
BEGIN SELECT RAISE(ABORT, 'vip_plan_perks belong to an immutable plan version'); END;
CREATE TRIGGER IF NOT EXISTS vip_plan_perks_no_delete BEFORE DELETE ON vip_plan_perks
BEGIN SELECT RAISE(ABORT, 'vip_plan_perks belong to an immutable plan version'); END;

CREATE TABLE IF NOT EXISTS vip_product_bindings (
    id          TEXT PRIMARY KEY,
    perk_id     TEXT NOT NULL REFERENCES vip_perks(id),
    product     TEXT NOT NULL,
    binding     TEXT NOT NULL,
    config      TEXT NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (perk_id, product, binding)
);

CREATE TABLE IF NOT EXISTS vip_member_preferences (
    member_subject  TEXT NOT NULL,
    creator_id      TEXT NOT NULL REFERENCES vip_creators(id),
    show_badge      INTEGER NOT NULL DEFAULT 1,
    listed          INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (member_subject, creator_id)
);

CREATE TABLE IF NOT EXISTS vip_gated_resource_rules (
    id                TEXT PRIMARY KEY,
    creator_id        TEXT NOT NULL REFERENCES vip_creators(id),
    resource_service  TEXT NOT NULL,
    resource_type     TEXT NOT NULL,
    resource_id       TEXT NOT NULL,
    requirement       TEXT NOT NULL CHECK (requirement IN ('member', 'plan', 'perk')),
    plan_id           TEXT REFERENCES vip_plans(id),
    perk_key          TEXT,
    sensitive         INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_by        TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    CHECK (requirement <> 'plan' OR plan_id IS NOT NULL),
    CHECK (requirement <> 'perk' OR perk_key IS NOT NULL)
);
-- One active rule per (resource, creator): the product names the owner when it asks (policies.js).
DROP INDEX IF EXISTS idx_vip_rules_resource;
CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_rules_resource_creator
    ON vip_gated_resource_rules (resource_service, resource_type, resource_id, creator_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS vip_migration_maps (
    source        TEXT NOT NULL,
    source_table  TEXT NOT NULL,
    source_id     TEXT NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    status        TEXT NOT NULL CHECK (status IN ('imported', 'linked', 'held', 'excluded')),
    reason        TEXT,
    run_id        TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (source, source_table, source_id)
);

CREATE TABLE IF NOT EXISTS vip_memberships (
    id                       TEXT PRIMARY KEY,
    member_subject           TEXT NOT NULL,
    creator_id               TEXT NOT NULL REFERENCES vip_creators(id),
    plan_id                  TEXT REFERENCES vip_plans(id),
    plan_version_id          TEXT REFERENCES vip_plan_versions(id),
    billing_subscription_id  TEXT,
    origin                   TEXT NOT NULL CHECK (origin IN ('checkout', 'billing', 'import')),
    joined_at                TEXT NOT NULL,
    terms_since              TEXT NOT NULL,
    updated_at               TEXT NOT NULL,
    UNIQUE (member_subject, creator_id)
);
CREATE INDEX IF NOT EXISTS idx_vip_memberships_creator ON vip_memberships (creator_id);

CREATE TABLE IF NOT EXISTS vip_entitlement_projection (
    member_subject         TEXT NOT NULL,
    creator_subject        TEXT NOT NULL,
    kind                   TEXT NOT NULL,
    active                 INTEGER NOT NULL,
    expires_at             TEXT,
    cancel_at_period_end   INTEGER NOT NULL DEFAULT 0,
    subscription_id        TEXT,
    subscription_status    TEXT,
    source                 TEXT NOT NULL CHECK (source IN ('event', 'billing_check', 'import')),
    last_reason            TEXT,
    billing_event_id       TEXT,
    billing_as_of          INTEGER NOT NULL,
    synced_at              INTEGER NOT NULL,
    valid_until            INTEGER NOT NULL,
    last_used_at           INTEGER,
    PRIMARY KEY (member_subject, creator_subject, kind)
);
CREATE INDEX IF NOT EXISTS idx_vip_projection_creator ON vip_entitlement_projection (creator_subject, kind, active);

CREATE TABLE IF NOT EXISTS vip_checkouts (
    id                       TEXT PRIMARY KEY,
    member_subject           TEXT NOT NULL,
    creator_id               TEXT NOT NULL REFERENCES vip_creators(id),
    plan_id                  TEXT NOT NULL REFERENCES vip_plans(id),
    plan_version_id          TEXT NOT NULL REFERENCES vip_plan_versions(id),
    provider                 TEXT NOT NULL,
    status                   TEXT NOT NULL CHECK (status IN ('created', 'handed_off', 'paid', 'failed', 'used')),
    billing_intent_id        TEXT,
    billing_subscription_id  TEXT,
    checkout_url             TEXT,
    checkout_ref             TEXT,
    error                    TEXT,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vip_checkouts_member ON vip_checkouts (member_subject, creator_id, created_at);
`;

function openDb(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db);
    return db;
}

function migrate(db) {
    db.exec(SCHEMA);
    const now = new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO settings (id, created_at) VALUES (1, ?)').run(now);
    // The network itself offers network-wide plans and owns network perks.
    db.prepare(`INSERT OR IGNORE INTO vip_creators (id, kind, subject, username, username_lc, display_name, origin, created_at, updated_at)
        VALUES ('network', 'network', NULL, NULL, NULL, 'OpenVibe', 'system', ?, ?)`).run(now, now);
}

module.exports = { openDb, migrate };
