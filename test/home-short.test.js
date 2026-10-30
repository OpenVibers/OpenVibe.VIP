'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the questions are a fold, closed on a phone and open
 * where there is room, and the creators are one sideways row. Everything stays in the page for the crawlers.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pages = require('../server/web/pages');

const creators = [
    { username: 'alma', display_name: 'Alma' },
    { username: 'bo', display_name: 'Bo' },
];
const html = pages.home({ creators, live: [], networkUrl: 'https://openvibe.network' });

// The questions are a fold, open in the page and closed on a phone.
assert.ok(html.includes('<details class="hm-fold hm-fold-block" id="questions-fold" open>'), 'the questions are a fold, open in the page');
assert.ok(html.includes('document.getElementById("questions-fold")'), 'the fold has the script that closes it on a phone');
// The questions stay in the page.
assert.match(html, /What is a membership\?/);
assert.ok(html.includes('id="questions"'), 'the questions keep their section');
// Every creator stays in the page.
for (const c of creators) assert.ok(html.includes(`href="/${c.username}"`), `${c.username} is on the page`);

// The CSS guard: a fold is a 44 px target and the creators are one row on a phone.
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'vip.css'), 'utf8');
assert.match(css, /\.hm-fold-block > summary \{[^}]*min-height: 44px/, 'a fold is a 44 px target');
assert.match(css, /@media \(max-width: 599px\) \{\s*\.creator-list \{ display: flex; overflow-x: auto;/, 'the creators are one sideways row on a phone');
assert.match(css, /\.creator-list > li \{ flex: 0 0/, 'every creator keeps its place in the row');

console.log('home-short: 2/2 passed');
