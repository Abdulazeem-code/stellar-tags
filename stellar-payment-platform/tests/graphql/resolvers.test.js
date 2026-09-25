'use strict';

/**
 * #685 — Resolver behaviour, executed against a real schema.
 *
 * Operations are run through `graphql()` rather than by calling resolvers
 * directly, so argument coercion, the default resolver, and the custom scalars
 * are all exercised the way a client would hit them.
 */

const { graphql } = require('graphql');
const { makeSchema } = require('../../src/graphql/schema');
const { typeDefs } = require('../../src/graphql/typeDefs');
const resolvers = require('../../src/graphql/resolvers');
const { createLoaders } = require('../../src/graphql/loaders');
const { normalizeUsername } = require('../../src/graphql/resolvers/helpers');
const { createFakePrisma } = require('./support/fakePrisma');

const schema = makeSchema({ typeDefs, resolvers });

const ALICE = 'G_ALICE_ADDRESS';
const BOB = 'G_BOB_ADDRESS';

const user = (name, address, extra = {}) => ({
  username: name,
  address,
  isPrimary: true,
  memoType: null,
  memo: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  flaggedAt: null,
  deletedAt: null,
  ...extra,
});

/**
 * A context shaped like the one `createContext` builds, with the two ownership
 * hooks stubbed so the read paths can be tested without signing anything.
 *
 * The stub normalizes the way the real hook does, so a resolver that trusts the
 * hook's return value sees the same shape it would see in production.
 */
const makeContext = (prisma, overrides = {}) => ({
  prisma,
  redisClient: null,
  poolGet: null,
  loaders: createLoaders(prisma),
  viewer: null,
  correlationId: null,
  requireUsernameOwner: jest.fn(async (_context, username) => ({
    username: normalizeUsername(username),
    address: ALICE,
  })),
  requireWebhookOwnerUsername: jest.fn(() => 'alice*localhost'),
  ...overrides,
});

const run = (source, context, variableValues) =>
  graphql({ schema, source, contextValue: context, variableValues });

describe('Query.users', () => {
  const seed = () => ({
    users: [
      user('alice*localhost', ALICE, { createdAt: new Date('2026-03-01T00:00:00.000Z') }),
      user('bob*localhost', BOB, { createdAt: new Date('2026-02-01T00:00:00.000Z') }),
      user('carol*localhost', 'G_CAROL', { createdAt: new Date('2026-01-01T00:00:00.000Z') }),
    ],
  });

  it('returns a page with totals', async () => {
    const prisma = createFakePrisma(seed());
    const result = await run(
      '{ users(pagination: { page: 1, limit: 2 }) { nodes { username } totalCount currentPage totalPages hasNextPage } }',
      makeContext(prisma),
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.users.totalCount).toBe(3);
    expect(result.data.users.currentPage).toBe(1);
    expect(result.data.users.totalPages).toBe(2);
    expect(result.data.users.hasNextPage).toBe(true);
    expect(result.data.users.nodes.map((n) => n.username)).toEqual([
      'alice*localhost',
      'bob*localhost',
    ]);
  });

  it('defaults to the newest first, page one, ten per page', async () => {
    const prisma = createFakePrisma(seed());
    const result = await run('{ users { nodes { username } } }', makeContext(prisma));

    expect(result.data.users.nodes).toHaveLength(3);
    expect(result.data.users.nodes[0].username).toBe('alice*localhost');
  });

  it('honours an explicit username ordering', async () => {
    const prisma = createFakePrisma(seed());
    const result = await run(
      '{ users(orderBy: [{ field: USERNAME, direction: ASC }]) { nodes { username } } }',
      makeContext(prisma),
    );

    expect(result.data.users.nodes.map((n) => n.username)).toEqual([
      'alice*localhost',
      'bob*localhost',
      'carol*localhost',
    ]);
  });

  it('filters by search across username and address', async () => {
    const prisma = createFakePrisma(seed());
    const result = await run(
      '{ users(filter: { search: "bob" }) { nodes { username } totalCount } }',
      makeContext(prisma),
    );

    expect(result.data.users.totalCount).toBe(1);
    expect(result.data.users.nodes[0].username).toBe('bob*localhost');
  });

  it('hides soft-deleted accounts unless asked for them', async () => {
    const prisma = createFakePrisma({
      users: [user('gone*localhost', ALICE, { deletedAt: new Date('2026-04-01T00:00:00.000Z') })],
    });

    const hidden = await run('{ users { totalCount } }', makeContext(prisma));
    expect(hidden.data.users.totalCount).toBe(0);

    const shown = await run('{ users(filter: { includeDeleted: true }) { totalCount } }', makeContext(prisma));
    expect(shown.data.users.totalCount).toBe(1);
  });

  it('caps limit at 100', async () => {
    const prisma = createFakePrisma(seed());
    const result = await run(
      '{ users(pagination: { limit: 5000 }) { nodes { username } } }',
      makeContext(prisma),
    );

    expect(result.errors).toBeUndefined();
    expect(prisma.__callsTo('user', 'findMany')[0].args.take).toBe(100);
  });
});

describe('Query.user / userByAddress', () => {
  it('normalises a bare name to the stored name tag', async () => {
    const prisma = createFakePrisma({ users: [user('alice*localhost', ALICE)] });
    const result = await run('{ user(username: "Alice") { username address } }', makeContext(prisma));

    expect(result.errors).toBeUndefined();
    expect(prisma.__callsTo('user', 'findMany')[0].args.where).toEqual({
      username: { in: ['alice*localhost'] },
    });
    expect(result.data.user).toEqual({ username: 'alice*localhost', address: ALICE });
  });

  it('returns null for an unknown account', async () => {
    const prisma = createFakePrisma({ users: [] });
    const result = await run('{ user(username: "nobody") { username } }', makeContext(prisma));

    expect(result.errors).toBeUndefined();
    expect(result.data.user).toBeNull();
  });

  it('resolves an address to its primary username', async () => {
    const prisma = createFakePrisma({ users: [user('alice*localhost', ALICE)] });
    const result = await run(
      '{ userByAddress(address: "' + ALICE + '") { username address } }',
      makeContext(prisma),
    );

    expect(result.data.userByAddress.address).toBe(ALICE);
  });
});

describe('nested relations do not cause N+1', () => {
  it('resolves every relation for a page of users in a fixed number of queries', async () => {
    const users = Array.from({ length: 25 }, (_, index) =>
      user(`user${index}*localhost`, `G_ADDRESS_${index}`, {
        createdAt: new Date(2026, 0, index + 1),
      }),
    );
    const webhooks = users.flatMap((row) => [
      { id: `w-${row.username}`, username: row.username, url: 'https://x.test', events: ['*'], createdAt: new Date(), lastSentAt: null, failingSince: null },
    ]);
    const activityLogs = users.map((row) => ({
      id: `a-${row.username}`,
      username: row.username,
      action: 'user.registered',
      metadata: null,
      ipAddress: null,
      createdAt: new Date(),
    }));
    const payments = users.map((row) => ({
      id: `p-${row.username}`,
      createdAt: new Date(),
      fromAddress: row.address,
      toAddress: 'G_SINK',
      amount: 2,
      fee: 0.0001,
      assetCode: 'XLM',
      transactionHash: null,
      status: 'completed',
    }));

    const prisma = createFakePrisma({ users, webhooks, activityLogs, payments });

    const result = await run(
      `{
        users(pagination: { limit: 25 }) {
          nodes {
            username
            webhooks { id }
            webhookCount
            activityCount
            activity(limit: 5) { id }
            paymentStats { totalCount totalAmount receivedCount }
          }
        }
      }`,
      makeContext(prisma),
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.users.nodes).toHaveLength(25);
    expect(result.data.users.nodes[0].webhooks).toHaveLength(1);
    expect(result.data.users.nodes[0].webhookCount).toBe(1);
    expect(result.data.users.nodes[0].activityCount).toBe(1);
    expect(result.data.users.nodes[0].paymentStats).toEqual({
      totalCount: 1,
      totalAmount: 2,
      receivedCount: 0,
    });

    // One query per relation for the whole page — not one per user.
    expect(prisma.__callsTo('user', 'findMany')).toHaveLength(1);
    expect(prisma.__callsTo('webhook', 'findMany')).toHaveLength(1);
    expect(prisma.__callsTo('webhook', 'groupBy')).toHaveLength(1);
    expect(prisma.__callsTo('activityLog', 'findMany')).toHaveLength(1);
    expect(prisma.__callsTo('activityLog', 'groupBy')).toHaveLength(1);
    // Two: one GROUP BY for sent totals, one for received.
    expect(prisma.__callsTo('payment', 'groupBy')).toHaveLength(2);

    const totalQueries = prisma.__calls.length;
    expect(totalQueries).toBeLessThanOrEqual(10);
  });

  it('batches the account behind a payment across a payment list', async () => {
    const prisma = createFakePrisma({
      users: [user('alice*localhost', ALICE), user('bob*localhost', BOB)],
      payments: [
        { id: 'p1', createdAt: new Date(), fromAddress: ALICE, toAddress: BOB, amount: 1, fee: 0, assetCode: null, transactionHash: null, status: 'completed' },
        { id: 'p2', createdAt: new Date(), fromAddress: BOB, toAddress: ALICE, amount: 2, fee: 0, assetCode: null, transactionHash: null, status: 'completed' },
      ],
    });

    const result = await run(
      '{ payments { nodes { id toUser { username } fromUser { username } } } }',
      makeContext(prisma),
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.payments.nodes[0].toUser.username).toBe('bob*localhost');
    expect(prisma.__callsTo('user', 'findMany')).toHaveLength(1);
  });
});

describe('Query.webhooks', () => {
  const seed = () => ({
    webhooks: [
      { id: 'w1', username: 'alice*localhost', url: 'https://a.test', secret: 'shh', events: ['payment.completed'], createdAt: new Date(), lastSentAt: null, failingSince: null },
      { id: 'w2', username: 'alice*localhost', url: 'https://b.test', secret: 'shh', events: '*', createdAt: new Date(), lastSentAt: null, failingSince: new Date() },
    ],
  });

  it('returns the caller webhooks and never the secret', async () => {
    const prisma = createFakePrisma(seed());
    const result = await run(
      '{ webhooks { id url events isFailing } }',
      makeContext(prisma),
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.webhooks.map((w) => w.id)).toEqual(['w1', 'w2']);
    expect(result.data.webhooks[1].isFailing).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain('shh');
  });

  it('coerces a serialised event filter to an array', async () => {
    const prisma = createFakePrisma({
      webhooks: [{ id: 'w1', username: 'alice*localhost', url: 'https://a.test', events: '["*"]', createdAt: new Date(), lastSentAt: null, failingSince: null }],
    });
    const result = await run('{ webhooks { events } }', makeContext(prisma));

    expect(result.data.webhooks[0].events).toEqual(['*']);
  });

  it('surfaces an unauthenticated caller as an error', async () => {
    const prisma = createFakePrisma(seed());
    const { ApiError } = require('../../src/errors');
    const context = makeContext(prisma, {
      requireWebhookOwnerUsername: () => {
        throw new ApiError('UNAUTHENTICATED', 'no credentials');
      },
    });

    const result = await run('{ webhooks { id } }', context);

    expect(result.data.webhooks).toBeNull();
    expect(result.errors[0].originalError.code).toBe('UNAUTHENTICATED');
  });
});

describe('Query.webhook', () => {
  const webhook = (id, username) => ({
    id,
    username,
    url: 'https://a.test',
    events: ['*'],
    createdAt: new Date(),
    lastSentAt: null,
    failingSince: null,
  });

  it('returns null when the webhook does not exist', async () => {
    const prisma = createFakePrisma({ webhooks: [] });
    const result = await run('{ webhook(id: "missing") { id } }', makeContext(prisma));

    expect(result.errors).toBeUndefined();
    expect(result.data.webhook).toBeNull();
  });

  it('checks ownership before returning one', async () => {
    const prisma = createFakePrisma({ webhooks: [webhook('w1', 'bob*localhost')] });
    const { ApiError } = require('../../src/errors');
    const requireUsernameOwner = jest.fn(async () => {
      throw new ApiError('FORBIDDEN', 'not yours');
    });

    const result = await run('{ webhook(id: "w1") { id } }', makeContext(prisma, { requireUsernameOwner }));

    expect(result.data.webhook).toBeNull();
    expect(result.errors[0].originalError.code).toBe('FORBIDDEN');
    expect(requireUsernameOwner).toHaveBeenCalledWith(expect.anything(), 'bob*localhost', 'webhook');
  });
});

describe('Query.activity', () => {
  it('returns the caller trail newest first', async () => {
    const prisma = createFakePrisma({
      activityLogs: [
        { id: 'a1', username: 'alice*localhost', action: 'user.registered', metadata: { a: 1 }, ipAddress: '127.0.0.1', createdAt: new Date('2026-01-01T00:00:00.000Z') },
        { id: 'a2', username: 'alice*localhost', action: 'user.transferred', metadata: null, ipAddress: null, createdAt: new Date('2026-02-01T00:00:00.000Z') },
      ],
    });

    const result = await run('{ activity(username: "alice") { nodes { id action metadata } totalCount } }', makeContext(prisma));

    expect(result.errors).toBeUndefined();
    expect(result.data.activity.nodes.map((n) => n.id)).toEqual(['a2', 'a1']);
    expect(result.data.activity.nodes[1].metadata).toEqual({ a: 1 });
    expect(result.data.activity.totalCount).toBe(2);
  });

  it('scopes the query to the verified owner, not the argument', async () => {
    const prisma = createFakePrisma({ activityLogs: [] });
    const context = makeContext(prisma);

    await run('{ activity(username: "alice") { totalCount } }', context);

    expect(context.requireUsernameOwner).toHaveBeenCalledWith(expect.anything(), 'alice', 'activity');
    expect(prisma.__callsTo('activityLog', 'count')[0].args.where).toEqual({
      username: 'alice*localhost',
    });
  });

  it('applies a date range', async () => {
    const prisma = createFakePrisma({ activityLogs: [] });
    await run(
      '{ activity(username: "alice", range: { startDate: "2026-01-01", endDate: "2026-01-31" }) { totalCount } }',
      makeContext(prisma),
    );

    const where = prisma.__callsTo('activityLog', 'count')[0].args.where;
    expect(where.createdAt.gte.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(where.createdAt.lte.toISOString()).toBe('2026-01-31T23:59:59.999Z');
  });

  it('rejects a range that ends before it starts', async () => {
    const prisma = createFakePrisma({ activityLogs: [] });
    const result = await run(
      '{ activity(username: "alice", range: { startDate: "2026-02-01", endDate: "2026-01-01" }) { totalCount } }',
      makeContext(prisma),
    );

    expect(result.errors[0].originalError.code).toBe('INVALID_INPUT');
  });
});

describe('Query.payments', () => {
  const payment = (id, extra = {}) => ({
    id,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    fromAddress: ALICE,
    toAddress: BOB,
    amount: 10,
    fee: 0.0001,
    assetCode: 'XLM',
    transactionHash: 'abc',
    status: 'completed',
    ...extra,
  });

  it('filters by counterparty, status and amount', async () => {
    const prisma = createFakePrisma({
      payments: [payment('p1'), payment('p2', { toAddress: 'G_OTHER', amount: 100, status: 'failed' })],
    });

    const result = await run(
      `{ payments(filter: { toAddress: "${BOB}", status: "completed", minAmount: 1, maxAmount: 50 }) {
           nodes { id } totalCount
         } }`,
      makeContext(prisma),
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.payments.nodes.map((n) => n.id)).toEqual(['p1']);
  });

  it('fetches a single payment by id', async () => {
    const prisma = createFakePrisma({ payments: [payment('p1')] });
    const result = await run('{ payment(id: "p1") { id amount assetCode } }', makeContext(prisma));

    expect(result.data.payment).toEqual({ id: 'p1', amount: 10, assetCode: 'XLM' });
  });
});

describe('Query.paymentIntents', () => {
  const intent = (id, extra = {}) => ({
    id,
    externalId: `ext-${id}`,
    from: ALICE,
    to: BOB,
    amount: '100',
    asset: 'XLM',
    memoType: null,
    memo: null,
    metadata: { order: 7 },
    status: 'pending',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...extra,
  });

  it('lists intents with their JSON metadata intact', async () => {
    const prisma = createFakePrisma({ paymentIntents: [intent('i1')] });
    const result = await run(
      '{ paymentIntents { nodes { id amount metadata status } totalCount } }',
      makeContext(prisma),
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.paymentIntents.nodes[0].metadata).toEqual({ order: 7 });
  });

  it('filters by status', async () => {
    const prisma = createFakePrisma({
      paymentIntents: [intent('i1'), intent('i2', { status: 'settled' })],
    });
    const result = await run(
      '{ paymentIntents(filter: { status: "settled" }) { nodes { id } } }',
      makeContext(prisma),
    );

    expect(result.data.paymentIntents.nodes.map((n) => n.id)).toEqual(['i2']);
  });
});

describe('Query.platformStats', () => {
  it('maps the cached snake_case payload onto the schema', async () => {
    const prisma = createFakePrisma({
      users: [user('alice*localhost', ALICE), user('bob*localhost', BOB, { flaggedAt: new Date() })],
    });

    const result = await run(
      '{ platformStats { totalRegisteredUsers activeTokens platformUptimeStartedAt } }',
      makeContext(prisma),
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.platformStats.totalRegisteredUsers).toBe(2);
    expect(result.data.platformStats.activeTokens).toBe(1);
    expect(typeof result.data.platformStats.platformUptimeStartedAt).toBe('string');
  });
});

describe('Query.routingStats', () => {
  it('aggregates by the requested interval', async () => {
    const prisma = createFakePrisma({
      payments: [
        { id: 'p1', createdAt: new Date('2026-01-01T10:00:00.000Z'), fromAddress: ALICE, toAddress: BOB, amount: 10, fee: 0.0001, assetCode: 'XLM', transactionHash: null, status: 'completed' },
        { id: 'p2', createdAt: new Date('2026-01-02T10:00:00.000Z'), fromAddress: ALICE, toAddress: BOB, amount: 5, fee: 0.0002, assetCode: 'XLM', transactionHash: null, status: 'completed' },
      ],
    });

    const result = await run(
      '{ routingStats(groupBy: MONTH) { interval totalVolume totalFees totalCount data { period volume count } } }',
      makeContext(prisma),
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.routingStats.interval).toBe('MONTH');
    expect(result.data.routingStats.totalVolume).toBe(15);
    expect(result.data.routingStats.totalCount).toBe(2);
    expect(result.data.routingStats.data).toEqual([
      { period: '2026-01', volume: 15, count: 2 },
    ]);
  });

  it('defaults to daily buckets', async () => {
    const prisma = createFakePrisma({ payments: [] });
    const result = await run('{ routingStats { interval data { period } } }', makeContext(prisma));

    expect(result.data.routingStats.interval).toBe('DAY');
    expect(result.data.routingStats.data).toEqual([]);
  });
});

describe('Query.federation', () => {
  it('resolves a name tag to an account', async () => {
    const prisma = createFakePrisma({
      users: [user('alice*localhost', ALICE, { memoType: 'text', memo: 'hi' })],
    });

    const result = await run(
      '{ federation(q: "alice") { stellarAddress accountId memoType memo } }',
      makeContext(prisma),
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.federation).toEqual({
      stellarAddress: 'alice*localhost',
      accountId: ALICE,
      memoType: 'text',
      memo: 'hi',
    });
  });

  it('resolves an address back to its primary name tag', async () => {
    const prisma = createFakePrisma({ users: [user('alice*localhost', ALICE)] });

    const result = await run(
      `{ federation(q: "${ALICE}", type: ID) { stellarAddress accountId } }`,
      makeContext(prisma),
    );

    expect(result.data.federation).toEqual({
      stellarAddress: 'alice*localhost',
      accountId: ALICE,
    });
  });

  it('returns null for an unknown name', async () => {
    const prisma = createFakePrisma({ users: [] });
    const result = await run('{ federation(q: "nobody-here") { accountId } }', makeContext(prisma));

    expect(result.errors).toBeUndefined();
    expect(result.data.federation).toBeNull();
  });

  it('rejects an empty query', async () => {
    const prisma = createFakePrisma({ users: [] });
    const result = await run('{ federation(q: "   ") { accountId } }', makeContext(prisma));

    expect(result.errors[0].originalError.code).toBe('INVALID_INPUT');
  });
});

describe('Query.health', () => {
  it('reports the database as up', async () => {
    const prisma = createFakePrisma({});
    const result = await run('{ health { status database redis uptimeSeconds } }', makeContext(prisma));

    expect(result.errors).toBeUndefined();
    expect(result.data.health.status).toBe('UP');
    expect(result.data.health.database).toBe('up');
    expect(result.data.health.redis).toBe('not configured');
  });

  it('reports DOWN when the database probe fails', async () => {
    const prisma = createFakePrisma({});
    prisma.$queryRaw = () => Promise.reject(new Error('connection refused'));

    const result = await run('{ health { status database } }', makeContext(prisma));

    expect(result.data.health.status).toBe('DOWN');
    expect(result.data.health.database).toBe('down');
  });
});

describe('User derived fields', () => {
  it('builds the federation address for a name without a domain', async () => {
    const prisma = createFakePrisma({ users: [user('alice*localhost', ALICE)] });
    const result = await run('{ user(username: "alice") { federationAddress } }', makeContext(prisma));

    expect(result.data.user.federationAddress).toBe('alice*localhost');
  });

  it('leaves a fully qualified name alone', async () => {
    const prisma = createFakePrisma({ users: [user('alice*stellar.test', ALICE)] });
    const result = await run('{ user(username: "alice*stellar.test") { federationAddress } }', makeContext(prisma));

    expect(result.data.user.federationAddress).toBe('alice*stellar.test');
  });
});

describe('schema behaviour', () => {
  it('rejects an unknown field', async () => {
    const result = await run('{ users { nope } }', makeContext(createFakePrisma({})));

    expect(result.errors[0].message).toMatch(/Cannot query field "nope"/);
  });

  it('coerces a variable through the input types', async () => {
    const prisma = createFakePrisma({ users: [user('alice*localhost', ALICE)] });
    const result = await run(
      'query Q($filter: UserFilter, $pagination: PaginationArgs) { users(filter: $filter, pagination: $pagination) { totalCount } }',
      makeContext(prisma),
      { filter: { search: 'alice' }, pagination: { limit: 5 } },
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.users.totalCount).toBe(1);
  });
});
