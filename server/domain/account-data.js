'use strict';

/**
 * Account export and deletion → VIP (ADR-033; openvibe-sdk/account-data). A person is here as a member or a creator.
 *
 *   member    their memberships, badge preferences, entitlement cache (Billing re-sends what is still true) and checkout
 *             hand-offs are deleted. Their paid periods (Billing transaction ids, start, end, reversal) are money
 *             records and stay, counted as retained: VIP's history must still reconcile with Billing's books.
 *   creator   their creator row stays, because plans, perks and other people's memberships reference it, but it is
 *             suspended and loses its username, display name and bio; plans, perks and gated rules they made lose
 *             created_by. Plan versions stay whole: they are the immutable terms members joined under (a trigger keeps
 *             them so), counted as retained.
 *
 * Billing owns payments, balances, refunds and the subscriptions themselves; its own consumer answers for those.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const anonymize = { anonymize: {} };

const TABLES = [
    { table: 'vip_memberships', subject: 'member_subject', file: 'memberships.json', columns: ['id', 'creator_id', 'plan_id', 'plan_version_id', 'origin', 'joined_at', 'terms_since', 'updated_at'], order: 'joined_at' },
    { table: 'vip_member_preferences', subject: 'member_subject', file: 'preferences.json', columns: ['creator_id', 'show_badge', 'listed', 'updated_at'], order: 'updated_at' },
    { table: 'vip_entitlement_projection', subject: 'member_subject', file: 'entitlements.json', columns: ['creator_subject', 'kind', 'active', 'expires_at', 'cancel_at_period_end', 'subscription_status'], order: 'synced_at' },
    { table: 'vip_checkouts', subject: 'member_subject', file: 'checkouts.json', columns: ['id', 'creator_id', 'plan_id', 'provider', 'status', 'created_at', 'updated_at'] },
    { table: 'vip_membership_periods', subject: 'member_subject', file: 'paid-periods.json', columns: ['id', 'creator_subject', 'billing_transaction_id', 'period_start', 'period_end', 'status', 'recorded_at'], order: 'recorded_at', erase: { keep: 'paid periods are money records that reconcile with Billing\'s books' } },
    { table: 'vip_membership_periods', subject: 'reversed_by', file: null, erase: anonymize },
    { table: 'vip_creators', subject: 'subject', file: 'creator-profile.json', columns: ['id', 'username', 'display_name', 'bio', 'status', 'created_at', 'updated_at'], erase: { keep: 'plans, perks and other people\'s memberships reference the creator row; it is suspended and its name and bio removed' } },
    { table: 'vip_plans', subject: 'created_by', file: 'plans.json', columns: ['id', 'creator_id', 'slug', 'status', 'billing_kind', 'latest_version', 'created_at', 'updated_at', 'archived_at'], erase: anonymize },
    { table: 'vip_plan_versions', subject: 'created_by', file: 'plan-versions.json', columns: ['id', 'plan_id', 'version', 'name', 'description', 'benefits', 'terms', 'change_note', 'created_at', 'published_at'], erase: { keep: 'plan versions are the immutable terms members joined under' } },
    { table: 'vip_perks', subject: 'created_by', file: 'perks.json', columns: ['id', 'creator_id', 'key', 'name', 'description', 'kind', 'status', 'created_at'], erase: anonymize },
    { table: 'vip_gated_resource_rules', subject: 'created_by', file: null, erase: anonymize },
];

/** The creator row stays (it is referenced; counted as retained above) but is suspended and loses what names the person. */
async function extraErase(t, subjects) {
    await t.exec(`UPDATE vip_creators SET status = 'suspended', username = NULL, username_lc = NULL, display_name = NULL, bio = NULL,
        updated_at = $2 WHERE kind = 'creator' AND subject = ANY($1::text[])`, [subjects, new Date().toISOString()]);
}

/** The account-data handle for VIP's database (domain.db). */
function create({ db, log = console } = {}) {
    return createAccountData({
        db, service: 'vip', tables: TABLES, extraErase, log,
        note: 'Payments, refunds and subscriptions are OpenVibe.Billing\'s records. Paid periods stay here for its books.',
    });
}

module.exports = { create, TABLES, TOPICS };
