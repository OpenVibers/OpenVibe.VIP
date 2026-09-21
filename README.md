# OpenVibe.VIP

> Memberships: plans, perks and benefits recognised across every OpenVibe site.

**Status:** placeholder — planning only, no runnable code yet.  
**Domain:** `openvibe.vip`  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §11.3.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

Creator and network membership plans and perks with product bindings. Billing remains the subscription and entitlement truth; VIP owns plan versions, perk definitions, member/creator UX and gated-resource policy references.

## Owns

- `vip_creators`, `vip_plans`, `vip_plan_versions`, `vip_perks`, `vip_plan_perks`, `vip_product_bindings`, `vip_member_preferences`, `vip_gated_resource_rules`, `vip_migration_maps`

## Does not own

- subscription contracts, charges, renewals, refunds, canonical entitlements (Billing)

## Planned surfaces

- plan/perk management, member status, checkout hand-off, badges/cards/widgets
- entitlement projection client with a direct authoritative check for sensitive actions

## Data (authority tables / families)

- see above

## Capabilities and events

- `vip.plan.*`, `vip.perk.*`, `vip.membership.checkout|status`, `vip.entitlement.check`, `vip.resource.policy.get|evaluate`, `vip.creator.members.list`

Events: ``vip.plan.published``, ``vip.membership.changed` (projection of Billing events)`

## Depends on

- OpenVibe.Billing
- OpenVibe.Network
- OpenVibe.Events
- consumers: Live, Chat, Community, Blog, Wiki

## Acceptance (must be true before "done")

- cancel/renew/refund converges across all consuming products within the defined window
- plan edits are versioned and never rewrite historical terms
- a stale cache cannot authorise indefinitely
- VIP works with Live unavailable

## Bootstrap / extraction source

Live's channel-subscription behaviour and perks, reconciled into Billing first.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
