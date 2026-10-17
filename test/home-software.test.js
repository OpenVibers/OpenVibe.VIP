'use strict';
// The home tells developers how to sell a subscription to their own software (the owner's ask: "some vibe coder who wants a
// monthly subscription thing for their software"): the SDK call and the plain HTTPS call against /api/v1/entitlements/check,
// which a person's own token may ask about themselves.
const assert = require('assert');
const pages = require('../server/web/pages');

const html = pages.home({ creators: [] });
assert.match(html, /id="software"/);
assert.match(html, /Sell a subscription to your software/);
assert.match(html, /require\(&#39;openvibe-sdk\/vip&#39;\)|require\('openvibe-sdk\/vip'\)/, 'the SDK sample');
assert.match(html, /checkEntitlement\(\{ creator: &#39;yourname&#39; \}\)|checkEntitlement\(\{ creator: 'yourname' \}\)/);
assert.match(html, /https:\/\/openvibe\.vip\/api\/v1\/entitlements\/check \\\n/, 'the HTTPS sample keeps its line continuations');
console.log('home software: all checks passed');
