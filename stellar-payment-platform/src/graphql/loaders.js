'use strict';

/**
 * #685 — Per-request DataLoaders.
 *
 * GraphQL resolves sibling fields concurrently, so any resolver that touches the
 * database per parent turns a single query into one round trip per row. Every
 * relation on a list-returning field therefore goes through a loader here.
 *
 * A loader is created *per request* (see `createContext`), which is what makes
 * it correct: a cache shared across requests would serve one user's rows to
 * another and would go stale the moment a registration lands. Within a request
 * the loader both de-duplicates repeated keys and batches everything resolved in
 * the same tick into one `WHERE ... IN (...)` query, so a page of 50 users with
 * `webhooks`, `activityCount`, and `paymentStats` selected costs 4 queries
 * instead of 151.
 *
 * Notes:
 *   - `maxBatchSize` caps each generated `IN (...)` list, keeping the parameter
 *     count and query plan inside PostgreSQL's comfort zone.
 *   - Keys are returned positionally, one entry per requested key, because that
 *     is the contract DataLoader joins results back on. Grouped loaders therefore
 *     return an array *of arrays*.
 */

const DataLoader = require('dataloader');
const { PRIMARY_USERNAME_ORDER } = require('../utils');
const { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } = require('../services/activityService');

/**
 * Caps a batch. A page of 100 users already produces 100-element IN lists;
 * beyond this the generated SQL stops being worth planning.
 */
const MAX_BATCH_SIZE = 100;

/**
 * Safety valve for the grouped activity fetch. A trail row is small and users
 * have short trails, so this is only ever hit by a pathological account; it
 * bounds the worst case rather than shaping the normal one.
 */
const MAX_ACTIVITY_FETCH = 5000;

const clampActivityLimit = (limit) => {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, parsed);
};

/** Groups rows by a string key, preserving insertion order per group. */
const groupBy = (rows, keyOf) => {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
};

/**
 * Normalises a `prisma.groupBy` result into `Map<groupKey, { count, amount, fees }>`.
 * Prisma returns `{ _count: { _all: n }, _sum: { amount, fee } }` per group.
 */
const toAggregateMap = (groups, keyOf) => {
  const totals = new Map();
  for (const group of groups || []) {
    totals.set(keyOf(group), {
      count: Number(group?._count?._all ?? 0),
      amount: Number(group?._sum?.amount ?? 0),
      fees: Number(group?._sum?.fee ?? 0),
    });
  }
  return totals;
};

const ZERO_AGGREGATE = { count: 0, amount: 0, fees: 0 };

/**
 * Builds the loader set for a single request.
 *
 * @param {object} prisma - Prisma client (or the repo's test fallback).
 * @returns {Record<string, import('dataloader').default>} loaders, keyed by the
 *   name resolvers use.
 */
function createLoaders(prisma) {
  // --- Users -------------------------------------------------------------

  const userByUsername = new DataLoader(
    async (usernames) => {
      const rows = await prisma.user.findMany({
        where: { username: { in: [...usernames] } },
      });
      const byUsername = new Map(rows.map((row) => [row.username, row]));
      return usernames.map((username) => byUsername.get(username) ?? null);
    },
    { maxBatchSize: MAX_BATCH_SIZE },
  );

  // An address may carry several usernames (#613); the primary one wins, which
  // is the same ordering the REST reverse lookup uses.
  const userByAddress = new DataLoader(
    async (addresses) => {
      const rows = await prisma.user.findMany({
        where: { address: { in: [...addresses] }, deletedAt: null },
        orderBy: PRIMARY_USERNAME_ORDER,
      });
      const byAddress = new Map();
      for (const row of rows) {
        if (!byAddress.has(row.address)) byAddress.set(row.address, row);
      }
      return addresses.map((address) => byAddress.get(address) ?? null);
    },
    { maxBatchSize: MAX_BATCH_SIZE },
  );

  // --- Webhooks ----------------------------------------------------------

  const webhooksByUsername = new DataLoader(
    async (usernames) => {
      const rows = await prisma.webhook.findMany({
        where: { username: { in: [...usernames] } },
        orderBy: { createdAt: 'desc' },
      });
      const grouped = groupBy(rows, (row) => row.username);
      return usernames.map((username) => grouped.get(username) ?? []);
    },
    { maxBatchSize: MAX_BATCH_SIZE },
  );

  const webhookCountByUsername = new DataLoader(
    async (usernames) => {
      const groups = await prisma.webhook.groupBy({
        by: ['username'],
        where: { username: { in: [...usernames] } },
        _count: { _all: true },
      });
      const totals = toAggregateMap(groups, (group) => group.username);
      return usernames.map((username) => totals.get(username)?.count ?? 0);
    },
    { maxBatchSize: MAX_BATCH_SIZE },
  );

  // --- Activity ----------------------------------------------------------

  // Keyed by "username\0limit" so one loader serves every requested page size
  // without a per-limit cache entry colliding.
  const activityByUsername = new DataLoader(
    async (keys) => {
      const parsed = keys.map((key) => {
        const [username, rawLimit] = String(key).split('\u0000');
        return { username, limit: clampActivityLimit(rawLimit) };
      });

      const rows = await prisma.activityLog.findMany({
        where: { username: { in: [...new Set(parsed.map((entry) => entry.username))] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_ACTIVITY_FETCH,
      });

      const grouped = groupBy(rows, (row) => row.username);
      return parsed.map(({ username, limit }) =>
        (grouped.get(username) ?? []).slice(0, limit),
      );
    },
    { maxBatchSize: MAX_BATCH_SIZE },
  );

  const activityCountByUsername = new DataLoader(
    async (usernames) => {
      const groups = await prisma.activityLog.groupBy({
        by: ['username'],
        where: { username: { in: [...usernames] } },
        _count: { _all: true },
      });
      const totals = toAggregateMap(groups, (group) => group.username);
      return usernames.map((username) => totals.get(username)?.count ?? 0);
    },
    { maxBatchSize: MAX_BATCH_SIZE },
  );

  // --- Payment aggregates ------------------------------------------------
  //
  // Sent and received are two separate `GROUP BY` queries because the grouping
  // column differs (from_address vs to_address). Two queries for any number of
  // users is the point: the naive version runs one per user.

  const sentStatsByAddress = new DataLoader(
    async (addresses) => {
      const groups = await prisma.payment.groupBy({
        by: ['fromAddress'],
        where: { fromAddress: { in: [...addresses] } },
        _sum: { amount: true, fee: true },
        _count: { _all: true },
      });
      const totals = toAggregateMap(groups, (group) => group.fromAddress);
      return addresses.map((address) => totals.get(address) ?? ZERO_AGGREGATE);
    },
    { maxBatchSize: MAX_BATCH_SIZE },
  );

  const receivedStatsByAddress = new DataLoader(
    async (addresses) => {
      const groups = await prisma.payment.groupBy({
        by: ['toAddress'],
        where: { toAddress: { in: [...addresses] } },
        _sum: { amount: true, fee: true },
        _count: { _all: true },
      });
      const totals = toAggregateMap(groups, (group) => group.toAddress);
      return addresses.map((address) => totals.get(address) ?? ZERO_AGGREGATE);
    },
    { maxBatchSize: MAX_BATCH_SIZE },
  );

  return {
    userByUsername,
    userByAddress,
    webhooksByUsername,
    webhookCountByUsername,
    activityByUsername,
    activityCountByUsername,
    sentStatsByAddress,
    receivedStatsByAddress,
  };
}

/** Builds the composite key `activityByUsername` is keyed by. */
const activityKey = (username, limit) =>
  `${username}\u0000${clampActivityLimit(limit)}`;

module.exports = {
  createLoaders,
  activityKey,
  clampActivityLimit,
  groupBy,
  toAggregateMap,
  ZERO_AGGREGATE,
  MAX_BATCH_SIZE,
  MAX_ACTIVITY_FETCH,
};
