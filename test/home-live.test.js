'use strict';
// The home's "Live now" strip and creator grid: creators with a plan who are live on OpenVibe.Live come first and get
// their own card (title, viewers, Watch and plan links); a channel live without a plan here is not shown; with nobody
// live the strip is absent. The FAQ on the page and its FAQPage data say the same thing. live-now keeps every live,
// non-NSFW channel from Live's public list and never breaks the page when Live fails.
const assert = require('assert');
const pages = require('../server/web/pages');
const { esc } = require('../server/util');
const { createLiveNow } = require('../server/live-now');

const creators = [
    { username: 'alma', display_name: 'Alma' },
    { username: 'bo', display_name: 'Bo' },
    { username: 'Cyd', display_name: 'Cyd <3' },
];
const live = [
    { username: 'cyd', name: 'Cyd', title: 'Building a bot <live>', category: 'Science', viewers: 12, url: 'https://openvibe.live/@cyd' },
    { username: 'stranger', name: 'Stranger', title: 'No plan here', category: null, viewers: 40, url: 'https://openvibe.live/@stranger' },
];

const html = pages.home({ creators, live, networkUrl: 'https://openvibe.network' });
assert.match(html, /id="live"/, 'the strip shows when a creator with a plan is live');
assert.match(html, /Building a bot &lt;live&gt;/, 'the stream title, escaped');
assert.match(html, /12 viewers/);
assert.match(html, /href="https:\/\/openvibe\.live\/@cyd" rel="noopener">Watch/);
assert.ok(!html.includes('No plan here'), 'a channel without a plan here is not on the home');
const grid = html.slice(html.indexOf('id="creators"'));
assert.ok(grid.indexOf('href="/Cyd"') < grid.indexOf('href="/alma"'), 'live creators come first in the grid');
assert.match(html, /src="https:\/\/openvibe\.network\/avatar\/alma\?s=40" width="40" height="40" alt="" loading="lazy"/, 'avatars from Network, sized');
assert.match(html, /<dt>3 creators<\/dt><dd>offer a membership<\/dd>/);
assert.match(html, /<dt>1 creator<\/dt><dd>live on OpenVibe\.Live now<\/dd>/);

const quiet = pages.home({ creators, live: [] });
assert.ok(!quiet.includes('id="live"'), 'no strip when nobody with a plan is live');
assert.ok(!/live on OpenVibe\.Live now/.test(quiet), 'and no live count');

const ld = pages.homeFaqJsonLd();
assert.strictEqual(ld['@type'], 'FAQPage');
assert.deepStrictEqual(ld.mainEntity.map((q) => q.name), pages.HOME_FAQ.map((f) => f.q), 'FAQPage data asks what the page asks');
const shown = [...html.matchAll(/<summary>([^<]*)<\/summary>/g)].map((m) => m[1]);
assert.deepStrictEqual(shown, pages.HOME_FAQ.map((f) => esc(f.q)), 'every question is on the page, in order');
assert.ok(pages.HOME_TITLE.length + ' · OpenVibe.VIP'.length <= 60, 'the title fits 60 characters');
assert.ok(pages.HOME_DESCRIPTION.length <= 160, 'the description fits 160 characters');

(async () => {
    const config = { liveNow: true, liveUrl: 'https://openvibe.live' };
    const rows = [
        { username: 'a', is_live: 1, viewer_count: 3, title: 'x' },
        { username: 'b', is_live: 1, viewer_count: 9, is_nsfw: 1 },
        { username: 'c', is_live: 0, viewer_count: 50 },
        { username: 'bad name', is_live: 1, viewer_count: 99 },
    ];
    let calls = 0;
    const ok = createLiveNow({ config, log: { warn() {} }, fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ streams: rows }) }; } });
    assert.deepStrictEqual((await ok.list()).map((s) => s.username), ['a'], 'live, safe-for-work, well-formed channels only');
    await ok.list();
    assert.strictEqual(calls, 1, 'read at most once a minute');
    const down = createLiveNow({ config, log: { warn() {} }, fetchImpl: async () => { throw new Error('refused'); } });
    assert.deepStrictEqual(await down.list(), [], 'Live down: an empty strip, never an error');
    const off = createLiveNow({ config: { ...config, liveNow: false }, fetchImpl: async () => { throw new Error('must not be called'); } });
    assert.deepStrictEqual(await off.list(), []);
    console.log('home live: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
