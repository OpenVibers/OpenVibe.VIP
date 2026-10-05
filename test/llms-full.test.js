'use strict';
/**
 * /llms-full.txt: the /llms.txt header plus the full text of every public page — the home copy,
 * each creator's plan page and every published plan's terms. It is public data, cached for an hour.
 */
const assert = require('assert');
const { boot, harness } = require('./helpers/app');

const { test, run } = harness('llms-full');

(async () => {
    const t = await boot();
    const creator = t.network.newUser('dana', { role: 'streamer' });
    let plan;

    test('the full text covers the home, the creator page and the plan terms', async () => {
        const res = await t.call('POST', '/api/v1/plans', { user: creator, body: { name: 'Backstage', description: 'First description', benefits: ['A badge'], publish: true } });
        assert.strictEqual(res.status, 201, res.text);
        plan = res.json.plan;
        const full = await t.call('GET', '/llms-full.txt', { token: null });
        assert.strictEqual(full.status, 200);
        assert.match(full.headers.get('content-type'), /^text\/plain/);
        assert.strictEqual(full.headers.get('cache-control'), 'public, max-age=3600');
        assert.match(full.text, /^# OpenVibe\.VIP/, 'the llms.txt header comes first');
        assert.match(full.text, /## Home/);
        assert.match(full.text, /## Creators/);
        assert.match(full.text, /## Plans/);
        assert.match(full.text, /URL: http:\/\/vip\.test\/\n/, 'the home page');
        assert.match(full.text, /URL: http:\/\/vip\.test\/dana\n/, 'the public creator page');
        assert.match(full.text, new RegExp(`URL: http:\\/\\/vip\\.test\\/dana\\/plans\\/${plan.slug}\\n`), 'the plan terms page');
        assert.match(full.text, /First description/, 'the full plan text, never clipped');
        assert.match(full.text, /@dana/);
    });

    test('the body is built once and cached for an hour', async () => {
        const before = (await t.call('GET', '/llms-full.txt', { token: null })).text;
        const edit = await t.call('PATCH', `/api/v1/plans/${plan.id}`, { user: creator, body: { description: 'Second description' } });
        assert.strictEqual(edit.status, 200, edit.text);
        const cached = (await t.call('GET', '/llms-full.txt', { token: null })).text;
        assert.strictEqual(cached, before, 'within the hour the cached copy is served unchanged');
        assert.doesNotMatch(cached, /Second description/);
        t.clock.advance(3600 * 1000 + 1);
        const fresh = (await t.call('GET', '/llms-full.txt', { token: null })).text;
        assert.match(fresh, /Second description/, 'after the hour the body is rebuilt from the database');
    });

    await run().finally(async () => await t.close());
})();
