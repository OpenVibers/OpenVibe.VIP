-- phase: expand
-- Members-only posts (owner's ask, plan 2026-10-22 §4 "Creator money: Tips, VIP": members-only posts on
-- creator pages). A creator writes a post for the members of one or more of their tiers: the tiers are
-- Billing's tiers of that creator (vip_plans.billing_tier), the title and body are the creator's, and an
-- optional image is a Media object (med_…, the bytes live in OpenVibe.Media).
--
-- The body is never read with the list of posts: it is served only after the entitlement check
-- (server/domain/posts.js), so a signed-out visitor and a non-member never receive it.
CREATE TABLE IF NOT EXISTS vip_member_posts (
    id           text COLLATE "C" PRIMARY KEY,
    creator_id   text COLLATE "C" NOT NULL REFERENCES vip_creators(id),
    title        text COLLATE "C" NOT NULL,
    body         text COLLATE "C" NOT NULL,
    body_html    text COLLATE "C" NOT NULL,
    tiers        text COLLATE "C" NOT NULL DEFAULT '[]',
    image_id     text COLLATE "C",
    image_url    text COLLATE "C",
    status       text COLLATE "C" NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
    created_by   text COLLATE "C",
    created_at   text COLLATE "C" NOT NULL,
    updated_at   text COLLATE "C" NOT NULL,
    published_at text COLLATE "C",
    hidden_at    text COLLATE "C",
    hidden_by    text COLLATE "C",
    hide_reason  text COLLATE "C"
);
CREATE INDEX IF NOT EXISTS idx_vip_member_posts_creator ON vip_member_posts (creator_id, published_at DESC);
