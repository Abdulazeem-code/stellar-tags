'use strict';

/**
 * Tests for the /graphql endpoint.
 *
 * All database and SDK calls are mocked so these tests run without a live
 * PostgreSQL instance.  The test suite:
 *
 *   - Boots Apollo Server via setupGraphQL and then tears it down
 *   - Sends real HTTP requests with supertest
 *   - Covers the primary Query and Mutation operations
 *   - Verifies authentication-gated resolvers return UNAUTHENTICATED
 */

const request = require('supertest');

// ---------------------------------------------------------------------------
// Module mocks — set up before any require() of server.js
// ---------------------------------------------------------------------------

// Prevent Stellar SDK from requiring native ESM
jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: {
    isValidEd25519PublicKey: jest.fn((key) => typeof key === 'string' && key.startsWith('G') && key.length >= 10),
  },
  Keypair: { fromPublicKey: jest.fn() },
}));

// Prisma mock — replace with controllable in-memory state
const mockPrismaUser = {
  findFirst: jest.fn(),
  findMany: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  count: jest.fn(),
};
const mockPrismaWebhook = {
  findMany: jest.fn(),
  create: jest.fn(),
  deleteMany: jest.fn(),
};

jest.mock('../prismaClient', () => ({
  prisma: {
    user: mockPrismaUser,
    webhook: mockPrismaWebhook,
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
  isPrismaConnectionError: jest.fn(() => false),
}));

// SQLite pool mock (fallback path, not exercised in happy-path tests)
jest.mock('../src/db', () => ({
  poolGet: jest.fn().mockResolvedValue(null),
  poolRun: jest.fn().mockResolvedValue({ changes: 1 }),
  poolAll: jest.fn().mockResolvedValue([]),
}));

// v1 routes — return an empty router to avoid registering duplicate routes
jest.mock('../src/routes/v1', () => () => require('express').Router());

// Cache helpers — use pass-through implementations
jest.mock('../src/cache', () => ({
  lookupCached: jest.fn((key, fn) => fn()),
  federationIdKey: jest.fn((v) => `id:${v}`),
  federationNameKey: jest.fn((v) => `name:${v}`),
  federationLookupCached: jest.fn((key, fn) => fn()),
  invalidateFederationCache: jest.fn(),
}));

// ---------------------------------------------------------------------------
// App + GraphQL bootstrap
// ---------------------------------------------------------------------------

const { app, setupGraphQL } = require('../server');

beforeAll(async () => {
  await setupGraphQL();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GQL_URL = '/graphql';

/**
 * Send a GraphQL POST request via supertest.
 *
 * @param {string} query  — GraphQL document string
 * @param {object} [variables]
 * @param {object} [headers]
 */
const gql = (query, variables = {}, headers = {}) =>
  request(app)
    .post(GQL_URL)
    .set('Content-Type', 'application/json')
    .set(headers)
    .send({ query, variables });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_ADDRESS = 'GABC123DEF456GHI789JKL012MNO345PQ';
const VALID_USERNAME = 'alice123*localhost';
const USER_ROW = {
  username: VALID_USERNAME,
  address: VALID_ADDRESS,
  memoType: null,
  memo: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
  flaggedAt: null,
  deletedAt: null,
};

// ---------------------------------------------------------------------------
// Query: user
// ---------------------------------------------------------------------------

describe('Query: user', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns a user when found', async () => {
    mockPrismaUser.findFirst.mockResolvedValueOnce(USER_ROW);

    const res = await gql(`
      query {
        user(username: "alice123") {
          username
          address
          createdAt
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.user).toMatchObject({
      username: VALID_USERNAME,
      address: VALID_ADDRESS,
    });
  });

  it('returns null when user is not found', async () => {
    mockPrismaUser.findFirst.mockResolvedValueOnce(null);

    const res = await gql(`
      query {
        user(username: "nobody") {
          username
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.user).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Query: userByAddress
// ---------------------------------------------------------------------------

describe('Query: userByAddress', () => {
  afterEach(() => jest.clearAllMocks());

  it('resolves a user by valid Stellar address', async () => {
    mockPrismaUser.findFirst.mockResolvedValueOnce(USER_ROW);

    const res = await gql(`
      query ($address: String!) {
        userByAddress(address: $address) {
          username
          address
        }
      }
    `, { address: VALID_ADDRESS });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.userByAddress.username).toBe(VALID_USERNAME);
  });

  it('returns an INVALID_INPUT error for a non-Stellar address', async () => {
    const res = await gql(`
      query {
        userByAddress(address: "notanaddress") {
          username
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// Query: users (paginated)
// ---------------------------------------------------------------------------

describe('Query: users', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns a paginated list of users', async () => {
    mockPrismaUser.$transaction = undefined; // handled by prisma.$transaction mock
    const { prisma } = require('../prismaClient');
    prisma.$transaction.mockResolvedValueOnce([1, [USER_ROW]]);

    const res = await gql(`
      query {
        users(page: 1, limit: 10) {
          data {
            username
            address
          }
          pageInfo {
            total
            page
            limit
            totalPages
          }
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.users.data).toHaveLength(1);
    expect(res.body.data.users.pageInfo.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Query: federation
// ---------------------------------------------------------------------------

describe('Query: federation', () => {
  afterEach(() => jest.clearAllMocks());

  it('resolves a tag to a federation record (type: name)', async () => {
    mockPrismaUser.findFirst.mockResolvedValueOnce(USER_ROW);

    const res = await gql(`
      query {
        federation(q: "alice123", type: "name") {
          stellar_address
          account_id
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.federation.account_id).toBe(VALID_ADDRESS);
  });

  it('returns NOT_FOUND when tag has no registration', async () => {
    mockPrismaUser.findFirst.mockResolvedValueOnce(null);

    const res = await gql(`
      query {
        federation(q: "ghost999", type: "name") {
          stellar_address
          account_id
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('NOT_FOUND');
  });

  it('returns INVALID_INPUT when q is missing', async () => {
    // GraphQL type system will catch the missing required argument
    const res = await gql(`
      query {
        federation(q: "") {
          stellar_address
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Mutation: register
// ---------------------------------------------------------------------------

describe('Mutation: register', () => {
  afterEach(() => jest.clearAllMocks());

  it('registers a new user and returns ok=true', async () => {
    mockPrismaUser.findFirst.mockResolvedValueOnce(null); // no existing address
    mockPrismaUser.create.mockResolvedValueOnce({
      username: 'newuser*localhost',
      address: VALID_ADDRESS,
      memoType: null,
      memo: null,
      createdAt: new Date(),
    });

    const res = await gql(`
      mutation {
        register(username: "newuser", address: "${VALID_ADDRESS}") {
          ok
          username
          address
          federation_address
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.register.ok).toBe(true);
    expect(res.body.data.register.username).toBe('newuser*localhost');
  });

  it('rejects a secret key (starts with S)', async () => {
    const res = await gql(`
      mutation {
        register(username: "baduser", address: "SECRETKEYSTARTSWITHS...") {
          ok
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('INVALID_INPUT');
    expect(res.body.errors[0].message).toContain('Secret Key');
  });

  it('rejects a reserved username', async () => {
    const res = await gql(`
      mutation {
        register(username: "admin", address: "${VALID_ADDRESS}") {
          ok
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('returns CONFLICT when address is already registered', async () => {
    mockPrismaUser.findFirst.mockResolvedValueOnce(USER_ROW); // existing user

    const res = await gql(`
      mutation {
        register(username: "alice456", address: "${VALID_ADDRESS}") {
          ok
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// Mutation: unregister
// ---------------------------------------------------------------------------

describe('Mutation: unregister', () => {
  afterEach(() => jest.clearAllMocks());

  it('soft-deletes an existing user', async () => {
    mockPrismaUser.findFirst.mockResolvedValueOnce(USER_ROW);
    mockPrismaUser.update.mockResolvedValueOnce({ ...USER_ROW, deletedAt: new Date() });

    const res = await gql(`
      mutation {
        unregister(username: "alice123") {
          ok
          deleted
          username
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.unregister.ok).toBe(true);
    expect(res.body.data.unregister.deleted).toBe(true);
  });

  it('returns NOT_FOUND for a non-existent user', async () => {
    mockPrismaUser.findFirst.mockResolvedValueOnce(null);

    const res = await gql(`
      mutation {
        unregister(username: "nobody") {
          ok
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Mutation: createWebhook (auth-gated)
// ---------------------------------------------------------------------------

describe('Mutation: createWebhook (authentication)', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns UNAUTHENTICATED when no x-stellar-address header is present', async () => {
    const res = await gql(`
      mutation {
        createWebhook(username: "alice123", url: "https://example.com/hook") {
          ok
          id
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('returns FORBIDDEN when caller address does not match username owner', async () => {
    mockPrismaUser.findFirst.mockResolvedValueOnce({
      ...USER_ROW,
      address: 'GDIFFERENTADDRESS123456789012345678',
    });

    const res = await gql(
      `mutation {
        createWebhook(username: "alice123", url: "https://example.com/hook") {
          ok
        }
      }`,
      {},
      { 'x-stellar-address': VALID_ADDRESS },
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('creates a webhook for an authenticated owner', async () => {
    // ownership check
    mockPrismaUser.findFirst.mockResolvedValueOnce(USER_ROW);
    mockPrismaWebhook.create.mockResolvedValueOnce({
      id: 'test-uuid-123',
      username: VALID_USERNAME,
      url: 'https://example.com/hook',
      secret: 'hashed-secret',
      createdAt: new Date(),
    });

    const res = await gql(
      `mutation {
        createWebhook(username: "alice123", url: "https://example.com/hook") {
          ok
          id
          url
          secret
          note
        }
      }`,
      {},
      { 'x-stellar-address': VALID_ADDRESS },
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.createWebhook.ok).toBe(true);
    expect(res.body.data.createWebhook.secret).toBeDefined();
    expect(res.body.data.createWebhook.note).toContain('secret');
  });

  it('rejects invalid webhook URLs', async () => {
    const res = await gql(
      `mutation {
        createWebhook(username: "alice123", url: "ftp://bad-protocol.example") {
          ok
        }
      }`,
      {},
      { 'x-stellar-address': VALID_ADDRESS },
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// Query: webhooks (auth-gated)
// ---------------------------------------------------------------------------

describe('Query: webhooks (authentication)', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns UNAUTHENTICATED when no header is provided', async () => {
    const res = await gql(`
      query {
        webhooks(username: "alice123") {
          id
          url
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('lists webhooks for an authenticated owner', async () => {
    // ownership check
    mockPrismaUser.findFirst.mockResolvedValueOnce(USER_ROW);
    mockPrismaWebhook.findMany.mockResolvedValueOnce([
      {
        id: 'webhook-1',
        username: VALID_USERNAME,
        url: 'https://example.com/hook',
        createdAt: new Date(),
        lastSentAt: null,
        failingSince: null,
      },
    ]);

    const res = await gql(
      `query {
        webhooks(username: "alice123") {
          id
          url
        }
      }`,
      {},
      { 'x-stellar-address': VALID_ADDRESS },
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.webhooks).toHaveLength(1);
    expect(res.body.data.webhooks[0].url).toBe('https://example.com/hook');
  });
});

// ---------------------------------------------------------------------------
// Mutation: deleteWebhook (auth-gated)
// ---------------------------------------------------------------------------

describe('Mutation: deleteWebhook (authentication)', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns UNAUTHENTICATED when no header is provided', async () => {
    const res = await gql(`
      mutation {
        deleteWebhook(id: "some-id", username: "alice123") {
          ok
          deleted
        }
      }
    `);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('deletes a webhook owned by the authenticated user', async () => {
    mockPrismaUser.findFirst.mockResolvedValueOnce(USER_ROW);
    mockPrismaWebhook.deleteMany.mockResolvedValueOnce({ count: 1 });

    const res = await gql(
      `mutation {
        deleteWebhook(id: "webhook-1", username: "alice123") {
          ok
          deleted
        }
      }`,
      {},
      { 'x-stellar-address': VALID_ADDRESS },
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.deleteWebhook.ok).toBe(true);
    expect(res.body.data.deleteWebhook.deleted).toBe(true);
  });

  it('returns NOT_FOUND when the webhook does not exist', async () => {
    mockPrismaUser.findFirst.mockResolvedValueOnce(USER_ROW);
    mockPrismaWebhook.deleteMany.mockResolvedValueOnce({ count: 0 });

    const res = await gql(
      `mutation {
        deleteWebhook(id: "missing-id", username: "alice123") {
          ok
        }
      }`,
      {},
      { 'x-stellar-address': VALID_ADDRESS },
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Introspection / endpoint availability
// ---------------------------------------------------------------------------

describe('GraphQL endpoint availability', () => {
  it('responds to an introspection query', async () => {
    const res = await gql('{ __typename }');
    expect(res.status).toBe(200);
    expect(res.body.data.__typename).toBe('Query');
  });

  it('returns a 400-level error for a malformed query', async () => {
    const res = await request(app)
      .post(GQL_URL)
      .set('Content-Type', 'application/json')
      .send({ query: '{ this is not valid graphql !!!!' });

    expect(res.status).toBe(400);
  });
});
