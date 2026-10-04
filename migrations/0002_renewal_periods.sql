-- phase: expand
-- Renewal and refund convergence on OpenVibe.Billing (T5 step 11): one row per paid period, keyed by the Billing
-- transaction that paid it, so VIP can show that every paid period has a charge record and that a reversed one is
-- not counted. Additive only: a new table and a nullable column. Rolling back the code leaves both unused.

CREATE TABLE vip_membership_periods (
    id                       text COLLATE "C" PRIMARY KEY,
    member_subject           text COLLATE "C" NOT NULL,
    creator_subject          text COLLATE "C" NOT NULL,
    billing_subscription_id  text COLLATE "C",
    billing_transaction_id   text COLLATE "C" NOT NULL,
    period_start             text COLLATE "C",
    period_end               text COLLATE "C",
    status                   text COLLATE "C" NOT NULL CHECK (status IN ('paid', 'reversed')),
    reversed_by              text COLLATE "C",
    reason                   text COLLATE "C",
    recorded_at              text COLLATE "C" NOT NULL,
    updated_at               text COLLATE "C" NOT NULL,
    UNIQUE (billing_transaction_id)
);
CREATE INDEX idx_vip_periods_pair ON vip_membership_periods (member_subject, creator_subject, status, period_end);

-- past_due: when Billing stops retrying a failed renewal (null outside a renewal grace)
ALTER TABLE vip_entitlement_projection ADD COLUMN grace_until text COLLATE "C";
