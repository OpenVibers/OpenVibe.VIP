'use strict';

/**
 * Server-rendered pages (useful without JavaScript):
 *
 *   GET  /                          directory of creators with published plans
 *   GET  /me                        the viewer's memberships, the version each was bought under, cancel
 *   GET  /dashboard[?as=network]    creator dashboard: plans, versions, perks, members, gated resources
 *   GET  /:username                 a creator's plan page (join through Billing)
 *   GET  /:username/plans/:slug     that plan's public terms history
 *   GET  /robots.txt, /sitemap.xml, /llms.txt, /llms-full.txt
 *
 * Every POST needs the signed-in viewer and the form's anti-forgery token; it acts through the same
 * domain calls as the API and redirects back with a notice (?ok= / ?error=).
 */
const crypto = require('crypto');
const cache = require('openvibe-shared/cache-policy');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const seo = require('openvibe-shared/seo');
const express = require('express');
const multer = require('multer');
const { VipError, bool } = require('../util');
const { viewerMiddleware } = require('./session');
const { createForms } = require('./forms');
const pages = require('./pages');

const RESERVED = new Set(['me', 'dashboard', 'auth', 'api', 'internal', 'css', 'js', 'terms', 'privacy', 'dmca', 'robots.txt', 'sitemap.xml', 'llms.txt', 'llms-full.txt', 'release.json', 'metrics', 'favicon.ico', 'embed']);
// The sitemap's lastmod: when this server booted — a real date, computed once, never per request.
const BOOT_AT = new Date().toISOString();

// The public description /llms.txt and /llms-full.txt share. llmstxt.org: a plain-markdown map of
// the site for language-model crawlers — public data only, never the viewer.
const LLMS_NAME = 'OpenVibe.VIP';
const LLMS_SUMMARY = 'OpenVibe.VIP: memberships for creators — plans, perks and benefits recognised across every OpenVibe site.';
const LLMS_DETAILS = 'A creator page lists the plans and perks a creator offers and how to join through Billing. Every plan keeps its published terms history, and a membership always points at the version it was bought under. Reading any public page needs no account; joining needs a signed-in person. Memberships, the dashboard, sign-in, embeds and the API are per-person and are never listed here.';
// /llms-full.txt changes only when a creator or a plan does, so it is built from the database at
// most once an hour (the browser keeps it the same 3600 s).
const LLMS_FULL_TTL_MS = 3600 * 1000;

function createWebRoutes({ domain, config, layout, userAuth, liveNow }) {
    const router = express.Router();
    const { creators, plans, perks, memberships, entitlements, policies, checkout, billing, prices } = domain;
    const forms = createForms({ secret: config.formSecret, now: domain.now });
    const isStaff = (v) => !!v && v.staff === true;
    router.use(viewerMiddleware(userAuth));
    const body = express.urlencoded({ extended: false, limit: '32kb' });
    // The post composer posts a form with an optional image: multipart, one file, 8 MB, in memory.
    const uploadImage = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 24, fieldSize: 64 * 1024 },
    }).single('image');

    let ratesCache = { at: 0, value: null };
    async function rates() {
        if (domain.now() - ratesCache.at < config.billing.ratesTtlMs) return ratesCache.value;
        try { ratesCache = { at: domain.now(), value: await billing.rates() }; } catch { ratesCache = { at: domain.now() - config.billing.ratesTtlMs + 30_000, value: null }; }
        return ratesCache.value;
    }

    const send = (res, status, o) => {
        // A public page names its Markdown twin in the Link header, exactly as the agent layer's own
        // responses do; a page rendered for a signed-in person (noindex) has no twin and no header.
        if (o && o.canonicalPath && !String(o.robots || 'index,follow').includes('noindex')) {
            res.set('Link', require('openvibe-shared/agent-layer').linkHeaderTags(layout.abs(o.canonicalPath), `${String(config.baseUrl).replace(/\/+$/, '')}/llms.txt`).header);
        }
        // The same page for every signed-out visitor: a minute of reuse, then a stale copy while the
        // new one is fetched. A page rendered for a signed-in person names them, so it stays private.
        if (!res.get('Cache-Control')) {
            res.vary('Cookie');
            res.set('Cache-Control', cache.htmlHeaders(o && o.viewer ? { private: true } : { maxAge: 60 }));
        }
        return res.status(status).type('html').send(layout.page(o));
    };
    const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
    /** A price typed in a form ("4.99", "$5"): cents, or null when left blank; anything else is refused. */
    function priceInput(v, { required = false } = {}) {
        if (v == null || String(v).trim() === '') {
            if (required) throw new VipError(422, 'vip.invalid_input', 'Type a monthly price, like 4.99.');
            return null;
        }
        const cents = prices.centsFromDollars(v);
        if (cents == null || cents <= 0) throw new VipError(422, 'vip.invalid_input', 'Type the monthly price in dollars and cents, like 4.99.');
        return cents;
    }
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
    function post(path, handler, { backTo, upload = null } = {}) {
        // A route with an upload takes the multipart parser first and the urlencoded one after it, so a
        // form without a file still works.
        const parser = upload ? [upload, body] : [body];
        router.post(path, ...parser, async (req, res, next) => {
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

    // Crawl and machine-readability artifacts, built from openvibe-shared/seo — the same
    // toolkit the other OpenVibe sites use. Public data only, never the viewer.
    router.get('/robots.txt', (req, res) => res.type('text/plain').send(seo.robotsTxt({
        sitemaps: [`${config.baseUrl}/sitemap.xml`],
        disallow: ['/me', '/dashboard', '/auth/', '/api/', '/embed/'],
    })));
    router.get('/sitemap.xml', async (req, res) => {
        const urls = [{ loc: `${config.baseUrl}/`, lastmod: BOOT_AT }, ...(await creators.listPublic({ limit: 5000 })).map((c) => ({ loc: `${config.baseUrl}/@${encodeURIComponent(c.username)}`, lastmod: BOOT_AT }))];
        res.type('application/xml').send(seo.sitemapXml(urls));
    });
    // /llms.txt (llmstxt.org): a plain-markdown map of the site for language-model crawlers.
    // AGT-5: own pages link their Markdown twins (openvibe-shared 4.108.0); ## Optional is what an agent may skip.
    router.get('/llms.txt', (req, res) => res.type('text/plain').send(seo.llmsTxt({
        name: LLMS_NAME,
        summary: LLMS_SUMMARY,
        details: LLMS_DETAILS,
        markdown: true,
        base: config.baseUrl,
        sections: [
            { title: 'Start here', links: [
                { title: 'Creators with published plans', url: `${config.baseUrl}/`, note: 'every creator on OpenVibe.VIP, with their public plans' },
            ] },
        ],
        optional: [
            { title: 'What shipped on OpenVibe.VIP', url: `${config.baseUrl}/updates` },
            { title: 'Sitemap', url: `${config.baseUrl}/sitemap.xml`, note: 'the public pages, with lastmod' },
            { title: 'robots.txt', url: `${config.baseUrl}/robots.txt` },
            { title: 'llms-full.txt', url: `${config.baseUrl}/llms-full.txt`, note: 'the full text of every public page' },
        ],
    })));

    // /llms-full.txt: /llms.txt with the full plain text of every public page — the home copy, each
    // creator's plan page and every published plan's terms. Built from public data only and cached
    // in memory for an hour; the response says the same, so caches and crawlers may keep it too.
    function termsText(v) {
        const out = [];
        if (v.description) out.push(v.description);
        if (v.benefits.length) out.push(`Benefits: ${v.benefits.join('; ')}.`);
        if (v.perks.length) out.push(`Perks: ${v.perks.map((p) => p.name).join(', ')}.`);
        if (v.change_note) out.push(`Change: ${v.change_note}.`);
        return out.join('\n');
    }
    async function buildLlmsFull() {
        const creatorPages = [];
        const planPages = [];
        for (const row of await creators.listPublic({ limit: 5000 })) {
            const c = creators.present(row);
            const name = c.display_name || c.username;
            const planRows = await Promise.all((await plans.list({ creatorId: c.id })).map(async (p) => await plans.present(p, { withVersions: true })));
            const about = [`${name} (@${c.username}) offers membership plans on OpenVibe.VIP.`];
            if (c.bio) about.push(c.bio);
            for (const p of planRows) {
                const v = p.current_version;
                about.push(`Plan ${v.name} (version ${v.version})${v.description ? `: ${v.description}` : ''}`);
            }
            creatorPages.push({ title: `${name} memberships`, url: `/@${c.username}`, text: about.join('\n\n') });
            for (const p of planRows) {
                const body = [`The published terms of ${name}'s ${p.current_version.name} plan on OpenVibe.VIP. Each edit is a new version; a member keeps the version they joined under.`];
                for (const v of (p.versions || []).filter((x) => x.published_at)) {
                    const terms = termsText(v);
                    body.push(`Version ${v.version}${v.published_at ? ` (published ${String(v.published_at).slice(0, 10)})` : ''}${terms ? `\n${terms}` : ''}`);
                }
                planPages.push({ title: `${name}: ${p.current_version.name} terms`, url: `/@${c.username}/plans/${p.slug}`, text: body.join('\n\n') });
            }
        }
        return seo.llmsFull({
            site: { name: LLMS_NAME, url: config.baseUrl },
            summary: `${LLMS_SUMMARY} ${LLMS_DETAILS}`,
            sections: [
                { title: 'Home', pages: [{ title: `${LLMS_NAME} home`, url: '/', text: `${LLMS_SUMMARY}\n\n${LLMS_DETAILS}\n\nThe home page lists every creator with a published plan.` }] },
                { title: 'Creators', pages: creatorPages },
                { title: 'Plans', pages: planPages },
            ],
        });
    }
    let llmsFullCache = { at: 0, value: null };
    router.get('/llms-full.txt', async (req, res, next) => {
        try {
            if (!llmsFullCache.value || domain.now() - llmsFullCache.at >= LLMS_FULL_TTL_MS) llmsFullCache = { at: domain.now(), value: await buildLlmsFull() };
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.type('text/plain').send(llmsFullCache.value);
        } catch (e) { next(e); }
    });

    // What shipped on OpenVibe.VIP: the shared update log every OpenVibe site has.
    router.get('/updates', (req, res) => send(res, 200, { viewer: req.viewer, canonicalPath: '/updates', title: 'What shipped on OpenVibe.VIP', body: frame.updatesBody({ service: 'vip', siteName: 'OpenVibe.VIP' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>` }));
    router.get('/', async (req, res) => {
        const list = (await creators.listPublic()).map(creators.present);
        const live = liveNow ? await liveNow.list() : [];
        send(res, 200, {
            title: pages.HOME_TITLE, description: pages.HOME_DESCRIPTION, jsonLd: [seo.jsonLd.website({ name: 'OpenVibe.VIP', url: `${String(config.baseUrl).replace(/\/+$/, '')}/`, description: pages.HOME_DESCRIPTION }), seo.jsonLd.organization(), pages.homeFaqJsonLd()],
            active: 'home', viewer: req.viewer, canonicalPath: '/', styles: [require('openvibe-shared/showcase').STYLESHEET],
            body: pages.home({ creators: list, live, networkUrl: config.network.url }),
        });
    });

    // ── The member's page ────────────────────────────────────
    router.get('/me', async (req, res, next) => {
        try {
            const rows = [];
            if (req.viewer) {
                for (const m of await memberships.forMember(req.viewer.subject)) {
                    const c = await creators.byId(m.creator_id);
                    const e = c && c.subject ? await entitlements.check(req.viewer.subject, c.subject, { mode: 'auto' }) : null;
                    rows.push({ membership: await memberships.present(m), creator: creators.present(c), entitlement: e, preferences: await memberships.preferences(req.viewer.subject, m.creator_id) });
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
        const c = await creators.byId(req.params.creatorId);
        if (!c || !await memberships.get(req.viewer.subject, c.id)) throw new VipError(404, 'vip.membership_not_found', 'no such membership');
        await memberships.setPreferences(req.viewer.subject, c.id, { showBadge: bool(req.body.show_badge) });
        back(res, to, 'ok', 'Saved.');
    }, { backTo: '/me' });

    // ── Creator dashboard ────────────────────────────────────
    /** The creator the dashboard acts for: the viewer, or the network for staff (?as=network). */
    async function dashCreator(req) {
        const asNetwork = (req.query.as || (req.body && req.body.as)) === 'network';
        if (asNetwork) {
            if (!isStaff(req.viewer)) throw new VipError(403, 'vip.not_staff', 'only staff manage network plans');
            return await creators.network();
        }
        return await creators.ensure({ subject: req.viewer.subject, username: req.viewer.username, displayName: req.viewer.name, origin: 'self' });
    }

    router.get('/dashboard', async (req, res, next) => {
        try {
            if (!req.viewer) return send(res, 200, { title: 'Dashboard', active: 'dashboard', robots: 'noindex,nofollow', viewer: null, body: pages.dashboard({ viewer: null }) });
            let creator;
            try { creator = await dashCreator(req); } catch (e) { return send(res, 403, { title: 'Dashboard', robots: 'noindex,nofollow', viewer: req.viewer, body: pages.errorPage({ status: 403, title: 'Not allowed', message: e.detail }) }); }
            const isNetwork = creator.kind === 'network';
            const planList = (await Promise.all((await plans.list({ creatorId: creator.id, includeDrafts: true, includeArchived: true })).map(async (p) => await plans.present(p, { withVersions: true }))));
            const planRows = isNetwork ? planList : await prices.withPrices(creator.subject, planList);
            const priceTable = isNetwork ? null : await prices.forCreator(creator.subject);
            const allPerks = (await Promise.all((await perks.list({ creatorId: creator.id })).map(async (p) => await perks.present(p, { withBindings: false }))));
            const ownPerks = (await Promise.all((await perks.list({ creatorId: creator.id, includeNetwork: false, includeRetired: true })).map(async (p) => await perks.present(p))));
            let members = [];
            let membersSource = 'billing';
            if (!isNetwork) {
                const byMember = new Map((await memberships.forCreator(creator.id)).map((m) => [m.member_subject, m]));
                try {
                    const out = await billing.listSubscriptions({ streamer: creator.subject, status: 'active' });
                    members = (await Promise.all((out.subscriptions || []).map(async (s) => ({ member: s.subscriber, current_period_end: s.current_period_end, cancel_at_period_end: !!s.cancel_at_period_end, membership: await memberships.present(byMember.get(s.subscriber.id)) }))));
                } catch {
                    membersSource = 'projection';
                    members = (await Promise.all((await entitlements.projectedMembers(creator.subject)).map(async (pr) => ({ member: { type: 'user', id: pr.member_subject }, current_period_end: pr.expires_at, cancel_at_period_end: !!pr.cancel_at_period_end, membership: await memberships.present(byMember.get(pr.member_subject)) }))));
                }
            }
            // The creator's own posts (with their text) and, for staff, every creator's posts to moderate.
            const postRows = isNetwork ? [] : await domain.posts.rows({ creatorId: creator.id, includeHidden: true });
            const postTiers = isNetwork ? [] : await domain.posts.offeredTiers(creator.id);
            const moderation = isStaff(req.viewer) ? await Promise.all((await domain.posts.recent({ limit: 50 })).map(async (row) => {
                const owner = await creators.byId(row.creator_id);
                return {
                    id: row.id, title: row.title, status: row.status, tiers: domain.posts.tiersOf(row),
                    creator: owner ? (owner.display_name || owner.username || owner.subject) : 'a creator',
                };
            })) : [];
            send(res, 200, {
                title: isNetwork ? 'Network plans' : 'Dashboard', active: 'dashboard', robots: 'noindex,nofollow', canonicalPath: '/dashboard', viewer: req.viewer,
                styles: ['ov-upload.css'], scripts: ['ov-upload.js'], pageScripts: ['js/post-upload.js'],
                body: pages.dashboard({
                    viewer: req.viewer, creator, isNetwork, isStaff: isStaff(req.viewer), plans: planRows, allPerks, ownPerks, members, membersSource, priceTable,
                    rules: isNetwork ? [] : await Promise.all((await policies.list(creator.id)).map(policies.present)), token: forms.token(req.viewer.subject), query: req.query, base: isNetwork ? '/dashboard/network' : '/dashboard',
                    embeds: !isNetwork && creator.username ? domain.cards.urls(creator) : null,
                    posts: postRows.map((row) => ({
                        id: row.id, title: row.title, tiers: domain.posts.tiersOf(row), status: row.status, published_at: row.published_at,
                        image: row.image_id ? { id: row.image_id, url: row.image_url } : null, body_html: row.body_html,
                    })),
                    postTiers, moderation,
                }),
            });
        } catch (e) { next(e); }
    });

    // Dashboard writes: /dashboard/... for the viewer's own creator, /dashboard/network/... for staff.
    for (const base of ['/dashboard', '/dashboard/network']) {
        const withAs = (req) => { if (base === '/dashboard/network') req.query.as = 'network'; };
        const own = async (req, row) => { withAs(req); const c = await dashCreator(req); if (!row || row.creator_id !== c.id) throw new VipError(404, 'vip.not_found', 'not found'); return c; };
        const opts = { backTo: () => (base === '/dashboard/network' ? '/dashboard?as=network' : '/dashboard') };
        post(`${base}/profile`, async (req, res, to) => {
            withAs(req);
            const c = await dashCreator(req);
            await creators.update(c.id, { displayName: req.body.display_name, bio: req.body.bio, showMemberCount: c.kind === 'creator' ? bool(req.body.show_member_count) : undefined });
            back(res, to, 'ok', 'Profile saved.');
        }, opts);
        post(`${base}/plans`, async (req, res, to) => {
            withAs(req);
            const c = await dashCreator(req);
            const cents = priceInput(req.body.price);
            const plan = await plans.create({ creatorId: c.id, name: req.body.name, description: req.body.description, benefits: lines(req.body.benefits), perks: list(req.body.perks), tier: req.body.tier || undefined, publish: bool(req.body.publish), actor: req.viewer.subject, traceparent: req.ov.traceparent });
            if (cents != null && plan.billing_kind) await prices.set(c, plan, cents, { traceparent: req.ov.traceparent });
            back(res, to, 'ok', `Plan created${plan.status === 'published' ? ' and published' : ''}${cents != null && plan.billing_kind ? ` at ${dollars(cents)} a month` : ''}.`);
        }, opts);
        // The plan's tier price, kept and charged by Billing (domain/prices.js).
        post(`${base}/plans/:id/price`, async (req, res, to) => {
            const plan = await plans.byId(req.params.id);
            const c = await own(req, plan);
            const cents = priceInput(req.body.price, { required: true });
            await prices.set(c, plan, cents, { traceparent: req.ov.traceparent });
            back(res, to, 'ok', `Price set: ${dollars(cents)} a month for new members. Current members keep the price they joined at.`);
        }, opts);
        post(`${base}/plans/:id`, async (req, res, to) => {
            const plan = await plans.byId(req.params.id);
            await own(req, plan);
            const out = await plans.update(plan.id, { name: req.body.name, description: req.body.description, benefits: lines(req.body.benefits), perks: list(req.body.perks), changeNote: req.body.change_note, actor: req.viewer.subject, traceparent: req.ov.traceparent });
            back(res, to, 'ok', out.unchanged ? 'Nothing changed.' : `Saved as version ${out.version.version}.`);
        }, opts);
        post(`${base}/plans/:id/publish`, async (req, res, to) => {
            const plan = await plans.byId(req.params.id);
            await own(req, plan);
            await plans.publish(plan.id, { traceparent: req.ov.traceparent });
            back(res, to, 'ok', 'Published.');
        }, opts);
        post(`${base}/plans/:id/archive`, async (req, res, to) => {
            const plan = await plans.byId(req.params.id);
            await own(req, plan);
            await plans.archive(plan.id);
            back(res, to, 'ok', 'Archived. Current members keep their terms until their membership ends.');
        }, opts);
        const bindingLines = (v) => lines(v).map((l) => { const [product, binding] = l.split(/\s+/); return { product, binding }; });
        post(`${base}/perks`, async (req, res, to) => {
            withAs(req);
            const c = await dashCreator(req);
            await perks.create({ creatorId: c.id, key: req.body.key || undefined, name: req.body.name, description: req.body.description, kind: req.body.kind || 'other', bindings: bindingLines(req.body.bindings), actor: req.viewer.subject });
            back(res, to, 'ok', 'Perk created.');
        }, opts);
        post(`${base}/perks/:id`, async (req, res, to) => {
            const p = await perks.byId(req.params.id);
            await own(req, p);
            await perks.update(p.id, { name: req.body.name, description: req.body.description, status: req.body.status, bindings: bindingLines(req.body.bindings) });
            back(res, to, 'ok', 'Perk saved.');
        }, opts);
        if (base === '/dashboard') {
            post(`${base}/rules`, async (req, res, to) => {
                const c = await dashCreator(req);
                await policies.set({
                    creatorId: c.id, resource: { service: req.body.service, type: req.body.type, id: req.body.id }, requirement: req.body.requirement || 'member',
                    planId: req.body.plan_id || null, perkKey: req.body.perk_key || null, sensitive: bool(req.body.sensitive), actor: req.viewer.subject,
                });
                back(res, to, 'ok', 'Rule saved.');
            }, opts);
            post(`${base}/rules/:id/disable`, async (req, res, to) => {
                const rule = await policies.byId(req.params.id);
                await own(req, rule);
                await policies.disable(rule.id);
                back(res, to, 'ok', 'Rule removed.');
            }, opts);
            // A post for the members of one or more of the creator's tiers (an optional image goes to Media).
            post(`${base}/posts`, async (req, res, to) => {
                const c = await dashCreator(req);
                const tiers = list(req.body.tiers).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 10);
                let image = null;
                if (req.file && req.file.buffer && req.file.buffer.length) {
                    try {
                        image = await domain.media.uploadImage({ buffer: req.file.buffer, mime: req.file.mimetype, filename: req.file.originalname, owner: c.subject });
                    } catch (e) {
                        throw new VipError(503, 'vip.image_failed', `The image could not be stored: ${e.detail || e.message}`);
                    }
                }
                await domain.posts.create({ creatorId: c.id, title: req.body.title, body: req.body.body, tiers, image, actor: req.viewer.subject, traceparent: req.ov.traceparent });
                back(res, to, 'ok', 'Post published.');
            }, { ...opts, upload: uploadImage });
            post(`${base}/posts/:id/hide`, async (req, res, to) => {
                const row = await domain.posts.byId(req.params.id);
                await own(req, row);
                await domain.posts.hide(row.id, { actor: req.viewer.subject });
                back(res, to, 'ok', 'Post hidden. Nobody reads it now.');
            }, opts);
            post(`${base}/posts/:id/unhide`, async (req, res, to) => {
                const row = await domain.posts.byId(req.params.id);
                await own(req, row);
                await domain.posts.unhide(row.id, { actor: req.viewer.subject });
                back(res, to, 'ok', 'Post shown again.');
            }, opts);
        }
    }

    // Staff moderation: hide or show any creator's post (the way staff manage network plans).
    post('/dashboard/moderation/posts/:id/hide', async (req, res, to) => {
        if (!isStaff(req.viewer)) throw new VipError(403, 'vip.not_staff', 'only staff moderate posts');
        const row = await domain.posts.byId(req.params.id);
        if (!row) throw new VipError(404, 'vip.post_not_found', 'no such post');
        await domain.posts.hide(row.id, { actor: req.viewer.subject, reason: 'hidden by staff' });
        back(res, to, 'ok', 'Post hidden.');
    }, { backTo: '/dashboard' });
    post('/dashboard/moderation/posts/:id/unhide', async (req, res, to) => {
        if (!isStaff(req.viewer)) throw new VipError(403, 'vip.not_staff', 'only staff moderate posts');
        const row = await domain.posts.byId(req.params.id);
        if (!row) throw new VipError(404, 'vip.post_not_found', 'no such post');
        await domain.posts.unhide(row.id, { actor: req.viewer.subject, staff: true });
        back(res, to, 'ok', 'Post shown again.');
    }, { backTo: '/dashboard' });

    // ── Creator pages ────────────────────────────────────────
    router.get('/@:username', async (req, res, next) => {
        try {
            if (RESERVED.has(req.params.username.toLowerCase())) return notFound(req, res);
            const c = await creators.byUsername(req.params.username);
            if (!c || c.status !== 'active') return notFound(req, res);
            if (c.username !== req.params.username) return res.redirect(301, `/@${encodeURIComponent(c.username)}`);
            const list = await prices.withPrices(c.subject, (await Promise.all((await plans.list({ creatorId: c.id })).map(async (p) => await plans.present(p)))));
            const isOwner = !!(req.viewer && req.viewer.subject === c.subject);
            const member = req.viewer && !isOwner ? await entitlements.check(req.viewer.subject, c.subject, { mode: 'auto' }) : null;
            const name = c.display_name || c.username;
            // The posts: the title and the tier are public, the text only for a member of that tier.
            const posts = [];
            for (const row of await domain.posts.rows({ creatorId: c.id })) {
                const tiers = domain.posts.tiersOf(row);
                // The plan that opens this post: the cheapest tier that reads it and can be joined (a tier
                // above it reads it too). When no such plan can be joined, the post offers no way in — a
                // primary button must never lead to a dead end.
                const needed = tiers.length ? Math.min(...tiers) : null;
                const target = needed == null ? null : list.filter((p) => p.purchasable && p.tier && p.tier >= needed).sort((a, b) => a.tier - b.tier)[0];
                const access = isOwner
                    ? { unlocked: true }
                    : await domain.posts.access({
                        post: row, memberSubject: req.viewer ? req.viewer.subject : null, creatorSubject: c.subject, creatorId: c.id,
                        entitlement: member, traceparent: req.ov.traceparent,
                    });
                posts.push({
                    id: row.id, title: row.title, tiers, published_at: row.published_at,
                    image: row.image_id ? { id: row.image_id, url: row.image_url } : null,
                    unlocked: !!access.unlocked, body_html: access.unlocked ? row.body_html : null,
                    join_url: target ? `/@${encodeURIComponent(c.username)}#plan-${encodeURIComponent(target.slug)}` : null,
                });
            }
            send(res, 200, {
                title: `${name} memberships`, active: 'creator', canonicalPath: `/@${c.username}`, viewer: req.viewer,
                description: c.bio || `Membership plans from ${name} on OpenVibe.`,
                robots: list.length ? 'index,follow' : 'noindex,follow',
                body: pages.creatorPage({ creator: creators.present(c), plans: list, viewer: req.viewer, member, rates: list.some((p) => p.purchasable) ? await rates() : null, providers: config.billing.providers, token: req.viewer ? forms.token(req.viewer.subject) : '', query: req.query, isOwner, posts }),
            });
        } catch (e) { next(e); }
    });
    router.get('/@:username/plans/:slug', async (req, res) => {
        const c = await creators.byUsername(req.params.username);
        if (!c || c.status !== 'active') return notFound(req, res);
        const plan = (await plans.list({ creatorId: c.id, includeArchived: true })).find((p) => p.slug === req.params.slug);
        if (!plan) return notFound(req, res);
        const versions = (await Promise.all((await plans.versions(plan.id)).filter((v) => v.published_at).map(plans.presentVersion)));
        return send(res, 200, {
            title: `Terms history · ${c.display_name || c.username}`, canonicalPath: `/@${c.username}/plans/${plan.slug}`, viewer: req.viewer, robots: 'noindex,follow',
            body: pages.planHistory({ creator: creators.present(c), plan, versions }),
        });
    });
    // The canonical creator address is /@<username>. The root /<username> form is kept only as a 301 from old
    // links (query kept); a name that is not an active creator still 404s.
    const legacyCreator = (suffix) => async (req, res, next) => {
        try {
            if (RESERVED.has(String(req.params.username).toLowerCase())) return notFound(req, res);
            const c = await creators.byUsername(req.params.username);
            if (!c || c.status !== 'active') return notFound(req, res);
            const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
            return res.redirect(301, `/@${encodeURIComponent(c.username)}${suffix}${q}`);
        } catch (e) { next(e); }
    };
    router.get('/:username', legacyCreator(''));
    router.get('/:username/plans/:slug', async (req, res, next) => {
        try {
            if (RESERVED.has(String(req.params.username).toLowerCase())) return notFound(req, res);
            const c = await creators.byUsername(req.params.username);
            if (!c || c.status !== 'active') return notFound(req, res);
            const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
            return res.redirect(301, `/@${encodeURIComponent(c.username)}/plans/${encodeURIComponent(req.params.slug)}${q}`);
        } catch (e) { next(e); }
    });

    post('/@:username/join', async (req, res, to) => {
        const c = await creators.byUsername(req.params.username);
        if (!c) throw new VipError(404, 'vip.creator_not_found', 'no such creator');
        const plan = await plans.byId(String(req.body.plan_id || ''));
        if (!plan || plan.creator_id !== c.id) throw new VipError(404, 'vip.plan_not_found', 'that plan is not offered here');
        const out = await checkout.start({
            member: req.viewer.subject, planId: req.body.plan_id, provider: req.body.provider, autoRenew: bool(req.body.auto_renew),
            traceparent: req.ov.traceparent,
        });
        if (out.membership_started) return back(res, '/me', 'ok', `Welcome — you are now a member of ${c.display_name || c.username}.`);
        if (out.checkout_url && !out.checkout_ref) return res.redirect(303, out.checkout_url);
        return send(res, 200, { title: 'Finish joining', robots: 'noindex,nofollow', viewer: req.viewer, body: pages.checkoutPage({ creator: creators.present(c), out }) });
    }, { backTo: (req) => `/@${req.params.username}` });

    // An old in-flight join form: 308 keeps the method and body while moving it to the canonical address.
    router.post('/:username/join', async (req, res, next) => {
        if (String(req.params.username).startsWith('@')) return next();   // the canonical /@:username/join route above
        try {
            const c = await creators.byUsername(req.params.username);
            if (!c || c.status !== 'active') return notFound(req, res);
            return res.redirect(308, `/@${encodeURIComponent(c.username)}/join`);
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = { createWebRoutes };
