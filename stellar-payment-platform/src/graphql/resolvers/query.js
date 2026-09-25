'use strict';

/**
 * #685 — Root `Query` resolvers.
 *
 * These mirror the REST read paths they replace, so the GraphQL surface and
 * `/api/v1` cannot drift on validation or normalisation rules: both call the
 * same helpers, and the stats and federation resolvers delegate to the same
 * services the REST routes use.
 *
 * Read-only by design. Writes (registration, account transfer, webhook
 * management) keep going through their REST endpoints, which already enforce
 * Stellar multisig verification, idempotency keys, and activity logging — none
 * of which a GraphQL mutation would inherit for free.
 */

const { getRoutingStats, fetchAdminStats, SERVER_START_TIME } = require('../../services/statsService');
const { getCachedStats } = require('../../cache/statsCache');
const {
  federationNameKey,
  federationIdKey,
  federationLookupCached,
} = require('../../cache');
const { USER_DATABASE, PRIMARY_USERNAME_ORDER } = require('../../utils');
const { ApiError } = require('../../errors');
const {
  normalizeUsername,
  paginationFromArgs,
  connection,
  dateBounds,
  buildUserWhere,
  buildPaymentWhere,
  buildPaymentIntentWhere,
  buildUserOrderBy,
  buildPaymentOrderBy,
} = require('./helpers');

const DEFAULT_FEDERATION_DOMAIN = 'localhost';

const federationDomain = () => process.env.DOMAIN || DEFAULT_FEDERATION_DOMAIN;

const toFederationRecord = ({ stellarAddress, accountId, memoType = null, memo = null }) => ({
  stellarAddress,
  accountId,
  memoType,
  memo,
});

/** Maps the snake_case stats payload onto the camelCase GraphQL type. */
const toPlatformStats = (stats) => ({
  totalRegisteredUsers: Number(stats?.total_registered_users ?? 0),
  activeTokens: Number(stats?.active_tokens ?? 0),
  platformUptimeSeconds: Number(stats?.platform_uptime_seconds ?? 0),
  platformUptimeStartedAt: stats?.platform_uptime_started_at ?? new Date(SERVER_START_TIME).toISOString(),
});

const toRoutingStats = (result) => ({
  interval: String(result?.interval || 'day').toUpperCase(),
  startDate: result?.startDate ?? null,
  endDate: result?.endDate ?? null,
  totalVolume: Number(result?.summary?.total_volume ?? 0),
  totalFees: Number(result?.summary?.total_fees ?? 0),
  totalCount: Number(result?.summary?.total_count ?? 0),
  data: (result?.data || []).map((bucket) => ({
    period: bucket.period,
    volume: Number(bucket.volume ?? 0),
    fees: Number(bucket.fees ?? 0),
    count: Number(bucket.count ?? 0),
  })),
});

/** Runs a probe and reports `up` / `down` rather than throwing. */
const probe = async (check) => {
  try {
    await check();
    return 'up';
  } catch {
    return 'down';
  }
};

const Query = {
  user: (_root, { username }, context) =>
    context.loaders.userByUsername.load(normalizeUsername(username)),

  userByAddress: (_root, { address }, context) =>
    context.loaders.userByAddress.load(address),

  users: async (_root, args, context) => {
    const where = buildUserWhere(args.filter);
    const { page, limit, skip } = paginationFromArgs(args.pagination);
    const orderBy = buildUserOrderBy(args.orderBy);

    const [totalCount, rows] = await context.prisma.$transaction([
      context.prisma.user.count({ where }),
      context.prisma.user.findMany({ where, orderBy, skip, take: limit }),
    ]);

    return connection(rows, totalCount, { page, limit });
  },

  webhooks: async (_root, _args, context) => {
    const username = context.requireWebhookOwnerUsername(context);
    const owner = await context.requireUsernameOwner(context, username, 'webhook');
    return context.loaders.webhooksByUsername.load(owner.username);
  },

  webhook: async (_root, { id }, context) => {
    const webhook = await context.prisma.webhook.findUnique({ where: { id } });
    if (!webhook) return null;

    await context.requireUsernameOwner(context, webhook.username, 'webhook');
    return webhook;
  },

  payments: async (_root, args, context) => {
    const where = buildPaymentWhere(args.filter);
    const { page, limit, skip } = paginationFromArgs(args.pagination);

    const [totalCount, rows] = await context.prisma.$transaction([
      context.prisma.payment.count({ where }),
      context.prisma.payment.findMany({
        where,
        orderBy: buildPaymentOrderBy(args.orderBy),
        skip,
        take: limit,
      }),
    ]);

    return connection(rows, totalCount, { page, limit });
  },

  payment: (_root, { id }, context) => context.prisma.payment.findUnique({ where: { id } }),

  paymentIntent: (_root, { id }, context) =>
    context.prisma.paymentIntent.findUnique({ where: { id } }),

  paymentIntents: async (_root, args, context) => {
    const where = buildPaymentIntentWhere(args.filter);
    const { page, limit, skip } = paginationFromArgs(args.pagination);

    const [totalCount, rows] = await context.prisma.$transaction([
      context.prisma.paymentIntent.count({ where }),
      context.prisma.paymentIntent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
    ]);

    return connection(rows, totalCount, { page, limit });
  },

  activity: async (_root, args, context) => {
    const owner = await context.requireUsernameOwner(context, args.username, 'activity');
    const { page, limit, skip } = paginationFromArgs(args.pagination);

    const range = dateBounds(args.range);
    const where = {
      username: owner.username,
      ...(range && { createdAt: range }),
    };

    const [totalCount, rows] = await context.prisma.$transaction([
      context.prisma.activityLog.count({ where }),
      context.prisma.activityLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
    ]);

    return connection(rows, totalCount, { page, limit });
  },

  federation: async (_root, { q, type }, context) => {
    const query = typeof q === 'string' ? q.trim() : '';
    if (!query) {
      throw new ApiError('INVALID_INPUT', 'Missing required field: q.');
    }

    if (type === 'ID') {
      return federationLookupCached(federationIdKey(query), async () => {
        const row = await context.prisma.user.findFirst({
          where: { address: { equals: query, mode: 'insensitive' }, deletedAt: null },
          select: { username: true, address: true, memoType: true, memo: true },
          orderBy: PRIMARY_USERNAME_ORDER,
        });
        if (!row) return null;

        return toFederationRecord({
          stellarAddress: row.username.includes('*')
            ? row.username
            : `${row.username}*${federationDomain()}`,
          accountId: row.address,
          memoType: row.memoType,
          memo: row.memo,
        });
      });
    }

    const queryName = normalizeUsername(query);
    if (!queryName) {
      throw new ApiError('INVALID_INPUT', 'Missing required field: q.');
    }

    return federationLookupCached(federationNameKey(queryName), async () => {
      const row = await context.prisma.user.findFirst({
        where: { username: queryName, deletedAt: null },
        select: { username: true, address: true, memoType: true, memo: true },
      });

      const address = row?.address || USER_DATABASE[queryName];
      if (!address) return null;

      return toFederationRecord({
        stellarAddress: row?.username ?? queryName,
        accountId: address,
        memoType: row?.memoType,
        memo: row?.memo,
      });
    });
  },

  platformStats: async (_root, _args, context) => {
    const stats = await getCachedStats(context.redisClient, () =>
      fetchAdminStats(context.prisma, context.poolGet),
    );
    return toPlatformStats(stats);
  },

  routingStats: async (_root, args, context) => {
    const range = dateBounds(args.range);

    const result = await getRoutingStats({
      prisma: context.prisma,
      startDate: range?.gte ? range.gte.toISOString() : undefined,
      endDate: range?.lte ? range.lte.toISOString() : undefined,
      groupBy: args.groupBy ? String(args.groupBy).toLowerCase() : undefined,
      assetCode: args.assetCode ?? undefined,
    });

    return toRoutingStats(result);
  },

  health: async (_root, _args, context) => {
    const [database, redis] = await Promise.all([
      probe(() => context.prisma.$queryRaw`SELECT 1`),
      context.redisClient ? probe(() => context.redisClient.ping()) : Promise.resolve('not configured'),
    ]);

    return {
      status: database === 'up' && redis !== 'down' ? 'UP' : 'DOWN',
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt: new Date(SERVER_START_TIME).toISOString(),
      database,
      redis,
    };
  },
};

module.exports = { Query, toPlatformStats, toRoutingStats, probe };
