'use strict';

/**
 * vip_creators: who offers memberships. A creator is a canonical Network user subject (never a
 * product's integer id); the row's username is a cached handle for the public page /:username,
 * refreshed whenever the creator signs in. The network itself is the creator `network` (staff
 * manage its plans and network-wide perks).
 */
const { fail, prefixedId, iso, text } = require('../util');

const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}$/;

function createCreators({ db, now }) {
    const byId = async (id) => await db.prepare('SELECT * FROM vip_creators WHERE id = ?').get(id) || null;
    const bySubject = async (s) => await db.prepare('SELECT * FROM vip_creators WHERE subject = ?').get(s) || null;
    const byUsername = async (u) => (u ? await db.prepare('SELECT * FROM vip_creators WHERE username_lc = ?').get(String(u).toLowerCase()) || null : null);
    const network = async () => await byId('network');

    /**
     * The creator row for a subject, created on first use. username/displayName (from the creator's
     * own Network token, the importer or the identity service) refresh the cached handle; a handle
     * another row still holds (a rename) is taken over, the stale row keeps no handle.
     */
    async function ensure({ subject, username = null, displayName = null, origin = 'self' }) {
        if (!subject) fail(422, 'vip.invalid_subject', 'a creator needs a subject');
        const at = iso(now());
        const handle = username && USERNAME_RE.test(String(username)) ? String(username) : null;
        let row = await bySubject(subject);
        if (handle) {
            const holder = await byUsername(handle);
            if (holder && holder.subject !== subject) await db.prepare('UPDATE vip_creators SET username = NULL, username_lc = NULL, updated_at = ? WHERE id = ?').run(at, holder.id);
        }
        if (!row) {
            const id = prefixedId('vcr', now());
            await db.prepare(`INSERT INTO vip_creators (id, kind, subject, username, username_lc, display_name, origin, created_at, updated_at)
                VALUES (?, 'creator', ?, ?, ?, ?, ?, ?, ?)`).run(id, subject, handle, handle ? handle.toLowerCase() : null, displayName ? String(displayName).slice(0, 80) : null, origin, at, at);
            return await byId(id);
        }
        const changes = {};
        if (handle && handle !== row.username) changes.username = handle;
        if (displayName && String(displayName).slice(0, 80) !== row.display_name) changes.display_name = String(displayName).slice(0, 80);
        if (Object.keys(changes).length) {
            await db.prepare(`UPDATE vip_creators SET username = COALESCE(?, username), username_lc = COALESCE(?, username_lc), display_name = COALESCE(?, display_name), updated_at = ? WHERE id = ?`)
                .run(changes.username || null, changes.username ? changes.username.toLowerCase() : null, changes.display_name || null, at, row.id);
            row = await byId(row.id);
        }
        return row;
    }

    async function update(id, { displayName, bio, showMemberCount }) {
        const row = await byId(id);
        if (!row) fail(404, 'vip.creator_not_found', `no creator ${id}`);
        const name = displayName !== undefined ? text(displayName, 'display_name', 80) : row.display_name;
        const about = bio !== undefined ? text(bio, 'bio', 2000) : row.bio;
        const count = showMemberCount !== undefined ? (showMemberCount ? 1 : 0) : row.show_member_count;
        await db.prepare('UPDATE vip_creators SET display_name = ?, bio = ?, show_member_count = ?, updated_at = ? WHERE id = ?').run(name, about, count, iso(now()), id);
        return await byId(id);
    }

    /** Creators with at least one published plan, for the directory and the sitemap. */
    async function listPublic({ limit = 200 } = {}) {
        return await db.prepare(`SELECT c.* FROM vip_creators c WHERE c.status = 'active' AND c.kind = 'creator' AND c.username IS NOT NULL
            AND EXISTS (SELECT 1 FROM vip_plans p WHERE p.creator_id = c.id AND p.status = 'published')
            ORDER BY lower(COALESCE(c.display_name, c.username)) LIMIT ?`).all(limit);
    }

    function present(c) {
        if (!c) return null;
        return {
            id: c.id, kind: c.kind, subject: c.subject ? { type: 'user', id: c.subject } : null,
            username: c.username, display_name: c.display_name || c.username || (c.kind === 'network' ? 'OpenVibe' : null),
            bio: c.bio || null, status: c.status,
        };
    }

    return { byId, bySubject, byUsername, network, ensure, update, listPublic, present };
}

module.exports = { createCreators };
