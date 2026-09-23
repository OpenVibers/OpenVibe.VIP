'use strict';
/**
 * Checkout hand-off and cancellation through Billing, members lists, readiness/metrics, and the
 * server-rendered pages (useful without JavaScript, forms with anti-forgery tokens).
 */
const assert = require('assert');
const { boot, harness } = require('./helpers/app');

const { test, run } = harness('api');

(async () => {
    const t = await boot();
    const creator = t.network.newUser('lena', { role: 'streamer' });
    const buyer = t.network.newUser('milo');
    const payer = t.network.newUser('nora');
    let plan;

    test('health, release and truthful readiness', async () => {
        const h = await t.call('GET', '/api/health', { token: null });
        assert.strictEqual(h.json.service, 'vip');
        const rel = await t.call('GET', '/release.json', { token: null });
        assert.strictEqual(rel.json.service, 'vip');
        // Billing down: VIP stays ready (the projection still answers while fresh) and says so.
        t.billing.state.down = true;
        const r = await t.call('GET', '/api/ready', { token: null });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.ready, true);
        assert.strictEqual(r.json.status, 'degraded');
        assert.deepStrictEqual(r.json.degraded, ['billing']);
        assert.strictEqual(r.json.checks.db.required, true);
        assert.strictEqual(r.json.checks.billing.required, false);
        assert.strictEqual(typeof r.json.projection.rows, 'number');
        t.billing.state.down = false;
    });

    test('/metrics answers loopback callers with golden signals and VIP gauges', async () => {
        const m = await fetch(`${t.base}/metrics`);
        assert.strictEqual(m.status, 200);
        const text = await m.text();
        assert.match(text, /vip_outbox_pending/);
        assert.match(text, /vip_projection_rows\{state="fresh"\}/);
        assert.match(text, /http_requests_total|http_request_duration_seconds/);
    });

    test('the creator publishes a plan', async () => {
        plan = (await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Front row', description: 'Monthly membership', benefits: ['Badge in chat'], publish: true } })).json.plan;
        assert.ok(plan && plan.purchasable);
    });

    test('checkout hand-off returns Billing\'s checkout (PowerChat reference / provider URL) and records the version', async () => {
        const pc = await t.call('POST', '/api/v1/checkout', { user: buyer, body: { plan_id: plan.id, provider: 'powerchat' } });
        assert.strictEqual(pc.status, 201, pc.text);
        assert.match(pc.json.checkout_ref, /^pcsub:/);
        assert.strictEqual(pc.json.membership_started, false);
        assert.strictEqual(pc.json.checkout.plan_version_id, plan.current_version.id);
        const intentCall = t.billing.calls.filter((c) => c.path === '/api/v1/intents').pop();
        assert.strictEqual(intentCall.key, `vip:checkout:${pc.json.checkout.id}`);
        assert.strictEqual(intentCall.body.kind, 'subscription');
        assert.deepStrictEqual(intentCall.body.streamer, { type: 'user', id: creator.subject });
        const st = await t.call('POST', '/api/v1/checkout', { user: buyer, body: { plan_id: plan.id, provider: 'stripe' } });
        assert.match(st.json.checkout_url, /^https:\/\/checkout\.stripe\.test\//);
        const bad = await t.call('POST', '/api/v1/checkout', { user: buyer, body: { plan_id: plan.id, provider: 'bitcoin-atm' } });
        assert.strictEqual(bad.status, 422);
        const self = await t.call('POST', '/api/v1/checkout', { user: creator, body: { plan_id: plan.id, provider: 'stripe' } });
        assert.strictEqual(self.status, 422);
    });

    test('when Billing settles the handed-off checkout, the membership is filed under the version chosen then', async () => {
        await t.call('PATCH', `/api/v1/plans/${plan.id}`, { user: creator, body: { benefits: ['Badge in chat', 'Monthly stream'] } });   // v2 published meanwhile
        await t.deliverAll(t.billing.pay(buyer.subject, creator.subject, { provider: 'stripe' }).events);
        const m = t.domain.memberships.get(buyer.subject, t.domain.creators.bySubject(creator.subject).id);
        assert.strictEqual(m.origin, 'checkout');
        assert.strictEqual(t.domain.plans.version(m.plan_version_id).version, 1);
        const again = await t.call('POST', '/api/v1/checkout', { user: buyer, body: { plan_id: plan.id, provider: 'stripe' } });
        assert.strictEqual(again.status, 409);
        assert.strictEqual(again.json.code, 'vip.already_member');
    });

    test('paying from Vibes credit starts the membership at once, through Billing', async () => {
        const poor = await t.call('POST', '/api/v1/checkout', { user: payer, body: { plan_id: plan.id, provider: 'credit' } });
        assert.strictEqual(poor.status, 409);
        assert.strictEqual(poor.json.code, 'vip.checkout.insufficient_credit');
        t.billing.state.credit.set(payer.subject, 1000);
        const ok = await t.call('POST', '/api/v1/checkout', { user: payer, body: { plan_id: plan.id, provider: 'credit' } });
        assert.strictEqual(ok.status, 201, ok.text);
        assert.strictEqual(ok.json.membership_started, true);
        const e = await t.call('GET', `/api/v1/entitlements/check?creator=${creator.subject}&mode=projection`, { user: payer });
        assert.strictEqual(e.json.status, 'active');
        assert.strictEqual(e.json.membership.plan_version.version, 2);
        // Billing's own event for the same grant arrives later and changes nothing.
        const before = t.outboxEvents('vip.membership.changed').filter((x) => x.payload.member.id === payer.subject).length;
        const out = await t.deliverAll(t.billing.state.lastEvents);
        assert.ok(['unchanged', 'stale_ignored'].includes(out[1].json.outcome), out[1].json.outcome);
        assert.strictEqual(t.outboxEvents('vip.membership.changed').filter((x) => x.payload.member.id === payer.subject).length, before);
        assert.strictEqual(before, 1);
    });

    test('a service checks out on behalf of a member only with vip.membership.checkout', async () => {
        const x = t.network.newUser('otto');
        const no = await t.call('POST', '/api/v1/checkout', { cap: ['vip.entitlement.check'], body: { subject: { type: 'user', id: x.subject }, plan_id: plan.id, provider: 'stripe' } });
        assert.strictEqual(no.status, 403);
        const yes = await t.call('POST', '/api/v1/checkout', { cap: ['vip.membership.checkout'], body: { subject: { type: 'user', id: x.subject }, plan_id: plan.id, provider: 'stripe' } });
        assert.strictEqual(yes.status, 201, yes.text);
    });

    test('Billing frozen or down: checkout is refused and nothing is claimed', async () => {
        const x = t.network.newUser('pia');
        t.billing.state.down = true;
        try {
            const r = await t.call('POST', '/api/v1/checkout', { user: x, body: { plan_id: plan.id, provider: 'stripe' } });
            assert.strictEqual(r.status, 503);
            assert.strictEqual(r.json.code, 'vip.billing_unavailable');
        } finally { t.billing.state.down = false; }
    });

    test('cancel goes through Billing (member only) and keeps the paid period', async () => {
        const cid = t.domain.creators.bySubject(creator.subject).id;
        const svc = await t.call('POST', `/api/v1/memberships/${creator.subject}/cancel`, { cap: ['vip.membership.checkout'] });
        assert.strictEqual(svc.status, 403);
        const r = await t.call('POST', `/api/v1/memberships/${creator.subject}/cancel`, { user: buyer });
        assert.strictEqual(r.status, 200, r.text);
        const cancelCall = t.billing.calls.filter((c) => /\/cancel$/.test(c.path)).pop();
        assert.match(cancelCall.key, /^vip:cancel:/);
        const e = await t.call('GET', `/api/v1/entitlements/check?creator=${creator.subject}&mode=projection`, { user: buyer });
        assert.strictEqual(e.json.active, true);
        assert.strictEqual(e.json.cancel_at_period_end, true);
        const again = await t.call('POST', `/api/v1/memberships/lena/cancel`, { user: buyer });
        assert.strictEqual(again.json.already, true);
        const none = await t.call('POST', `/api/v1/memberships/${creator.subject}/cancel`, { user: t.network.newUser('quin') });
        assert.strictEqual(none.status, 404);
        void cid;
    });

    test('membership status: users see their own, services need vip.membership.status', async () => {
        const own = await t.call('GET', `/api/v1/memberships/${payer.subject}`, { user: payer });
        assert.strictEqual(own.status, 200);
        assert.strictEqual(own.json.memberships.length, 1);
        assert.strictEqual(own.json.memberships[0].creator.username, 'lena');
        assert.strictEqual((await t.call('GET', `/api/v1/memberships/${payer.subject}`, { user: buyer })).status, 403);
        assert.strictEqual((await t.call('GET', `/api/v1/memberships/${payer.subject}`, { cap: ['vip.membership.status'] })).status, 200);
        assert.strictEqual((await t.call('GET', `/api/v1/memberships/${payer.subject}`, { cap: [] })).status, 403);
    });

    test('creator members: from Billing, or the fresh projection when Billing is down', async () => {
        const r = await t.call('GET', `/api/v1/creators/${creator.subject}/members`, { user: creator });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.source, 'billing');
        assert.strictEqual(r.json.members.length, 2);
        assert.ok(r.json.members.every((m) => m.membership && m.membership.plan_version));
        t.billing.state.down = true;
        try {
            const p = await t.call('GET', '/api/v1/creators/lena/members', { cap: ['vip.creator.members.list'] });
            assert.strictEqual(p.json.source, 'projection');
            assert.strictEqual(p.json.members.length, 2);
        } finally { t.billing.state.down = false; }
        assert.strictEqual((await t.call('GET', '/api/v1/creators/lena/members', { user: buyer })).status, 403);
    });

    test('public creator page works without JavaScript and without an account', async () => {
        const p = await t.page('/lena');
        assert.strictEqual(p.status, 200);
        assert.match(p.text, /Front row/);
        assert.match(p.text, /Monthly stream/);
        assert.match(p.text, /\$4\.99<\/b> every 30 days/);
        assert.match(p.text, /Sign in to join/);
        assert.match(p.text, /<link rel="canonical" href="http:\/\/vip\.test\/lena">/);
        assert.match(p.text, /openvibe\.network\/shared\/navbar\.js/);
        assert.match(p.text, /<noscript>/);
        assert.doesNotMatch(p.text, /\bfree\b|\$0|no ads/i);
        const hist = await t.page(`/lena/plans/${plan.slug}`);
        assert.strictEqual(hist.status, 200);
        assert.match(hist.text, /v1/);
        assert.match(hist.text, /v2/);
        assert.strictEqual((await t.page('/LENA')).location, '/lena');
        assert.strictEqual((await t.page('/nobody-here')).status, 404);
        const sm = await t.page('/sitemap.xml');
        assert.match(sm.text, /http:\/\/vip\.test\/lena/);
    });

    test('joining from the page: form with anti-forgery token → Billing credit → member page', async () => {
        const x = t.network.newUser('rita');
        t.billing.state.credit.set(x.subject, 600);
        const p = await t.page('/lena', { user: x });
        const token = t.csrf(p.text);
        assert.ok(token);
        const forged = await t.page('/lena/join', { user: x, method: 'POST', form: { plan_id: plan.id, provider: 'credit', auto_renew: '1' } });
        assert.strictEqual(forged.status, 303);
        assert.match(forged.location, /error=/);
        const ok = await t.page('/lena/join', { user: x, method: 'POST', form: { _csrf: token, plan_id: plan.id, provider: 'credit', auto_renew: '1' } });
        assert.strictEqual(ok.status, 303);
        assert.match(ok.location, /^\/me\?ok=/);
        const me = await t.page('/me', { user: x });
        assert.match(me.text, /Front row<\/b> v2/);
        assert.match(me.text, /Cancel at period end/);
        const handoff = await t.page('/lena/join', { user: t.network.newUser('sam'), method: 'POST', form: { _csrf: 'x'.repeat(32), plan_id: plan.id, provider: 'stripe' } });
        assert.match(handoff.location, /error=/);
    });

    test('dashboard: plans, versions, perks and members; forms create versions', async () => {
        const d = await t.page('/dashboard', { user: creator });
        assert.strictEqual(d.status, 200);
        assert.match(d.text, /Front row/);
        assert.match(d.text, /Versions \(2\)/);
        assert.match(d.text, /From OpenVibe\.Billing\./);
        const token = t.csrf(d.text);
        const edit = await t.page(`/dashboard/plans/${plan.id}`, { user: creator, method: 'POST', form: { _csrf: token, name: 'Front row', description: 'Monthly membership', benefits: 'Badge in chat\nMonthly stream\nEarly VODs', change_note: 'early VODs' } });
        assert.strictEqual(edit.status, 303);
        assert.match(decodeURIComponent(edit.location), /Saved as version 3/);
        const perk = await t.page('/dashboard/perks', { user: creator, method: 'POST', form: { _csrf: token, name: 'Early VODs', key: 'early-vods', kind: 'gated_content', bindings: 'live vod_early_access' } });
        assert.match(decodeURIComponent(perk.location), /Perk created/);
        const other = t.network.newUser('tess', { role: 'streamer' });
        const steal = await t.page(`/dashboard/plans/${plan.id}`, { user: other, method: 'POST', form: { _csrf: t.csrf((await t.page('/dashboard', { user: other })).text), name: 'mine now' } });
        assert.match(steal.location, /error=/);
        assert.strictEqual(t.domain.plans.latestVersion(plan.id).version, 3);
        const net = await t.page('/dashboard?as=network', { user: creator });
        assert.strictEqual(net.status, 403);
        const anon = await t.page('/dashboard');
        assert.match(anon.text, /Sign in/);
    });

    test('API errors are problem+json', async () => {
        const r = await t.call('GET', '/api/v1/plans/vpl_missing', { token: null });
        assert.strictEqual(r.status, 404);
        assert.match(r.headers.get('content-type'), /application\/problem\+json/);
        assert.strictEqual(r.json.code, 'vip.plan_not_found');
        const bad = await t.call('GET', '/api/v1/plans', { token: 'garbage' });
        assert.strictEqual(bad.status, 401);
    });

    test('checkout closed (VIP_CHECKOUT_PROVIDERS empty, before the Billing cutover): pages say so, the API refuses', async () => {
        const t2 = await boot({ env: { VIP_CHECKOUT_PROVIDERS: '' } });
        try {
            const c = t2.network.newUser('uma', { role: 'streamer' });
            const p = (await t2.call('POST', '/api/v1/plans', { user: c, body: { name: 'Club', publish: true } })).json.plan;
            const page = await t2.page('/uma', { user: t2.network.newUser('vic') });
            assert.match(page.text, /Joining through OpenVibe\.Billing is not open yet/);
            assert.doesNotMatch(page.text, /<select name="provider">/);
            const r = await t2.call('POST', '/api/v1/checkout', { user: t2.network.newUser('wes'), body: { plan_id: p.id, provider: 'powerchat' } });
            assert.strictEqual(r.status, 422);
            assert.strictEqual(r.json.code, 'vip.checkout.provider_unavailable');
        } finally { await t2.close(); }
    });

    await run().finally(() => t.close());
})();
