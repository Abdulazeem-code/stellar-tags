'use strict';

/**
 * #685 — Type field resolvers.
 *
 * Anything the default resolver cannot derive from a row is resolved here.
 * Every relation on a list-returning field goes through a DataLoader, so
 * selecting `webhooks`, `activity`, `webhookCount`, `activityCount`, and
 * `paymentStats` for a page of users costs a fixed number of queries rather
 * than one per field per user.
 */

const { activityKey } = require('../loaders');
const { roundAmount } = require('./helpers');

const DEFAULT_FEDERATION_DOMAIN = 'localhost';

const federationAddress = (user) => {
  const username = user?.username;
  if (!username) return null;
  if (username.includes('*')) return username;
  return `${username}*${process.env.DOMAIN || DEFAULT_FEDERATION_DOMAIN}`;
};

const User = {
  federationAddress: (user) => federationAddress(user),

  webhooks: (user, _args, context) =>
    context.loaders.webhooksByUsername.load(user.username),

  webhookCount: (user, _args, context) =>
    context.loaders.webhookCountByUsername.load(user.username),

  activity: (user, args, context) =>
    context.loaders.activityByUsername.load(activityKey(user.username, args?.limit)),

  activityCount: (user, _args, context) =>
    context.loaders.activityCountByUsername.load(user.username),

  paymentStats: async (user, _args, context) => {
    const address = user.address;
    const [sent, received] = await Promise.all([
      context.loaders.sentStatsByAddress.load(address),
      context.loaders.receivedStatsByAddress.load(address),
    ]);

    return {
      address,
      sentCount: sent?.count ?? 0,
      sentAmount: sent?.amount ?? 0,
      sentFees: sent?.fees ?? 0,
      receivedCount: received?.count ?? 0,
      receivedAmount: received?.amount ?? 0,
      receivedFees: received?.fees ?? 0,
      totalCount: (sent?.count ?? 0) + (received?.count ?? 0),
      totalAmount: roundAmount((sent?.amount ?? 0) + (received?.amount ?? 0)),
      totalFees: roundAmount((sent?.fees ?? 0) + (received?.fees ?? 0)),
    };
  },
};

const Webhook = {
  // The raw-SQL fallback can hand back a JSON string here, so normalise rather
  // than trusting the column to always arrive as an array.
  events: (webhook) => {
    const events = webhook.events;
    if (Array.isArray(events)) return events;
    if (typeof events === 'string') {
      try {
        const parsed = JSON.parse(events);
        return Array.isArray(parsed) ? parsed : ['*'];
      } catch {
        return ['*'];
      }
    }
    return ['*'];
  },

  isFailing: (webhook) => Boolean(webhook.failingSince),
};

const Payment = {
  fromUser: (payment, _args, context) =>
    context.loaders.userByAddress.load(payment.fromAddress),
  toUser: (payment, _args, context) =>
    context.loaders.userByAddress.load(payment.toAddress),
};

const PaymentIntent = {
  fromUser: (intent, _args, context) => context.loaders.userByAddress.load(intent.from),
  toUser: (intent, _args, context) => context.loaders.userByAddress.load(intent.to),
};

module.exports = { User, Webhook, Payment, PaymentIntent, federationAddress };
