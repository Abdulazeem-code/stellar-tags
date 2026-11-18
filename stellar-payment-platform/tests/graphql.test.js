'use strict';

// End-to-end tests for the GraphQL layer mounted on the Express app at
// /graphql. They load the real server.js (with infrastructure mocked, exactly
// as the other server tests do) and drive the endpoint through supertest, so
// they exercise the Apollo-Server-on-Express wiring and the request -> context
// -> resolver auth flow rather than the resolvers in isolation.

const request = require('supertest');

// Admin key and domain are read by buildContext/resolvers at request time.
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.DOMAIN = 'localhost';

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
  Keypair: { fromPublicKey: jest.fn(() => ({ verify: jest.fn(() => true) })) },
}));

jest.mock('pdfkit', () => jest.fn());

jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({
  scheduleSoftDeletePurgeJob: jest.fn(),
}));

// bad-words ships as ESM; mock so resolvers load under Jest's CJS transform.
jest.mock('bad-words', () => jest.fn(() => ({ isProfane: () => false })));

jest.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));

jest.mock('../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn(),
  isSingleSignerAccount: jest.fn(() => true),
}));

jest.mock('sqlite3', () => ({
  verbose: () => ({
    Database: jest.fn().mockImplementation((_path, cb) => {
      const db = {
        run: jest.fn((sql, cb2) => cb2 && cb2(null)),
        close: jest.fn((cb2) => cb2 && cb2()),
      };
      if (cb) cb(null);
      return db;
    }),
  }),
}));

// A mock pooled SQLite connection: run/get/all accept (sql, params, cb) and
// invoke the callback, so src/db.js's promisified wrappers resolve. Without
// this the db init IIFE throws and process.exit(1)s the test process.
const mockDbConn = {
  run: jest.fn((sql, params, cb) => {
    const fn = typeof params === 'function' ? params : cb;
    if (fn) fn.call({ lastID: 0, changes: 0 }, null);
  }),
  get: jest.fn((sql, params, cb) => {
    const fn = typeof params === 'function' ? params : cb;
    if (fn) fn.call({}, null, null);
  }),
  all: jest.fn((sql, params, cb) => {
    const fn = typeof params === 'function' ? params : cb;
    if (fn) fn.call({}, null, []);
  }),
};

jest.mock('generic-pool', () => ({
  createPool: jest.fn(() => ({
    acquire: jest.fn().mockResolvedValue(mockDbConn),
    release: jest.fn(),
    drain: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
  })),
}));

// A Prisma mock exposing every model/method the resolvers touch. Methods are
// Jest mocks so each test can configure return values or rejections.
jest.mock('../prismaClient', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    webhook: {
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  };
  return { prisma, isPrismaConnectionError: jest.fn(() => false) };
});

const { verifyMultiSignerThreshold } = require('../src/multisigner-verifier');
const { prisma } = require('../prismaClient');
const { app, graphQLReady } = require('../server');

const ADMIN_HEADERS = { 'x-api-key': 'test-admin-key' };

const ALICE = {
  username: 'alice*localhost',
  address: 'GALICE000000000000000000000000000000000000000000000000',
  memoType: null,
  memo: null,
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  flaggedAt: null,
  deletedAt: null,
};

const BOB = {
  username: 'bob*localhost',
  address: 'GBOB000000000000000000000000000000000000000000000000000',
  memoType: 'text',
  memo: 'invoice-1',
  createdAt: new Date('2024-01-02T00:00:00.000Z'),
  flaggedAt: null,
  deletedAt: null,
};

/** Posts a GraphQL operation to /graphql and returns the parsed body. */
async function gql(query, { variables, headers } = {}) {
  await graphQLReady;
  const res = await request(app)
    .post('/graphql')
    .set({ 'Content-Type': 'application/json', ...(headers || {}) })
    .send({ query, variables });
  return res.body;
}

const VALID_SIGNER = 'GSIGNER00000000000000000000000000000000000000000000000';

beforeEach(() => {
  jest.clearAllMocks();
  // Default: signature verification succeeds for the register flow.
  verifyMultiSignerThreshold.mockResolvedValue({
    success: true,
    accountId: ALICE.address,
    operationType: 'management',
    requiredThreshold: 1,
    totalWeight: 1,
    signatureCount: 1,
    uniqueSignerCount: 1,
    signerCount: 1,
    errorMessage: null,
  });
  // Default $transaction behaves like Prisma: runs the operations in parallel.
  prisma.$transaction.mockImplementation(async (ops) => Promise.all(ops));
});

describe('GraphQL — Express integration', () => {
  test('/graphql is mounted and serves a valid GraphQL response', async () => {
    const body = await gql('{ __typename }');
    expect(body.data.__typename).toBe('Query');
    expect(body.errors).toBeUndefined();
  });

  test('introspection is available in non-production', async () => {
    const body = await gql('{ __schema { queryType { name } } }');
    expect(body.data.__schema.queryType.name).toBe('Query');
  });
});

describe('GraphQL Query.stats', () => {
  test('returns platform counters', async () => {
    prisma.user.count
      .mockResolvedValueOnce(5) // total
      .mockResolvedValueOnce(3); // active (flaggedAt null)
    const body = await gql(
      '{ stats { totalRegisteredUsers activeTokens platformUptimeSeconds platformUptimeStartedAt } }',
    );
    expect(body.data.stats).toMatchObject({
      totalRegisteredUsers: 5,
      activeTokens: 3,
    });
    expect(body.data.stats.platformUptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('GraphQL Query.users', () => {
  test('returns a paginated page with search', async () => {
    prisma.user.count.mockResolvedValue(1);
    prisma.user.findMany.mockResolvedValue([ALICE]);
    const body = await gql(
      '{ users(search: "alice") { totalCount totalPages currentPage limit data { username address memoType memo isFlagged isDeleted } } }',
    );
    expect(body.data.users.totalCount).toBe(1);
    expect(body.data.users.data).toHaveLength(1);
    expect(body.data.users.data[0]).toMatchObject({
      username: 'alice*localhost',
      isFlagged: false,
      isDeleted: false,
    });
  });

  test('clamps limit to a maximum of 100', async () => {
    prisma.user.count.mockResolvedValue(0);
    prisma.user.findMany.mockResolvedValue([]);
    const body = await gql('{ users(limit: 9999) { limit } }');
    expect(body.data.users.limit).toBe(100);
  });
});

describe('GraphQL Query.user / userByAddress', () => {
  test('user(username) returns the user', async () => {
    prisma.user.findFirst.mockResolvedValue(ALICE);
    const body = await gql('{ user(username: "alice*localhost") { username address federationAddress } }');
    expect(body.data.user.username).toBe('alice*localhost');
    expect(body.data.user.federationAddress).toBe('alice*localhost');
  });

  test('user(username) returns null when not found', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const body = await gql('{ user(username: "nobody*localhost") { username } }');
    expect(body.data.user).toBeNull();
  });

  test('userByAddress resolves via the relation resolver', async () => {
    prisma.user.findFirst.mockResolvedValue(BOB);
    prisma.webhook.findMany.mockResolvedValue([]);
    const body = await gql(
      '{ userByAddress(address: "GBOB") { username memoType memo webhooks { id } } }',
    );
    expect(body.data.userByAddress).toMatchObject({
      username: 'bob*localhost',
      memoType: 'text',
      memo: 'invoice-1',
    });
    expect(prisma.webhook.findMany).toHaveBeenCalled();
  });
});

describe('GraphQL Query.federation', () => {
  test('type=name resolves an address (DB fallback via USER_DATABASE)', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const body = await gql('{ federation(q: "client*localhost", type: "name") { stellarAddress accountId } }');
    expect(body.data.federation.accountId).toMatch(/^G/);
  });

  test('type=name returns null when not found', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const body = await gql('{ federation(q: "ghost*localhost", type: "name") { stellarAddress } }');
    expect(body.data.federation).toBeNull();
  });

  test('type=id returns memo fields and parity stellar_address with REST', async () => {
    prisma.user.findFirst.mockResolvedValue(BOB);
    const body = await gql(
      `{ federation(q: "${BOB.address}", type: "id") { stellarAddress accountId memoType memo } }`,
    );
    expect(body.data.federation).toMatchObject({
      accountId: BOB.address,
      memoType: 'text',
      memo: 'invoice-1',
    });
    expect(body.data.federation.stellarAddress).toBe('bob*localhost*localhost');
  });

  test('rejects an unsupported type with INVALID_INPUT', async () => {
    const body = await gql('{ federation(q: "x", type: "bogus") { stellarAddress } }');
    expect(body.errors[0].extensions.code).toBe('INVALID_INPUT');
  });
});

describe('GraphQL Mutation.registerUser', () => {
  const input = {
    username: 'carol',
    address: 'GCAROL000000000000000000000000000000000000000000000000',
  };

  test('creates a user and returns verification metadata', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      username: 'carol*localhost',
      address: input.address,
      memoType: null,
      memo: null,
      createdAt: new Date(),
      flaggedAt: null,
      deletedAt: null,
    });
    const body = await gql(
      'mutation($i: RegisterUserInput!) { registerUser(input: $i) { ok user { username federationAddress } verification { thresholdMet requiredThreshold } } }',
      { variables: { i: input } },
    );
    expect(body.data.registerUser.ok).toBe(true);
    expect(body.data.registerUser.user.username).toBe('carol*localhost');
    expect(body.data.registerUser.verification.thresholdMet).toBe(true);
  });

  test('409 conflict when address already registered', async () => {
    prisma.user.findFirst.mockResolvedValue(ALICE);
    const body = await gql('mutation($i: RegisterUserInput!) { registerUser(input: $i) { ok } }', {
      variables: { i: input },
    });
    expect(body.errors[0].extensions.code).toBe('CONFLICT');
  });

  test('rejects a secret key (S-prefixed) address', async () => {
    const body = await gql('mutation($i: RegisterUserInput!) { registerUser(input: $i) { ok } }', {
      variables: { i: { username: 'carol', address: 'SSECRETKEY000000000000000000000000000000000' } },
    });
    expect(body.errors[0].extensions.code).toBe('INVALID_INPUT');
    expect(body.errors[0].message).toMatch(/Secret Key/);
  });

  test('rejects a reserved username', async () => {
    const body = await gql('mutation($i: RegisterUserInput!) { registerUser(input: $i) { ok } }', {
      variables: { i: { username: 'admin', address: input.address } },
    });
    expect(body.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  test('UNAUTHENTICATED when signature verification fails', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    verifyMultiSignerThreshold.mockResolvedValue({
      success: false,
      errorMessage: 'below threshold',
      signerCount: 0,
      requiredThreshold: 10,
      totalWeight: 1,
      accountId: input.address,
    });
    const body = await gql('mutation($i: RegisterUserInput!) { registerUser(input: $i) { ok } }', {
      variables: { i: { ...input, signature: VALID_SIGNER } },
    });
    expect(body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});

describe('GraphQL Mutation.unregisterUser', () => {
  test('soft-deletes a user', async () => {
    prisma.user.findFirst.mockResolvedValue(ALICE);
    prisma.user.update.mockResolvedValue({ ...ALICE, deletedAt: new Date() });
    const body = await gql('mutation { unregisterUser(username: "alice*localhost") { ok deleted } }');
    expect(body.data.unregisterUser).toEqual({ ok: true, deleted: true });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: 'alice*localhost' } }),
    );
  });

  test('NOT_FOUND when the user does not exist', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const body = await gql('mutation { unregisterUser(username: "ghost*localhost") { ok } }');
    expect(body.errors[0].extensions.code).toBe('NOT_FOUND');
  });
});

describe('GraphQL Mutation.blockUser — auth context', () => {
  test('refuses without an admin API key (FORBIDDEN)', async () => {
    const body = await gql('mutation { blockUser(address: "GALICE") { username isFlagged } }');
    expect(body.errors[0].extensions.code).toBe('FORBIDDEN');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('blocks the address with a valid admin API key', async () => {
    prisma.user.update.mockResolvedValue({ ...ALICE, flaggedAt: new Date() });
    const body = await gql('mutation { blockUser(address: "GALICE") { username isFlagged } }', {
      headers: ADMIN_HEADERS,
    });
    expect(body.data.blockUser.isFlagged).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { address: 'GALICE' } }),
    );
  });

  test('NOT_FOUND when the address does not exist', async () => {
    const err = new Error('Record not found');
    err.code = 'P2025';
    prisma.user.update.mockRejectedValue(err);
    const body = await gql('mutation { blockUser(address: "GMISSING") { username } }', {
      headers: ADMIN_HEADERS,
    });
    expect(body.errors[0].extensions.code).toBe('NOT_FOUND');
  });
});

describe('GraphQL Webhook operations — auth context', () => {
  test('Query.webhooks as admin lists webhooks (secret omitted)', async () => {
    prisma.user.findUnique.mockResolvedValue(ALICE);
    prisma.webhook.findMany.mockResolvedValue([
      { id: 'wh-1', username: 'alice*localhost', url: 'https://example.com/h', secret: 'topsecret', createdAt: new Date(), lastSentAt: null, failingSince: null },
    ]);
    const body = await gql(
      '{ webhooks(username: "alice*localhost", signature: "x") { id url secret username user { username } } }',
      { headers: ADMIN_HEADERS },
    );
    expect(body.data.webhooks[0].secret).toBeNull();
    expect(body.data.webhooks[0].user.username).toBe('alice*localhost');
  });

  test('Query.webhooks without admin or signature is UNAUTHENTICATED', async () => {
    prisma.user.findUnique.mockResolvedValue(ALICE);
    const body = await gql('{ webhooks(username: "alice*localhost") { id } }');
    expect(body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  test('Query.webhooks for an unregistered user is NOT_FOUND', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const body = await gql('{ webhooks(username: "ghost*localhost", signature: "x") { id } }', {
      headers: ADMIN_HEADERS,
    });
    expect(body.errors[0].extensions.code).toBe('NOT_FOUND');
  });

  test('createWebhook as admin returns the secret once', async () => {
    prisma.user.findUnique.mockResolvedValue(ALICE);
    prisma.webhook.create.mockResolvedValue({
      id: 'wh-2',
      username: 'alice*localhost',
      url: 'https://example.com/hook',
      secret: 'once-only-secret',
      createdAt: new Date(),
      lastSentAt: null,
      failingSince: null,
    });
    const body = await gql(
      'mutation($i: CreateWebhookInput!) { createWebhook(input: $i) { ok note webhook { id url secret username } } }',
      {
        variables: { i: { username: 'alice*localhost', url: 'https://example.com/hook' } },
        headers: ADMIN_HEADERS,
      },
    );
    expect(body.data.createWebhook.webhook.secret).toBe('once-only-secret');
    expect(body.data.createWebhook.note).toMatch(/Save the secret/);
  });

  test('createWebhook rejects an invalid URL', async () => {
    prisma.user.findUnique.mockResolvedValue(ALICE);
    const body = await gql(
      'mutation($i: CreateWebhookInput!) { createWebhook(input: $i) { ok } }',
      {
        variables: { i: { username: 'alice*localhost', url: 'ftp://bad.example.com' } },
        headers: ADMIN_HEADERS,
      },
    );
    expect(body.errors[0].extensions.code).toBe('INVALID_INPUT');
  });

  test('createWebhook reports CONFLICT on a duplicate (P2002)', async () => {
    prisma.user.findUnique.mockResolvedValue(ALICE);
    const err = new Error('Unique constraint');
    err.code = 'P2002';
    prisma.webhook.create.mockRejectedValue(err);
    const body = await gql(
      'mutation($i: CreateWebhookInput!) { createWebhook(input: $i) { ok } }',
      {
        variables: { i: { username: 'alice*localhost', url: 'https://example.com/hook' } },
        headers: ADMIN_HEADERS,
      },
    );
    expect(body.errors[0].extensions.code).toBe('CONFLICT');
  });

  test('deleteWebhook as admin deletes and reports deleted', async () => {
    prisma.user.findUnique.mockResolvedValue(ALICE);
    prisma.webhook.deleteMany.mockResolvedValue({ count: 1 });
    const body = await gql(
      'mutation { deleteWebhook(id: "wh-1", username: "alice*localhost", signature: "x") { ok deleted } }',
      { headers: ADMIN_HEADERS },
    );
    expect(body.data.deleteWebhook).toEqual({ ok: true, deleted: true });
  });

  test('deleteWebhook returns NOT_FOUND when nothing matched', async () => {
    prisma.user.findUnique.mockResolvedValue(ALICE);
    prisma.webhook.deleteMany.mockResolvedValue({ count: 0 });
    const body = await gql(
      'mutation { deleteWebhook(id: "wh-missing", username: "alice*localhost", signature: "x") { ok } }',
      { headers: ADMIN_HEADERS },
    );
    expect(body.errors[0].extensions.code).toBe('NOT_FOUND');
"use strict";

const express = require("express");
const request = require("supertest");
const {
  createGraphQLContext,
  createGraphQLMiddleware,
  createGraphQLServer,
} = require("../src/graphql");

const userRows = [
  {
    username: "alice*stellar.test",
    address: "GALICE",
    isPrimary: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  {
    username: "bob*stellar.test",
    address: "GBOB",
    isPrimary: true,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
  },
];

const paymentRows = [
  {
    id: "payment-1",
    createdAt: new Date("2026-01-03T00:00:00.000Z"),
    fromAddress: "GALICE",
    toAddress: "GBOB",
    amount: 25,
    fee: 0.25,
    assetCode: "USDC",
    transactionHash: "tx-1",
    status: "completed",
  },
  {
    id: "payment-2",
    createdAt: new Date("2026-01-04T00:00:00.000Z"),
    fromAddress: "GBOB",
    toAddress: "GALICE",
    amount: 10,
    fee: 0.1,
    assetCode: "XLM",
    transactionHash: "tx-2",
    status: "completed",
  },
];

const createPrismaMock = () => ({
  user: {
    findUnique: jest.fn(({ where }) =>
      Promise.resolve(userRows.find((user) => user.username === where.username) || null),
    ),
    findMany: jest.fn(({ take } = {}) => Promise.resolve(userRows.slice(0, take))),
  },
  payment: {
    findUnique: jest.fn(({ where }) =>
      Promise.resolve(paymentRows.find((payment) => payment.id === where.id) || null),
    ),
    findMany: jest.fn().mockResolvedValue(paymentRows),
  },
});

const execute = async (server, prisma, query, variables) => {
  const response = await server.executeOperation(
    { query, variables },
    { contextValue: createGraphQLContext(prisma) },
  );
  expect(response.body.kind).toBe("single");
  return response.body.singleResult;
};

describe("federated GraphQL API", () => {
  let server;

  beforeEach(async () => {
    server = createGraphQLServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("publishes federation entity directives", async () => {
    const result = await execute(
      server,
      createPrismaMock(),
      `query SubgraphSchema { _service { sdl } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data._service.sdl).toContain('type User @key(fields: "username")');
    expect(result.data._service.sdl).toContain('type Payment @key(fields: "id")');
    expect(result.data._service.sdl).toContain('type Token @key(fields: "code")');
  });

  it("exposes nested users, payments, and tokens", async () => {
    const prisma = createPrismaMock();
    const result = await execute(
      server,
      prisma,
      `query UsersWithPayments {
        users {
          username
          payments {
            id
            amount
            token { code }
          }
        }
      }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.users).toEqual([
      {
        username: "alice*stellar.test",
        payments: [
          { id: "payment-1", amount: 25, token: { code: "USDC" } },
        ],
      },
      {
        username: "bob*stellar.test",
        payments: [
          { id: "payment-2", amount: 10, token: { code: "XLM" } },
        ],
      },
    ]);
  });

  it("batches nested payment lookups with DataLoader", async () => {
    const prisma = createPrismaMock();
    await execute(
      server,
      prisma,
      `query BatchedUsers { users { username payments { id } } }`,
    );

    expect(prisma.payment.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.payment.findMany).toHaveBeenCalledWith({
      where: { fromAddress: { in: ["GALICE", "GBOB"] } },
      orderBy: { createdAt: "desc" },
    });
  });

  it("serves GraphQL requests through the Express middleware", async () => {
    const app = express();
    const handler = createGraphQLMiddleware({ prismaClient: createPrismaMock() });
    app.use(express.json());
    app.use("/graphql", handler);

    const response = await request(app)
      .post("/graphql")
      .send({ query: "query { users(limit: 1) { username } }" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        users: [
          { username: "alice*stellar.test" },
        ],
      },
    });
    await handler.apolloServer.stop();
  });

  it("rejects queries exceeding the maximum depth limit", async () => {
    const query = `
      query TooDeep {
        user(username: "alice*stellar.test") {
          payments {
            token {
              payments {
                token {
                  payments {
                    token { code }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const response = await server.executeOperation(
      { query },
      { contextValue: createGraphQLContext(createPrismaMock()) }
    );
    expect(response.body.singleResult.errors).toBeDefined();
    expect(response.body.singleResult.errors[0].message).toMatch(/exceeds maximum operation depth/);
  });
});
