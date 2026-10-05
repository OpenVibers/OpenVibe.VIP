'use strict';

/**
 * Page shell for every server-rendered page, composed by openvibe-shared/shell: full <head> SEO
 * (title, description, canonical, robots, Open Graph, JSON-LD), the shared OpenVibe Frame (app icon,
 * navbar.js from the Network, the SSR footer and a <noscript> navigation), this site's stylesheet
 * and its small progressive script. Everything is useful without JavaScript.
 */
const crypto = require('crypto');
const ovServe = require('openvibe-shared/serve');
const fs = require('fs');
const path = require('path');
const appIcon = require('openvibe-shared/app-icon');
const frame = require('openvibe-shared/frame');
const shell = require('openvibe-shared/shell');

const SITE_NAME = 'OpenVibe.VIP';
const NETWORK_URL = 'https://openvibe.network';
const DEFAULT_DESCRIPTION = 'Memberships on the OpenVibe network: join a creator\'s plan, see the terms you joined under and the perks that come with it on every OpenVibe site.';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const _hashes = new Map();
function asset(rel) {
    if (!_hashes.has(rel)) {
        let v = 'dev';
        try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing in tests */ }
        _hashes.set(rel, v);
    }
    return `/${rel}?v=${_hashes.get(rel)}`;
}
const assetVersion = (rel) => { asset(rel); return _hashes.get(rel); };

// The deployed release (app.js sets it from openvibe-shared/release): openvibe-shared/boost swaps a page in place only
// between pages of the same release, and does a normal load across a deploy.
let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

const NAV_LINKS = [
    { label: 'Memberships', href: '/me' },
    { label: 'Dashboard', href: '/dashboard' },
];

function createLayout({ config, release }) {
    const abs = (p) => (/^https?:\/\//i.test(p) ? p : `${config.baseUrl}${p.startsWith('/') ? '' : '/'}${p}`);

    /**
     * o: title, description, canonicalPath, robots ('index,follow' | 'noindex,nofollow'), body,
     *    active ('home'|'memberships'|'dashboard'|'creator'), ogImage, jsonLd (array), viewer
     */
    function page(o) {
        const description = (o.description || DEFAULT_DESCRIPTION).replace(/\s+/g, ' ').trim().slice(0, 300);
        const canonical = abs(o.canonicalPath || '/');
        const nav = {
            service: 'vip', apiBase: NETWORK_URL,
            links: NAV_LINKS.map((l) => ({ ...l, active: o.active === l.label.toLowerCase() })),
            history: { type: 'page', title: o.title || SITE_NAME },
            silentLogin: `${config.baseUrl}/auth/login?silent=1&next={url}`,
            sessionUrl: '/auth/me',
            loginUrl: '/auth/login?next={path}',           // filled from the current page (boost moves between pages)
            logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
            notificationsRealtime: true,   // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
        };
        const footer = { service: 'vip', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };
        const who = o.viewer
            ? `<span class="who">Signed in as <b>${esc(o.viewer.name || o.viewer.username || 'you')}</b> · <a href="/auth/logout?next=/">Sign out</a></span>`
            : `<a class="who" href="/auth/login?next=${encodeURIComponent(o.canonicalPath || '/')}">Sign in</a>`;
        // shell.page writes the document, the SEO head (+ the WebPage JSON-LD and ai-summary from the
        // summary), the theme-loader, navbar.js/footer.js with the navbar init, the noscript nav and
        // the SSR footer; the rest of the head is this site's own.
        return shell.page({
            name: SITE_NAME, service: 'vip', lang: 'en',
            title: o.title || `${SITE_NAME} — memberships across OpenVibe`,
            titleSuffix: o.title ? ` · ${SITE_NAME}` : undefined,
            siteName: SITE_NAME, description, canonical, robots: o.robots || 'index,follow',
            type: o.ogType || 'website', image: o.ogImage, jsonLd: o.jsonLd,
            summary: description, url: canonical,
            navbar: nav, footer, home: '/', navLinks: NAV_LINKS,
            head: [
                '<meta name="referrer" content="strict-origin-when-cross-origin">',
                appIcon.headTags({ site: 'vip' }),
                release ? release.metaTag() : '',
                `<link rel="stylesheet" href="${asset('css/vip.css')}">`,
                // openvibe-shared stylesheets a page asks for by name (the home's showcase.css).
                ...(o.styles || []).map((name) => `<link rel="stylesheet" href="${ovServe.url(name)}">`),
                `<meta name="ov-boost" content="vip@${esc(RELEASE)}">`,
                `<script src="${ovServe.url('boost.js')}" data-main="#main" defer></script>`,
                `<script src="${asset('js/vip.js')}" defer></script>`,
            ].filter(Boolean).join('\n'),
            body: `<div id="navbar-mount"></div>
<header class="site-head"><a class="brand" href="/">${SITE_NAME}</a><nav>${NAV_LINKS.map((l) => `<a href="${l.href}"${o.active === l.label.toLowerCase() ? ' aria-current="page"' : ''}>${l.label}</a>`).join('')}</nav>${who}</header>
<main id="main" class="page">
${o.body || ''}
${o.canonicalPath === '/' && o.active === 'home' ? frame.shipped({ service: 'vip', title: `Recently shipped on ${SITE_NAME}` }) : ''}
</main>
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav, footer }).replace(/</g, '\\u003c')};
window.addEventListener('DOMContentLoaded', function () {
  if (window.OpenVibeNavbar) document.documentElement.classList.add('ov-has-navbar');
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* the SSR footer stays */ }
});
</script>`,
            bodyAttributes: { 'data-page': o.active || 'page' },
        });
    }

    return { page, abs };
}

module.exports = { createLayout, esc, asset, assetVersion, setRelease, SITE_NAME, DEFAULT_DESCRIPTION };
