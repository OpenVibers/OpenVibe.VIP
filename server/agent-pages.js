'use strict';
// The Markdown twins of openvibe.vip' public pages (openvibe-shared/agent-layer), rendered by the same
// public data readers and page builders the routes use (web/pages.js through web/layout.js). They are
// signed out, so no member state, join form token or owner view can leak into a twin. Private pages
// (/me, /dashboard, auth, API) are never rendered here, and a creator page with no published plan is
// noindex on the site, so it has no twin either.
const pages = require('./web/pages');

const RESERVED = new Set(['me', 'dashboard', 'auth', 'api', 'internal', 'css', 'js', 'terms', 'privacy', 'dmca', 'robots.txt', 'sitemap.xml', 'llms.txt', 'llms-full.txt', 'release.json', 'metrics', 'favicon.ico', 'embed']);

function createAgentPages({ domain, config, layout, liveNow }) {
    const { creators, plans, prices, billing } = domain;

    async function home() {
        const list = (await creators.listPublic()).map(creators.present);
        const live = liveNow ? await liveNow.list() : [];
        return {
            html: layout.page({
                title: pages.HOME_TITLE, description: pages.HOME_DESCRIPTION, jsonLd: [pages.homeFaqJsonLd()],
                active: 'home', canonicalPath: '/', styles: [require('openvibe-shared/showcase').STYLESHEET], viewer: null,
                body: pages.home({ creators: list, live, networkUrl: config.network.url }),
            }),
        };
    }

    function updates() {
        return {
            html: layout.page({
                canonicalPath: '/updates', title: 'What shipped on OpenVibe.VIP', viewer: null,
                body: require('openvibe-shared/frame').updatesBody({ service: 'vip', siteName: 'OpenVibe.VIP' }) + `<script src="${require('openvibe-shared/serve').url('shipped.js')}" defer></script>`,
            }),
        };
    }

    async function creator(username) {
        if (RESERVED.has(String(username).toLowerCase())) return null;
        const c = await creators.byUsername(username);
        if (!c || c.status !== 'active') return null;
        const list = await prices.withPrices(c.subject, await Promise.all((await plans.list({ creatorId: c.id })).map(async (p) => await plans.present(p))));
        if (!list.length) return null;   // the site keeps a planless creator page noindex
        // The price line reads Billing's published charge; a Billing outage leaves the page's honest fallback.
        let chargeRates = null;
        if (list.some((p) => p.purchasable)) { try { chargeRates = await billing.rates(); } catch { chargeRates = null; } }
        const name = c.display_name || c.username;
        return {
            html: layout.page({
                title: `${name} memberships`, active: 'creator', canonicalPath: `/${c.username}`, robots: 'index,follow',
                description: c.bio || `Membership plans from ${name} on OpenVibe.`, viewer: null,
                body: pages.creatorPage({
                    creator: creators.present(c), plans: list, viewer: null, member: null, rates: chargeRates,
                    providers: config.billing.providers, token: '', query: {}, isOwner: false,
                }),
            }),
        };
    }

    async function renderPublicPage(path) {
        const p = String(path || '/').replace(/\/+$/, '') || '/';
        if (p === '/') return home();
        if (p === '/updates') return updates();
        const m = /^\/([^/]+)$/.exec(p);
        if (!m) return null;
        return creator(decodeURIComponent(m[1]));
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
