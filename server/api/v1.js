'use strict';

/**
 * /api/v1 — VIP's API. Service tokens (audience openvibe.vip, one capability per route) and Network
 * user tokens (people acting on their own things). Errors are RFC 9457 problem+json.
 *
 * People are SubjectRefs ({ type: 'user', id: 'usr_…' }); a creator can also be named by its VIP
 * handle (username) or `network`. VIP never prices, charges, renews or refunds: checkout and
 * cancellation are handed to OpenVibe.Billing, and entitlement truth is Billing's.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { VipError, fail, userSubject, isUserSubject, entityRef, bool } = require('../util');

const CAP = {
    planCreate: 'vip.plan.create',
    planUpdate: 'vip.plan.update',
    planArchive: 'vip.plan.archive',
    planList: 'vip.plan.list',
    perkCreate: 'vip.perk.create',
    perkUpdate: 'vip.perk.update',
    perkList: 'vip.perk.list',
    checkout: 'vip.membership.checkout',
    status: 'vip.membership.status',
    entitlement: 'vip.entitlement.check',
    policyGet: 'vip.resource.policy.get',
    policySet: 'vip.resource.policy.set',
    policyEvaluate: 'vip.resource.policy.evaluate',
    members: 'vip.creator.members.list',
};

function v1Router({ domain, apiAuth, limits }) {
    const r = express.Router();
    const { creators, plans, perks, memberships, entitlements, policies, checkout, billing } = domain;

    // Per-actor limits (api/actor-limits.js), after the credential and before any work: reads take the
    // defaults, except the entitlement check, which sets its own below.
    r.use(limits.reads('vip.read', (req) => req.path === '/entitlements/check'));
    const create = limits('vip.catalog.create', { minute: 10, hour: 100 });   // new plans and perks, publish, archive
    const edit = limits('vip.catalog.update', { minute: 30, hour: 300 });     // plan, perk and rule changes, preferences
    /** Services and people meet different numbers on one route: `service` for a principal, `person` otherwise. */
    const byKind = (service, person) => (req, res, next) => (req.principal.kind === 'service' ? service : person)(req, res, next);
    const granted = apiAuth.granted;
    const isStaff = apiAuth.isStaff;

    const denied = (cap) => fail(403, 'capability.denied', cap ? `${cap} not granted` : 'not allowed');
    const needAuth = (p) => { if (p.kind === 'anonymous') fail(401, 'auth.required', 'a Network service or user token is required'); };

    /** A creator named by SubjectRef, usr_ id, username or 'network'. */
    async function findCreator(ref) {
        if (ref === 'network') return await creators.network();
        if (ref && typeof ref === 'object') return await creators.bySubject(userSubject(ref, 'creator'));
        const s = String(ref || '');
        if (isUserSubject(s)) return await creators.bySubject(s);
        return await creators.byUsername(s);
    }

    /**
     * The creator a write acts for. Users: themselves (created on first use), or `network` for staff.
     * Services (holding `cap`): the creator named in the body.
     */
    async function actingCreator(req, ref, cap) {
        const p = req.principal;
        needAuth(p);
        if (p.kind === 'service') {
            if (!granted(p, cap)) denied(cap);
            if (ref === 'network') return await creators.network();
            if (!ref) fail(422, 'vip.invalid_input', 'creator is required ({ type: "user", id } or "network")');
            return await creators.ensure({ subject: userSubject(ref, 'creator'), origin: 'service' });
        }
        if (ref === 'network') {
            if (!isStaff(p)) denied();
            return await creators.network();
        }
        if (ref && (typeof ref === 'object' ? ref.id : ref) !== p.subject) {
            if (!isStaff(p)) fail(403, 'vip.not_yours', 'you can only manage your own plans');
            return await creators.ensure({ subject: userSubject(ref, 'creator'), origin: 'staff' });
        }
        return await creators.ensure({ subject: p.subject, username: p.username, displayName: p.name, origin: 'self' });
    }

    /** May the principal manage things owned by creator row `c`? */
    function mayManage(p, c, cap) {
        if (p.kind === 'service') return granted(p, cap);
        if (p.kind !== 'user' || !c) return false;
        if (c.kind === 'network') return isStaff(p);
        return c.subject === p.subject || isStaff(p);
    }
    const requireManage = (req, c, cap) => { needAuth(req.principal); if (!mayManage(req.principal, c, cap)) denied(req.principal.kind === 'service' ? cap : null); };

    /** The subject a member-side call is about: users → themselves; services (with cap) → body/query. */
    function memberSubject(req, value, cap) {
        const p = req.principal;
        needAuth(p);
        if (p.kind === 'user') {
            if (value && (typeof value === 'object' ? value.id : value) !== p.subject) fail(403, 'vip.not_yours', 'you can only ask about yourself');
            return p.subject;
        }
        if (!granted(p, cap)) denied(cap);
        return userSubject(value, 'subject');
    }

    const presentPlanFull = async (plan) => ({ ...await plans.present(plan), creator: creators.present(await creators.byId(plan.creator_id)) });
    const trace = (req) => req.ov && req.ov.traceparent;

    // ── Creators (public) ────────────────────────────────────
    r.get('/creators/:ref', wrap(async (req, res) => {
        const c = await findCreator(req.params.ref);
        if (!c) fail(404, 'vip.creator_not_found', 'no such creator');
        const own = mayManage(req.principal, c, CAP.planList);
        res.json({
            creator: creators.present(c),
            plans: (await Promise.all((await plans.list({ creatorId: c.id, includeDrafts: own })).map(async (p) => await plans.present(p)))),
            perks: (await Promise.all((await perks.list({ creatorId: c.id, includeNetwork: false })).map(async (p) => await perks.present(p)))),
        });
    }));

    /** The public membership card (server/domain/cards.js): what /embed/:username/card.json serves. */
    r.get('/creators/:ref/card', wrap(async (req, res) => {
        const card = await domain.cards.card(await findCreator(req.params.ref));
        if (!card) fail(404, 'vip.creator_not_found', 'no public membership card for this creator');
        res.json({ card });
    }));

    // ── Plans ────────────────────────────────────────────────
    r.get('/plans', wrap(async (req, res) => {
        const c = await findCreator(req.query.creator);
        if (!c) fail(404, 'vip.creator_not_found', 'creator must name a creator (usr_ id, username or network)');
        const include = String(req.query.include || '').split(',');
        const own = mayManage(req.principal, c, CAP.planList);
        const list = await plans.list({ creatorId: c.id, includeDrafts: own && include.includes('drafts'), includeArchived: own && include.includes('archived') });
        res.json({ creator: creators.present(c), plans: (await Promise.all(list.map(async (p) => await plans.present(p)))) });
    }));
    const visiblePlan = async (req, id) => {
        const plan = await plans.byId(id);
        if (!plan) fail(404, 'vip.plan_not_found', `no plan ${id}`);
        if (plan.status !== 'published' && !mayManage(req.principal, await creators.byId(plan.creator_id), CAP.planList)) fail(404, 'vip.plan_not_found', `no plan ${id}`);
        return plan;
    };
    r.get('/plans/:id', wrap(async (req, res) => res.json({ plan: await presentPlanFull(await visiblePlan(req, req.params.id)) })));
    r.get('/plans/:id/versions', wrap(async (req, res) => {
        const plan = await visiblePlan(req, req.params.id);
        const own = mayManage(req.principal, await creators.byId(plan.creator_id), CAP.planList);
        const all = (await Promise.all((await plans.versions(plan.id)).filter((v) => own || v.published_at).map(plans.presentVersion)));
        res.json({ plan_id: plan.id, versions: all });
    }));
    r.post('/plans', create, wrap(async (req, res) => {
        const b = req.body || {};
        const c = await actingCreator(req, b.creator, CAP.planCreate);
        const actor = req.principal.kind === 'service' ? req.principal.sub : req.principal.subject;
        const plan = await plans.create({
            creatorId: c.id, slug: b.slug, name: b.name, description: b.description, benefits: b.benefits, perks: b.perks,
            billingKind: b.billing_kind, publish: bool(b.publish), changeNote: b.change_note, actor, traceparent: trace(req),
        });
        res.status(201).json({ plan: await presentPlanFull(plan) });
    }));
    const managedPlan = async (req, cap) => {
        const plan = await plans.byId(req.params.id);
        if (!plan) fail(404, 'vip.plan_not_found', `no plan ${req.params.id}`);
        requireManage(req, await creators.byId(plan.creator_id), cap);
        return plan;
    };
    r.patch('/plans/:id', edit, wrap(async (req, res) => {
        const plan = await managedPlan(req, CAP.planUpdate);
        const b = req.body || {};
        const actor = req.principal.kind === 'service' ? req.principal.sub : req.principal.subject;
        const out = await plans.update(plan.id, { name: b.name, description: b.description, benefits: b.benefits, perks: b.perks, changeNote: b.change_note, actor, traceparent: trace(req) });
        res.json({ plan: await presentPlanFull(out.plan), version: await plans.presentVersion(out.version), unchanged: out.unchanged });
    }));
    r.post('/plans/:id/publish', create, wrap(async (req, res) => {
        const plan = await managedPlan(req, CAP.planUpdate);
        const out = await plans.publish(plan.id, { traceparent: trace(req) });
        res.json({ plan: await presentPlanFull(out.plan), replay: out.replay });
    }));
    r.post('/plans/:id/archive', create, wrap(async (req, res) => {
        const plan = await managedPlan(req, CAP.planArchive);
        res.json({ plan: await presentPlanFull(await plans.archive(plan.id)) });
    }));

    // ── Perks ────────────────────────────────────────────────
    r.get('/perks', wrap(async (req, res) => {
        const c = await findCreator(req.query.creator);
        if (!c) fail(404, 'vip.creator_not_found', 'creator must name a creator (usr_ id, username or network)');
        const own = mayManage(req.principal, c, CAP.perkList);
        const list = await perks.list({ creatorId: c.id, includeNetwork: bool(req.query.network, true), includeRetired: own && bool(req.query.retired) });
        res.json({ perks: (await Promise.all(list.map(async (p) => await perks.present(p)))) });
    }));
    r.post('/perks', create, wrap(async (req, res) => {
        const b = req.body || {};
        const c = await actingCreator(req, b.creator, CAP.perkCreate);
        const actor = req.principal.kind === 'service' ? req.principal.sub : req.principal.subject;
        const p = await perks.create({ creatorId: c.id, key: b.key, name: b.name, description: b.description, kind: b.kind, bindings: b.bindings, actor });
        res.status(201).json({ perk: await perks.present(p) });
    }));
    r.patch('/perks/:id', edit, wrap(async (req, res) => {
        const p = await perks.byId(req.params.id);
        if (!p) fail(404, 'vip.perk_not_found', `no perk ${req.params.id}`);
        requireManage(req, await creators.byId(p.creator_id), CAP.perkUpdate);
        const b = req.body || {};
        res.json({ perk: await perks.present(await perks.update(p.id, { name: b.name, description: b.description, kind: b.kind, status: b.status, bindings: b.bindings })) });
    }));

    // ── Checkout hand-off (Billing) ──────────────────────────
    const ownOrigin = (() => { try { return new URL(domain.config.baseUrl).origin; } catch { return null; } })();
    /**
     * A return URL a person asked for: only pages of this site. Billing hands these to the payment
     * provider, which sends the buyer there after paying or cancelling — anything else would make
     * a provider-hosted checkout link an open redirect to a look-alike page.
     */
    function returnUrl(req, v, field) {
        if (v == null || v === '') return undefined;
        if (req.principal.kind === 'service') return String(v);
        let u;
        try { u = new URL(String(v)); } catch { u = null; }
        if (!u || !ownOrigin || u.origin !== ownOrigin) fail(422, 'vip.invalid_input', `${field} must be a page of ${ownOrigin || 'this site'}`);
        return u.toString();
    }
    // A checkout asks Billing for a payment intent: a person starts at most 10 a minute and 60 an hour;
    // a service starting them for its members gets one a second (60 and 1200).
    r.post('/checkout', byKind(limits('vip.checkout', { minute: 60, hour: 1200 }), limits('vip.checkout', { minute: 10, hour: 60 })), wrap(async (req, res) => {
        const b = req.body || {};
        const member = memberSubject(req, b.subject, CAP.checkout);
        const out = await checkout.start({
            member, planId: b.plan_id, provider: b.provider,
            successUrl: returnUrl(req, b.success_url, 'success_url'), cancelUrl: returnUrl(req, b.cancel_url, 'cancel_url'),
            autoRenew: b.auto_renew === undefined ? true : bool(b.auto_renew), traceparent: trace(req),
        });
        res.status(201).json(out);
    }));

    // ── Membership status ────────────────────────────────────
    r.get('/memberships/:subject', wrap(async (req, res) => {
        const member = memberSubject(req, req.params.subject, CAP.status);
        const mode = ['projection', 'authoritative'].includes(req.query.mode) ? req.query.mode : 'auto';
        const list = [];
        for (const m of await memberships.forMember(member)) {
            const c = await creators.byId(m.creator_id);
            const ent = c && c.subject ? await entitlements.check(member, c.subject, { mode, traceparent: trace(req) }) : null;
            list.push({ ...await memberships.present(m), creator: creators.present(c), entitlement: ent, preferences: await memberships.preferences(member, m.creator_id) });
        }
        res.json({ member: { type: 'user', id: member }, memberships: list });
    }));
    const creatorParam = async (req) => {
        const c = await findCreator(req.params.creator);
        if (!c || !c.subject) fail(404, 'vip.creator_not_found', 'no such creator');
        return c;
    };
    // Cancelling is handed to Billing: the member does it once.
    r.post('/memberships/:creator/cancel', limits('vip.membership.cancel', { minute: 5, hour: 30 }), wrap(async (req, res) => {
        if (req.principal.kind !== 'user') fail(403, 'vip.member_only', 'only the member can cancel their membership');
        const c = await creatorParam(req);
        res.json(await checkout.cancel({ member: req.principal.subject, creatorId: c.id, traceparent: trace(req) }));
    }));
    r.put('/memberships/:creator/preferences', edit, wrap(async (req, res) => {
        if (req.principal.kind !== 'user') fail(403, 'vip.member_only', 'only the member sets their preferences');
        const c = await creatorParam(req);
        const b = req.body || {};
        res.json({ preferences: await memberships.setPreferences(req.principal.subject, c.id, { showBadge: b.show_badge === undefined ? undefined : bool(b.show_badge), listed: b.listed === undefined ? undefined : bool(b.listed) }) });
    }));

    // ── Entitlement check (projection + authoritative fallback) ──
    const entitlementCheck = wrap(async (req, res) => {
        const src = req.method === 'GET' ? req.query : (req.body || {});
        const member = memberSubject(req, src.subject, CAP.entitlement);
        // A creator VIP has never seen can still have a Billing entitlement: a usr_ id is asked as is.
        const raw = src.creator && typeof src.creator === 'object' ? src.creator.id : src.creator;
        let creatorSubject = isUserSubject(raw) ? raw : null;
        if (!creatorSubject) {
            const c = await findCreator(raw);
            if (!c || !c.subject) fail(422, 'vip.invalid_input', 'creator must be a user SubjectRef, usr_ id or VIP username');
            creatorSubject = c.subject;
        }
        const mode = ['projection', 'authoritative'].includes(src.mode) ? src.mode : 'auto';
        const out = await entitlements.check(member, creatorSubject, { mode, traceparent: trace(req) });
        // `product`: what this membership means in one product — the perks of the member's plan version
        // with that product's bindings (a chat badge, a gated post, …) and the member's badge preference.
        if (src.product != null && src.product !== '') {
            const product = String(src.product);
            if (!/^[a-z][a-z0-9-]{1,39}$/.test(product)) fail(422, 'vip.invalid_input', 'product must be a service id such as chat or blog');
            out.product = product;
            out.product_perks = out.active ? await perks.forMembership(out.membership, product) : [];
            const c = await creators.bySubject(creatorSubject);
            out.preferences = c ? await memberships.preferences(member, c.id) : { show_badge: true, listed: false };
        }
        res.json(out);
    });
    // Products (Chat badges, Community and Blog gates) ask once per member and resource behind a 30 to
    // 60 s cache, so one service asks about many people: 1200 a minute only stops a runaway loop, and a
    // refusal there would lock members out. A person asking about themselves takes the defaults.
    const hot = limits('vip.entitlement.check', { minute: 1200, hour: 30000 });
    const entitlementLimit = byKind(hot, limits('vip.entitlement.check'));
    r.get('/entitlements/check', entitlementLimit, entitlementCheck);
    r.post('/entitlements/check', entitlementLimit, entitlementCheck);

    // ── Gated-resource policy ────────────────────────────────
    r.get('/policies', wrap(async (req, res) => {
        const p = req.principal;
        needAuth(p);
        if (req.query.service || req.query.type || req.query.id) {
            const resource = entityRef({ service: req.query.service, type: req.query.type, id: req.query.id });
            // Rules are per creator: name the owner (services must; a person defaults to themselves).
            const owner = req.query.owner ? await policies.ownerCreator(req.query.owner === 'network' ? 'network' : String(req.query.owner))
                : (p.kind === 'user' ? await creators.bySubject(p.subject) : null);
            if (!req.query.owner && p.kind !== 'user') fail(422, 'vip.invalid_input', 'owner (the creator\'s usr_ id or network) is required');
            const rule = owner ? await policies.forResource(resource, owner.id) : null;
            if (p.kind === 'service' && !granted(p, CAP.policyGet)) denied(CAP.policyGet);
            if (!rule || (p.kind === 'user' && !mayManage(p, await creators.byId(rule.creator_id), CAP.policyGet))) fail(404, 'vip.rule_not_found', 'no rule for that resource');
            return res.json({ rule: await policies.present(rule) });
        }
        const c = await findCreator(req.query.creator || (p.kind === 'user' ? p.subject : null));
        if (!c) fail(404, 'vip.creator_not_found', 'no such creator');
        requireManage(req, c, CAP.policyGet);
        return res.json({ rules: await Promise.all((await policies.list(c.id)).map(policies.present)) });
    }));
    r.get('/policies/:id', wrap(async (req, res) => {
        const rule = await policies.byId(req.params.id);
        if (!rule) fail(404, 'vip.rule_not_found', `no rule ${req.params.id}`);
        requireManage(req, await creators.byId(rule.creator_id), CAP.policyGet);
        res.json({ rule: await policies.present(rule) });
    }));
    r.post('/policies', edit, wrap(async (req, res) => {
        const b = req.body || {};
        const c = await actingCreator(req, b.creator, CAP.policySet);
        if (c.kind !== 'creator') fail(422, 'vip.invalid_input', 'gated resources belong to a creator');
        const actor = req.principal.kind === 'service' ? req.principal.sub : req.principal.subject;
        const rule = await policies.set({ creatorId: c.id, resource: b.resource, requirement: b.requirement, planId: b.plan_id, perkKey: b.perk_key, sensitive: bool(b.sensitive), actor });
        res.status(201).json({ rule: await policies.present(rule) });
    }));
    r.delete('/policies/:id', edit, wrap(async (req, res) => {
        const rule = await policies.byId(req.params.id);
        if (!rule) fail(404, 'vip.rule_not_found', `no rule ${req.params.id}`);
        requireManage(req, await creators.byId(rule.creator_id), CAP.policySet);
        res.json({ rule: await policies.present(await policies.disable(rule.id)) });
    }));
    // Evaluation is the gates' hot path too (see the entitlement check).
    r.post('/policies/evaluate', byKind(limits('vip.resource.policy.evaluate', { minute: 1200, hour: 30000 }), limits('vip.resource.policy.evaluate')), wrap(async (req, res) => {
        const b = req.body || {};
        const p = req.principal;
        needAuth(p);
        let subject = null;
        if (p.kind === 'user') {
            if (b.subject && (typeof b.subject === 'object' ? b.subject.id : b.subject) !== p.subject) fail(403, 'vip.not_yours', 'you can only ask about yourself');
            subject = p.subject;
        } else {
            if (!granted(p, CAP.policyEvaluate)) denied(CAP.policyEvaluate);
            // No subject (a signed-out viewer) or a guest is a valid question; the answer is no.
            const s = b.subject && typeof b.subject === 'object' ? b.subject.id : b.subject;
            subject = s ? String(s) : null;
        }
        const out = await policies.evaluate({ subject, resource: b.resource, owner: b.owner || null, ruleId: b.rule_id, mode: b.mode === 'authoritative' ? 'authoritative' : 'auto', fallback: b.fallback || null, traceparent: trace(req) });
        res.json(out);
    }));

    // ── Creator members ──────────────────────────────────────
    r.get('/creators/:ref/members', wrap(async (req, res) => {
        const c = await findCreator(req.params.ref);
        if (!c || !c.subject) fail(404, 'vip.creator_not_found', 'no such creator');
        requireManage(req, c, CAP.members);
        const byMember = new Map((await memberships.forCreator(c.id)).map((m) => [m.member_subject, m]));
        const row = async (subject, extra) => ({ member: { type: 'user', id: subject }, ...extra, membership: await memberships.present(byMember.get(subject)) });
        try {
            // Authoritative: Billing's active subscriptions to this creator.
            const out = await billing.listSubscriptions({ streamer: c.subject, status: 'active' });
            const members = (await Promise.all((out.subscriptions || []).map(async (s) => await row(s.subscriber.id, {
                current_period_end: s.current_period_end, cancel_at_period_end: !!s.cancel_at_period_end, subscription_id: s.id,
            }))));
            return res.json({ creator: creators.present(c), source: 'billing', members });
        } catch {
            const members = (await Promise.all((await entitlements.projectedMembers(c.subject)).map(async (pr) => await row(pr.member_subject, {
                current_period_end: pr.expires_at, cancel_at_period_end: !!pr.cancel_at_period_end, subscription_id: pr.subscription_id,
            }))));
            return res.json({ creator: creators.present(c), source: 'projection', note: 'Billing did not answer; this list is VIP\'s projection (fresh rows only) and may be incomplete', members });
        }
    }));

    return r;
}

/** Async-safe handler: VipError → problem+json; anything else → 500. */
function wrap(fn) {
    return async (req, res, next) => {
        try {
            const p = await fn(req, res, next);
            if (p && typeof p.catch === 'function') p.catch((e) => sendError(req, res, e));
        } catch (e) { sendError(req, res, e); }
    };
}

function sendError(req, res, e) {
    if (res.headersSent) return;
    if (e instanceof VipError) {
        return http.sendProblem(res, e.status, e.code, { detail: e.detail || e.message, ctx: req.ov, extra: e.extra && e.status < 500 ? { details: e.extra } : undefined });
    }
    console.error('[VIP] unexpected error:', e);
    return http.sendProblem(res, 500, 'vip.internal', { detail: 'internal error', ctx: req.ov });
}

module.exports = { v1Router, wrap, sendError, CAP };
