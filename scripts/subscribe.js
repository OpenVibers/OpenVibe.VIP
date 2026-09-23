#!/usr/bin/env node
'use strict';
/**
 * Create VIP's OpenVibe.Events subscriptions for Billing's membership-relevant events:
 *
 *   billing.entitlement.*          (billing.entitlement.changed)
 *   billing.subscription.*         (billing.subscription.canceled)
 *   billing.transaction.reversed   (refunds and chargebacks that revoke periods)
 *
 *   node scripts/subscribe.js [--endpoint http://127.0.0.1:4620/internal/events]
 *
 * Reads the environment (.env or /etc/openvibe/vip.env): EVENTS_URL, OV_NETWORK_INTERNAL_URL,
 * OV_OAUTH_CLIENT_ID, OV_OAUTH_CLIENT_SECRET (the vip principal needs events.subscription.manage for
 * audience openvibe.events) and VIP_EVENTS_SECRET — the delivery signing secret handed to Events here,
 * so generate it first (`openssl rand -hex 32`). Nothing secret is printed. Existing identical
 * subscriptions are reported, not duplicated.
 */
require('dotenv').config();
const { serviceAuth } = require('openvibe-contracts');
const { loadConfig } = require('../server/config');

const PATTERNS = ['billing.entitlement.*', 'billing.subscription.*', 'billing.transaction.reversed'];
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };

(async () => {
    const config = loadConfig();
    const endpoint = opt('endpoint', `http://127.0.0.1:${config.port}/internal/events`);
    const secret = config.events.webhookSecrets[0];
    if (!config.events.url) throw new Error('EVENTS_URL is not set');
    if (!secret || secret.length < 32) throw new Error('VIP_EVENTS_SECRET must be set (32+ characters) before subscribing');
    if (!config.oauth.clientSecret) throw new Error('OV_OAUTH_CLIENT_SECRET is not set');
    const tokens = serviceAuth.createTokenClient({
        tokenUrl: `${config.network.internalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.events', scope: 'events.subscription.manage',
    });
    for (const pattern of PATTERNS) {
        const res = await fetch(`${config.events.url}/api/v1/subscriptions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await tokens.authHeaders()) },
            body: JSON.stringify({ topic_pattern: pattern, endpoint, secret }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && body.subscription_id) { console.log(`subscription exists: ${body.subscription_id} (${pattern} → ${endpoint})`); continue; }
        if (!res.ok) throw new Error(`Events answered ${res.status} for ${pattern}: ${body.code || ''} ${body.detail || ''}`.trim());
        console.log(`subscribed: ${body.id} (${pattern} → ${endpoint})`);
    }
    console.log('Replay history per subscription with POST /api/v1/deliveries/replay { subscription_id, from_seq }.');
})().catch((err) => { console.error(`subscribe failed: ${err.message}`); process.exit(1); });
