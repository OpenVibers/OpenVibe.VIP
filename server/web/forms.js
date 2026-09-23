'use strict';

/**
 * Anti-forgery tokens for the server-rendered forms: HMAC(VIP_FORM_SECRET, subject | hour), valid
 * for the current and the previous hour. The session cookies are SameSite=Lax too, so a cross-site
 * POST does not carry them; the token is the second lock.
 */
const crypto = require('crypto');

function createForms({ secret, now = () => Date.now() }) {
    const sign = (subject, bucket) => crypto.createHmac('sha256', String(secret)).update(`${subject}|${bucket}`).digest('base64url').slice(0, 32);
    const bucket = () => Math.floor(now() / 3600_000);
    function token(subject) { return secret && subject ? sign(subject, bucket()) : ''; }
    function verify(subject, given) {
        if (!secret || !subject || typeof given !== 'string' || given.length !== 32) return false;
        const b = bucket();
        return [b, b - 1].some((x) => {
            const want = Buffer.from(sign(subject, x));
            const got = Buffer.from(given);
            return want.length === got.length && crypto.timingSafeEqual(want, got);
        });
    }
    return { token, verify };
}

module.exports = { createForms };
