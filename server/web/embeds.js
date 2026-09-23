'use strict';

/**
 * Embeds for other products and other sites: a creator's membership card, badge and widget.
 *
 *   GET /embed/:username/card.json   the public card (server/domain/cards.js), CORS-open
 *   GET /embed/:username/badge.svg   the creator's member badge as an SVG image
 *   GET /embed/:username/widget      an HTML widget for an <iframe>: member count and a join link
 *
 * They are the same for everyone. They are mounted before the cookie parser and never read a cookie,
 * a token or the viewer. They set no cookie, run no script and carry nothing private: published plans,
 * perk names, a member count the creator may switch off, never who the members are.
 *
 * Headers:
 *   card.json   Access-Control-Allow-Origin: * (no credentials), Cache-Control public
 *   badge.svg   image/svg+xml, CSP default-src 'none'; sandbox (inert if opened directly),
 *               Cross-Origin-Resource-Policy: cross-origin (usable as an <img> anywhere)
 *   widget      CSP default-src 'none', the style allowed by its hash, form-action/base-uri 'none',
 *               frame-ancestors = VIP_WIDGET_FRAME_ANCESTORS (any site by default; every other VIP
 *               page stays frame-ancestors 'self'); links open in a new tab with no opener
 */
const crypto = require('crypto');
const express = require('express');
const { esc } = require('../util');

const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}$/;
// XML 1.0 forbids most control characters; a name carrying one would break the SVG.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const xml = (s) => esc(String(s == null ? '' : s).replace(CONTROL, ''));
const clip = (s, n) => { const a = [...String(s || '')]; return a.length > n ? `${a.slice(0, n - 1).join('')}…` : a.join(''); };
const fmt = (n) => Number(n).toLocaleString('en-US');

// The widget's styles, one per theme, allowed by hash (no 'unsafe-inline').
const BASE_CSS = `*{box-sizing:border-box}html,body{margin:0;height:100%}body{font:15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg)}
.w{height:100%;display:flex;flex-direction:column;justify-content:center;gap:6px;padding:14px 16px;border:1px solid var(--line);border-radius:12px}
.k{margin:0;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}h1{margin:0;font-size:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.n{margin:0;color:var(--muted)}.n b{color:var(--fg)}ul{margin:0;padding:0;list-style:none;font-size:13px;color:var(--muted)}li{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.b{align-self:flex-start;margin-top:4px;padding:7px 14px;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;text-decoration:none}.b:focus-visible{outline:2px solid var(--fg);outline-offset:2px}`;
const LIGHT = '--bg:#ffffff;--fg:#0f172a;--muted:#475569;--line:#e2e8f0;--accent:#2563eb';
const DARK = '--bg:#0b1220;--fg:#e6edf7;--muted:#9aa7bd;--line:rgba(255,255,255,.12);--accent:#3b82f6';
const STYLES = {
    auto: `:root{${LIGHT}}@media (prefers-color-scheme:dark){:root{${DARK}}}${BASE_CSS}`,
    light: `:root{${LIGHT}}${BASE_CSS}`,
    dark: `:root{${DARK}}${BASE_CSS}`,
};
const HASH = Object.fromEntries(Object.entries(STYLES).map(([k, css]) => [k, `'sha256-${crypto.createHash('sha256').update(css).digest('base64')}'`]));

function badgeSvg({ label, name }) {
    const left = `★ ${clip(label, 24)}`;
    const right = clip(name, 28);
    const width = (s) => Math.round([...s].length * 6.8 + 14);
    const lw = width(left);
    const rw = width(right);
    const w = lw + rw;
    const title = `${label} of ${name} on OpenVibe.VIP`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" viewBox="0 0 ${w} 20" role="img" aria-label="${xml(title)}">
<title>${xml(title)}</title>
<linearGradient id="g" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-opacity=".12"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="4" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#1f2937"/><rect x="${lw}" width="${rw}" height="20" fill="#2563eb"/><rect width="${w}" height="20" fill="url(#g)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,Geneva,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${xml(left)}</text><text x="${lw + rw / 2}" y="14">${xml(right)}</text></g>
</svg>
`;
}

function widgetHtml({ card, theme }) {
    const name = card.creator.display_name;
    const m = card.members;
    const count = m.shown && m.count != null ? `<p class="n"><b>${fmt(m.count)}</b> member${m.count === 1 ? '' : 's'}</p>` : '';
    const plans = card.plans.slice(0, 3).map((p) => `<li>${xml(p.name)}${p.perks.length ? ` · ${xml(p.perks.map((x) => x.name).join(', '))}` : ''}</li>`).join('');
    const cta = card.joining_open ? `Join ${xml(clip(name, 24))}` : 'See the plans';
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${xml(name)} memberships · OpenVibe.VIP</title><style>${STYLES[theme]}</style></head>
<body><main class="w"><p class="k">Memberships on OpenVibe.VIP</p><h1>${xml(name)}</h1>${count}<ul>${plans}</ul>
<a class="b" href="${xml(card.join_url)}" target="_blank" rel="noopener noreferrer">${cta}</a></main></body></html>
`;
}

function createEmbedRoutes({ domain, config }) {
    const r = express.Router();
    const { creators, cards } = domain;
    const frameAncestors = config.embeds.frameAncestors;

    /** The creator and its card, or null (unknown handle, suspended, no published plan). */
    async function lookup(username) {
        if (!USERNAME_RE.test(String(username || ''))) return null;
        const c = creators.byUsername(username);
        const card = c ? await cards.card(c) : null;
        return card ? { c, card } : null;
    }
    const common = (res) => res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' });

    r.get('/:username/card.json', async (req, res, next) => {
        try {
            const found = await lookup(req.params.username);
            common(res).set({ 'Access-Control-Allow-Origin': '*', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
            if (!found) return res.status(404).set('Cache-Control', 'public, max-age=60').json({ code: 'vip.creator_not_found', detail: 'no public membership card for this name' });
            return res.set('Cache-Control', 'public, max-age=60').json(found.card);
        } catch (e) { return next(e); }
    });

    r.get('/:username/badge.svg', async (req, res, next) => {
        try {
            const found = await lookup(req.params.username);
            common(res).set({ 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*' });
            if (!found) return res.status(404).set('Cache-Control', 'public, max-age=60').type('text/plain').send('No member badge for this name.\n');
            return res.status(200).set('Cache-Control', 'public, max-age=300').type('image/svg+xml; charset=utf-8')
                .send(badgeSvg({ label: found.card.badge.label, name: found.card.creator.display_name }));
        } catch (e) { return next(e); }
    });

    r.get('/:username/widget', async (req, res, next) => {
        try {
            const theme = ['light', 'dark'].includes(req.query.theme) ? req.query.theme : 'auto';
            const found = await lookup(req.params.username);
            common(res).set({
                'Content-Security-Policy': [`default-src 'none'`, `style-src ${HASH[theme]}`, "img-src 'none'", "base-uri 'none'", "form-action 'none'", `frame-ancestors ${frameAncestors}`].join('; '),
                'Referrer-Policy': 'strict-origin-when-cross-origin',
            });
            res.removeHeader('X-Frame-Options');
            if (!found) {
                return res.status(404).set('Cache-Control', 'public, max-age=60').type('html')
                    .send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>OpenVibe.VIP</title><style>${STYLES[theme]}</style></head><body><main class="w"><p class="k">OpenVibe.VIP</p><p class="n">No memberships to show.</p></main></body></html>\n`);
            }
            return res.status(200).set('Cache-Control', 'public, max-age=60').type('html').send(widgetHtml({ card: found.card, theme }));
        } catch (e) { return next(e); }
    });

    return r;
}

module.exports = { createEmbedRoutes, badgeSvg, widgetHtml, STYLES, HASH };
