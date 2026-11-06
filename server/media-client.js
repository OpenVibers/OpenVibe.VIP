'use strict';

/**
 * OpenVibe.Media Object API v2 client — the image on a members-only post. The bytes live in Media under
 * VIP's tenant (the namespace VIP's service token holds media.object.upload for), owned by the creator who
 * wrote the post (X-OV-Subject); VIP keeps the med_ reference and the public URL.
 *
 *   POST /api/v2/<app>/objects                 init { kind, visibility, size_bytes, mime_type, filename, content_hash }
 *   PUT  /api/v2/<app>/objects/:id/content     the bytes
 *   POST /api/v2/<app>/objects/:id/complete    Media checks size, hash and type → ready
 *
 * Public bytes are served at <media>/o/:id. The tenant (config.media.app, "vip" by default) must exist in
 * Media and VIP's service principal must hold media.object.upload for it.
 */
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');

function createMediaClient({ config, fetchImpl = globalThis.fetch } = {}) {
    const configured = !!(config.oauth && config.oauth.clientSecret);
    const tokens = configured ? serviceAuth.createTokenClient({
        tokenUrl: `${config.network.internalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.media',
        scope: 'media.object.upload',
        fetchImpl,
    }) : null;
    const base = `${config.media.internalUrl}/api/v2/${config.media.app}/objects`;

    async function call(method, path, { json, body, headers = {} } = {}, retried = false) {
        const h = { Accept: 'application/json', ...headers, ...(await tokens.authHeaders()) };
        if (json !== undefined) h['Content-Type'] = 'application/json';
        const res = await fetchImpl(`${base}${path}`, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body, signal: AbortSignal.timeout(60_000) });
        if (res.status === 401 && !retried) { tokens.invalidate(); return await call(method, path, { json, body, headers }, true); }
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error(`Media ${method} ${path || '/'} ${res.status}: ${(data && (data.detail || data.error)) || 'failed'}`);
            err.status = res.status; err.code = data && data.code;
            throw err;
        }
        return data || {};
    }

    /**
     * Store one image. → { id (med_…), url, size_bytes, mime }
     * owner: the person (usr_…) the object belongs to; kind: 'post_image'; visibility 'unlisted': served to
     * anyone with the link (the object id is unguessable), never listed on openvibe.media — the post decides
     * who sees the link.
     */
    async function uploadImage({ buffer, mime, filename, owner = null, kind = 'post_image', visibility = 'unlisted', source = 'vip.member_post' }) {
        if (!configured) { const e = new Error("An image needs VIP's service principal (OV_OAUTH_CLIENT_SECRET)"); e.status = 503; throw e; }
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const init = await call('POST', '', {
            json: { kind, visibility, size_bytes: buffer.length, mime_type: mime, filename, content_hash: sha256, metadata: { source } },
            headers: /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(owner || '')) ? { 'X-OV-Subject': owner } : {},
        });
        const id = init.id || (init.object && init.object.id);
        if (!/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || ''))) throw Object.assign(new Error('Media returned no object id'), { status: 502 });
        await call('PUT', `/${id}/content`, { body: buffer, headers: { 'Content-Type': mime } });
        await call('POST', `/${id}/complete`, { json: { content_hash: sha256 } });
        return { id, url: `${config.media.url}/o/${id}`, size_bytes: buffer.length, mime };
    }

    return { configured, uploadImage };
}

module.exports = { createMediaClient };
