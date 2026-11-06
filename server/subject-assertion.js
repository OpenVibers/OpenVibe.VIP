'use strict';

/**
 * The person's own subject assertion for VIP's money calls (ADR-003, the 2026-11-06 amendment; plan H1).
 *
 * VIP names the member it acts for and Billing believes it. On a money route (a membership bought
 * from the member's Vibes, a cancelled membership) that is only VIP's word: a compromised VIP could
 * spend anyone's credit. A subject assertion is the person's own answer: Network signs their access
 * token into a 60-second proof that names them, and Billing checks that proof instead of VIP's word.
 *
 * VIP holds the person's Network access token on the request (the Authorization header or the session
 * cookie `ov_token`), so it can ask Network to sign it. Without that token there is nothing to sign
 * and no assertion is minted: the call then travels the old way, which Billing's
 * BILLING_REQUIRE_SUBJECT_ASSERTION flag decides on.
 *
 * The assertion is minted per call and never cached: Billing refuses a replayed one (it remembers the
 * jti), so two money calls must not share it.
 */
const { createSubjectAssertionMinter: createSubjectAssertionMinterSdk } = require('openvibe-sdk/assertions');

const NETWORK_INTERNAL_URL = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const CLIENT_ID = process.env.OV_OAUTH_CLIENT_ID || 'vip';
const CLIENT_SECRET = process.env.OV_OAUTH_CLIENT_SECRET || '';
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The person's own Network access token on this request, or null. */
function personToken(headers) {
    const h = headers || {};
    const auth = String(h.authorization || '');
    if (/^Bearer\s+/i.test(auth)) {
        const token = auth.slice(7).trim();
        if (token) return token;
    }
    for (const part of String(h.cookie || '').split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        if (part.slice(0, idx).trim() !== 'ov_token') continue;
        const value = decodeURIComponent(part.slice(idx + 1).trim());
        if (value) return value;
    }
    return null;
}

/**
 * The minter, from the config the app loaded (the service token it presents to Network comes from
 * VIP's own OAuth client).
 */
function createSubjectAssertionMinter(config) {
    const c = config || {};
    const network = c.network || {};
    const oauth = c.oauth || {};
    const minter = createSubjectAssertionMinterSdk({
        internalUrl: network.internalUrl || NETWORK_INTERNAL_URL,
        oauth: { clientId: oauth.clientId || CLIENT_ID, clientSecret: oauth.clientSecret || CLIENT_SECRET },
    });
    /**
     * The assertion for the member this request acts for, or null when it cannot be had (no session,
     * no grant, Network down). It never throws: a money call must not fail because a proof is missing.
     */
    return async function assertionFor(headers, subject) {
        if (!subject || !SUBJECT_RE.test(String(subject))) return null;
        const userToken = personToken(headers);
        if (!userToken) return null;
        return await minter.mint({ userToken, subject, audience: 'openvibe.billing' });
    };
}

/** The header the assertion rides on. */
const assertionHeader = (assertion) => (assertion ? { 'X-OV-Subject-Assertion': String(assertion) } : {});

module.exports = { createSubjectAssertionMinter, personToken, assertionHeader, SUBJECT_RE };
