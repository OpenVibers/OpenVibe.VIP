'use strict';

/**
 * Server-rendered pages (useful without JavaScript):
 *
 *   GET  /                          directory of creators with published plans
 *   GET  /me                        the viewer's memberships, the version each was bought under, cancel
 *   GET  /dashboard[?as=network]    creator dashboard: plans, versions, perks, members, gated resources
 *   GET  /:username                 a creator's plan page (join through Billing)
 *   GET  /:username/plans/:slug     that plan's public terms history
 *   GET  /robots.txt, /sitemap.xml
 *
 * Every POST needs the signed-in viewer and the form's anti-forgery token; it acts through the same
 * domain calls as the API and redirects back with a notice (?ok= / ?error=).
 */
const crypto = require('crypto');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const express = require('express');
const { VipError, bool } = require('../util');
const { viewerMiddleware } = require('./session');
const { createForms } = require('./forms');
const pages = require('./pages');

const RESERVED = new Set(['me', 'dashboard', 'auth', 'api', 'internal', 'css', 'js', 'terms', 'privacy', 'dmca', 'robots.txt', 'sitemap.xml', 'release.json', 'metrics', 'favicon.ico', 'embed']);

function createWebRoutes({ domain, config, layout, userAuth }) {
    const router = express.Router();
    const { creators, plans, perks, memberships, entitlements, policies, checkout, billing } = domain;
    const forms = createForms({ secret: config.formSecret, now: domain.now });
    const isStaff = (v) => !!v && v.staff === true;
    router.use(viewerMiddleware(userAuth));
    const body = express.urlencoded({ extended: false, limit: '32kb' });

    let ratesCache = { at: 0, value: null };
    async function rates() {
        if (domain.now() - ratesCache.at < config.billing.ratesTtlMs) return ratesCache.value;
        try { ratesCache = { at: domain.now(), value: await billing.rates() }; } catch { ratesCache = { at: domain.now() - config.billing.ratesTtlMs + 30_000, value: null }; }
        return ratesCache.value;
    }

    const send = (res, status, o) => res.status(status).type('html').send(layout.page(o));
    const notFound = (req, res) => send(res, 404, { title: 'Not found', robots: 'noindex', viewer: req.viewer, body: pages.errorPage({ status: 404, title: 'Nothing here', message: 'That page does not exist.' }) });
    // Notices ride in the redirect (?ok= / ?error=) and carry an HMAC of their text, so a crafted
    // link cannot put words of its choosing on a VIP page (e.g. "send your Vibes to …").
    const noticeSig = (kind, msg) => crypto.createHmac('sha256', String(config.formSecret || '')).update(`notice|${kind}|${msg}`).digest('base64url').slice(0, 22);
    const back = (res, path, kind, msg) => res.redirect(303, `${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(msg)}&ns=${noticeSig(kind, msg)}`);
    router.use((req, res, next) => {
        for (const kind of ['ok', 'error']) {
            const msg = req.query[kind];
            if (msg === undefined) continue;
            const sig = String(req.query.ns || '');
            const want = typeof msg === 'string' && config.formSecret ? noticeSig(kind, msg) : null;
            if (!want || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) delete req.query[kind];
        }
        next();
    });
    const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
    const lines = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);

    /** A POST handler: viewer + anti-forgery token, VipError → redirect with the message. */
    function post(path, handler, { backTo } = {}) {
        router.post(path, body, async (req, res, next) => {
            const to = typeof backTo === 'function' ? backTo(req) : (backTo || req.path);
            if (!req.viewer) return res.redirect(303, `/auth/login?next=${encodeURIComponent(to)}`);
            if (!forms.verify(req.viewer.subject, req.body && req.body._csrf)) return back(res, to, 'error', 'That form expired. Please try again.');
            try {
                await handler(req, res, to);
            } catch (e) {
                if (e instanceof VipError) return back(res, to, 'error', e.detail || e.message);
                return next(e);
            }
        });
    }

    router.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nDisallow: /me\nDisallow: /dashboard\nDisallow: /auth/\nDisallow: /api/\nDisallow: /embed/\nSitemap: ${config.baseUrl}/sitemap.xml\n`));
    router.get('/sitemap.xml', (req, res) => {
        const urls = [`${config.baseUrl}/`, ...creators.listPublic({ limit: 5000 }).map((c) => `${config.baseUrl}/${encodeURIComponent(c.username)}`)];
        res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${u.replace(/&/g, '&amp;')}</loc></url>`).join('\n')}\n</urlset>\n`);
    });

    // What shipped on OpenVibe.VIP: the shared update log every OpenVibe site has.
    router.get('/updates', (req, res) => send(res, 200, { viewer: req.viewer, canonicalPath: '/updates', title: 'What shipped on OpenVibe.VIP', body: frame.updatesBody({ service: 'vip', siteName: 'OpenVibe.VIP' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>` }));
    router.get('/', (req, res) => send(res, 200, {
        active: 'home', viewer: req.viewer, canonicalPath: '/',
        body: pages.home({ creators: creators.listPublic().map(creators.present) }),
    }));

    // ── The member's page ────────────────────────────────────
    router.get('/me', async (req, res, next) => {
        try {
            const rows = [];
            if (req.viewer) {
                for (const m of memberships.forMember(req.viewer.subject)) {
                    const c = creators.byId(m.creator_id);
                    const e = c && c.subject ? await entitlements.check(req.viewer.subject, c.subject, { mode: 'auto' }) : null;
                    rows.push({ membership: memberships.present(m), creator: creators.present(c), entitlement: e, preferences: memberships.preferences(req.viewer.subject, m.creator_id) });
                }
            }
            send(res, 200, { title: 'Your memberships', active: 'memberships', robots: 'noindex,nofollow', canonicalPath: '/me', viewer: req.viewer, body: pages.memberPage({ viewer: req.viewer, rows, token: req.viewer ? forms.token(req.viewer.subject) : '', query: req.query }) });
        } catch (e) { next(e); }
    });
    post('/me/:creatorId/cancel', async (req, res, to) => {
        const out = await checkout.cancel({ member: req.viewer.subject, creatorId: req.params.creatorId, traceparent: req.ov.traceparent });
        back(res, to, 'ok', out.already ? 'That membership was already set to end.' : `Cancelled. Your membership runs until ${pages.fmtDate(out.expires_at)}.`);
    }, { backTo: '/me' });
    post('/me/:creatorId/preferences', async (req, res, to) => {
        const c = creators.byId(req.params.creatorId);
        if (!c || !memberships.get(req.viewer.subject, c.id)) throw new VipError(404, 'vip.membership_not_found', 'no such membership');
        memberships.setPreferences(req.viewer.subject, c.id, { showBadge: bool(req.body.show_badge) });
        back(res, to, 'ok', 'Saved.');
    }, { backTo: '/me' });

    // ── Creator dashboard ────────────────────────────────────
    /** The creator the dashboard acts for: the viewer, or the network for staff (?as=network). */
    function dashCreator(req) {
        const asNetwork = (req.query.as || (req.body && req.body.as)) === 'network';
        if (asNetwork) {
            if (!isStaff(req.viewer)) throw new VipError(403, 'vip.not_staff', 'only staff manage network plans');
            return creators.network();
        }
        return creators.ensure({ subject: req.viewer.subject, username: req.viewer.username, displayName: req.viewer.name, origin: 'self' });
    }

    router.get('/dashboard', async (req, res, next) => {
        try {
            if (!req.viewer) return send(res, 200, { title: 'Dashboard', active: 'dashboard', robots: 'noindex,nofollow', viewer: null, body: pages.dashboard({ viewer: null }) });
            let creator;
            try { creator = dashCreator(req); } catch (e) { return send(res, 403, { title: 'Dashboard', robots: 'noindex,nofollow', viewer: req.viewer, body: pages.errorPage({ status: 403, title: 'Not allowed', message: e.detail }) }); }
            const isNetwork = creator.kind === 'network';
            const planRows = plans.list({ creatorId: creator.id, includeDrafts: true, includeArchived: true }).map((p) => plans.present(p, { withVersions: true }));
            const allPerks = perks.list({ creatorId: creator.id }).map((p) => perks.present(p, { withBindings: false }));
            const ownPerks = perks.list({ creatorId: creator.id, includeNetwork: false, includeRetired: true }).map((p) => perks.present(p));
            let members = [];
            let membersSource = 'billing';
            if (!isNetwork) {
                const byMember = new Map(memberships.forCreator(creator.id).map((m) => [m.member_subject, m]));
                try {
                    const out = await billing.listSubscriptions({ streamer: creator.subject, status: 'active' });
                    members = (out.subscriptions || []).map((s) => ({ member: s.subscriber, current_period_end: s.current_period_end, cancel_at_period_end: !!s.cancel_at_period_end, membership: memberships.present(byMember.get(s.subscriber.id)) }));
                } catch {
                    membersSource = 'projection';
                    members = entitlements.projectedMembers(creator.subject).map((pr) => ({ member: { type: 'user', id: pr.member_subject }, current_period_end: pr.expires_at, cancel_at_period_end: !!pr.cancel_at_period_end, membership: memberships.present(byMember.get(pr.member_subject)) }));
                }
            }
            send(res, 200, {
                title: isNetwork ? 'Network plans' : 'Dashboard', active: 'dashboard', robots: 'noindex,nofollow', canonicalPath: '/dashboard', viewer: req.viewer,
                body: pages.dashboard({
                    viewer: req.viewer, creator, isNetwork, isStaff: isStaff(req.viewer), plans: planRows, allPerks, ownPerks, members, membersSource,
                    rules: isNetwork ? [] : policies.list(creator.id).map(policies.present), token: forms.token(req.viewer.subject), query: req.query, base: isNetwork ? '/dashboard/network' : '/dashboard',
                    embeds: !isNetwork && creator.username ? domain.cards.urls(creator) : null,
                }),
            });
        } catch (e) { next(e); }
    });

    // Dashboard writes: /dashboard/... for the viewer's own creator, /dashboard/network/... for staff.
    for (const base of ['/dashboard', '/dashboard/network']) {
        const withAs = (req) => { if (base === '/dashboard/network') req.query.as = 'network'; };
        const own = (req, row) => { withAs(req); const c = dashCreator(req); if (!row || row.creator_id !== c.id) throw new VipError(404, 'vip.not_found', 'not found'); return c; };
        const opts = { backTo: () => (base === '/dashboard/network' ? '/dashboard?as=network' : '/dashboard') };
        post(`${base}/profile`, async (req, res, to) => {
            withAs(req);
            const c = dashCreator(req);
            creators.update(c.id, { displayName: req.body.display_name, bio: req.body.bio, showMemberCount: c.kind === 'creator' ? bool(req.body.show_member_count) : undefined });
            back(res, to, 'ok', 'Profile saved.');
        }, opts);
        post(`${base}/plans`, async (req, res, to) => {
            withAs(req);
            const c = dashCreator(req);
            const plan = plans.create({ creatorId: c.id, name: req.body.name, description: req.body.description, benefits: lines(req.body.benefits), perks: list(req.body.perks), publish: bool(req.body.publish), actor: req.viewer.subject, traceparent: req.ov.traceparent });
            back(res, to, 'ok', `Plan created${plan.status === 'published' ? ' and published' : ''}.`);
        }, opts);
        post(`${base}/plans/:id`, async (req, res, to) => {
            const plan = plans.byId(req.params.id);
            own(req, plan);
            const out = plans.update(plan.id, { name: req.body.name, description: req.body.description, benefits: lines(req.body.benefits), perks: list(req.body.perks), changeNote: req.body.change_note, actor: req.viewer.subject, traceparent: req.ov.traceparent });
            back(res, to, 'ok', out.unchanged ? 'Nothing changed.' : `Saved as version ${out.version.version}.`);
        }, opts);
        post(`${base}/plans/:id/publish`, async (req, res, to) => {
            const plan = plans.byId(req.params.id);
            own(req, plan);
            plans.publish(plan.id, { traceparent: req.ov.traceparent });
            back(res, to, 'ok', 'Published.');
        }, opts);
        post(`${base}/plans/:id/archive`, async (req, res, to) => {
            const plan = plans.byId(req.params.id);
            own(req, plan);
            plans.archive(plan.id);
            back(res, to, 'ok', 'Archived. Current members keep their terms until their membership ends.');
        }, opts);
        const bindingLines = (v) => lines(v).map((l) => { const [product, binding] = l.split(/\s+/); return { product, binding }; });
        post(`${base}/perks`, async (req, res, to) => {
            withAs(req);
            const c = dashCreator(req);
            perks.create({ creatorId: c.id, key: req.body.key || undefined, name: req.body.name, description: req.body.description, kind: req.body.kind || 'other', bindings: bindingLines(req.body.bindings), actor: req.viewer.subject });
            back(res, to, 'ok', 'Perk created.');
        }, opts);
        post(`${base}/perks/:id`, async (req, res, to) => {
            const p = perks.byId(req.params.id);
            own(req, p);
            perks.update(p.id, { name: req.body.name, description: req.body.description, status: req.body.status, bindings: bindingLines(req.body.bindings) });
            back(res, to, 'ok', 'Perk saved.');
        }, opts);
        if (base === '/dashboard') {
            post(`${base}/rules`, async (req, res, to) => {
                const c = dashCreator(req);
                policies.set({
                    creatorId: c.id, resource: { service: req.body.service, type: req.body.type, id: req.body.id }, requirement: req.body.requirement || 'member',
                    planId: req.body.plan_id || null, perkKey: req.body.perk_key || null, sensitive: bool(req.body.sensitive), actor: req.viewer.subject,
                });
                back(res, to, 'ok', 'Rule saved.');
            }, opts);
            post(`${base}/rules/:id/disable`, async (req, res, to) => {
                const rule = policies.byId(req.params.id);
                own(req, rule);
                policies.disable(rule.id);
                back(res, to, 'ok', 'Rule removed.');
            }, opts);
        }
    }

    // ── Creator pages ────────────────────────────────────────
    router.get('/:username', async (req, res, next) => {
        try {
            if (RESERVED.has(req.params.username.toLowerCase())) return notFound(req, res);
            const c = creators.byUsername(req.params.username);
            if (!c || c.status !== 'active') return notFound(req, res);
            if (c.username !== req.params.username) return res.redirect(301, `/${encodeURIComponent(c.username)}`);
            const list = plans.list({ creatorId: c.id }).map((p) => plans.present(p));
            const isOwner = !!(req.viewer && req.viewer.subject === c.subject);
            const member = req.viewer && !isOwner ? await entitlements.check(req.viewer.subject, c.subject, { mode: 'auto' }) : null;
            const name = c.display_name || c.username;
            send(res, 200, {
                title: `${name} memberships`, active: 'creator', canonicalPath: `/${c.username}`, viewer: req.viewer,
                description: c.bio || `Membership plans from ${name} on OpenVibe.`,
                robots: list.length ? 'index,follow' : 'noindex,follow',
                body: pages.creatorPage({ creator: creators.present(c), plans: list, viewer: req.viewer, member, rates: list.some((p) => p.purchasable) ? await rates() : null, providers: config.billing.providers, token: req.viewer ? forms.token(req.viewer.subject) : '', query: req.query, isOwner }),
            });
        } catch (e) { next(e); }
    });
    router.get('/:username/plans/:slug', (req, res) => {
        const c = creators.byUsername(req.params.username);
        if (!c || c.status !== 'active') return notFound(req, res);
        const plan = plans.list({ creatorId: c.id, includeArchived: true }).find((p) => p.slug === req.params.slug);
        if (!plan) return notFound(req, res);
        const versions = plans.versions(plan.id).filter((v) => v.published_at).map(plans.presentVersion);
        return send(res, 200, {
            title: `Terms history · ${c.display_name || c.username}`, canonicalPath: `/${c.username}/plans/${plan.slug}`, viewer: req.viewer, robots: 'noindex,follow',
            body: pages.planHistory({ creator: creators.present(c), plan, versions }),
        });
    });
    post('/:username/join', async (req, res, to) => {
        const c = creators.byUsername(req.params.username);
        if (!c) throw new VipError(404, 'vip.creator_not_found', 'no such creator');
        const plan = plans.byId(String(req.body.plan_id || ''));
        if (!plan || plan.creator_id !== c.id) throw new VipError(404, 'vip.plan_not_found', 'that plan is not offered here');
        const out = await checkout.start({
            member: req.viewer.subject, planId: req.body.plan_id, provider: req.body.provider, autoRenew: bool(req.body.auto_renew),
            traceparent: req.ov.traceparent,
        });
        if (out.membership_started) return back(res, '/me', 'ok', `Welcome — you are now a member of ${c.display_name || c.username}.`);
        if (out.checkout_url && !out.checkout_ref) return res.redirect(303, out.checkout_url);
        return send(res, 200, { title: 'Finish joining', robots: 'noindex,nofollow', viewer: req.viewer, body: pages.checkoutPage({ creator: creators.present(c), out }) });
    }, { backTo: (req) => `/${req.params.username}` });

    return router;
}

module.exports = { createWebRoutes };
