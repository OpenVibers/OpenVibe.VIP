# AGENTS.md — OpenVibe.VIP

## Project overview

OpenVibe.VIP (`https://openvibe.vip`) is membership on the OpenVibe network: creator and network plans
with versioned terms, perks, gated-resource policy, members-only posts, and a product-wide answer to
"is this person a member, and may they see this?". VIP owns plans and perks; **Billing owns
subscriptions, prices and the entitlement truth** (ADR-012).

- **Entry:** `server/index.js`; app `server/app.js`; port `4620`, service id `vip`.
- **API:** `server/api/v1.js`, auth `server/api/auth.js`, limits `server/api/actor-limits.js`.
- **Domain:** `server/domain/` — `plans.js` (versions), `perks.js`, `policies.js` (gated resources),
  `memberships.js`, `entitlements.js` (projection), `periods.js`, `checkout.js`, `posts.js`,
  `prices.js`, `creators.js`, `cards.js`, `markdown.js`, `account-data.js`, `index.js`.
- **Pages and embeds:** `server/web/` (`pages.js`, `routes.js`, `layout.js`, `session.js`,
  `embeds.js`, `forms.js`, `short.js`); the public card/badge/embed at `/embed`; `public/js/vip.js`
  and `post-upload.js`; own CSS in `public/css`.
- **Consumer client:** `client/vip-client.js` — the package products use to check membership and gate
  a resource, with the product cache and its convergence bound (README "Consumer seam").
- **Docs:** `docs/cutover-0002-renewal-periods.md` (renewal periods/grace), `SECURITY.md`.

## Owns, does not own

VIP is the only writer of the nine authority tables: `vip_creators`, `vip_plans`,
`vip_plan_versions` (immutable; triggers refuse UPDATE/DELETE except the publish stamp), `vip_perks`,
`vip_plan_perks` (immutable per version), `vip_product_bindings`, `vip_member_preferences`,
`vip_gated_resource_rules` and `vip_migration_maps`. Operational tables: `vip_memberships` (which plan
version a membership was bought under — never whether it is active), `vip_entitlement_projection` (a
cache with `valid_until`), `vip_checkouts`, `vip_membership_periods` (Billing's charge records),
`event_outbox` and `idempotency_receipts`.

Does not own: subscription contracts, prices, charges, renewals, cancellations, refunds, chargebacks or
canonical entitlements (Billing — VIP never prices anything and never moves money; plan terms carry no
price); identities (Network); products' own resources (only an EntityRef); badge rendering (each
product).

## Who calls it, what it calls

People use the pages/API with a Network user JWT and act on their own plans, perks, rules, members,
memberships and checks; staff with `staff.site.configure` manage network plans. Services use
client-credentials tokens for audience `openvibe.vip` with one `vip.*` capability per route. Products
consume VIP through `client/vip-client.js` / SDK `openvibe-sdk/vip` and the product cache: Chat (member
badge), Community (members-only spaces/threads), Blog (members-only posts), Wiki (VIP spaces/pages);
Live is not wired. VIP calls Billing (`billing.intent.create`, `billing.subscription.manage`,
`billing.entitlement.check`), Network (JWKS, OAuth), Events (Billing deliveries in, VIP outbox out) and
Media (a members-only post's image, `media.object.upload`, `vip` tenant; without it the post has none).

## Database and migrations

PostgreSQL `ov_vip` through `openvibe-sdk/db` (PgBouncer for the app, direct owner role for
migrations); Valkey optionally holds per-actor limit counters. Migrations `0001..0007` include plan
tiers, account data, telemetry, member posts and the outbox rejection index; applied at boot, never
edited after they run, only additive so a rollback works. The immutability of plan versions and
plan-perks is enforced by database triggers, not only by code.

## Entitlements and auth

Every API route checks one capability (service) or ownership (person); the API never reads cookies.
Billing events arrive HMAC-SHA256-signed over the raw body (`VIP_EVENTS_SECRET`, rotation by list),
`source` must be `billing`, the inbox is exactly-once and the ordering guard rejects a stale period.
**Fail closed everywhere a membership is decided:** "unknown" is never "yes"; the projection has a
`valid_until` and a convergence bound, and an expired/unsynced row is not a membership.

## Deploy

`sudo ovhost deploy vip` (git-checkout: fast-forward `/opt/openvibe.vip`, install on a lockfile
change, restart, wait for `/api/ready`; rollback `sudo ovhost rollback vip --to <sha>`). Unit
`openvibe-vip.service` on `127.0.0.1:4620`, env `/etc/openvibe/vip.env`, database `ov_vip`, nginx
`deploy/nginx/openvibe.vip.conf` (live since 2026-10-17). The release migrates at boot.

## Commands and tests

```bash
npm ci
npm run dev                 # http://127.0.0.1:4620
npm test                    # every test/*.test.js, in-process Network/Billing stubs
npm test -- plans import    # only matching files
npm run test:pg             # the same on PostgreSQL
npm run subscribe           # create the Events subscriptions once
```

`test/run.js` uses `openvibe-shared/test-runner` (60 s, serial); temp databases and stubs, never the
network. Tests cover immutable plan versions, perks/bindings, gated policy incl. sensitive resources,
the Billing projection and convergence, renewal periods/grace/refunds, checkout/cancel, member posts,
the consumer client/cache, the embed/card, account export/deletion (a paid period stays), and the
pages.

## Conventions and pitfalls

- CommonJS, 4-space indent, single quotes, semicolons; RFC 9457 problem+json; escaped HTML and a safe
  Markdown renderer (a post source can never carry markup).
- **Never store "is a member".** `vip_memberships` says which version was bought; access is answered
  by the entitlement check/projection, and a projection row is a cache with a validated `valid_until`.
- **Never put a price in plan terms.** The terms say Billing sets and charges it; `vip_prices` is a
  display of Billing's numbers, not an authority.
- **Immutability is real:** do not add an UPDATE path to `vip_plan_versions`/`vip_plan_perks`; publish
  stamps once, then a new version is a new row.
- **A gated resource rule is policy, not content:** add a `{service, type, id}` EntityRef rule and a
  product binding; the product still renders its own resource.
- **Billing is exactly-once and ordered:** a redelivery, a stale `billing.entitlement.changed` or a
  reversed transaction must converge, not double-count a period or grant access after a refund.
- **Deleting a member does not delete the books:** memberships/preferences/projection/checkouts go,
  paid periods stay; a deleted creator is suspended without their name but plan versions members joined
  under stay whole.
