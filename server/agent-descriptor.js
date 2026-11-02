'use strict';
// What openvibe.vip tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves: the JSON API, the llms.txt/llms-full.txt/sitemap map,
// and the auth that API accepts (service client-credentials tokens and Network user tokens). No OpenAPI
// document or documentation page is published, so neither is named.
module.exports = {
    id: 'vip',
    name: 'OpenVibe.VIP',
    purpose: 'Memberships across the OpenVibe network: creators publish plans and versioned terms, members join through OpenVibe.Billing, and perks and gated resources follow the membership.',
    home: 'https://openvibe.vip',
    site: 'openvibe.vip',
    api: '/api/v1',
    policy: {
        auth: ['none', 'Network OIDC', 'service token'],
    },
};
