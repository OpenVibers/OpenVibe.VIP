'use strict';
/**
 * The reusable membership card, badge and widget (roadmap §11.3): public data only (published plans,
 * perk names, a member count the creator may hide, never who the members are), the same for everyone
 * (no cookie read or set), safe to embed (the widget's CSP frame-ancestors, no script, the badge inert
 * when opened), and a member count from Billing that survives a Billing outage without inventing one.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, harness } = require('./helpers/app');

const { test, run } = harness('embeds');

(async () => {
    const t = await boot();
    const lena = t.network.newUser('lena', { role: 'streamer' });
    const quiet = t.network.newUser('quiet', { role: 'streamer' });
    const members = [t.network.newUser('milo'), t.network.newUser('nora')];
    const cookie = `ov_token=${t.network.signUser(members[0])}`;
    const get = async (p, headers = {}) => {
        const r = await fetch(t.base + p, { headers, redirect: 'manual' });
        return { status: r.status, headers: r.headers, text: await r.text() };
    };
    let plan;

    test('setup: a published plan with a badge perk, a draft and an archived plan, two members in Billing', async () => {
        await t.call('POST', '/api/v1/perks', { user: lena, body: { name: 'Supporter badge', key: 'supporter', kind: 'badge', bindings: [{ product: 'chat', binding: 'badge', config: { badge: 'secret-config' } }] } });
        await t.call('POST', '/api/v1/perks', { user: lena, body: { name: 'Members-only posts', key: 'posts', kind: 'gated_content' } });
        plan = (await t.call('POST', '/api/v1/plans', { user: lena, body: { name: 'Club', description: 'The club', benefits: ['A badge in chat'], perks: ['supporter', 'posts'], publish: true } })).json.plan;
        assert.ok(plan && plan.purchasable);
        await t.call('POST', '/api/v1/plans', { user: lena, body: { name: 'Secret draft plan', billing_kind: null } });
        const old = (await t.call('POST', '/api/v1/plans', { user: lena, body: { name: 'Old terms plan', billing_kind: null, publish: true } })).json.plan;
        await t.call('POST', `/api/v1/plans/${old.id}/archive`, { user: lena });
        for (const m of members) t.billing.pay(m.subject, lena.subject);
        await t.call('POST', '/api/v1/plans', { user: quiet, body: { name: 'Draft only' } });
    });

    test('card.json: published plans, perks, join and terms links, Billing\'s price and member count; CORS-open', async () => {
        const r = await get('/embed/lena/card.json');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
        assert.strictEqual(r.headers.get('access-control-allow-credentials'), null);
        assert.match(r.headers.get('cache-control'), /^public/);
        assert.strictEqual(r.headers.get('set-cookie'), null);
        const card = JSON.parse(r.text);
        assert.deepStrictEqual(card.creator, { username: 'lena', display_name: 'Lena', url: 'http://vip.test/lena' });
        assert.deepStrictEqual(card.plans.map((p) => p.name), ['Club'], 'no drafts, no archived plans');
        const club = card.plans[0];
        assert.deepStrictEqual(club.perks.map((p) => [p.key, p.kind]), [['supporter', 'badge'], ['posts', 'gated_content']]);
        assert.strictEqual(club.join_url, 'http://vip.test/lena#plan-club');
        assert.strictEqual(club.terms_url, 'http://vip.test/lena/plans/club');
        assert.strictEqual(card.joining_open, true);
        assert.deepStrictEqual(card.price, { price_cents: 499, period_days: 30, charged_by: 'OpenVibe.Billing' });
        assert.deepStrictEqual(card.members, { count: 2, shown: true, stale: false });
        assert.strictEqual(card.badge.label, 'Supporter');
        assert.strictEqual(card.badge.svg_url, 'http://vip.test/embed/lena/badge.svg');
        assert.strictEqual(card.widget_url, 'http://vip.test/embed/lena/widget');
        for (const secret of [lena.subject, ...members.map((m) => m.subject), 'secret-config', 'Secret draft', 'Old terms']) {
            assert.ok(!r.text.includes(secret), `the card leaks ${secret}`);
        }
        const signedIn = await get('/embed/lena/card.json', { Cookie: cookie, Authorization: 'Bearer not-even-checked' });
        assert.strictEqual(signedIn.text, r.text, 'the same for everyone: no cookie or token is read');
        assert.strictEqual(signedIn.headers.get('set-cookie'), null);
    });

    test('the API serves the same card to products by subject', async () => {
        const r = await t.call('GET', `/api/v1/creators/${lena.subject}/card`, { token: null });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.card.creator.username, 'lena');
        assert.strictEqual((await t.call('GET', `/api/v1/creators/${quiet.subject}/card`, { token: null })).status, 404, 'no published plan, no card');
        assert.strictEqual((await t.call('GET', '/api/v1/creators/network/card', { token: null })).status, 404);
    });

    test('badge.svg: an inert SVG image anyone can embed, names escaped', async () => {
        const r = await get('/embed/lena/badge.svg', { Cookie: cookie });
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /^image\/svg\+xml/);
        assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
        assert.match(r.headers.get('content-security-policy'), /sandbox/);
        assert.strictEqual(r.headers.get('cross-origin-resource-policy'), 'cross-origin');
        assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
        assert.strictEqual(r.headers.get('set-cookie'), null);
        assert.match(r.text, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
        assert.match(r.text, /★ Supporter/);
        assert.match(r.text, />Lena</);
        assert.ok(!/<script|\son\w+=|href=/i.test(r.text), 'no script, handler or link');
        // A display name with markup is text in the SVG.
        const evil = (await t.page('/dashboard', { user: lena })).text;
        const csrf = t.csrf(evil);
        await t.page('/dashboard/profile', { user: lena, method: 'POST', form: { _csrf: csrf, display_name: '<script>alert(1)</script> & "x"', bio: '', show_member_count: '1' } });
        const e = await get('/embed/lena/badge.svg');
        assert.ok(!e.text.includes('<script'), e.text);
        assert.match(e.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;x&quot;|&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;…/);
        await t.page('/dashboard/profile', { user: lena, method: 'POST', form: { _csrf: csrf, display_name: 'Lena', bio: '', show_member_count: '1' } });
    });

    test('widget: embeddable anywhere, no script, its style allowed by hash, the rest of VIP still not framable', async () => {
        const r = await get('/embed/lena/widget');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /^text\/html/);
        const csp = r.headers.get('content-security-policy');
        assert.match(csp, /default-src 'none'/);
        assert.match(csp, /frame-ancestors \*/);
        assert.match(csp, /form-action 'none'/);
        assert.match(csp, /base-uri 'none'/);
        assert.ok(!/unsafe-inline/.test(csp));
        const style = r.text.match(/<style>([\s\S]*?)<\/style>/)[1];
        assert.ok(csp.includes(`'sha256-${crypto.createHash('sha256').update(style).digest('base64')}'`), 'the inline style is allowed by its hash');
        assert.strictEqual(r.headers.get('x-frame-options'), null);
        assert.strictEqual(r.headers.get('set-cookie'), null);
        assert.ok(!/<script|\son\w+=/i.test(r.text), 'no script or handler');
        assert.match(r.text, /<b>2<\/b> members/);
        assert.match(r.text, /<a class="b" href="http:\/\/vip\.test\/lena" target="_blank" rel="noopener noreferrer">Join Lena<\/a>/);
        assert.match(r.text, /Club · Supporter badge, Members-only posts/);
        for (const m of members) assert.ok(!r.text.includes(m.subject) && !r.text.includes(m.username));
        const signedIn = await get('/embed/lena/widget', { Cookie: cookie });
        assert.strictEqual(signedIn.text, r.text, 'no personalisation');
        const dark = await get('/embed/lena/widget?theme=dark');
        const darkStyle = dark.text.match(/<style>([\s\S]*?)<\/style>/)[1];
        assert.notStrictEqual(darkStyle, style);
        assert.ok(dark.headers.get('content-security-policy').includes(crypto.createHash('sha256').update(darkStyle).digest('base64')));
        const page = await get('/lena');
        assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/, 'the plan page itself cannot be framed');
    });

    test('the creator can hide their member count', async () => {
        const dash = await t.page('/dashboard', { user: lena });
        assert.match(dash.text, /Share your memberships/);
        assert.match(dash.text, /\/embed\/lena\/widget/);
        await t.page('/dashboard/profile', { user: lena, method: 'POST', form: { _csrf: t.csrf(dash.text), display_name: 'Lena', bio: '' } });
        const card = JSON.parse((await get('/embed/lena/card.json')).text);
        assert.deepStrictEqual(card.members, { count: null, shown: false, stale: false });
        assert.ok(!/members<\/p>/.test((await get('/embed/lena/widget')).text));
        await t.page('/dashboard/profile', { user: lena, method: 'POST', form: { _csrf: t.csrf(dash.text), display_name: 'Lena', bio: '', show_member_count: '1' } });
        assert.strictEqual(JSON.parse((await get('/embed/lena/card.json')).text).members.count, 2);
    });

    test('member count: cached, then Billing\'s new answer; when Billing is down the last count is kept (stale), never invented', async () => {
        t.billing.pay(t.network.newUser('olga').subject, lena.subject);
        assert.strictEqual(JSON.parse((await get('/embed/lena/card.json')).text).members.count, 2, 'cached');
        t.clock.advance(t.config.embeds.memberCountTtlMs + 1);
        assert.strictEqual(JSON.parse((await get('/embed/lena/card.json')).text).members.count, 3);
        t.billing.state.down = true;
        t.clock.advance(t.config.embeds.memberCountTtlMs + 1);
        assert.deepStrictEqual(JSON.parse((await get('/embed/lena/card.json')).text).members, { count: 3, shown: true, stale: true });
        // A creator VIP never counted: no number rather than a guess.
        const fresh = t.network.newUser('fresh', { role: 'streamer' });
        t.billing.state.down = false;
        await t.call('POST', '/api/v1/plans', { user: fresh, body: { name: 'Fresh club', publish: true } });
        t.billing.state.down = true;
        const r = await get('/embed/fresh/card.json');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(JSON.parse(r.text).members, { count: null, shown: true, stale: false });
        assert.match((await get('/embed/fresh/widget')).text, /Fresh/);
        t.billing.state.down = false;
    });

    test('no card for an unknown name, a creator without a published plan, or a malformed name', async () => {
        for (const name of ['nobody', 'quiet', '..', '%3Cscript%3E']) {
            for (const kind of ['card.json', 'badge.svg', 'widget']) {
                const r = await get(`/embed/${name}/${kind}`);
                assert.strictEqual(r.status, 404, `${name}/${kind} → ${r.status}`);
                assert.strictEqual(r.headers.get('set-cookie'), null);
            }
        }
        const w = await get('/embed/nobody/widget');
        assert.match(w.headers.get('content-security-policy'), /default-src 'none'/);
        assert.match((await get('/robots.txt')).text, /Disallow: \/embed\//);
    });

    test('VIP_WIDGET_FRAME_ANCESTORS restricts who may frame the widget (and cannot add a directive)', async () => {
        const t2 = await boot({ env: { VIP_WIDGET_FRAME_ANCESTORS: "https://openvibe.live https://example.com; script-src 'unsafe-inline'" } });
        const zed = t2.network.newUser('zed', { role: 'streamer' });
        await t2.call('POST', '/api/v1/plans', { user: zed, body: { name: 'Zed club', publish: true } });
        const r = await fetch(`${t2.base}/embed/zed/widget`);
        assert.strictEqual(r.status, 200);
        const csp = r.headers.get('content-security-policy');
        assert.match(csp, /frame-ancestors https:\/\/openvibe\.live https:\/\/example\.com script-src 'unsafe-inline'$/);
        assert.ok(!/; script-src/.test(csp), 'no directive smuggled in');
        await t2.close();
    });

    await run();
})().catch((e) => { console.error(e); process.exit(1); });
