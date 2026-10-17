-- phase: expand
-- Tiers (owner's ask: creator memberships with tiers; openvibe-contracts 0.201.0): a plan sold through Billing names the
-- tier it is sold as, and Billing prices each tier (billing.tier.manage, ADR-012). A creator now publishes one plan per
-- tier instead of one plan in all. Every existing plan is tier 1, which Billing sells at its default price until the
-- creator sets one, so nothing a member bought changes.
ALTER TABLE vip_plans ADD COLUMN billing_tier integer NOT NULL DEFAULT 1 CHECK (billing_tier BETWEEN 1 AND 10);
CREATE UNIQUE INDEX idx_vip_plans_one_per_tier
    ON vip_plans (creator_id, billing_kind, billing_tier) WHERE status = 'published' AND billing_kind IS NOT NULL;
DROP INDEX idx_vip_plans_one_billing_product;
