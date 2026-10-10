# OpenVibe.VIP

> Memberships: plans, perks and benefits recognised across every OpenVibe site.

**Status:** alpha — runtime built and tested (roadmap Wave 10). Deployed internally, **not launched**:
it runs on the host since 2026-09-23 on `127.0.0.1:4620` only, holding the Live import (on 2026-09-24:
44 creators, 43 plans, 0 memberships), with checkout closed. `openvibe.vip` keeps its
[OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) placeholder until the launch rule
below holds.  
**Domain:** `openvibe.vip` (port 4620, service id `vip`)  
**Decision:** [ADR-012](https://github.com/OpenVibers/OpenVibe.Contracts/blob/main/docs/adr/ADR-012-economic-classification.md) —
Billing holds the entitlement truth; VIP holds plans and perks.  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §11.3; roadmap §15.11, §29, Wave 10.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

Creator and network membership plans and perks with product bindings. A creator publishes a plan;
a member joins it through OpenVibe.Billing; every OpenVibe product can ask VIP whether a person is a
member and whether they may see a members-only resource. VIP owns plan versions, perk definitions,
member and creator UX and gated-resource policy; Billing remains the subscription and entitlement
truth.

## Owns

The nine authority tables (VIP is their only writer):

| Table | Holds |
|---|---|
| `vip_creators` | a creator (a Network `usr_` subject, with a cached handle for `/:username`) or the network itself |
| `vip_plans` | a plan: status (draft/published/archived), the Billing product it is sold as, its current version |
| `vip_plan_versions` | **immutable** plan terms, one row per edit (database triggers refuse UPDATE/DELETE except the one-time publish stamp) |
| `vip_perks` | perk definitions (creator or network scope): badge, emote, gated content, room, role, other |
| `vip_plan_perks` | **immutable**: which perks a plan *version* includes, with the key and name it was published with |
| `vip_product_bindings` | how a perk shows up in a product (`live chat_badge`, `chat badge`, `blog gated_post`, …) |
| `vip_member_preferences` | per member and creator: show the badge, be listed |
| `vip_gated_resource_rules` | "resource `{service, type, id}` is for members of creator C (of plan P / with perk K)", optionally *sensitive* |
| `vip_migration_maps` | legacy source row → VIP target, with status (`imported`, `linked`, `held`, `excluded`) and reason |

Operational tables, authority for nothing outside VIP: `vip_memberships` (which plan **version** a
membership was bought under — never whether it is active), `vip_entitlement_projection` (a cache of
Billing entitlements with `valid_until`), `vip_checkouts` (checkout hand-offs), and the openvibe-sdk
`event_outbox` / `idempotency_receipts`. `vip_memberships` is a tenth table the charter did not
list; it is needed so that "a membership always points at the version it was bought under" has a
home that is not a cache. An eleventh, `vip_membership_periods` (migration 0002), is the per-period
charge ledger described under "Renewals, grace and refunds" below; it is a record of Billing's
transactions, not an authority for anything.

## Does not own

- subscription contracts, prices, charges, renewals, cancellations, refunds, chargebacks and the
  canonical entitlements — **OpenVibe.Billing**. VIP never prices anything and never moves money;
  plan terms carry no price (`"price": "set and charged by OpenVibe.Billing"`).
- identities (OpenVibe.Network), the products' own resources (Blog posts, Chat rooms, …: VIP stores
  only an EntityRef), badges' rendering (each product).

## Depends on

- **OpenVibe.Billing** — checkout (`billing.intent.create`), credit-paid periods and cancel
  (`billing.subscription.manage`), the authoritative check and subscription lists (`billing.entitlement.check`),
  and its events `billing.entitlement.changed`, `billing.subscription.canceled`, `billing.transaction.reversed`.
- **OpenVibe.Network** — RS256 service and user tokens (JWKS), OAuth sign-in for the pages.
- **OpenVibe.Events** — delivery of Billing's events to `/internal/events`; relay of VIP's outbox.
- **PostgreSQL 18 and Valkey 9** (OpenVibe.Host `roles/data/`, ADR-035): every read and write is async through `openvibe-sdk/db`; Valkey holds the per-actor limit counters (optional).
- **openvibe-contracts** v0.76.0, **openvibe-sdk** v0.28.0 (outbox, inbox, delivery signatures, per-actor
  limits), **openvibe-shared** v2.2.0 (Frame, legal pages, release manifest and update metrics, metrics,
  readiness).
- Consumers, through the client below: Chat (the member badge), Community (members-only spaces and
  threads), Blog (members-only posts) and Wiki (VIP spaces and pages); Live is not wired yet.
- **Not** OpenVibe.Live: VIP works with Live unavailable (nothing here calls Live).

## Capabilities

Implemented here (the service manifest's `capabilities`, 14 `vip.*` ids, audience `openvibe.vip`):
`vip.plan.create|update|archive|list`, `vip.perk.create|update|list`, `vip.membership.checkout|status`,
`vip.entitlement.check`, `vip.resource.policy.get|set|evaluate` and `vip.creator.members.list`.

Called elsewhere, as the service principal `vip`:

| Service | Grant | Why |
|---|---|---|
| OpenVibe.Billing | `billing.intent.create`, `billing.subscription.manage`, `billing.entitlement.check` | checkout, credit-paid periods and cancel, the authoritative check |
| OpenVibe.Events | `events.event.publish`; `events.subscription.manage` (`scripts/subscribe.js`, and at boot) | the outbox relay; the three subscriptions for Billing's events; the two account subscriptions (created at boot when missing) |
| OpenVibe.Network | `network.account.export.contribute`, `network.account.deletion.confirm` (granted last, once this release is live) | account export and deletion (ADR-033) |

## Run it

```bash
fnm exec --using=22.22.1 npm install
cp .env.example .env                 # OV_OAUTH_CLIENT_SECRET, VIP_FORM_SECRET, VIP_EVENTS_SECRET, BILLING_URL …
fnm exec --using=22.22.1 npm run dev # http://localhost:4620
fnm exec --using=22.22.1 npm test    # every test/*.test.js: stub Network + Billing, temp DBs, random ports, injected clock
node scripts/subscribe.js            # create the three Events subscriptions for Billing's events
```

Production (deployed, loopback only): `/opt/openvibe.vip`, env `/etc/openvibe/vip.env`, unit
[deploy/systemd/openvibe-vip.service](deploy/systemd/openvibe-vip.service).
The vhost [deploy/nginx/openvibe.vip.conf](deploy/nginx/openvibe.vip.conf) is not installed yet:
`openvibe.vip` still serves the Sites placeholder. The three Events subscriptions exist.

## Design

### Versioned plans

- Creating a plan writes version 1. **Every edit writes version N+1**; nothing ever updates an earlier
  version (triggers enforce it). An edit of a published plan is published at once and becomes what
  new members buy (`vip.plan.published`); a draft's edits stay drafts until published.
- A membership records the version it was bought under: the member's own checkout hand-off, or —
  for a subscription bought elsewhere (e.g. on Live before its cutover) — the creator's current
  purchasable version at the moment Billing granted it. **Renewals keep that version**, however
  often the plan changes; a new purchase after the membership lapsed takes the current version.
- Perk rules evaluate the perks of the member's version, not the plan's latest.
- Renaming a perk never changes published terms (each version keeps its snapshot).
- Billing sells one channel subscription per (member, creator) today, so a creator has at most **one
  published plan sold through Billing** (a unique index; a second is refused with
  `409 vip.plan.billing_product_taken`). Tiers and network memberships need a Billing product first:
  a network plan (staff) can be published as terms, but checkout answers `409 vip.checkout.unavailable`.
- Archiving stops new members; existing members keep their terms until Billing ends the membership.

### The entitlement projection (Billing is the truth)

`vip_entitlement_projection` is a cache of Billing's entitlements, fed by Billing's events
(signed Events webhook + openvibe-sdk `createPgInbox`, exactly once) and by direct checks.

- `valid_until = min(paid period end, last word from Billing + VIP_PROJECTION_MAX_AGE_MS)`; a "no"
  is kept for the max age.
- `now ≤ valid_until`: the projection answers. Past it, mode `auto` asks Billing
  (`GET /api/v1/entitlements/:subject?streamer=`) and re-projects; only if Billing cannot answer
  and we are within `VIP_PROJECTION_GRACE_MS` does it return the stale answer (flagged `stale: true`).
- After the grace, **VIP answers `"unknown"`, which never authorizes** — a stale cache cannot
  authorize indefinitely, whatever the paid period says.
- Mode `authoritative` (sensitive actions: checkout, cancel, rules marked *sensitive*) always asks
  Billing and answers `unknown` when it cannot.
- Ordering: each row remembers the Billing time it reflects. An older event that would grant is
  ignored; an older event that would revoke puts the row in doubt (`valid_until = 0`), so the next
  check goes to Billing — out-of-order delivery can deny briefly, never grant wrongly.
- `billing.transaction.reversed` that revoked periods puts the pair in doubt at once, even before (or
  without) the matching `billing.entitlement.changed`.
- Convergence window: seconds when events flow; when every event for a change is lost, at most
  `VIP_PROJECTION_MAX_AGE_MS + VIP_PROJECTION_GRACE_MS` (15 min + 60 s by default), and never past
  the paid period's end for renewals and cancellations.
- A background job re-confirms, with Billing, projections that products used in the last hour
  before they go stale.

### Renewals, grace and refunds (Billing does them; VIP records and converges)

- A membership renews by **Billing's own sweep**: one charge per period from the subscriber's credit,
  idempotent on `renew:<subscription id>:<period end>`, so a retried or replayed renewal never charges
  twice. VIP has no renewal call; it projects `billing.entitlement.changed` (`reason: renewed`), and a
  renewal keeps the plan version the membership already has.
- **Charge ledger.** `vip_membership_periods` holds one row per paid period, unique on the Billing
  transaction (`billing_transaction_id`), written from a `granted`/`renewed` entitlement event that names
  its `transaction_id` and from the credit checkout answer. A replayed event, or the same transaction
  again, never records a second row. `billing.transaction.reversed` marks the period it reverses as
  `reversed` (`reversed_by` = the reversing transaction); if the reversal arrives **before** the grant
  event, a tombstone is written and the grant that follows leaves it reversed and grants nothing.
  Provider refunds and chargebacks (`entitlements_revoked`) and credit refunds of a subscription period
  (`metadata.original_type = subscription`) both count; a reversal of anything else is ignored.
- **Renewal grace.** When a renewal charge fails Billing moves the subscription to `past_due` until
  `grace_until`, retrying on the same key, then ends it (`grace_ended`). VIP stores both
  (`vip_entitlement_projection.grace_until`), answers `status: inactive` with
  `grace: { until, reason: "renewal_failed" }` while the grace runs (`null` otherwise), and **never
  authorizes a `past_due` row**, whatever an event says. After the grace the membership row is kept and
  inactive; a later paid renewal restores it on the same plan version. `vip.membership.changed` carries
  `renewal_failed` / `grace_ended` as its `reason`; its payload is unchanged.
- **Audit.** `periods.audit()` runs with the projection refresh job: an active, fresh row that claims a
  payment (last word `granted`/`renewed`, or the pair already has ledger rows) without a `paid` period
  reaching its `expires_at`, or whose period was reversed, is logged, counted (`vip_period_audit_offenders`)
  and put in doubt (`valid_until = 0`) so the next check asks Billing. Pairs VIP only knows from a Billing
  check (imports, shadow entitlements) are not audited until a payment event names them.

### Checkout and cancellation (Billing does both)

- `POST /api/v1/checkout` asks Billing first (a member cannot buy twice), records the plan version
  chosen, and hands off: `provider: credit` → Billing `POST /subscriptions` (paid from Vibes credit,
  membership starts at once); any other provider → Billing `POST /intents` (kind subscription),
  returning Billing's `checkout_url` or PowerChat `checkout_ref`. The membership starts when Billing's
  settlement event arrives. Idempotency keys come from VIP's ids (`vip:checkout:<id>`).
- Cancel is the member's own action: VIP confirms with Billing that the subscription is theirs, then
  Billing `POST /subscriptions/:id/cancel` (at period end).

### Events (openvibe-sdk outbox, same transaction as the change)

| Event | When | Payload |
|---|---|---|
| `vip.plan.published` (public) | a plan version becomes what new members buy | plan id, slug, version, version id, creator, billing_kind, full terms |
| `vip.membership.changed` (internal) | a member's standing changed as projected from Billing (granted, renewed, cancel_scheduled, canceled, expired, refund, …) | member, creator, active, expires_at, cancel_at_period_end, previous, reason, plan id, plan version, source, Billing event id |

## API (`/api/v1`)

Service tokens: Network client-credentials, audience `openvibe.vip`, one capability per route (the
`vip.*` ids are released in openvibe-contracts v0.19.0; the drafts stay in
[docs/capabilities-proposal/](docs/capabilities-proposal/); grants are matched with contracts'
`capabilities.grants()` — exact id or a `.*` family). User tokens: a Network user JWT; people act on their own things (their plans,
perks, rules, members; their own memberships and checks); staff holding `staff.site.configure` (the contracts staff map) manage
network plans. Errors are RFC 9457 problem+json. Creators are named by SubjectRef, `usr_` id, VIP
handle or `network`.

| Method & path | Capability (services) | Users | Does |
|---|---|---|---|
| `GET /api/health`, `/api/ready`, `/release.json`, `/metrics` | — | — | liveness; truthful readiness (db required; Network key and Billing optional → degraded); release; loopback metrics |
| `GET /creators/:ref` | — (public) | owner sees drafts | creator, published plans, own perks |
| `GET /creators/:ref/card` | — (public) | — | the membership card (below), the same as `/embed/:username/card.json` |
| `GET /plans?creator=&include=drafts,archived` | `vip.plan.list` for drafts | owner | plans with current/draft versions |
| `GET /plans/:id`, `GET /plans/:id/versions` | `vip.plan.list` for drafts | owner | a plan; its version history (published versions are public) |
| `POST /plans` | `vip.plan.create` (body `creator`) | self / staff for `network` | create (v1), optionally `publish` |
| `PATCH /plans/:id` | `vip.plan.update` | owner | edit → new version |
| `POST /plans/:id/publish` | `vip.plan.update` | owner | publish the latest version |
| `POST /plans/:id/archive` | `vip.plan.archive` | owner | archive |
| `GET /perks?creator=&network=&retired=` | `vip.perk.list` for retired | owner | perks with product bindings |
| `POST /perks`, `PATCH /perks/:id` | `vip.perk.create` / `vip.perk.update` | owner | define / edit a perk and its bindings |
| `POST /checkout` | `vip.membership.checkout` (body `subject`) | self | hand-off to Billing: `{ checkout, membership_started, checkout_url, checkout_ref }` |
| `GET /memberships/:subject[?mode=]` | `vip.membership.status` | self | memberships, version bought under, entitlement, preferences |
| `POST /memberships/:creator/cancel` | — | self only | cancel at period end through Billing |
| `PUT /memberships/:creator/preferences` | — | self only | `{ show_badge, listed }` |
| `GET\|POST /entitlements/check` `{subject, creator, mode, product?}` | `vip.entitlement.check` | self | `{ status: active\|inactive\|unknown, active, expires_at, cancel_at_period_end, source, stale, valid_until, membership }`; with `product` also `product_perks` (the member's version perks bound to that product, with each binding's config, e.g. Chat's `badge`) and `preferences` (`show_badge`) |
| `GET /policies?service=&type=&id=&owner=` / `?creator=` (services must name `owner`; a person defaults to themselves) | `vip.resource.policy.get` | owner | the rule for a resource / a creator's rules |
| `POST /policies`, `DELETE /policies/:id` | `vip.resource.policy.set` | owner | gate / un-gate a resource `{resource, requirement: member\|plan\|perk, plan_id, perk_key, sensitive}` |
| `POST /policies/evaluate` `{subject, resource, owner, rule_id?, mode?, fallback?}` — `owner` = the creator the PRODUCT says owns the resource (usr_ id or `network`); only that creator's rule applies, none → `owner_required`. `fallback` `{ requirement: 'member', binding?: 'product:binding' }` = the product's default gate, used only when the owner has no rule (below) | `vip.resource.policy.evaluate` | self | `{ allow, reason, rule, entitlement, fallback? }` — **fails closed** |
| `GET /creators/:ref/members` | `vip.creator.members.list` | owner / staff | active members with their plan version; from Billing, or the labelled projection when Billing is down |

Evaluate reasons: `member`, `owner`, `no_rule`, `rule_mismatch`, `rule_disabled`, `invalid_resource`,
`invalid_fallback`, `creator_unavailable`, `not_signed_in`, `not_a_member`, `entitlement_unknown`,
`plan_required`, `perk_missing`. Only `allow: true` allows.

**The product's default gate (`fallback`).** A product that marks its own resource members-only (a Blog
post, a Community space or thread) does not register a VIP rule per resource. It asks with
`fallback: { requirement: 'member', binding: 'blog:gated_post' }`, which applies only when the owner
has no active rule for that resource — a rule the creator sets in VIP (plan or perk requirement,
sensitive) always wins. Under the fallback the viewer needs an active entitlement to the owner and,
when the owner defines an active perk carrying that product binding, a plan version that includes one
of those perks (`perk_missing` otherwise). A creator VIP has never seen is asked of Billing as is.
The answer has `fallback: true` and `rule: null`.

## Consumer seam: `openvibe-vip/client`

A module with no dependencies for Blog, Wiki, Chat, Live and Community
([client/vip-client.js](client/vip-client.js)). Every failure — VIP unreachable, a timeout, a refused
token, a malformed answer — is a denial, never an exception and never a "yes".

```js
const { createVipClient } = require('openvibe-vip/client');
const tokens = contracts.serviceAuth.createTokenClient({ tokenUrl: `${NETWORK}/oauth/token`, clientId, clientSecret,
    audience: 'openvibe.vip', scope: 'vip.resource.policy.evaluate vip.entitlement.check' });
const vip = createVipClient({ baseUrl: 'http://127.0.0.1:4620', tokenClient: tokens, timeoutMs: 2000 });

const d = await vip.evaluate({ subject: viewer ? viewer.subject : null, resource: { service: 'blog', type: 'post', id: '42' } });
if (!d.allow) return renderMembersOnlyTeaser(d.reason);

await vip.isMember(viewerSubject, creatorSubject);                  // boolean; false on any doubt
await vip.checkEntitlement({ subject, creator, mode: 'authoritative' }); // sensitive content
```

Until the SDK grows a `vip` module, consumers pin this repository's tag tarball and require only
`openvibe-vip/client` (it loads nothing else), or vendor the file verbatim with the commit it was
copied from (Chat, Community and Blog do, in `server/vip/vip-client.js`, until a VIP tag is published);
moving it into openvibe-sdk is the intended home.

### The product cache and the convergence bound

Every consumer puts `createVipCache` (same module) in front of the client, so the rule for how long
a product may keep granting after a membership ends is written once:

```js
const { createVipClient, createVipCache } = require('openvibe-vip/client');
const cache = createVipCache({ vip, ttlMs: 30_000, denyTtlMs: 10_000, unavailableTtlMs: 2_000 });
await cache.evaluate({ subject, resource, owner, fallback });        // Community, Blog
await cache.entitlement({ subject, creator, product: 'chat' });      // Chat's badge
cache.peekEntitlement({ subject, creator, product: 'chat' });        // never waits (a miss warms it)
cache.handleEvent(envelope);                                          // vip.membership.changed, billing.entitlement.changed, …
```

When a membership changes (Billing emits `billing.entitlement.changed`, VIP applies it and emits
`vip.membership.changed`), a product stops granting within:

| Situation | Bound |
|---|---|
| the product hands the event to `cache.handleEvent` | at once (the member–creator pair is dropped; an answer in flight is not stored) |
| VIP has the event, the product does not | `ttlMs` (a cached "yes" lives at most that long) |
| every event lost, VIP's included | `VIP_PROJECTION_MAX_AGE_MS` + `ttlMs` (15 min + the product's TTL by default); with Billing down as well, add `VIP_PROJECTION_GRACE_MS`, after which VIP answers `unknown` |
| cancel at period end / the period ends | never past `expires_at`: a "yes" is not cached beyond the entitlement's `expires_at` or VIP's `valid_until` |
| VIP unreachable | `ttlMs`, then every answer is a denial (a failure never extends a "yes") |

A "no" is cached `denyTtlMs` (a new member waits at most that long); failures `unavailableTtlMs`.
[test/convergence.test.js](test/convergence.test.js) proves every row against the real VIP with an
injected clock. The products' TTLs: Chat 60 s (a badge), Community 30 s, Blog 30 s — each product's
README repeats its bound and its own test drives the product through a change.
Live's badge mapping (`live chat_badge`, `live powerchat_overlay`, `live ai_context`) and Chat's
(`chat badge`) are declared as product bindings of the network perk `subscriber-badge`.

## Card, badge and widget (`/embed`)

The reusable membership endpoints of roadmap §11.3, for a creator's stream page, their own site, or any
other product. They cover creators with at least one published plan ([server/domain/cards.js](server/domain/cards.js),
[server/web/embeds.js](server/web/embeds.js)):

| Endpoint | What | Headers |
|---|---|---|
| `GET /embed/:username/card.json` (and `GET /api/v1/creators/:ref/card`) | plan names, descriptions, benefits and version (the terms new members buy), perks (key, name, kind), join and terms links, whether joining is open, Billing's price and period, the member count, the badge and widget URLs | `Access-Control-Allow-Origin: *` (no credentials), `Cache-Control: public, max-age=60` |
| `GET /embed/:username/badge.svg` | a two-part badge, "★ <badge perk>" and the creator's name, for an `<img>` | `image/svg+xml`, CSP `default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: cross-origin`, cached 5 min |
| `GET /embed/:username/widget[?theme=light\|dark]` | an HTML widget for an `<iframe>`: name, member count, up to three plans with their perks, a join link that opens openvibe.vip in a new tab | CSP `default-src 'none'`, the one inline style allowed by its hash, `form-action`/`base-uri 'none'`, `frame-ancestors` from `VIP_WIDGET_FRAME_ANCESTORS` (any site by default) |

**Safe to embed:**
- The endpoints are the same for everyone. They are mounted before the cookie parser and never read a
  cookie, token or viewer, and they set no cookie.
- They run no script.
- They show nothing private: published plans only, never drafts or archived ones; perk names, never
  product binding configs; a member count, never who. The creator can switch the count off in the
  dashboard.
- Every other VIP page keeps `frame-ancestors 'self'`. The nginx reference config serves `/embed/`
  without the server-wide `X-Frame-Options`.

**The member count** is Billing's: active subscriptions to the creator. It is reused for
`VIP_MEMBER_COUNT_TTL_MS` (5 min), with one Billing call at a time per creator. When Billing does not
answer, the last count is shown as `stale: true`, or no count at all. VIP never guesses from its
projection, which only holds members someone asked about recently. The dashboard's *Share your
memberships* card gives the creator the badge and widget HTML and the card URL.

## Pages (server-rendered, useful without JavaScript, shared chrome)

`/` directory of creators with published plans · `/:username` a creator's plans (terms, perks,
Billing's price and period from `GET /api/v1/rates`, join form) · `/:username/plans/:slug` public terms
history · `/me` your memberships, the version you joined under, cancel, badge preference ·
`/dashboard` plans, versions, perks and bindings, members, members-only resources, the badge and
widget to share and the member-count switch (`?as=network` for staff) · `/embed/:username/…` (above) · `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/llms-full.txt` · `/terms`, `/privacy`, `/dmca`
(openvibe-shared legal). Navbar from `https://openvibe.network/shared/navbar.js`, SSR footer and
`<noscript>` navigation from openvibe-shared. Forms carry HMAC anti-forgery tokens
(`VIP_FORM_SECRET`); cookies are SameSite=Lax. No feed: plans are not a publication stream.

### Crawlers and AI readers

`/robots.txt` and `/sitemap.xml` come from openvibe-shared/seo (the sitemap lists the home and every
creator with a published plan). `/llms.txt` is the site map for language models; `/llms-full.txt` is
the same header followed by the full plain text of the home, every public creator page and every
published plan's terms (`seo.llmsFull`, built from public data only, cached an hour in memory and with
`Cache-Control: public, max-age=3600`). Every page's head carries an `ai-summary` meta and WebPage
JSON-LD through openvibe-shared/shell.

### IndexNow (openvibe-shared/indexnow)

With `INDEXNOW_KEY` set (8–128 hex or alphanumeric characters, what IndexNow's own tools generate),
the key file is served at `/<key>.txt` as `text/plain` (before static, so a file cannot shadow it) and
a plan that changes tells the engines: publishing, editing a published plan and archiving ping
`api.indexnow.org` with the creator's page, the plan's terms page and `/sitemap.xml`; the module
batches and debounces (one POST per 30 s window). A draft, an unchanged edit, a replayed publish and
network plans (no public creator page) never ping, and a failed ping never takes a publish down.
Unset: off — the key route is not mounted and nothing is sent (`test/indexnow.test.js`).

## Account export and deletion (ADR-033)

`network.account.export_requested` and `network.account.deleted` arrive at `POST /internal/events` and are answered by
`server/domain/account-data.js` (`openvibe-sdk/account-data`), outside the billing inbox, with one receipt per export
and deletion in `account_data_events`.

- **A member:** the export carries their memberships, preferences, entitlements, checkouts and paid periods. The
  deletion removes the memberships, preferences, entitlement cache and checkout hand-offs. Paid periods are money
  records and stay, counted as retained.
- **A creator:** the export carries their profile, plans, plan versions and perks. Their creator row stays, because
  plans, perks and other people's memberships reference it, but it is suspended and loses its username, display name
  and bio. Plans, perks and gated rules lose `created_by`. Plan versions stay whole: they are the immutable terms
  members joined under.
- **Billing:** payments, refunds and subscriptions are Billing's records, and its own consumer answers for them.

## Before and after the Billing cutover

Billing runs in shadow mode until the Wave 8 cutover (Live stays authoritative for money,
`BILLING_AUTHORITY=live`). Until then:

- keep **checkout closed** (`VIP_CHECKOUT_PROVIDERS=` empty): a subscription sold through Billing
  now would be one Live does not know about. Plan pages say joining is not open yet; the API answers
  `422 vip.checkout.provider_unavailable`;
- VIP can run read-only against Billing's shadow entitlements (imported from Live), which are only as
  current as Billing's last import; new Live subscriptions do not reach Billing (or VIP) before the cutover;
- Billing publishes its events only when its own `EVENTS_URL` is set.

After the cutover: run `scripts/subscribe.js`, then open checkout (`VIP_CHECKOUT_PROVIDERS=powerchat,credit`).

## Security notes

Reporting a vulnerability: [SECURITY.md](SECURITY.md).

- Every API route checks one capability (services) or ownership (users); a presented token is judged
  on that token alone. The API never reads cookies.
- Billing events: HMAC-SHA256 signature over the raw body (`VIP_EVENTS_SECRET`, rotation by list),
  `source` must be `billing`, exactly-once inbox, ordering guard.
- Fail closed everywhere a membership is decided; "unknown" is never "yes".
- Outbound calls go only to configured service URLs (Network, Billing, Events); no user-supplied
  URLs are fetched. Checkout redirects only to http(s) URLs Billing returned.
- Secrets appear as environment variable names only.
- The embeds (`/embed`) read no cookie or token and set none; the widget runs no script, and its CSP
  allows only its own hashed style. `VIP_WIDGET_FRAME_ANCESTORS` is reduced to source expressions, so it
  cannot add a CSP directive. The badge SVG is served sandboxed, with every name escaped.
  `test/embeds.test.js` covers all of this.
- Per-actor limits on `/api/v1` (`server/api/actor-limits.js`, openvibe-sdk/limits, roadmap WS-R task 4),
  counted once the credential is checked and before any work: a service as its principal (`svc:chat`), a
  person as `user:usr_…`, anyone else by address. Past a limit: `429` problem+json `rate_limited` with
  `Retry-After`, one log line and `vip_rate_limited_total{limit,window}`. Reads take `VIP_LIMITS_MINUTE` /
  `VIP_LIMITS_HOUR` (120 a minute, 3000 an hour). `GET|POST /entitlements/check` and
  `POST /policies/evaluate` give a service 1200 / 30000 (products ask per member and resource behind
  their cache; a refusal would lock members out) and a person the defaults. `POST /checkout`: a person
  10 / 60, a service 60 / 1200; cancel 5 / 30. New plans and perks, publish and archive 10 / 100; plan,
  perk and rule changes and preferences 30 / 300. Never limited: health, ready, `/release.json`,
  `/metrics`, `/embed` and the signed Events deliveries at `/internal/events` (`test/actor-limits.test.js`).

## Acceptance (what the tests prove)

| Criterion | Test |
|---|---|
| plan edits create versions and never rewrite historical terms | `test/plans.test.js` (edit → v2, v1 row byte-identical, triggers refuse UPDATE/DELETE, perk rename keeps terms) |
| old members keep old terms; renewals keep them; a new purchase after a lapse takes the current version | `test/plans.test.js`, `test/api.test.js` (checkout version survives a later edit) |
| cancel / renew / refund converge (events, and with events lost) | `test/entitlements.test.js` (injected clock) |
| a renewal replayed or re-sent records one period; renew then refund reverses it; a reversal before the grant stays reversed; a failed renewal is inactive with a grace and never authorized; the audit doubts a paid period without a record | `test/renewal.test.js` |
| a stale projection cannot authorize past `valid_until` (+ grace), even with Billing down for 100 days | `test/entitlements.test.js` |
| authoritative fallback and sensitive checks | `test/entitlements.test.js`, `test/policies.test.js` |
| gated-resource evaluation fails closed (no rule, unknown, perk missing, guest, VIP down in the client) | `test/policies.test.js` |
| VIP works with Live unavailable | no code path calls Live; every test runs without a Live stub |
| a creator's membership card, badge and widget are public-data only, the same for everyone, embeddable and inert | `test/embeds.test.js` (published plans only, no subjects or binding configs, no cookie read or set, CORS, SVG escaping and sandbox, the widget's frame-ancestors and hashed style, the creator's member-count switch, Billing outage keeps the last count or shows none) |
| `/llms-full.txt` carries the full text of the home, creator and plan pages, and is cached for an hour | `test/llms-full.test.js`, `test/api.test.js` (discovery artifacts) |
| IndexNow is off without `INDEXNOW_KEY` (no key route, nothing sent); with one the key file is served at `/<key>.txt` as `text/plain` and publishing, editing and archiving a plan ping the creator page, the terms page and the sitemap; a draft and an unchanged edit never ping | `test/indexnow.test.js` |

Not yet demonstrated (needs the other services): convergence **across consuming products** end to end
(Chat, Community, Blog and Wiki call VIP in code; Live does not), and a real Billing/Events round trip
on the host (Billing is in shadow and has sent VIP no events). The Live import ran on production on
2026-09-23.

## Deploy

Production deploys with `sudo ovhost deploy vip` on the host (strategy `git-checkout`: fetch,
fast-forward `/opt/openvibe.vip`, install on a lockfile change, restart, wait for `/api/ready`).
The unit is `openvibe-vip.service` on `127.0.0.1:4620`, the env file `/etc/openvibe/vip.env`. The database is
`ov_vip` on the host's data role (`sudo /opt/openvibe.host/roles/data/add-service.sh vip` writes its settings); the
release migrates it at boot. The vhost [deploy/nginx/openvibe.vip.conf](deploy/nginx/openvibe.vip.conf) waits
for the launch: `openvibe.vip` serves the Sites placeholder.
Rollback: ovhost puts the previous sha back by itself when `/api/ready` does not answer 2xx after the
restart; afterwards `sudo ovhost rollback vip --to <sha>`. One blocker: `idx_vip_rules_resource` (one
active rule per resource) was replaced by a per-creator unique index, and a release from before it
recreates the narrower index, which fails at boot once two creators gate the same resource.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability — ✔ (`/api/health`, truthful `/api/ready`, `/metrics`);
2. canonical identity/auth integration (Network subjects, scoped service principals) — ✔; the `vip` principal is provisioned on the host;
3. server-rendered public routes useful without JavaScript — ✔;
4. real persistence and end-to-end workflows — ✔ against stubs; not yet against the running Billing and Events (deployed, but Billing is in shadow and checkout is closed);
5. capability and event registration against `OpenVibe.Contracts` — ✔ v0.19.0;
6. a migration/seed strategy ✔, a security/threat review (notes above; a review by someone else is still due), sitemap/robots ✔ (no feed by design);
7. acceptance tests proving the advertised functionality — ✔ for VIP itself; cross-product convergence waits for the consumers.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.126.0
- openvibe-sdk: v0.37.0
- openvibe-shared: v2.20.3
<!-- versions:end -->
