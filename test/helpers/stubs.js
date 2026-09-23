'use strict';
/**
 * Stand-ins for the services VIP talks to, each on a random port with a real RS256 key pair.
 *
 *   startNetwork()        JWKS, client-credentials token endpoint (scope → cap), user JWTs
 *                         (signUser), resolve-batch for the importer
 *   startBilling(net, clock)  the parts of OpenVibe.Billing VIP uses — intents, credit subscriptions,
 *                         cancel, subscriptions list/get, entitlements, rates, health — with
 *                         Billing's rules that matter here (service token audience + capability,
 *                         Idempotency-Key replay, self-dealing, one subscription per pair, periods
 *                         on the injected clock), plus the envelopes Billing would publish for each
 *                         change (grant, renew, cancel, expire, refund) so tests deliver them
 */
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { serviceAuth, ids } = require('openvibe-contracts');

const DAY = 86_400_000;

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
function readBody(req) {
    return new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
}
const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' }); res.end(JSON.stringify(obj)); };

async function startNetwork() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const legacy = {};
    const grants = [];
    const state = { resolveDown: false };
    let issuer = 'http://network.test';
    let n = 0;

    function signService({ sub = 'svc:live', aud = ['openvibe.vip'], cap = [], expSec = 300 } = {}) {
        const now = Math.floor(Date.now() / 1000);
        return serviceAuth.signServiceToken({ iss: issuer, sub, actor_type: 'service', aud, cap, iat: now, exp: now + expSec, jti: crypto.randomBytes(8).toString('hex') }, privatePem);
    }
    function signUser(u) {
        return jwt.sign({ sub: String(++n), subject_id: u.subject, username: u.username, display_name: u.display_name || u.username, role: u.role || 'user' },
            privatePem, { algorithm: 'RS256', issuer, expiresIn: '1h' });
    }
    function newUser(username, { liveId = null, role = 'user' } = {}) {
        const subject = ids.newId('user');
        if (liveId != null) legacy[String(liveId)] = { subject, username };
        return { subject, username, display_name: username[0].toUpperCase() + username.slice(1), role };
    }
    function mapLive(liveId, username) { const subject = ids.newId('user'); legacy[String(liveId)] = { subject, username }; return subject; }

    const server = http.createServer(async (req, res) => {
        const raw = await readBody(req);
        if (req.url === '/api/.well-known/jwks') return send(res, 200, { public_key: publicPem, algorithm: 'RS256' });
        if (req.url === '/oauth/token' && req.method === 'POST') {
            const body = Object.fromEntries(new URLSearchParams(raw));
            grants.push(body);
            if (body.client_secret !== 'shh') return send(res, 401, { error: 'invalid_client' });
            const cap = String(body.scope || '').split(/\s+/).filter(Boolean);
            return send(res, 200, { access_token: signService({ sub: `svc:${body.client_id}`, aud: [body.audience], cap }), token_type: 'Bearer', expires_in: 300 });
        }
        if (req.url === '/internal/identity/resolve-batch' && req.method === 'POST') {
            const v = serviceAuth.verifyServiceToken(String(req.headers.authorization || '').slice(7), { publicKey: publicPem, issuer, audience: 'openvibe.network' });
            if (!v.ok) return send(res, 401, { code: v.code });
            if (!(v.claims.cap || []).includes('identity.subject.resolve')) return send(res, 403, { code: 'capability.denied' });
            if (state.resolveDown) return send(res, 503, { error: 'down' });
            const body = JSON.parse(raw || '{}');
            const results = {};
            for (const id of body.ids || []) {
                const s = body.system === 'live' ? legacy[String(id)] : null;
                results[String(id)] = s ? { subject: { type: 'user', id: s.subject }, username: s.username } : null;
            }
            return send(res, 200, { results });
        }
        send(res, 404, { error: 'not found' });
    });
    const url = await listen(server);
    issuer = url;
    return { url, publicPem, signService, signUser, newUser, mapLive, legacy, grants, state, close: () => new Promise((r) => server.close(r)) };
}

/**
 * Billing stub. Periods are 30 days on `clock.now()`. Each mutation returns the envelopes Billing
 * would emit; tests deliver them (or not, to simulate loss).
 */
async function startBilling(network, clock) {
    const subs = new Map();          // id → sub
    const periods = [];              // { sub_id, subject, scope, starts, ends, revoked, txn }
    const idem = new Map();
    const calls = [];
    const state = { down: false, frozen: false, credit: new Map() };
    const now = () => clock.now();
    const iso = (ms) => new Date(ms).toISOString();
    let seq = 0;
    const nextId = (p) => `${p}_${ids.ulid(now())}${(++seq).toString(36)}`.slice(0, 40);

    const pairKey = (a, b) => `${a}:${b}`;
    const byPair = (a, b) => [...subs.values()].find((s) => s.subscriber === a && s.streamer === b) || null;
    function entitlement(subject, scope) {
        const t = now();
        const live = periods.filter((p) => p.subject === subject && p.scope === scope && !p.revoked && p.starts <= t && p.ends > t);
        let exp = live.length ? Math.max(...live.map((p) => p.ends)) : null;
        if (exp) {
            for (;;) {
                const next = periods.filter((p) => p.subject === subject && p.scope === scope && !p.revoked && p.starts <= exp && p.ends > exp);
                if (!next.length) break;
                exp = Math.max(...next.map((p) => p.ends));
            }
        }
        const s = byPair(subject, scope);
        return {
            subject: { type: 'user', id: subject }, streamer: { type: 'user', id: scope }, kind: 'channel_subscription', active: !!exp, expires_at: exp ? iso(exp) : null,
            subscription: s ? { id: s.id, status: s.status, auto_renew: s.auto_renew, cancel_at_period_end: s.cancel_at_period_end, provider: s.provider } : null,
        };
    }
    const present = (s) => ({
        id: s.id, subscriber: { type: 'user', id: s.subscriber }, streamer: { type: 'user', id: s.streamer }, tier: 1, provider: s.provider,
        status: s.status, auto_renew: s.auto_renew, cancel_at_period_end: s.cancel_at_period_end, price_cents: 499,
        current_period_end: s.current_period_end, created_at: s.created_at, updated_at: s.updated_at, legacy_live_id: s.legacy_live_id ?? null,
    });
    function envelope(type, subject, payload) {
        return {
            event_id: ids.newId('event', now()), event_type: type, version: 1, source: 'billing', actor: { type: 'service', id: 'billing' },
            timestamp: iso(now()), priority: 'important', visibility: 'internal', subject, payload,
        };
    }
    const entEvent = (member, creator, reason, extra = {}) => envelope('billing.entitlement.changed', { type: 'entitlement', id: `${member}:channel_subscription:${creator}` }, { ...entitlement(member, creator), reason, ...extra });

    /** Pay one period (grant or renew). Returns { sub, events }. */
    function pay(member, creator, { provider = 'credit', autoRenew = true, legacyLiveId = null } = {}) {
        const t = now();
        let s = byPair(member, creator);
        const renewal = !!(s && s.status === 'active');
        const start = s && s.current_period_end && Date.parse(s.current_period_end) > t ? Date.parse(s.current_period_end) : t;
        const end = start + 30 * DAY;
        const txn = nextId('txn');
        if (!s) {
            s = { id: nextId('sub'), subscriber: member, streamer: creator, provider, created_at: iso(t), legacy_live_id: legacyLiveId };
            subs.set(s.id, s);
        }
        Object.assign(s, { status: 'active', auto_renew: autoRenew, cancel_at_period_end: false, current_period_end: iso(end), updated_at: iso(t) });
        periods.push({ sub_id: s.id, subject: member, scope: creator, starts: start, ends: end, revoked: false, txn });
        return { sub: s, txn, events: [envelope('billing.transaction.settled', { type: 'transaction', id: txn }, { transaction_id: txn, type: 'subscription', from_subject: member, to_subject: creator }), entEvent(member, creator, renewal ? 'renewed' : 'granted', { transaction_id: txn })] };
    }
    function cancel(id) {
        const s = subs.get(id);
        s.cancel_at_period_end = true; s.auto_renew = false; s.updated_at = iso(now());
        return { sub: s, events: [envelope('billing.subscription.canceled', { type: 'subscription', id }, { subscription: present(s), provider_sync: 'not_needed' })] };
    }
    /** The renewal sweep for one subscription whose period ended without renewal. */
    function expire(id, status = 'canceled') {
        const s = subs.get(id);
        s.status = status; s.auto_renew = false; s.updated_at = iso(now());
        return { sub: s, events: [entEvent(s.subscriber, s.streamer, status)] };
    }
    /** Refund the latest period's payment: revokes it. */
    function refund(member, creator) {
        const s = byPair(member, creator);
        const p = [...periods].reverse().find((x) => x.sub_id === s.id && !x.revoked);
        p.revoked = true;
        const left = periods.filter((x) => x.sub_id === s.id && !x.revoked && x.ends > now());
        if (!left.length) { s.status = 'expired'; s.current_period_end = iso(now()); s.auto_renew = false; }
        const rtx = nextId('txn');
        return {
            sub: s,
            events: [
                envelope('billing.transaction.reversed', { type: 'transaction', id: rtx }, { transaction_id: rtx, type: 'refund', from_subject: creator, to_subject: member, reverses_txn: p.txn, entitlements_revoked: 1 }),
                entEvent(member, creator, 'refund', { revoked_period: { starts_at: iso(p.starts), ends_at: iso(p.ends) } }),
            ],
        };
    }

    function auth(req, cap) {
        const v = serviceAuth.verifyServiceToken(String(req.headers.authorization || '').slice(7), { publicKey: network.publicPem, issuer: network.url, audience: 'openvibe.billing' });
        if (!v.ok) return [401, { code: v.code }];
        if (cap && !(v.claims.cap || []).includes(cap)) return [403, { code: 'capability.denied', detail: `${cap} not granted` }];
        return null;
    }

    const server = http.createServer(async (req, res) => {
        const raw = await readBody(req);
        const u = new URL(req.url, 'http://x');
        const p = u.pathname;
        calls.push({ method: req.method, path: p, query: Object.fromEntries(u.searchParams), key: req.headers['idempotency-key'] || null, body: raw ? JSON.parse(raw) : null });
        if (p === '/api/health') return state.down ? send(res, 503, { ok: false }) : send(res, 200, { ok: true });
        if (state.down) { req.socket.destroy(); return undefined; }
        const need = (cap) => { const e = auth(req, cap); if (e) { send(res, e[0], e[1]); return false; } return true; };
        const body = raw ? JSON.parse(raw) : {};
        const replay = () => { const k = req.headers['idempotency-key']; if (k && idem.has(k)) { const r = idem.get(k); send(res, r.status, r.body); return true; } return false; };
        const store = (status, out) => { const k = req.headers['idempotency-key']; if (k) idem.set(k, { status, body: out }); send(res, status, out); };

        if (p === '/api/v1/rates' && req.method === 'GET') {
            return send(res, 200, { currency: 'vibes-bits', subscription: { price_cents: 499, streamer_share_pct: 70, site_route_fee_pct: 10, period_days: 30 }, providers: { powerchat: true, stripe: true } });
        }
        if (p === '/api/v1/intents' && req.method === 'POST') {
            if (!need('billing.intent.create')) return undefined;
            if (replay()) return undefined;
            if (body.subject.id === body.streamer.id) return send(res, 422, { code: 'billing.self_dealing' });
            if (!['powerchat', 'stripe'].includes(body.provider)) return send(res, 409, { code: 'billing.provider_disabled' });
            const id = nextId('pi');
            const intent = { id, provider: body.provider, kind: 'subscription', subject: body.subject, streamer: body.streamer, amount_cents: body.provider === 'powerchat' ? 549 : 499, status: 'created', checkout_ref: body.provider === 'powerchat' ? `pcsub:${id}` : undefined };
            return store(201, { intent, checkout_url: body.provider === 'stripe' ? `https://checkout.stripe.test/${id}` : null });
        }
        if (p === '/api/v1/subscriptions' && req.method === 'POST') {
            if (!need('billing.subscription.manage')) return undefined;
            if (replay()) return undefined;
            if (state.frozen) return send(res, 503, { code: 'billing.frozen' });
            const member = body.subscriber.id; const creator = body.streamer.id;
            if (member === creator) return send(res, 422, { code: 'billing.self_dealing' });
            const credit = state.credit.get(member) || 0;
            if (credit < 499) return send(res, 409, { code: 'billing.insufficient_funds', detail: 'not enough credit' });
            state.credit.set(member, credit - 499);
            const out = pay(member, creator, { autoRenew: body.auto_renew !== false });
            state.lastEvents = out.events;
            return store(201, { subscription: present(out.sub), entitlement: entitlement(member, creator), transaction: { id: out.txn } });
        }
        let m = p.match(/^\/api\/v1\/subscriptions\/([^/]+)\/cancel$/);
        if (m && req.method === 'POST') {
            if (!need('billing.subscription.manage')) return undefined;
            if (replay()) return undefined;
            const s = subs.get(m[1]);
            if (!s) return send(res, 404, { code: 'billing.subscription_not_found' });
            const out = cancel(s.id);
            state.lastEvents = out.events;
            return store(200, { subscription: present(out.sub), provider_sync: 'not_needed' });
        }
        m = p.match(/^\/api\/v1\/subscriptions\/([^/]+)$/);
        if (m && req.method === 'GET') {
            if (!need('billing.entitlement.check')) return undefined;
            const s = subs.get(m[1]);
            if (!s) return send(res, 404, { code: 'billing.subscription_not_found' });
            return send(res, 200, { subscription: present(s), entitlement: entitlement(s.subscriber, s.streamer) });
        }
        if (p === '/api/v1/subscriptions' && req.method === 'GET') {
            if (!need('billing.entitlement.check')) return undefined;
            const q = Object.fromEntries(u.searchParams);
            const list = [...subs.values()].filter((s) => (!q.streamer || s.streamer === q.streamer) && (!q.subscriber || s.subscriber === q.subscriber) && (!q.status || s.status === q.status));
            return send(res, 200, { subscriptions: list.map(present) });
        }
        m = p.match(/^\/api\/v1\/entitlements\/([^/]+)$/);
        if (m && req.method === 'GET') {
            if (!need('billing.entitlement.check')) return undefined;
            return send(res, 200, entitlement(m[1], u.searchParams.get('streamer')));
        }
        return send(res, 404, { code: 'not_found' });
    });
    const url = await listen(server);
    const entitlementCalls = () => calls.filter((c) => c.path.startsWith('/api/v1/entitlements/')).length;
    return { url, subs, periods, calls, state, pay, cancel, expire, refund, entitlement, envelope, entitlementCalls, byPair, pairKey, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { startNetwork, startBilling, DAY };
