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
 *   const d = await vip.evaluate({ subject: viewerSubjectOrNull, resource: { service: 'blog', type: 'post', id: '42' }, owner: authorSubject });
 *   if (!d.allow) return renderTeaser(d.reason);        // FAILS CLOSED
 *
 *   const e = await vip.checkEntitlement({ subject: 'usr_…', creator: 'usr_…' });  // e.active
 *   await vip.isMember('usr_…', 'usr_…');               // boolean, false on any doubt
 *
 * Every failure — VIP unreachable, a timeout, a refused token, a malformed answer — is a denial
 * ({ allow: false, reason: 'vip_unavailable' } / { status: 'unknown', active: false }), never an
 * exception and never a "yes". Pass mode: 'authoritative' for sensitive content: VIP then asks
 * OpenVibe.Billing directly instead of its projection.
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
    async function evaluate({ subject = null, resource, owner = null, ruleId, mode } = {}) {
        try {
            const d = await post('/api/v1/policies/evaluate', { subject: subject || null, resource, owner, rule_id: ruleId, mode });
            return { ...d, allow: d.allow === true, reason: d.reason || (d.allow === true ? 'member' : 'denied') };
        } catch (err) {
            note('evaluate', err);
            return { allow: false, reason: 'vip_unavailable', error: err.message };
        }
    }

    /** The entitlement of `subject` to `creator` (usr_ ids or SubjectRefs). */
    async function checkEntitlement({ subject, creator, mode } = {}) {
        try {
            const e = await post('/api/v1/entitlements/check', { subject, creator, mode });
            return { ...e, active: e.active === true && e.status === 'active' };
        } catch (err) {
            note('checkEntitlement', err);
            return { status: 'unknown', active: false, reason: 'vip_unavailable', error: err.message };
        }
    }

    const isMember = async (subject, creator, opts = {}) => (await checkEntitlement({ subject, creator, mode: opts.mode })).active;

    return { evaluate, checkEntitlement, isMember };
}

module.exports = { createVipClient };
