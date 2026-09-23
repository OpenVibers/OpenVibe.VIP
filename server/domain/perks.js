'use strict';

/**
 * vip_perks and vip_product_bindings. A perk is a benefit a creator (or the network) defines once
 * and includes in plan versions; a product binding says how a product recognises it (Live's chat
 * subscriber badge, a Chat room, a Community role, a gated Blog post, …).
 *
 * Editing a perk's name or bindings never rewrites a plan version: each version keeps its own
 * snapshot of the perk keys and names it was published with (vip_plan_perks).
 */
const { fail, prefixedId, iso, text, slug, json } = require('../util');

const KINDS = ['badge', 'emote', 'gated_content', 'room', 'role', 'other'];
const PRODUCT_RE = /^[a-z][a-z0-9-]{1,39}$/;
const BINDING_RE = /^[a-z][a-z0-9_.]{1,63}$/;

function createPerks({ db, now }) {
    const byId = (id) => db.prepare('SELECT * FROM vip_perks WHERE id = ?').get(id) || null;
    const byKey = (creatorId, key) => db.prepare('SELECT * FROM vip_perks WHERE creator_id = ? AND key = ?').get(creatorId, key) || null;

    function cleanBindings(list) {
        if (list == null) return null;
        if (!Array.isArray(list) || list.length > 20) fail(422, 'vip.invalid_input', 'bindings must be a list of at most 20 { product, binding, config? }');
        const seen = new Set();
        return list.map((b, i) => {
            if (!b || !PRODUCT_RE.test(String(b.product || ''))) fail(422, 'vip.invalid_input', `bindings[${i}].product must be a service id such as live, chat or community`);
            if (!BINDING_RE.test(String(b.binding || ''))) fail(422, 'vip.invalid_input', `bindings[${i}].binding must be an id such as chat_badge or room_access`);
            const config = b.config == null ? {} : b.config;
            if (typeof config !== 'object' || Array.isArray(config) || JSON.stringify(config).length > 2000) fail(422, 'vip.invalid_input', `bindings[${i}].config must be an object under 2 KB`);
            const k = `${b.product}:${b.binding}`;
            if (seen.has(k)) fail(422, 'vip.invalid_input', `bindings[${i}] repeats ${k}`);
            seen.add(k);
            return { product: String(b.product), binding: String(b.binding), config };
        });
    }

    function setBindings(perkId, list) {
        const at = iso(now());
        const keep = new Set(list.map((b) => `${b.product}:${b.binding}`));
        for (const b of db.prepare("SELECT * FROM vip_product_bindings WHERE perk_id = ? AND status = 'active'").all(perkId)) {
            if (!keep.has(`${b.product}:${b.binding}`)) db.prepare("UPDATE vip_product_bindings SET status = 'removed', updated_at = ? WHERE id = ?").run(at, b.id);
        }
        const up = db.prepare(`INSERT INTO vip_product_bindings (id, perk_id, product, binding, config, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
            ON CONFLICT (perk_id, product, binding) DO UPDATE SET config = excluded.config, status = 'active', updated_at = excluded.updated_at`);
        for (const b of list) up.run(prefixedId('vpb', now()), perkId, b.product, b.binding, JSON.stringify(b.config), at, at);
    }

    function create({ creatorId, key, name, description, kind = 'other', bindings = [], actor = null }) {
        const k = slug(key || name, 'key');
        if (byKey(creatorId, k)) fail(409, 'vip.perk_exists', `a perk with key ${k} already exists`);
        if (!KINDS.includes(kind)) fail(422, 'vip.invalid_input', `kind must be one of ${KINDS.join(', ')}`);
        const clean = cleanBindings(bindings) || [];
        const at = iso(now());
        const id = prefixedId('vpk', now());
        db.transaction(() => {
            db.prepare(`INSERT INTO vip_perks (id, creator_id, key, name, description, kind, status, created_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`).run(id, creatorId, k, text(name, 'name', 80, { required: true }), text(description, 'description', 500), kind, actor, at, at);
            setBindings(id, clean);
        })();
        return byId(id);
    }

    function update(perkId, { name, description, kind, status, bindings }) {
        const p = byId(perkId);
        if (!p) fail(404, 'vip.perk_not_found', `no perk ${perkId}`);
        if (kind !== undefined && !KINDS.includes(kind)) fail(422, 'vip.invalid_input', `kind must be one of ${KINDS.join(', ')}`);
        if (status !== undefined && !['active', 'retired'].includes(status)) fail(422, 'vip.invalid_input', 'status must be active or retired');
        const clean = cleanBindings(bindings);
        db.transaction(() => {
            db.prepare('UPDATE vip_perks SET name = ?, description = ?, kind = ?, status = ?, updated_at = ? WHERE id = ?').run(
                name !== undefined ? text(name, 'name', 80, { required: true }) : p.name,
                description !== undefined ? text(description, 'description', 500) : p.description,
                kind !== undefined ? kind : p.kind, status !== undefined ? status : p.status, iso(now()), perkId);
            if (clean) setBindings(perkId, clean);
        })();
        return byId(perkId);
    }

    /** Perks usable in a creator's plans: their own plus the network's. */
    function list({ creatorId, includeNetwork = true, includeRetired = false }) {
        const owners = includeNetwork && creatorId !== 'network' ? [creatorId, 'network'] : [creatorId];
        return db.prepare(`SELECT * FROM vip_perks WHERE creator_id IN (${owners.map(() => '?').join(',')}) ${includeRetired ? '' : "AND status = 'active'"}
            ORDER BY creator_id = 'network', name COLLATE NOCASE`).all(...owners);
    }

    /** Resolve perk ids or keys for a plan of creatorId: own or network perks, active only. */
    function resolveForPlan(creatorId, refs) {
        if (refs == null) return null;
        if (!Array.isArray(refs) || refs.length > 30) fail(422, 'vip.invalid_input', 'perks must be a list of at most 30 perk ids or keys');
        const out = [];
        const seen = new Set();
        for (const r of refs) {
            const s = String(r || '');
            let p = s.startsWith('vpk_') ? byId(s) : (byKey(creatorId, s) || byKey('network', s));
            if (p && p.creator_id !== creatorId && p.creator_id !== 'network') p = null;
            if (!p || p.status !== 'active') fail(422, 'vip.perk_not_found', `no active perk ${s} for this creator`);
            if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
        }
        return out;
    }

    const bindingsOf = (perkId) => db.prepare("SELECT * FROM vip_product_bindings WHERE perk_id = ? AND status = 'active' ORDER BY product, binding").all(perkId);

    function present(p, { withBindings = true } = {}) {
        if (!p) return null;
        return {
            id: p.id, key: p.key, name: p.name, description: p.description || null, kind: p.kind, status: p.status,
            scope: p.creator_id === 'network' ? 'network' : 'creator', creator_id: p.creator_id,
            bindings: withBindings ? bindingsOf(p.id).map((b) => ({ product: b.product, binding: b.binding, config: json(b.config, {}) })) : undefined,
            updated_at: p.updated_at,
        };
    }

    return { byId, byKey, create, update, list, resolveForPlan, bindingsOf, present, KINDS };
}

module.exports = { createPerks };
