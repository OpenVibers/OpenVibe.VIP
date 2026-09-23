'use strict';

/**
 * OpenVibe.VIP configuration. Everything comes from the environment (.env in development,
 * /etc/openvibe/vip.env in production). loadConfig(env) is pure so tests build their own.
 *
 * VIP never prices anything and never moves money (ADR-012): prices, periods, charges, renewals,
 * cancellations and refunds are OpenVibe.Billing's. VIP holds plans, versioned plan terms, perks
 * and gated-resource policy.
 */
require('dotenv').config();

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v, d = false) => (v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const trim = (u) => String(u || '').replace(/\/+$/, '');
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function loadConfig(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4620);
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.vip' : `http://localhost:${port}`));
    return {
        nodeEnv,
        isProduction,
        port,
        host: env.HOST || '127.0.0.1',
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 1,
        dbPath: env.VIP_DB_PATH || './data/vip.db',

        // Identity: service tokens and user tokens are RS256 JWTs signed by OpenVibe.Network.
        network: {
            url: networkUrl,
            internalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
            issuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
            publicKey: env.OV_NETWORK_PUBLIC_KEY ? env.OV_NETWORK_PUBLIC_KEY.replace(/\\n/g, '\n') : null,
        },
        audience: env.VIP_AUDIENCE || 'openvibe.vip',
        // VIP's own client (client `vip` in the Network): service tokens for Billing, Events and the
        // Network (identity resolve, importer only), and the OAuth code flow for browser sign-in.
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'vip',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: env.OV_OAUTH_SCOPE || 'profile',
        },
        cookies: { secure: env.COOKIE_SECURE != null ? bool(env.COOKIE_SECURE) : isProduction },
        // Signs the anti-forgery tokens of the server-rendered forms (required in production).
        formSecret: env.VIP_FORM_SECRET || (isProduction ? '' : 'dev-form-secret'),
        // Network roles that may manage network-wide plans and see any creator's members.
        staffRoles: list(env.VIP_STAFF_ROLES || 'admin'),

        billing: {
            url: trim(env.BILLING_URL || 'http://127.0.0.1:4600'),
            audience: env.BILLING_AUDIENCE || 'openvibe.billing',
            timeoutMs: int(env.VIP_BILLING_TIMEOUT_MS, 5000),
            // Checkout providers offered on the plan pages (each must be enabled on Billing too).
            // `credit` pays from the member's Vibes credit through Billing's subscription API.
            // Empty (set but blank) closes checkout — the setting until Billing is authoritative.
            providers: list(env.VIP_CHECKOUT_PROVIDERS != null ? env.VIP_CHECKOUT_PROVIDERS : 'powerchat,credit'),
            // Billing answers a PowerChat intent with a checkout_ref (pcsub:…) instead of a URL. When
            // set, this template turns it into a link: {ref} and {cents} are filled in.
            powerchatLinkTemplate: env.VIP_POWERCHAT_LINK_TEMPLATE || '',
            ratesTtlMs: int(env.VIP_BILLING_RATES_TTL_MS, 5 * 60 * 1000),
        },

        // The entitlement projection (a cache of Billing, never the truth). An answer is trusted for
        // at most maxAgeMs after VIP last heard from Billing about it, and never past the paid
        // period's end; up to graceMs later a projection-only check still answers (flagged stale);
        // after that VIP answers "unknown" until Billing confirms again.
        projection: {
            maxAgeMs: int(env.VIP_PROJECTION_MAX_AGE_MS, 15 * 60 * 1000),
            graceMs: int(env.VIP_PROJECTION_GRACE_MS, 60 * 1000),
        },

        events: {
            url: trim(env.EVENTS_URL || ''),
            intervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
            // Signing secret(s) of VIP's OpenVibe.Events subscriptions (billing.entitlement.*,
            // billing.subscription.*, billing.transaction.reversed). Comma-separated for rotation.
            webhookSecrets: list(env.VIP_EVENTS_SECRET),
        },

        jobs: {
            enabled: env.VIP_JOBS !== 'off',
            // Re-confirm, with Billing, projections that were used recently and are about to go stale.
            refreshIntervalMs: int(env.VIP_REFRESH_INTERVAL_MS, 60 * 1000),
        },
        liveUrl: trim(env.LIVE_URL || 'https://openvibe.live'),

        // The public card, badge and widget (/embed, server/web/embeds.js). frameAncestors is the
        // widget's CSP frame-ancestors (any site by default: it is meant to be embedded; the rest of
        // VIP stays 'self'). The member count comes from Billing, cached for memberCountTtlMs.
        embeds: {
            // Source expressions only: a ';' or a line break would start another CSP directive.
            frameAncestors: String(env.VIP_WIDGET_FRAME_ANCESTORS || '*').replace(/[;,\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || '*',
            memberCountTtlMs: int(env.VIP_MEMBER_COUNT_TTL_MS, 5 * 60 * 1000),
        },
    };
}

module.exports = { loadConfig };
