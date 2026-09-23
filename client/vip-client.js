'use strict';

/**
 * openvibe-vip/client — the consumer seam for products that honour VIP memberships (Blog, Wiki,
 * Chat, Live, Community, …). No dependencies; Node 18+ (global fetch) or any fetch you pass.
 *
 *   const { createVipClient } = require('openvibe-vip/client');
 *   const tokens = contracts.serviceAuth.createTokenClient({ tokenUrl, clientId, clientSecret,
 *       audience: 'openvibe.vip', scope: 'vip.resource.policy.evaluate vip.entitlement.check' });
 *   const vip = createVipClient({ baseUrl: 'http://127.0.0.1:4620', tokenClient: tokens });
 *
 *   const d = await vip.evaluate({ subject: viewerSubjectOrNull, resource: { service: 'blog', type: 'post', id: '42' }, owner: authorSubject,
 *       fallback: { requirement: 'member', binding: 'blog:gated_post' } });   // the product's default gate
 *   if (!d.allow) return renderTeaser(d.reason);        // FAILS CLOSED
 *
 *   const e = await vip.checkEntitlement({ subject: 'usr_…', creator: 'usr_…', product: 'chat' });  // e.active, e.product_perks
 *   await vip.isMember('usr_…', 'usr_…');               // boolean, false on any doubt
 *
 * Every failure — VIP unreachable, a timeout, a refused token, a malformed answer — is a denial
 * ({ allow: false, reason: 'vip_unavailable' } / { status: 'unknown', active: false }), never an
 * exception and never a "yes". Pass mode: 'authoritative' for sensitive content: VIP then asks
 * OpenVibe.Billing directly instead of its projection.
 *
 * Put createVipCache (below) in front of it: it holds the convergence bound every product shares.
 */

function createVipClient({ baseUrl = 'http://127.0.0.1:4620', tokenClient = null, getToken = null, fetch: fetchImpl = globalThis.fetch, timeoutMs = 2000, log = null } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('createVipClient: a fetch implementation is required');
    const base = String(baseUrl).replace(/\/+$/, '');

    async function headers() {
        if (tokenClient && typeof tokenClient.authHeaders === 'function') return tokenClient.authHeaders();
        if (typeof getToken === 'function') return { Authorization: `Bearer ${await getToken()}` };
        throw new Error('createVipClient: tokenClient or getToken is required');
    }

    async function post(path, body, retried = false) {
        const res = await fetchImpl(`${base}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await headers()) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 401 && !retried && tokenClient && typeof tokenClient.invalidate === 'function') { tokenClient.invalidate(); return post(path, body, true); }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || typeof data !== 'object') throw new Error(`VIP ${res.status}: ${(data && (data.code || data.detail)) || 'bad response'}`);
        return data;
    }
    const note = (what, err) => { if (log && log.warn) log.warn(`[vip-client] ${what} failed closed: ${err.message}`); };

    /** May `subject` (a usr_ id, a SubjectRef, or null for a signed-out viewer) see `resource`? */
    async function evaluate({ subject = null, resource, owner = null, ruleId, mode, fallback } = {}) {
        try {
            const d = await post('/api/v1/policies/evaluate', { subject: subject || null, resource, owner, rule_id: ruleId, mode, fallback });
            return { ...d, allow: d.allow === true, reason: d.reason || (d.allow === true ? 'member' : 'denied') };
        } catch (err) {
            note('evaluate', err);
            return { allow: false, reason: 'vip_unavailable', error: err.message };
        }
    }

    /** The entitlement of `subject` to `creator` (usr_ ids or SubjectRefs). */
    async function checkEntitlement({ subject, creator, mode, product } = {}) {
        try {
            const e = await post('/api/v1/entitlements/check', { subject, creator, mode, product });
            return { ...e, active: e.active === true && e.status === 'active' };
        } catch (err) {
            note('checkEntitlement', err);
            return { status: 'unknown', active: false, reason: 'vip_unavailable', error: err.message };
        }
    }

    const isMember = async (subject, creator, opts = {}) => (await checkEntitlement({ subject, creator, mode: opts.mode })).active;

    return { evaluate, checkEntitlement, isMember };
}

/**
 * createVipCache({ vip, ttlMs, denyTtlMs, unavailableTtlMs, maxEntries, now }) — the product-side
 * cache every consumer puts in front of the client, with ONE convergence rule:
 *
 *   A cached "yes" lives at most ttlMs (and never past the entitlement's expires_at or VIP's
 *   valid_until). So once VIP stops granting — it has applied Billing's billing.entitlement.changed
 *   and emitted vip.membership.changed — the product stops granting within ttlMs. handleEvent(envelope)
 *   with either event (or billing.subscription.canceled / billing.transaction.reversed) drops that
 *   member's entries for that creator at once, so a product that receives the events converges
 *   immediately. A "no" lives denyTtlMs (a new member waits at most that long); a failure
 *   (vip_unavailable / unknown) lives unavailableTtlMs, and a cached "yes" is never extended by a
 *   failure: when VIP is down, entries expire into denials (fail closed).
 *
 *   await cache.entitlement({ subject, creator, product })  → the checkEntitlement answer (cached)
 *   cache.peekEntitlement({ subject, creator, product })    → the cached answer or undefined; never waits
 *                                                              (a miss starts a fetch in the background)
 *   await cache.evaluate({ subject, resource, owner, fallback, mode })  → the evaluate answer (cached;
 *                                                              mode 'authoritative' is never cached)
 *   cache.invalidate({ member, creator }), cache.handleEvent(envelope), cache.clear()
 */
function createVipCache({ vip, ttlMs = 30_000, denyTtlMs = 10_000, unavailableTtlMs = 2_000, maxEntries = 5000, now = () => Date.now() } = {}) {
    if (!vip || typeof vip.evaluate !== 'function' || typeof vip.checkEntitlement !== 'function') throw new TypeError('createVipCache: a VIP client is required');
    const entries = new Map();          // key → { value, expires, member, creator }
    const inflight = new Map();         // key → Promise
    let generation = 0;                 // bumped by clear(); an answer fetched before a clear is not stored
    const pairGen = new Map();          // `${member}|${creator}` → generation of its last invalidation

    const idOf = (v) => (v && typeof v === 'object' ? (v.id != null ? String(v.id) : null) : (v != null && v !== '' ? String(v) : null));
    const pairKey = (member, creator) => `${member || ''}|${creator || ''}`;

    function lifetime(value, allowed) {
        const t = now();
        if (value && (value.reason === 'vip_unavailable' || value.status === 'unknown' || value.reason === 'entitlement_unknown')) return unavailableTtlMs;
        if (!allowed) return denyTtlMs;
        let life = ttlMs;
        const ent = value.entitlement !== undefined ? value.entitlement : value;
        for (const at of [ent && ent.expires_at, ent && ent.valid_until]) {
            const ms = at ? Date.parse(at) : NaN;
            if (Number.isFinite(ms)) life = Math.min(life, ms - t);
        }
        if (ent && ent.stale) life = Math.min(life, unavailableTtlMs);
        return Math.max(0, life);
    }

    function store(key, value, allowed, member, creator, startedGen, startedPair) {
        if (startedGen !== generation || (pairGen.get(pairKey(member, creator)) || 0) !== startedPair) return; // invalidated meanwhile
        const life = lifetime(value, allowed);
        if (life <= 0) { entries.delete(key); return; }
        if (entries.size >= maxEntries) {
            const t = now();
            for (const [k, e] of entries) if (e.expires <= t) entries.delete(k);
            while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
        }
        entries.set(key, { value, expires: now() + life, member, creator });
    }

    function fresh(key) {
        const e = entries.get(key);
        if (!e) return undefined;
        if (e.expires <= now()) { entries.delete(key); return undefined; }
        return e.value;
    }

    function load(key, member, creator, fetcher, allowedOf) {
        const hit = fresh(key);
        if (hit !== undefined) return Promise.resolve(hit);
        if (inflight.has(key)) return inflight.get(key);
        const g = generation;
        const pg = pairGen.get(pairKey(member, creator)) || 0;
        const p = (async () => {
            try {
                const value = await fetcher();
                store(key, value, allowedOf(value), member, creator, g, pg);
                return value;
            } finally { inflight.delete(key); }
        })();
        inflight.set(key, p);
        return p;
    }

    function entitlement({ subject, creator, product = null, mode } = {}) {
        const member = idOf(subject);
        const owner = idOf(creator);
        if (!member || !owner) return Promise.resolve({ status: 'inactive', active: false, reason: 'not_signed_in' });
        if (mode === 'authoritative') return vip.checkEntitlement({ subject: member, creator: owner, mode, product: product || undefined });
        const key = `e|${member}|${owner}|${product || ''}`;
        return load(key, member, owner, () => vip.checkEntitlement({ subject: member, creator: owner, product: product || undefined }), (v) => v.active === true);
    }

    function peekEntitlement(args = {}) {
        const member = idOf(args.subject);
        const owner = idOf(args.creator);
        if (!member || !owner) return undefined;
        const key = `e|${member}|${owner}|${args.product || ''}`;
        const hit = fresh(key);
        if (hit === undefined) entitlement(args).catch(() => {});
        return hit;
    }

    function evaluate({ subject = null, resource, owner, fallback, mode } = {}) {
        const member = idOf(subject);
        const creator = idOf(owner);
        if (mode === 'authoritative' || !resource || typeof resource !== 'object') return vip.evaluate({ subject: member, resource, owner: creator, fallback, mode });
        if (!member) return Promise.resolve({ allow: false, reason: 'not_signed_in' });
        const fb = fallback == null ? '' : JSON.stringify(fallback);
        const key = `p|${member}|${creator || ''}|${resource.service}|${resource.type}|${resource.id}|${fb}`;
        return load(key, member, creator, () => vip.evaluate({ subject: member, resource, owner: creator, fallback }), (v) => v.allow === true);
    }

    /** Drop what the cache knows about (member, creator); either may be omitted to drop more. */
    function invalidate({ member = null, creator = null } = {}) {
        const m = idOf(member);
        const c = idOf(creator);
        if (m && c) pairGen.set(pairKey(m, c), (pairGen.get(pairKey(m, c)) || 0) + 1);
        else generation++;
        let dropped = 0;
        for (const [k, e] of entries) {
            if ((!m || e.member === m) && (!c || e.creator === c)) { entries.delete(k); dropped++; }
        }
        return dropped;
    }

    /**
     * An OpenVibe.Events envelope about a membership → invalidate that pair. Returns true when the
     * event was understood. vip.membership.changed { member, creator }; billing.entitlement.changed
     * { subject, streamer }; billing.subscription.canceled { subscription: { subscriber, streamer } };
     * billing.transaction.reversed { to_subject (member), from_subject (creator) }.
     */
    function handleEvent(envelope) {
        const e = envelope && envelope.event && envelope.event.event_type ? envelope.event : envelope;
        const p = (e && e.payload) || {};
        let member = null;
        let creator = null;
        switch (e && e.event_type) {
        case 'vip.membership.changed': member = idOf(p.member); creator = idOf(p.creator); break;
        case 'billing.entitlement.changed': member = idOf(p.subject); creator = idOf(p.streamer); break;
        case 'billing.subscription.canceled': member = idOf(p.subscription && p.subscription.subscriber); creator = idOf(p.subscription && p.subscription.streamer); break;
        case 'billing.transaction.reversed': member = idOf(p.to_subject); creator = idOf(p.from_subject); break;
        default: return false;
        }
        if (!member || !creator) return false;
        invalidate({ member, creator });
        return true;
    }

    function clear() { generation++; entries.clear(); }

    return {
        entitlement, peekEntitlement, evaluate, invalidate, handleEvent, clear,
        get size() { return entries.size; },
        /** The convergence bound, for docs and /ready: how long a cached "yes" can outlive VIP's "no". */
        bounds: Object.freeze({ grantMs: ttlMs, denyMs: denyTtlMs, unavailableMs: unavailableTtlMs }),
    };
}

module.exports = { createVipClient, createVipCache };
