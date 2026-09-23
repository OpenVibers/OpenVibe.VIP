'use strict';

/**
 * Page bodies (HTML strings) for the server-rendered routes. Everything here works without
 * JavaScript: forms post to the server, which redirects back with a notice.
 *
 * Copy rules: say what a plan includes and what Billing charges; never "free", "$0" or "no ads", and
 * no begging copy.
 */
const { esc } = require('../util');

const fmtDate = (s) => {
    if (!s) return '';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const money = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;
const csrf = (t) => `<input type="hidden" name="_csrf" value="${esc(t)}">`;

function notice(q) {
    if (!q) return '';
    if (q.error) return `<p class="notice notice-error" role="alert">${esc(q.error)}</p>`;
    if (q.ok) return `<p class="notice" role="status">${esc(q.ok)}</p>`;
    return '';
}

function priceLine(rates) {
    const sub = rates && rates.subscription;
    if (!sub || !sub.price_cents) return '<p class="price muted">OpenVibe.Billing sets the price; it is shown at checkout.</p>';
    return `<p class="price"><b>${money(sub.price_cents)}</b> every ${esc(sub.period_days)} days, charged and renewed by OpenVibe.Billing.</p>`;
}

function perkList(perks) {
    if (!perks || !perks.length) return '';
    return `<ul class="perks">${perks.map((p) => `<li><span class="perk-name">${esc(p.name)}</span></li>`).join('')}</ul>`;
}
function benefitList(benefits) {
    if (!benefits || !benefits.length) return '';
    return `<ul class="benefits">${benefits.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`;
}

function errorPage({ status, title, message }) {
    return `<section class="card narrow"><p class="eyebrow">${esc(status)}</p><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">OpenVibe.VIP home</a></p></section>`;
}

function home({ creators }) {
    const list = creators.length
        ? `<ul class="creator-list">${creators.map((c) => `<li><a href="/${encodeURIComponent(c.username)}"><b>${esc(c.display_name || c.username)}</b><span class="muted">@${esc(c.username)}</span></a></li>`).join('')}</ul>`
        : '<p class="muted">No creator has published a plan here yet.</p>';
    return `<section class="hero">
<h1>Memberships across OpenVibe</h1>
<p>Join a creator's plan once and your membership is recognised on every OpenVibe site that honours it: a badge in chat, members-only posts, rooms and more, as each plan lists.</p>
<p class="muted">Payments, renewals, cancellations and refunds are handled by OpenVibe.Billing. VIP keeps the plans, the exact terms you joined under, and the perks that come with them.</p>
<p><a class="button" href="/me">Your memberships</a> <a class="button button-quiet" href="/dashboard">Offer a plan</a></p>
</section>
<section><h2>Creators with plans</h2>${list}</section>`;
}

/** The creator's public plan page. */
function creatorPage({ creator, plans, viewer, member, rates, providers, token, query, isOwner }) {
    const name = creator.display_name || creator.username;
    const status = member && member.status === 'active'
        ? `<div class="card member-box"><p><b>You are a member.</b> ${member.cancel_at_period_end ? `Your membership ends on ${fmtDate(member.expires_at)}.` : `Paid through ${fmtDate(member.expires_at)}.`}</p>
${member.membership && member.membership.plan_version ? `<p class="muted">You joined under ${esc(member.membership.plan_version.name)} v${esc(member.membership.plan_version.version)}. Those terms stay yours while the membership lasts.</p>` : ''}<p><a href="/me">Manage your memberships</a></p></div>`
        : member && member.status === 'unknown'
            ? '<div class="card member-box"><p class="muted">We could not confirm your membership with OpenVibe.Billing just now. Nothing about it has changed; try again shortly.</p></div>'
            : '';
    const planCards = plans.length ? plans.map((p) => {
        const v = p.current_version;
        const join = !p.purchasable
            ? '<p class="muted">This plan is not sold through Billing yet.</p>'
            : isOwner ? '<p class="muted">This is your plan.</p>'
                : member && member.status === 'active' ? ''
                    : viewer
                        ? `<form method="post" action="/${encodeURIComponent(creator.username)}/join" class="join">${csrf(token)}<input type="hidden" name="plan_id" value="${esc(p.id)}">
<label>Pay with <select name="provider">${providers.map((x) => `<option value="${esc(x)}">${esc(x === 'credit' ? 'your Vibes credit' : x === 'powerchat' ? 'PowerChat' : x)}</option>`).join('')}</select></label>
<label class="check"><input type="checkbox" name="auto_renew" value="1" checked> Renew automatically</label>
<button type="submit">Join ${esc(v.name)}</button></form>`
                        : `<p><a class="button" href="/auth/login?next=${encodeURIComponent(`/${creator.username}`)}">Sign in to join</a></p>`;
        return `<article class="card plan" id="plan-${esc(p.slug)}">
<h2>${esc(v.name)}</h2>
${v.description ? `<p>${esc(v.description)}</p>` : ''}
${benefitList(v.benefits)}
${v.perks.length ? `<h3>Perks</h3>${perkList(v.perks)}` : ''}
${p.purchasable ? priceLine(rates) : ''}
${join}
<p class="muted small">Version ${esc(v.version)} · published ${fmtDate(v.published_at)} · <a href="/${encodeURIComponent(creator.username)}/plans/${encodeURIComponent(p.slug)}">terms history</a></p>
</article>`;
    }).join('') : '<p class="muted">No plan is published yet.</p>';
    return `<section class="creator-head"><p class="eyebrow">Membership</p><h1>${esc(name)}</h1><p class="muted">@${esc(creator.username)}</p>
${creator.bio ? `<p>${esc(creator.bio)}</p>` : ''}</section>
${notice(query)}
${status}
<section class="plans">${planCards}</section>`;
}

/** Public terms history of one plan: every published version, unchanged. */
function planHistory({ creator, plan, versions }) {
    return `<section><p class="eyebrow"><a href="/${encodeURIComponent(creator.username)}">${esc(creator.display_name || creator.username)}</a></p>
<h1>Terms history</h1>
<p class="muted">Each edit of a plan is a new version. Members keep the version they joined under; earlier versions are never rewritten.</p>
${versions.map((v) => `<article class="card version"><h2>${esc(v.name)} <span class="muted">v${esc(v.version)}</span></h2>
<p class="muted small">Published ${fmtDate(v.published_at)}${v.change_note ? ` · ${esc(v.change_note)}` : ''}</p>
${v.description ? `<p>${esc(v.description)}</p>` : ''}${benefitList(v.benefits)}${v.perks.length ? `<h3>Perks</h3>${perkList(v.perks)}` : ''}</article>`).join('')}
<p><a href="/${encodeURIComponent(creator.username)}#plan-${esc(plan.slug)}">Back to the plan</a></p></section>`;
}

/** The member's own status page. */
function memberPage({ viewer, rows, token, query }) {
    if (!viewer) {
        return `<section class="card narrow"><h1>Your memberships</h1><p>Sign in with your OpenVibe account to see the plans you belong to and the terms you joined under.</p>
<p><a class="button" href="/auth/login?next=%2Fme">Sign in</a></p></section>`;
    }
    const body = rows.length ? rows.map(({ membership: m, creator: c, entitlement: e, preferences: pref }) => {
        const who = c ? (c.username ? `<a href="/${encodeURIComponent(c.username)}">${esc(c.display_name || c.username)}</a>` : esc(c.display_name || 'a creator')) : 'a creator';
        const state = !e ? '<span class="pill">unknown</span>'
            : e.status === 'active' ? `<span class="pill pill-on">active</span> ${e.cancel_at_period_end ? `ends ${fmtDate(e.expires_at)}` : `paid through ${fmtDate(e.expires_at)}`}`
                : e.status === 'inactive' ? `<span class="pill">ended</span>${e.expires_at ? ` ${fmtDate(e.expires_at)}` : ''}`
                    : '<span class="pill">unconfirmed</span> OpenVibe.Billing did not answer just now; nothing changed';
        const v = m.plan_version;
        const cancel = e && e.status === 'active' && !e.cancel_at_period_end
            ? `<form method="post" action="/me/${encodeURIComponent(m.creator_id)}/cancel">${csrf(token)}<button type="submit" class="button-quiet">Cancel at period end</button></form>` : '';
        return `<article class="card membership"><h2>${who}</h2><p>${state}</p>
${v ? `<p>Joined under <b>${esc(v.name)}</b> v${esc(v.version)}${v.terms && v.terms.perks && v.terms.perks.length ? ` · perks: ${v.terms.perks.map((p) => esc(p.name)).join(', ')}` : ''}</p>` : '<p class="muted">Billing records this membership; the creator has no VIP plan for it.</p>'}
<form method="post" action="/me/${encodeURIComponent(m.creator_id)}/preferences" class="prefs">${csrf(token)}
<label class="check"><input type="checkbox" name="show_badge" value="1"${pref.show_badge ? ' checked' : ''}> Show my member badge</label>
<button type="submit" class="button-quiet">Save</button></form>
${cancel}</article>`;
    }).join('') : '<p class="muted">You have no memberships yet.</p>';
    return `<section><h1>Your memberships</h1>${notice(query)}${body}
<p class="muted small">Charges, renewals and refunds are OpenVibe.Billing's; the status shown here is confirmed with Billing when it is not recent.</p></section>`;
}

function checkoutPage({ creator, out }) {
    const ref = out.checkout_ref;
    return `<section class="card narrow"><h1>Finish joining ${esc(creator.display_name || creator.username)}</h1>
${out.checkout_url ? `<p><a class="button" href="${esc(out.checkout_url)}" rel="noopener">Continue to payment</a></p>` : ''}
${ref && !out.checkout_url ? `<p>Complete the payment on PowerChat with this reference: <code>${esc(ref)}</code>${out.amount_cents ? ` (${money(out.amount_cents)})` : ''}.</p>` : ''}
<p class="muted">Your membership starts as soon as OpenVibe.Billing confirms the payment; <a href="/me">your memberships</a> shows it then.</p></section>`;
}

// ── Dashboard ────────────────────────────────────────────────
function perkChoices(allPerks, selectedKeys) {
    if (!allPerks.length) return '<p class="muted small">No perks yet — define one below.</p>';
    return `<fieldset class="perk-choices"><legend>Perks</legend>${allPerks.map((p) => `<label class="check"><input type="checkbox" name="perks" value="${esc(p.key)}"${selectedKeys.includes(p.key) ? ' checked' : ''}> ${esc(p.name)}${p.scope === 'network' ? ' <span class="muted small">(network)</span>' : ''}</label>`).join('')}</fieldset>`;
}

function planEditor({ plan, allPerks, token, base }) {
    const v = plan.draft_version || plan.current_version;
    const keys = v ? v.perks.map((p) => p.key) : [];
    const versions = (plan.versions || []).map((x) => `<li>v${esc(x.version)} · ${esc(x.name)} · ${x.published_at ? `published ${fmtDate(x.published_at)}` : 'draft'}${x.change_note ? ` · ${esc(x.change_note)}` : ''}${x.perks.length ? ` · perks: ${x.perks.map((p) => esc(p.key)).join(', ')}` : ''}</li>`).join('');
    const actions = [
        plan.status === 'draft' ? `<form method="post" action="${base}/plans/${esc(plan.id)}/publish" class="inline">${csrf(token)}<button type="submit">Publish</button></form>` : '',
        plan.status !== 'archived' ? `<form method="post" action="${base}/plans/${esc(plan.id)}/archive" class="inline">${csrf(token)}<button type="submit" class="button-quiet">Archive</button></form>` : '',
    ].join(' ');
    return `<article class="card plan-editor"><h3>${esc(v ? v.name : plan.slug)} <span class="pill">${esc(plan.status)}</span></h3>
<p class="muted small">${plan.billing_kind ? 'Sold through OpenVibe.Billing as a channel subscription.' : 'Not sold through Billing (terms only).'} ${plan.current_version ? `New members buy v${esc(plan.current_version.version)}.` : ''}</p>
${plan.status !== 'archived' ? `<details><summary>Edit (creates version ${esc((plan.versions || []).length + 1)})</summary>
<form method="post" action="${base}/plans/${esc(plan.id)}">${csrf(token)}
<label>Name <input name="name" maxlength="80" required value="${esc(v ? v.name : '')}"></label>
<label>Description <textarea name="description" maxlength="2000" rows="3">${esc(v && v.description ? v.description : '')}</textarea></label>
<label>Benefits, one per line <textarea name="benefits" rows="3">${esc(v ? v.benefits.join('\n') : '')}</textarea></label>
${perkChoices(allPerks, keys)}
<label>What changed <input name="change_note" maxlength="300"></label>
<p class="muted small">Members who already joined keep the version they joined under.</p>
<button type="submit">Save as a new version</button></form></details>` : ''}
${actions}
<details><summary>Versions (${esc((plan.versions || []).length)})</summary><ul class="versions">${versions}</ul></details></article>`;
}

function dashboard({ viewer, creator, isNetwork, isStaff, plans, allPerks, ownPerks, members, membersSource, rules, token, query, base }) {
    if (!viewer) {
        return `<section class="card narrow"><h1>Creator dashboard</h1><p>Sign in with your OpenVibe account to offer a membership plan.</p>
<p><a class="button" href="/auth/login?next=%2Fdashboard">Sign in</a></p></section>`;
    }
    const title = isNetwork ? 'Network plans' : 'Your membership plans';
    const pageLink = !isNetwork && creator.username ? `<p class="muted">Your public page: <a href="/${encodeURIComponent(creator.username)}">openvibe.vip/${esc(creator.username)}</a></p>` : '';
    const planOptions = plans.filter((p) => p.status !== 'archived').map((p) => `<option value="${esc(p.id)}">${esc((p.current_version || p.draft_version || {}).name || p.slug)}</option>`).join('');
    return `<section><h1>${title}</h1>${isStaff ? `<p class="muted small">${isNetwork ? '<a href="/dashboard">Your own plans</a>' : '<a href="/dashboard?as=network">Network plans (staff)</a>'}</p>` : ''}${pageLink}${notice(query)}</section>
${isNetwork ? '' : `<section class="card"><h2>Profile</h2><form method="post" action="${base}/profile">${csrf(token)}
<label>Display name <input name="display_name" maxlength="80" value="${esc(creator.display_name || '')}"></label>
<label>About your memberships <textarea name="bio" maxlength="2000" rows="3">${esc(creator.bio || '')}</textarea></label>
<button type="submit">Save</button></form></section>`}
<section><h2>Plans</h2>${plans.length ? plans.map((p) => planEditor({ plan: p, allPerks, token, base })).join('') : '<p class="muted">No plans yet.</p>'}
<details class="card"><summary>New plan</summary><form method="post" action="${base}/plans">${csrf(token)}
<label>Name <input name="name" maxlength="80" required></label>
<label>Description <textarea name="description" maxlength="2000" rows="3"></textarea></label>
<label>Benefits, one per line <textarea name="benefits" rows="3"></textarea></label>
${perkChoices(allPerks, [])}
<label class="check"><input type="checkbox" name="publish" value="1"> Publish now</label>
<p class="muted small">${isNetwork ? 'Network plans are terms only until Billing sells a network membership.' : 'A published plan is sold through OpenVibe.Billing as your channel subscription; Billing sets the price. One published plan can be sold at a time.'}</p>
<button type="submit">Create plan</button></form></details></section>
<section><h2>Perks</h2>
${ownPerks.length ? `<ul class="perk-admin">${ownPerks.map((p) => `<li><details><summary><b>${esc(p.name)}</b> <span class="muted small">${esc(p.key)} · ${esc(p.kind)} · ${esc(p.status)}</span></summary>
<form method="post" action="${base}/perks/${esc(p.id)}">${csrf(token)}
<label>Name <input name="name" maxlength="80" value="${esc(p.name)}"></label>
<label>Description <input name="description" maxlength="500" value="${esc(p.description || '')}"></label>
<label>Product bindings, one "product binding" per line <textarea name="bindings" rows="2">${esc(p.bindings.map((b) => `${b.product} ${b.binding}`).join('\n'))}</textarea></label>
<label>Status <select name="status"><option value="active"${p.status === 'active' ? ' selected' : ''}>active</option><option value="retired"${p.status === 'retired' ? ' selected' : ''}>retired</option></select></label>
<p class="muted small">Renaming a perk does not change the terms of published versions.</p>
<button type="submit">Save perk</button></form></details></li>`).join('')}</ul>` : '<p class="muted">No perks of your own yet.</p>'}
<details class="card"><summary>New perk</summary><form method="post" action="${base}/perks">${csrf(token)}
<label>Name <input name="name" maxlength="80" required></label>
<label>Key (a-z, 0-9, -) <input name="key" maxlength="48" pattern="[a-z0-9][a-z0-9-]*"></label>
<label>Description <input name="description" maxlength="500"></label>
<label>Kind <select name="kind">${['badge', 'emote', 'gated_content', 'room', 'role', 'other'].map((k) => `<option>${k}</option>`).join('')}</select></label>
<label>Product bindings, one "product binding" per line (e.g. <code>chat badge</code>) <textarea name="bindings" rows="2"></textarea></label>
<button type="submit">Create perk</button></form></details></section>
${isNetwork ? '' : `<section><h2>Members</h2>
${members.length ? `<table class="members"><thead><tr><th>Member</th><th>Plan version</th><th>Paid through</th></tr></thead><tbody>${members.map((m) => `<tr><td><code>${esc(m.member.id)}</code></td><td>${m.membership && m.membership.plan_version ? `${esc(m.membership.plan_version.name)} v${esc(m.membership.plan_version.version)}` : '—'}</td><td>${fmtDate(m.current_period_end)}${m.cancel_at_period_end ? ' (ends)' : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No active members.</p>'}
<p class="muted small">${membersSource === 'billing' ? 'From OpenVibe.Billing.' : 'OpenVibe.Billing did not answer; this is VIP\'s recent projection and may be incomplete.'}</p></section>
<section><h2>Members-only resources</h2>
<p class="muted small">A product (Blog, Wiki, Community, Chat, Live) asks VIP whether a viewer may see a resource you gate here; anything VIP cannot confirm is refused.</p>
${rules.length ? `<ul class="rules">${rules.map((r) => `<li><code>${esc(r.resource.service)}/${esc(r.resource.type)}/${esc(r.resource.id)}</code> · ${esc(r.requirement)}${r.perk_key ? ` ${esc(r.perk_key)}` : ''}${r.sensitive ? ' · always checked with Billing' : ''}
<form method="post" action="${base}/rules/${esc(r.id)}/disable" class="inline">${csrf(token)}<button type="submit" class="button-quiet">Remove</button></form></li>`).join('')}</ul>` : ''}
<details class="card"><summary>Gate a resource</summary><form method="post" action="${base}/rules">${csrf(token)}
<label>Product <input name="service" required placeholder="blog" pattern="[a-z][a-z0-9-]{1,39}"></label>
<label>Type <input name="type" required placeholder="post" pattern="[a-z][a-z0-9_]{1,39}"></label>
<label>Id <input name="id" required maxlength="128"></label>
<label>Who may see it <select name="requirement"><option value="member">any member</option><option value="plan">members of one plan</option><option value="perk">members whose plan includes a perk</option></select></label>
<label>Plan <select name="plan_id"><option value="">—</option>${planOptions}</select></label>
<label>Perk <select name="perk_key"><option value="">—</option>${allPerks.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('')}</select></label>
<label class="check"><input type="checkbox" name="sensitive" value="1"> Always check with Billing (slower; for sensitive content)</label>
<button type="submit">Save rule</button></form></details></section>`}`;
}

module.exports = { errorPage, home, creatorPage, planHistory, memberPage, checkoutPage, dashboard, fmtDate };
