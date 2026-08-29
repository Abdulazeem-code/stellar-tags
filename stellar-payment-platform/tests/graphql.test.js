'use strict';

/**
 * GraphQL layer tests.
 *
 * Approach: test the schema + resolvers end-to-end through the Express app
 * using supertest (same style as the existing test suite), with Prisma mocked
 * so no real DB connection is needed.
 *
 * Additional unit-style tests exercise the resolver and context helpers
 * directly to cover auth paths that are hard to trigger via HTTP alone.
 */

const request = require('supertest');

// ── Mocks must be hoisted before any require() calls ─────────────────────

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
  Keypair: { fromPublicKey: jest.fn() },
}));

jest.mock('redis', () => ({
  createClient: jest.fn(() => null),
}));

// ── Prisma mock ────────────────────────────────────────────────────────────

const ALICE = {
  username: 'alice',
  address: 'GABC1234567890ABCDEF',
  memoType: null,
  memo: null,
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  flaggedAt: null,
  deletedAt: null,
};

const ALICE_WEBHOOK = {
  id: 'wh-001',
  username: 'alice',
  url: 'https://example.com/hook',
  secret: 'supersecret',
  createdAt: new Date('2024-01-02T00:00:00.000Z'),
  lastSentAt: null,
  failingSince: null,
};

const mockUser = {
  findFirst: jest.fn(),
  findMany: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  count: jest.fn(),
};

const mockWebhook = {
  findMany: jest.fn(),
  create: jest.fn(),
  deleteMany: jest.fn(),
};

const mockPrisma = {
  user: mockUser,
  webhook: mockWebhook,
  $transaction: jest.fn(),
  $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
};

jest.mock('../prismaClient', () => ({
  prisma: mockPrisma,
  isPrismaConnectionError: jest.fn().mockReturnValue(false),
}));

// ── Mock modules that open real resources ─────────────────────────────────

jest.mock('../src/routes/v1', () => () => require('express').Router());
jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));
jest.mock('../src/db-pool-monitor', () => ({
  schedulePoolMonitoring: jest.fn(() => ({ stop: jest.fn() })),
}));
jest.mock('../src/db', () => ({
  poolGet: jest.fn().mockResolvedValue(null),
  poolRun: jest.fn().mockResolvedValue({ changes: 1 }),
  poolAll: jest.fn().mockResolvedValue([]),
}));

process.env.NODE_ENV = 'test';

// ── App (loaded after mocks) ──────────────────────────────────────────────

let app;
let graphqlServer;

beforeAll(async () => {
  ({ app, graphqlServer } = require('../server'));
  // Wait for the Apollo Server to be fully started before running tests.
  await graphqlServer.ready;
});

afterAll(async () => {
  // Give Apollo a chance to drain before Jest tears down.
  await graphqlServer.server.stop().catch(() => {});
});

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Execute a GraphQL operation against the mounted /graphql endpoint.
 *
 * @param {string} query      GraphQL operation string
 * @param {object} [variables]
 * @param {object} [headers]  Extra request headers (e.g. auth headers)
 */
const gql = (query, variables = {}, headers = {}) =>
  request(app)
    .post('/graphql')
    .set('Content-Type', 'application/json')
    .set(headers)
    .send({ query, variables });

/** Auth headers for "alice" */
const aliceHeaders = {
  'x-user-username': 'alice',
  'x-user-address': ALICE.address,
};

/** Auth headers for an admin */
const adminHeaders = {
  'x-api-key': 'test-admin-key',
};

beforeEach(() => {
  jest.resetAllMocks();  // clears call history AND drains any unqueued Once values
  process.env.ADMIN_API_KEY = 'test-admin-key';

  // Default mock return values — individual tests override as needed.
  mockUser.findFirst.mockResolvedValue(null);
  mockUser.findMany.mockResolvedValue([]);
  mockUser.create.mockResolvedValue(ALICE);
  mockUser.update.mockResolvedValue(ALICE);
  mockUser.count.mockResolvedValue(0);
  mockWebhook.findMany.mockResolvedValue([]);
  mockWebhook.create.mockResolvedValue(ALICE_WEBHOOK);
  mockWebhook.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.$transaction.mockImplementation((queries) =>
    Array.isArray(queries)
      ? Promise.all(queries.map((q) => (typeof q === 'function' ? q() : q)))
      : Promise.all(queries),
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Query: user
// ═══════════════════════════════════════════════════════════════════════════

describe('Query: user', () => {
  const GET_USER = `
    query GetUser($username: ID!) {
      user(username: $username) {
        username
        address
        memoType
        createdAt
      }
    }
  `;

  it('returns a user when found', async () => {
    mockUser.findFirst.mockResolvedValue(ALICE);
    mockWebhook.findMany.mockResolvedValue([]);

    const res = await gql(GET_USER, { username: 'alice' });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.user).toMatchObject({
      username: 'alice',
      address: ALICE.address,
    });
  });

  it('returns null when user not found', async () => {
    mockUser.findFirst.mockResolvedValue(null);

    const res = await gql(GET_USER, { username: 'nobody' });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.user).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Query: users
// ═══════════════════════════════════════════════════════════════════════════

describe('Query: users', () => {
  const LIST_USERS = `
    query ListUsers($search: String, $limit: Int, $offset: Int) {
      users(search: $search, limit: $limit, offset: $offset) {
        username
        address
      }
    }
  `;

  it('returns a list of users', async () => {
    mockUser.findMany.mockResolvedValue([ALICE]);

    const res = await gql(LIST_USERS, {});

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.users).toHaveLength(1);
    expect(res.body.data.users[0].username).toBe('alice');
  });

  it('passes search, limit and offset to Prisma', async () => {
    mockUser.findMany.mockResolvedValue([]);

    await gql(LIST_USERS, { search: 'bob', limit: 5, offset: 10 });

    expect(mockUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 5,
        where: expect.objectContaining({ OR: expect.any(Array) }),
      }),
    );
  });

  it('clamps limit to 100', async () => {
    mockUser.findMany.mockResolvedValue([]);

    await gql(LIST_USERS, { limit: 9999 });

    expect(mockUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Query: usersPage
// ═══════════════════════════════════════════════════════════════════════════

describe('Query: usersPage', () => {
  const USERS_PAGE = `
    query UsersPage($page: Int, $limit: Int) {
      usersPage(page: $page, limit: $limit) {
        totalCount
        page
        limit
        totalPages
        data { username }
      }
    }
  `;

  it('returns pagination metadata', async () => {
    mockPrisma.$transaction.mockResolvedValue([3, [ALICE]]);

    const res = await gql(USERS_PAGE, { page: 1, limit: 2 });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const page = res.body.data.usersPage;
    expect(page.totalCount).toBe(3);
    expect(page.totalPages).toBe(2); // ceil(3/2)
    expect(page.data).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Query: webhooks
// ═══════════════════════════════════════════════════════════════════════════

describe('Query: webhooks', () => {
  const LIST_WEBHOOKS = `
    query ListWebhooks($username: ID) {
      webhooks(username: $username) {
        id
        url
        createdAt
      }
    }
  `;

  it('returns webhooks for the authenticated user', async () => {
    // Context build: findFirst returns alice
    mockUser.findFirst.mockResolvedValue(ALICE);
    mockWebhook.findMany.mockResolvedValue([ALICE_WEBHOOK]);

    const res = await gql(LIST_WEBHOOKS, { username: 'alice' }, aliceHeaders);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.webhooks).toHaveLength(1);
    expect(res.body.data.webhooks[0].url).toBe(ALICE_WEBHOOK.url);
  });

  it('returns UNAUTHENTICATED when no auth headers are supplied', async () => {
    mockUser.findFirst.mockResolvedValue(null); // context: no user

    const res = await gql(LIST_WEBHOOKS, { username: 'alice' });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('returns UNAUTHENTICATED when user tries to list another users webhooks', async () => {
    // Context build returns alice (authenticated as alice).
    // Resolver throws UNAUTHENTICATED before any DB call because alice != bob.
    mockUser.findFirst.mockResolvedValue(ALICE); // context build

    const res = await gql(LIST_WEBHOOKS, { username: 'bob' }, aliceHeaders);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Query: lookupByAddress
// ═══════════════════════════════════════════════════════════════════════════

describe('Query: lookupByAddress', () => {
  const LOOKUP = `
    query LookupByAddress($address: String!) {
      lookupByAddress(address: $address) {
        username
        address
      }
    }
  `;

  it('returns username and address when found', async () => {
    // No auth headers → buildContext skips findFirst entirely.
    // Only the resolver calls findFirst once.
    mockUser.findFirst.mockResolvedValue(ALICE);

    const res = await gql(LOOKUP, { address: ALICE.address });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.lookupByAddress).toMatchObject({
      username: 'alice',
      address: ALICE.address,
    });
  });

  it('returns null when address not found', async () => {
    mockUser.findFirst.mockResolvedValue(null);

    const res = await gql(LOOKUP, { address: 'GUNKNOWN' });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.lookupByAddress).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Query: resolveTag
// ═══════════════════════════════════════════════════════════════════════════

describe('Query: resolveTag', () => {
  const RESOLVE_TAG = `
    query ResolveTag($q: String!, $type: TagLookupType) {
      resolveTag(q: $q, type: $type) {
        stellarAddress
        accountId
        memoType
        memo
      }
    }
  `;

  it('resolves a name tag to a federation entry (type=name)', async () => {
    // No auth headers → buildContext skips findFirst entirely.
    // Only the resolver calls findFirst once.
    mockUser.findFirst.mockResolvedValue(ALICE);

    const res = await gql(RESOLVE_TAG, { q: 'alice', type: 'name' });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const result = res.body.data.resolveTag;
    expect(result.accountId).toBe(ALICE.address);
    expect(result.stellarAddress).toContain('alice');
  });

  it('resolves an address to a federation entry (type=id)', async () => {
    mockUser.findFirst.mockResolvedValue(ALICE);

    const res = await gql(RESOLVE_TAG, { q: ALICE.address, type: 'id' });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.resolveTag.accountId).toBe(ALICE.address);
  });

  it('returns null when the tag is not found', async () => {
    mockUser.findFirst.mockResolvedValue(null);

    const res = await gql(RESOLVE_TAG, { q: 'nobody', type: 'name' });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.resolveTag).toBeNull();
  });

  it('throws FORBIDDEN for a blocked user (type=name)', async () => {
    const flaggedAlice = { ...ALICE, flaggedAt: new Date() };
    mockUser.findFirst.mockResolvedValue(flaggedAlice);

    const res = await gql(RESOLVE_TAG, { q: 'alice', type: 'name' });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Query: stats
// ═══════════════════════════════════════════════════════════════════════════

describe('Query: stats', () => {
  const GET_STATS = `
    query GetStats {
      stats {
        totalRegisteredUsers
        activeTokens
        platformUptimeSeconds
        platformUptimeStartedAt
      }
    }
  `;

  it('returns platform statistics', async () => {
    mockUser.findFirst.mockResolvedValue(null); // context build
    mockPrisma.$transaction.mockResolvedValue([42, 40]);

    const res = await gql(GET_STATS);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    const stats = res.body.data.stats;
    expect(stats.totalRegisteredUsers).toBe(42);
    expect(stats.activeTokens).toBe(40);
    expect(typeof stats.platformUptimeSeconds).toBe('number');
    expect(stats.platformUptimeStartedAt).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mutation: registerUser
// ═══════════════════════════════════════════════════════════════════════════

describe('Mutation: registerUser', () => {
  const REGISTER = `
    mutation RegisterUser($input: RegisterUserInput!) {
      registerUser(input: $input) {
        username
        address
      }
    }
  `;

  it('registers a new user and returns the record', async () => {
    mockUser.findFirst.mockResolvedValue(null); // context build
    mockUser.create.mockResolvedValue(ALICE);

    const res = await gql(REGISTER, {
      input: { username: 'alice', address: ALICE.address },
    });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.registerUser.username).toBe('alice');
    expect(mockUser.create).toHaveBeenCalledTimes(1);
  });

  it('normalises username to lowercase', async () => {
    mockUser.findFirst.mockResolvedValue(null);
    mockUser.create.mockResolvedValue({ ...ALICE, username: 'alice' });

    await gql(REGISTER, { input: { username: 'ALICE', address: ALICE.address } });

    expect(mockUser.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ username: 'alice' }),
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mutation: deleteUser
// ═══════════════════════════════════════════════════════════════════════════

describe('Mutation: deleteUser', () => {
  const DELETE_USER = `
    mutation DeleteUser($username: ID!) {
      deleteUser(username: $username)
    }
  `;

  it('soft-deletes the authenticated user', async () => {
    mockUser.findFirst.mockResolvedValue(ALICE); // context build
    mockUser.update.mockResolvedValue({ ...ALICE, deletedAt: new Date() });

    const res = await gql(DELETE_USER, { username: 'alice' }, aliceHeaders);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.deleteUser).toBe(true);
  });

  it('returns UNAUTHENTICATED when called without auth', async () => {
    mockUser.findFirst.mockResolvedValue(null); // context: no user

    const res = await gql(DELETE_USER, { username: 'alice' });

    expect(res.status).toBe(200);
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mutation: updateUser
// ═══════════════════════════════════════════════════════════════════════════

describe('Mutation: updateUser', () => {
  const UPDATE_USER = `
    mutation UpdateUser($username: ID!, $input: UpdateUserInput!) {
      updateUser(username: $username, input: $input) {
        username
        memoType
        memo
      }
    }
  `;

  it('updates memo fields for the authenticated user', async () => {
    const updated = { ...ALICE, memoType: 'text', memo: 'hello' };
    // findFirst is called twice: context build (returns ALICE) + resolver existence check (returns ALICE).
    // Use mockImplementation so both calls succeed regardless of order.
    mockUser.findFirst.mockResolvedValue(ALICE);
    mockUser.update.mockResolvedValue(updated);

    const res = await gql(
      UPDATE_USER,
      { username: 'alice', input: { memoType: 'text', memo: 'hello' } },
      aliceHeaders,
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.updateUser.memoType).toBe('text');
  });

  it('returns UNAUTHENTICATED when called without auth', async () => {
    mockUser.findFirst.mockResolvedValue(null);

    const res = await gql(
      UPDATE_USER,
      { username: 'alice', input: { memoType: 'text', memo: 'x' } },
    );

    expect(res.status).toBe(200);
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('returns NOT_FOUND when the user does not exist', async () => {
    // Context build: returns ALICE (so the request is authenticated as alice).
    // Resolver existence check: returns null (user not found).
    mockUser.findFirst
      .mockResolvedValueOnce(ALICE)  // context build
      .mockResolvedValueOnce(null);  // resolver existence check

    const res = await gql(
      UPDATE_USER,
      { username: 'alice', input: { memoType: 'text', memo: 'x' } },
      aliceHeaders,
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('NOT_FOUND');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mutation: flagUser
// ═══════════════════════════════════════════════════════════════════════════

describe('Mutation: flagUser', () => {
  const FLAG_USER = `
    mutation FlagUser($username: ID!) {
      flagUser(username: $username) {
        username
        flaggedAt
      }
    }
  `;

  it('flags a user when called by an admin', async () => {
    const flagged = { ...ALICE, flaggedAt: new Date() };
    // Admin context: no x-user-username → context build skips findFirst.
    // Resolver existence check: needs to find ALICE.
    mockUser.findFirst.mockResolvedValue(ALICE);
    mockUser.update.mockResolvedValue(flagged);

    const res = await gql(FLAG_USER, { username: 'alice' }, adminHeaders);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.flagUser.flaggedAt).toBeTruthy();
  });

  it('returns FORBIDDEN when called by a non-admin', async () => {
    mockUser.findFirst.mockResolvedValue(ALICE); // context build returns alice

    const res = await gql(FLAG_USER, { username: 'alice' }, aliceHeaders);

    expect(res.status).toBe(200);
    expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('returns FORBIDDEN when called without any credentials', async () => {
    mockUser.findFirst.mockResolvedValue(null);

    const res = await gql(FLAG_USER, { username: 'alice' });

    expect(res.status).toBe(200);
    expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mutation: createWebhook
// ═══════════════════════════════════════════════════════════════════════════

describe('Mutation: createWebhook', () => {
  const CREATE_WEBHOOK = `
    mutation CreateWebhook($username: ID!, $url: String!) {
      createWebhook(username: $username, url: $url) {
        id
        username
        url
        createdAt
      }
    }
  `;

  it('creates a webhook for the authenticated user', async () => {
    mockUser.findFirst.mockResolvedValue(ALICE); // context build
    mockWebhook.create.mockResolvedValue(ALICE_WEBHOOK);

    const res = await gql(
      CREATE_WEBHOOK,
      { username: 'alice', url: 'https://example.com/hook' },
      aliceHeaders,
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.createWebhook.url).toBe(ALICE_WEBHOOK.url);
    expect(mockWebhook.create).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid URL', async () => {
    mockUser.findFirst.mockResolvedValue(ALICE);

    const res = await gql(
      CREATE_WEBHOOK,
      { username: 'alice', url: 'not-a-url' },
      aliceHeaders,
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('rejects a non-http(s) URL', async () => {
    mockUser.findFirst.mockResolvedValue(ALICE);

    const res = await gql(
      CREATE_WEBHOOK,
      { username: 'alice', url: 'ftp://example.com/hook' },
      aliceHeaders,
    );

    expect(res.status).toBe(200);
    expect(res.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('returns UNAUTHENTICATED when called without auth', async () => {
    mockUser.findFirst.mockResolvedValue(null);

    const res = await gql(
      CREATE_WEBHOOK,
      { username: 'alice', url: 'https://example.com/hook' },
    );

    expect(res.status).toBe(200);
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mutation: deleteWebhook
// ═══════════════════════════════════════════════════════════════════════════

describe('Mutation: deleteWebhook', () => {
  const DELETE_WEBHOOK = `
    mutation DeleteWebhook($id: ID!) {
      deleteWebhook(id: $id)
    }
  `;

  it('deletes the webhook and returns true', async () => {
    mockUser.findFirst.mockResolvedValue(ALICE);
    mockWebhook.deleteMany.mockResolvedValue({ count: 1 });

    const res = await gql(DELETE_WEBHOOK, { id: 'wh-001' }, aliceHeaders);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.deleteWebhook).toBe(true);
  });

  it('returns false when the webhook was not found / not owned', async () => {
    mockUser.findFirst.mockResolvedValue(ALICE);
    mockWebhook.deleteMany.mockResolvedValue({ count: 0 });

    const res = await gql(DELETE_WEBHOOK, { id: 'wh-unknown' }, aliceHeaders);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.deleteWebhook).toBe(false);
  });

  it('returns UNAUTHENTICATED when called without auth', async () => {
    mockUser.findFirst.mockResolvedValue(null);

    const res = await gql(DELETE_WEBHOOK, { id: 'wh-001' });

    expect(res.status).toBe(200);
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Auth context unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe('buildContext', () => {
  let buildContext;

  beforeAll(() => {
    ({ buildContext } = require('../src/graphql/index'));
  });

  it('sets isAdmin = true when the correct ADMIN_API_KEY is supplied', async () => {
    process.env.ADMIN_API_KEY = 'secret-key';
    const ctx = await buildContext({
      req: { headers: { 'x-api-key': 'secret-key' } },
    });
    expect(ctx.isAdmin).toBe(true);
  });

  it('sets isAdmin = false when the key is wrong', async () => {
    process.env.ADMIN_API_KEY = 'secret-key';
    const ctx = await buildContext({
      req: { headers: { 'x-api-key': 'wrong-key' } },
    });
    expect(ctx.isAdmin).toBe(false);
  });

  it('sets isAdmin = false when ADMIN_API_KEY is not configured', async () => {
    delete process.env.ADMIN_API_KEY;
    const ctx = await buildContext({
      req: { headers: { 'x-api-key': 'any-key' } },
    });
    expect(ctx.isAdmin).toBe(false);
  });

  it('resolves the user when matching username + address are provided', async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key';
    mockUser.findFirst.mockResolvedValue(ALICE);

    const ctx = await buildContext({
      req: {
        headers: {
          'x-user-username': 'alice',
          'x-user-address': ALICE.address,
        },
      },
    });

    expect(ctx.user).toMatchObject({ username: 'alice' });
  });

  it('sets user = null when no username header is supplied', async () => {
    const ctx = await buildContext({ req: { headers: {} } });
    expect(ctx.user).toBeNull();
  });
});
