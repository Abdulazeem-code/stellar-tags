'use strict';

/**
 * #685 — Resolver map.
 *
 * The single object handed to `makeSchema`. Every field in the SDL that the
 * default resolver cannot satisfy appears here, which keeps the map a
 * deliberate, reviewable list rather than a pile of overrides.
 */

const { Query } = require('./query');
const { User, Webhook, Payment, PaymentIntent } = require('./types');

const resolvers = {
  Query,
  User,
  Webhook,
  Payment,
  PaymentIntent,
};

module.exports = resolvers;
