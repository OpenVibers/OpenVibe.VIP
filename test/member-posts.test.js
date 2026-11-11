'use strict';
// Members-only posts on a creator page (owner's ask, plan 2026-10-22 §4 "Creator money: Tips, VIP"):
// a creator writes a post for the members of one or more of their tiers. The title is public; the text
// is served only after the entitlement check, and never to a signed-out visitor or a non-member.
const assert = require('assert');
const http = require('http');
const { boot, harness } = require('./helpers/app');
const { renderMarkdown } = require('../server/domain/markdown');
const pages = require('../server/web/pages');
const { createDomain } = require('../server/domain');
const { createPosts } = require('../server/domain/posts');
const { createMediaClient } = require('../server/media-client');
const { createWebRoutes } = require('../server/web/routes');
const glyphs = require('openvibe-shared/glyphs');

const { test, run } = harness('members-only posts');

/** A stand-in for OpenVibe.Media's Object API v2 (the image on a post). */
async function startMedia() {
    const objects = new Map();
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks);
        const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        const m = req.url.match(/^\/api\/v2\/[^/]+\/objects(?:\/([^/]+))?(?:\/(content|complete))?$/);
        if (!m) return json(404, { detail: 'not found' });
        const [, id, step] = m;
        if (!id) {
            const obj = { id: 'med_' + 'A'.repeat(26), size: raw.length, ready: false };
            objects.set(obj.id, obj);
            return json(201, { id: obj.id, status: 'pending' });
        }
        const obj = objects.get(id);
        if (!obj) return json(404, { detail: 'no such object' });
        if (step === 'content') { obj.size = raw.length; return json(200, { id, size_bytes: raw.length }); }
        if (step === 'complete') { obj.ready = true; return json(200, { id, status: 'ready' }); }
        return json(200, { id, status: obj.ready ? 'ready' : 'pending' });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, objects, close: () => new Promise((r) => server.close(r)) };
}

/** A creator with a tier-1 and a tier-2 plan published. */
async function publishTiers(t, creator, tiers = [1, 2]) {
    for (const tier of tiers) {
        const r = await t.call('POST', '/api/v1/plans', {
            body: { creator: { type: 'user', id: creator.subject }, name: `Tier ${tier} plan`, publish: true, tier },
            cap: ['vip.plan.create'],
        });
        assert.strictEqual(r.status, 201, `plan tier ${tier}: ${JSON.stringify(r.json)}`);
    }
}

/** A post written by the creator, through their own dashboard. */
async function writePost(t, creator, { title, body, tiers = ['1'] }) {
    const page = await t.page('/dashboard', { user: creator });
    const token = t.csrf(page.text);
    assert.ok(token, 'the dashboard has a form token');
    const res = await t.page('/dashboard/posts', { user: creator, method: 'POST', form: { title, body, tiers: tiers.join(','), _csrf: token } });
    assert.strictEqual(res.status, 303, `post ${title}: ${res.text.slice(0, 200)}`);
    return res;
}

test('a non-member and a signed-out visitor see the title, the tier and a way to join — never the text', async () => {
    const t = await boot();
    try {
        const creator = t.network.newUser('lena');
        await publishTiers(t, creator, [1]);
        await writePost(t, creator, { title: 'Studio notes', body: 'The secret of the mix: 60% patience.', tiers: ['1'] });

        const out = await t.page('/@lena');
        assert.strictEqual(out.status, 200);
        assert.ok(out.text.includes('Studio notes'), 'the title is public');
        assert.ok(out.text.includes('Tier 1'), 'the tier it needs is shown');
        assert.ok(out.text.includes('Become a member'), 'there is a way to join');
        assert.ok(!out.text.includes('60% patience'), 'the text is not on the page');

        // The API never hands the text to a signed-out caller.
        const list = await t.call('GET', '/api/v1/creators/' + creator.subject + '/posts', { token: null });
        assert.strictEqual(list.status, 200);
        assert.strictEqual(list.json.posts.length, 1);
        assert.strictEqual(list.json.posts[0].title, 'Studio notes');
        assert.strictEqual(list.json.posts[0].body, undefined, 'the list carries no text');
        assert.strictEqual(list.json.posts[0].locked, true);
        const body = await t.call('GET', '/api/v1/creators/' + creator.subject + '/posts/' + list.json.posts[0].id + '/body', { token: null });
        assert.strictEqual(body.status, 401, 'a signed-out caller gets nothing');

        // A signed-in non-member neither.
        const stranger = t.network.newUser('nils');
        const strangerBody = await t.call('GET', '/api/v1/creators/' + creator.subject + '/posts/' + list.json.posts[0].id + '/body', { user: stranger });
        assert.strictEqual(strangerBody.status, 403);
        assert.ok(!JSON.stringify(strangerBody.json).includes('60% patience'));
    } finally { await t.close(); }
});

test('a member of the tier reads the text, on the page and through the API', async () => {
    const t = await boot();
    try {
        const creator = t.network.newUser('lena');
        const member = t.network.newUser('mika');
        await publishTiers(t, creator, [1]);
        await writePost(t, creator, { title: 'Studio notes', body: 'The secret of the mix: 60% patience.', tiers: ['1'] });

        const paid = await t.billing.pay(member.subject, creator.subject, { tier: 1 });
        await t.deliverAll(paid.events);

        const out = await t.page('/@lena', { user: member });
        assert.ok(out.text.includes('Studio notes'));
        assert.ok(out.text.includes('60% patience'), 'a member reads the text');

        const list = await t.call('GET', '/api/v1/creators/' + creator.subject + '/posts', { user: member });
        const post = list.json.posts[0];
        assert.strictEqual(post.locked, false);
        const body = await t.call('GET', '/api/v1/creators/' + creator.subject + '/posts/' + post.id + '/body', { user: member });
        assert.strictEqual(body.status, 200);
        assert.ok(body.json.body.includes('60% patience'));
        assert.ok(body.json.body_html.includes('<p>'), 'the Markdown is rendered to safe HTML');
    } finally { await t.close(); }
});

test('a member of another tier does not read the text', async () => {
    const t = await boot();
    try {
        const creator = t.network.newUser('lena');
        const member = t.network.newUser('mika');
        await publishTiers(t, creator, [1, 2]);
        await writePost(t, creator, { title: 'Backstage', body: 'Only for the second row.', tiers: ['2'] });

        const paid = await t.billing.pay(member.subject, creator.subject, { tier: 1 });
        await t.deliverAll(paid.events);

        const out = await t.page('/@lena', { user: member });
        assert.ok(out.text.includes('Backstage'), 'the title is public');
        assert.ok(!out.text.includes('Only for the second row.'), 'the text is not');

        const list = await t.call('GET', '/api/v1/creators/' + creator.subject + '/posts', { user: member });
        const post = list.json.posts[0];
        assert.strictEqual(post.locked, true);
        const body = await t.call('GET', '/api/v1/creators/' + creator.subject + '/posts/' + post.id + '/body', { user: member });
        assert.strictEqual(body.status, 403);
    } finally { await t.close(); }
});

test('the creator reads their own post, on the page and on the dashboard', async () => {
    const t = await boot();
    try {
        const creator = t.network.newUser('lena');
        await publishTiers(t, creator, [1]);
        await writePost(t, creator, { title: 'Studio notes', body: 'The secret of the mix: 60% patience.', tiers: ['1'] });

        const page = await t.page('/@lena', { user: creator });
        assert.ok(page.text.includes('60% patience'), 'the creator reads their own text');
        const dash = await t.page('/dashboard', { user: creator });
        assert.ok(dash.text.includes('Studio notes'), 'the dashboard lists the post');
        assert.ok(dash.text.includes('60% patience'), 'the dashboard shows the creator their own text');
    } finally { await t.close(); }
});

test('staff hide a post: it is gone from the page and from the API, and the creator cannot bring it back', async () => {
    const t = await boot();
    try {
        const creator = t.network.newUser('lena');
        const member = t.network.newUser('mika');
        const staff = t.network.newUser('mod', { role: 'admin' });
        await publishTiers(t, creator, [1]);
        await writePost(t, creator, { title: 'Studio notes', body: 'The secret of the mix: 60% patience.', tiers: ['1'] });
        const paid = await t.billing.pay(member.subject, creator.subject, { tier: 1 });
        await t.deliverAll(paid.events);

        const list = await t.call('GET', '/api/v1/creators/' + creator.subject + '/posts', { user: member });
        const id = list.json.posts[0].id;

        const hidden = await t.call('POST', '/api/v1/posts/' + id + '/hide', { user: staff });
        assert.strictEqual(hidden.status, 200);
        assert.strictEqual(hidden.json.post.status, 'hidden');

        const page = await t.page('/@lena', { user: member });
        assert.ok(!page.text.includes('Studio notes'), 'a hidden post is not listed');
        assert.ok(!page.text.includes('60% patience'));
        const body = await t.call('GET', '/api/v1/creators/' + creator.subject + '/posts/' + id + '/body', { user: member });
        assert.strictEqual(body.status, 404, 'a hidden post serves no text');

        const dash = await t.page('/dashboard', { user: creator });
        assert.ok(dash.text.includes('Studio notes'), 'the creator still sees their post');
        assert.ok(dash.text.includes('hidden'), 'and sees that it is hidden');

        // The creator may not undo a staff decision; staff may.
        const back = await t.call('POST', '/api/v1/posts/' + id + '/unhide', { user: creator });
        assert.strictEqual(back.status, 403);
        const again = await t.call('POST', '/api/v1/posts/' + id + '/unhide', { user: staff });
        assert.strictEqual(again.status, 200);
        assert.strictEqual(again.json.post.status, 'published');
        const shown = await t.page('/@lena', { user: member });
        assert.ok(shown.text.includes('60% patience'), 'the post is readable again');
    } finally { await t.close(); }
});

test('an image on a post goes to Media and is shown to the members of the tier', async () => {
    const media = await startMedia();
    const t = await boot({ env: { OV_MEDIA_INTERNAL_URL: media.url, OV_MEDIA_URL: 'https://media.test' } });
    try {
        const creator = t.network.newUser('lena');
        const member = t.network.newUser('mika');
        await publishTiers(t, creator, [1]);
        const dash = await t.page('/dashboard', { user: creator });
        assert.ok(dash.text.includes('data-post-upload') && dash.text.includes('/shared/ov-upload.js') && dash.text.includes('/shared/ov-upload.css'), 'the composer loads the shared upload kit');
        assert.ok(!dash.text.includes('type="file" name="image"'), 'the hand-rolled file input is gone');
        const token = t.csrf(dash.text);
        const png = Buffer.from('89504e470d0a1a0a', 'hex');
        const res = await t.pageMultipart('/dashboard/posts', {
            user: creator,
            fields: { title: 'Cover art', body: 'The sleeve.', tiers: '1', _csrf: token },
            file: { field: 'image', filename: 'cover.png', contentType: 'image/png', data: png },
        });
        assert.strictEqual(res.status, 303, res.text.slice(0, 200));
        assert.strictEqual(media.objects.size, 1, 'the image was stored in Media');
        const object = [...media.objects.values()][0];
        assert.strictEqual(object.ready, true, 'Media has the whole object');

        const paid = await t.billing.pay(member.subject, creator.subject, { tier: 1 });
        await t.deliverAll(paid.events);
        const page = await t.page('/@lena', { user: member });
        assert.ok(page.text.includes(`https://media.test/o/${object.id}`), 'the image is on the page');
        assert.ok(page.text.includes('The sleeve.'));
    } finally { await t.close(); await media.close(); }
});

test('the Markdown a creator writes is rendered safely', async () => {
    const t = await boot();
    try {
        const creator = t.network.newUser('lena');
        await publishTiers(t, creator, [1]);
        await writePost(t, creator, { title: 'Markup', body: '**bold** <script>alert(1)</script>', tiers: ['1'] });
        const out = await t.page('/@lena', { user: creator });
        assert.ok(out.text.includes('<strong>bold</strong>'), 'the marks are rendered');
        assert.ok(!out.text.includes('<script>alert(1)</script>'), 'no markup is carried through');
    } finally { await t.close(); }
});

test('the renderer escapes everything but the marks, and the page shows a locked post without its text', async () => {
    // The Markdown renderer: only the marks survive, never markup.
    const html = renderMarkdown('## Heading\n\n**bold** and [link](https://a.test) and <script>alert(1)</script>\n\n- one\n- two');
    assert.ok(html.includes('<h4>Heading</h4>'), 'a heading is rendered one step down the page headings');
    assert.ok(html.includes('<strong>bold</strong>'));
    assert.ok(html.includes('<a href="https://a.test" rel="noopener noreferrer nofollow">link</a>'));
    assert.ok(!html.includes('<script>'), 'no markup is carried through');
    assert.ok(html.includes('&lt;script&gt;'), 'the markup is shown as text');
    assert.ok(renderMarkdown('[x](javascript:alert(1))').includes('javascript:alert(1)'), 'a javascript: link stays plain text');
    assert.ok(!renderMarkdown('[x](javascript:alert(1))').includes('<a '), 'and never becomes a link');

    // The page: a locked post shows its title, its tier and the way to join — and no text.
    const locked = pages.postsSection([{ title: 'Studio notes', tiers: [1], published_at: '2026-01-02T00:00:00.000Z', image: null, unlocked: false, body_html: null, join_url: '/@lena#plan-front-row' }]);
    assert.ok(locked.includes('Studio notes'));
    assert.ok(locked.includes('Tier 1'));
    assert.ok(locked.includes('Become a member'));
    assert.ok(!locked.includes('post-body'), 'a locked post carries no text');
    const open = pages.postsSection([{ title: 'Studio notes', tiers: [1], published_at: '2026-01-02T00:00:00.000Z', image: null, unlocked: true, body_html: '<p>The mix.</p>', join_url: '/@lena' }]);
    assert.ok(open.includes('<p>The mix.</p>'), 'a member reads the text');
    // A locked post whose tier cannot be joined: the line, no button.
    const closed = pages.postsSection([{ title: 'Studio notes', tiers: [2], published_at: '2026-01-02T00:00:00.000Z', image: null, unlocked: false, body_html: null, join_url: null }]);
    assert.ok(closed.includes('This post is for the members of Tier 2, which is not open to join yet.'), 'the line says the tier is not open');
    assert.ok(!closed.includes('Become a member'), 'no button that leads nowhere');
    assert.ok(closed.includes('aria-hidden="true"'), 'the lock glyph is decorative');
});

test('a post is written for a tier the creator sells, and the domain refuses the others', async () => {
    const t = await boot();
    try {
        const creator = t.network.newUser('lena');
        await publishTiers(t, creator, [1]);
        const c = await t.domain.creators.bySubject(creator.subject);
        // The domain, built the way the app builds it.
        const domain = createDomain({ db: t.domain.db, config: t.config, outbox: t.domain.outbox, billing: t.domain.billing, now: t.domain.now, log: console, media: t.domain.media });
        assert.ok(domain.posts, 'the domain has posts');
        const posts = createPosts({ db: t.domain.db, now: t.domain.now, creators: t.domain.creators, plans: t.domain.plans, memberships: t.domain.memberships, entitlements: t.domain.entitlements });
        const row = await posts.create({ creatorId: c.id, title: 'Notes', body: 'Hello', tiers: [1], actor: creator.subject });
        assert.ok(row.id);
        assert.deepStrictEqual(posts.tiersOf(row), [1]);
        await assert.rejects(() => posts.create({ creatorId: c.id, title: 'Notes', body: 'Hello', tiers: [4], actor: creator.subject }), /tier/i);
        await assert.rejects(() => posts.create({ creatorId: c.id, title: '', body: 'Hello', tiers: [1], actor: creator.subject }), /title/i);
        // The routes are registered: the composer and the moderation.
        const walk = (stack, out = []) => {
            for (const l of stack || []) {
                if (l.route) out.push(Object.keys(l.route.methods)[0] + ' ' + l.route.path);
                else if (l.handle && l.handle.stack) walk(l.handle.stack, out);
            }
            return out;
        };
        const paths = walk(t.app._router.stack);
        assert.ok(paths.includes('post /dashboard/posts'), 'the composer is a route');
        assert.ok(paths.includes('post /dashboard/posts/:id/hide'));
        assert.ok(paths.includes('post /dashboard/moderation/posts/:id/hide'));
        // The Media client refuses without a service principal rather than losing the image quietly.
        const client = createMediaClient({ config: { ...t.config, oauth: { ...t.config.oauth, clientSecret: '' } } });
        assert.strictEqual(client.configured, false);
        await assert.rejects(() => client.uploadImage({ buffer: Buffer.from('x'), mime: 'image/png', filename: 'x.png' }), /service principal/);
    } finally { await t.close(); }
});

test('a locked post offers a way to join only when a tier that reads it can be joined', async () => {
    const t = await boot();
    try {
        const creator = t.network.newUser('lena');
        const stranger = t.network.newUser('nils');
        // Tier 1 sells; tier 2 has no price, so it cannot be joined.
        await publishTiers(t, creator, [1, 2]);
        await writePost(t, creator, { title: 'Joinable', body: 'For the first row.', tiers: ['1'] });
        await writePost(t, creator, { title: 'Not joinable', body: 'For the second row.', tiers: ['2'] });

        const out = await t.page('/@lena', { user: stranger });
        // The tier-1 post: the button, and it points at the plan that opens it.
        assert.strictEqual((out.text.match(/Become a member/g) || []).length, 1, 'only the joinable post offers a way in');
        assert.ok(out.text.includes('/@lena#plan-tier-1-plan'), 'the link points at the plan that reads it');
        // The tier-2 post: no button, and the line says why.
        assert.ok(out.text.includes('This post is for the members of Tier 2, which is not open to join yet.'));
        assert.ok(!out.text.includes('/@lena#plan-tier-2-plan'), 'no link to a plan that cannot be joined');
        assert.ok(!out.text.includes('For the first row.'), 'no text of a locked post, either way');
        assert.ok(!out.text.includes('For the second row.'));
        // The lock glyph before the line, drawn by the shared glyph set and hidden from a screen reader.
        // Ask the pinned library for the drawing rather than pinning one of its older paths.
        const lock = glyphs.svg('lock', { size: 16 });
        assert.ok(lock, 'the shared glyph set draws a lock');
        assert.match(lock, /aria-hidden="true"/, 'the glyph is hidden from a screen reader');
        assert.ok(out.text.includes(lock), 'the shared lock glyph is on the line');
    } finally { await t.close(); }
});

run();
