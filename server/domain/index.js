'use strict';

/** The VIP domain: every module shares one database handle, one clock and one outbox. */
const { createCreators } = require('./creators');
const { createPerks } = require('./perks');
const { createPlans } = require('./plans');
const { createMemberships } = require('./memberships');
const { createEntitlements } = require('./entitlements');
const { createPolicies } = require('./policies');
const { createCheckout } = require('./checkout');

function createDomain({ db, config, outbox, billing, now = () => Date.now(), log = console }) {
    const creators = createCreators({ db, now });
    const perks = createPerks({ db, now });
    const plans = createPlans({ db, now, outbox, creators, perks });
    const memberships = createMemberships({ db, now, creators, plans });
    const entitlements = createEntitlements({ db, now, config, billing, outbox, memberships, plans, log });
    const policies = createPolicies({ db, now, creators, plans, perks, memberships, entitlements });
    const checkout = createCheckout({ db, now, config, billing, creators, plans, entitlements });
    const tx = (fn) => db.transaction(fn)();
    return { db, config, now, tx, outbox, billing, creators, perks, plans, memberships, entitlements, policies, checkout };
}

module.exports = { createDomain };
