'use strict';

/** Small shared pieces: ids, time, the error type, input checks. */
const { ids, validate } = require('openvibe-contracts');

class VipError extends Error {
    constructor(status, code, detail, extra) {
        super(detail || code);
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.extra = extra;
    }
}

function fail(status, code, detail, extra) { throw new VipError(status, code, detail, extra); }

const prefixedId = (prefix, ms = Date.now()) => `${prefix}_${ids.ulid(ms)}`;
const iso = (ms) => new Date(ms).toISOString();
const json = (v, d) => { if (v == null || v === '') return d; try { return JSON.parse(v); } catch { return d; } };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Optional trimmed text: null when empty, refused when longer than max. */
function text(v, field, max, { required = false } = {}) {
    if (v == null || v === '') { if (required) fail(422, 'vip.invalid_input', `${field} is required`); return null; }
    const s = String(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    if (!s) { if (required) fail(422, 'vip.invalid_input', `${field} is required`); return null; }
    if (s.length > max) fail(422, 'vip.text_too_long', `${field} must be at most ${max} characters`);
    return s;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
function slug(v, field = 'slug') {
    const s = String(v || '').trim().toLowerCase();
    if (!SLUG_RE.test(s)) fail(422, 'vip.invalid_input', `${field} must be 1-48 of a-z, 0-9 and -`);
    return s;
}
function slugify(v) {
    const s = String(v || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return s || 'plan';
}

/** A user SubjectRef or bare usr_ id → the subject id. */
function userSubject(v, field = 'subject') {
    const ref = typeof v === 'string' ? { type: 'user', id: v } : v;
    if (!ref || !validate('identity.subject-ref@1', ref).valid || ref.type !== 'user' || !ids.isSubjectId('user', ref.id)) {
        fail(422, 'vip.invalid_subject', `${field} must be a user SubjectRef ({ type: 'user', id: 'usr_…' })`);
    }
    return ref.id;
}
const isUserSubject = (s) => typeof s === 'string' && ids.isSubjectId('user', s);
const userRef = (id) => (id ? { type: 'user', id } : null);

/** An EntityRef { service, type, id } (common.entity-ref@1). */
function entityRef(v, field = 'resource') {
    if (!v || typeof v !== 'object' || !validate('common.entity-ref@1', v).valid) {
        fail(422, 'vip.invalid_input', `${field} must be an EntityRef ({ service, type, id })`);
    }
    return { service: String(v.service), type: String(v.type), id: String(v.id) };
}

function bool(v, d = false) {
    if (v == null || v === '') return d;
    if (typeof v === 'boolean') return v;
    return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

module.exports = { VipError, fail, prefixedId, iso, json, esc, text, slug, slugify, userSubject, isUserSubject, userRef, entityRef, bool };
