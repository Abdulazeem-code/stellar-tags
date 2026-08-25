'use strict';

/**
 * tests/graphql.test.js
 *
 * Integration tests for the Apollo Server GraphQL endpoint mounted at /graphql.
 * These tests use supertest against the Express app with Prisma and the Stellar
 * SDK mocked so no real database or network connection is needed.
 *
 * Coverage:
 *   Queries  : serverTime, listUsers, getUser, lookupUser, federation
 *   Mutations: registerUser, deleteUser
 *   Context  : X-Stellar-Address header forwarded to context
 *   Errors   : NOT_FOUND, INVALID_INPUT, CONFLICT (via resolver error mapping)
 */

const request = require('supertest');

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: {
    isValidEd25519PublicKey: jest.fn(() => true),
  },
  Keypair: {
    fromPublicKey: jest.fn(() => ({
      verify: jest.fn(() => true),
    })),
  },
}));

jest.mock('redis', () => ({
  createClient: jest.fn(() => null),
}));

// Stable fake user row returned by the mock Prisma client.
const FAKE_USER = {
  username: 'alice*localhost',
  address: 'GABC1234567890ALICE',
  memoType: null,
  memo: null,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  flaggedAt: null,
  deletedAt: null,
};

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  webhook: {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    deleteMany: jest.fn(),
  },
  $transaction: jest.fn(),
  $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  $disconnect: jest.fn(),
};

jest.mock('../prismaClient', () => ({
  prisma: mockPrisma,
  isPrismaConnectionError: jest.fn().mockReturnValue(false),
}));

jest.mock('../src/db', () => ({
  poolGet: jest.fn().mockResolvedValue(null),
  poolRun: jest.fn().mockResolvedValue({ changes: 1 }),
  poolAll: jest.fn().mockResolvedValue([]),
}));

// v1 routes are a factory; return an empty router so the app loads.
jest.mock('../src/routes/v1', () => () => require('express').Router());

// Multisigner verifier is called by registerUser when a signature is supplied.
jest.mock('../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn().mockResolvedValue({ success: true }),
}));

// ── App bootstrap ──────────────────────────────────────────────────────────

process.env.NODE_ENV = 'test';
process.env.DOMAIN = 'localhost';

// Mount GraphQL on the Express app before any tests run.
// We import mountGraphQL and the app separately so we can await the async
// mount without spawning a real HTTP server.
let app;

beforeAll(async () => {
  // Import server module (which does NOT call app.listen in test mode because
  // require.main !== module) so that 'app' is exported.
  const serverModule = require('../server');
  app = serverModule.app;

  // Mount the GraphQL endpoint.
  const { mountGraphQL } = require('../src/graphql');
  await mountGraphQL({ app, path: '/graphql' });
});

afterAll(() => {
  // Prevent Jest from hanging on the SQLite pool timers.
  jest.useRealTimers();
});

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * POST a GraphQL operation to /graphql and return the supertest response.
 *
 * @param {string} query     - GraphQL query or mutation string.
 * @param {object} [variables] - Variables map.
 * @param {object} [headers]  - Extra HTTP headers.
 */
const gql = (query, variables = {}, headers = {}) =>
  request(app)
    .post('/graphql')
    .set('Content-Type', 'application/json')
    .set(headers)
    .send({ query, variables });

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GraphQL endpoint /graphql', () => {
  // ── Basic connectivity ────────────────────────────────────────────────

  describe('connectivity', () => {
    it('returns 200 for a well-formed request', async () => {
      const res = await gql('{ serverTime }');
      expect(res.status).toBe(200);
    });

    it('returns the serverTime scalar as an ISO string', async () => {
      const res = await gql('{ serverTime }');
      expect(res.body.errors).toBeUndefined();
      expect(typeof res.body.data.serverTime).toBe('string');
      expect(new Date(res.body.data.serverTime).getTime()).not.toBeNaN();
    });

    it('returns 400 for a completely invalid body', async () => {
      const res = await request(app)
        .post('/graphql')
        .set('Content-Type', 'application/json')
        .send('not-json');
      // Apollo or Express will respond with 400 or 500 for unparseable bodies
      expect([400, 500]).toContain(res.status);
    });
  });

  // ── Query: listUsers ──────────────────────────────────────────────────

  describe('Query.listUsers', () => {
    beforeEach(() => {
      mockPrisma.$transaction.mockResolvedValue([1, [FAKE_USER]]);
    });

    it('returns paginated user list', async () => {
      const res = await gql(`{
        listUsers {
          data { username address federation_address created_at }
          meta { total page limit totalPages }
        }
      }`);

      expect(res.body.errors).toBeUndefined();
      const { data, meta } = res.body.data.listUsers;
      expect(Array.isArray(data)).toBe(true);
      expect(data[0].username).toBe(FAKE_USER.username);
      expect(data[0].federation_address).toContain(FAKE_USER.username);
      expect(meta.total).toBe(1);
      expect(meta.page).toBe(1);
    });

    it('accepts search and pagination variables', async () => {
      mockPrisma.$transaction.mockResolvedValue([0, []]);
      const res = await gql(
        `query ListUsers($search: String, $page: Int, $limit: Int) {
          listUsers(search: $search, page: $page, limit: $limit) {
            data { username }
            meta { total page limit totalPages }
          }
        }`,
        { search: 'nobody', page: 2, limit: 5 },
      );

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.listUsers.data).toHaveLength(0);
      expect(res.body.data.listUsers.meta.page).toBe(2);
      expect(res.body.data.listUsers.meta.limit).toBe(5);
    });
  });

  // ── Query: getUser ────────────────────────────────────────────────────

  describe('Query.getUser', () => {
    it('returns the user when found', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(FAKE_USER);

      const res = await gql(
        `query GetUser($username: String!) { getUser(username: $username) { username address } }`,
        { username: 'alice' },
      );

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.getUser.username).toBe(FAKE_USER.username);
    });

    it('returns null when the user does not exist', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(null);

      const res = await gql(
        `query GetUser($username: String!) { getUser(username: $username) { username } }`,
        { username: 'nobody' },
      );

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.getUser).toBeNull();
    });
  });

  // ── Query: lookupUser ─────────────────────────────────────────────────

  describe('Query.lookupUser', () => {
    it('resolves an address to a user', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(FAKE_USER);

      const res = await gql(
        `query Lookup($address: String!) { lookupUser(address: $address) { username address } }`,
        { address: FAKE_USER.address },
      );

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.lookupUser.username).toBe(FAKE_USER.username);
    });

    it('returns null when address has no registration', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(null);

      const res = await gql(
        `query Lookup($address: String!) { lookupUser(address: $address) { username } }`,
        { address: 'GUNKNOWN' },
      );

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.lookupUser).toBeNull();
    });
  });

  // ── Query: federation ─────────────────────────────────────────────────

  describe('Query.federation', () => {
    it('resolves a name tag to a stellar address (type=name)', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(FAKE_USER);

      const res = await gql(
        `query Fed($q: String!, $type: String) { federation(q: $q, type: $type) { stellar_address account_id } }`,
        { q: 'alice*localhost', type: 'name' },
      );

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.federation.account_id).toBe(FAKE_USER.address);
    });

    it('resolves an address to a federation address (type=id)', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(FAKE_USER);

      const res = await gql(
        `query Fed($q: String!, $type: String) { federation(q: $q, type: $type) { stellar_address account_id } }`,
        { q: FAKE_USER.address, type: 'id' },
      );

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.federation.stellar_address).toContain(FAKE_USER.username);
    });

    it('returns a NOT_FOUND error for unknown name tags', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(null);

      const res = await gql(
        `query Fed($q: String!) { federation(q: $q) { stellar_address } }`,
        { q: 'ghost*localhost' },
      );

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions.code).toBe('NOT_FOUND');
    });

    it('returns an INVALID_INPUT error for unsupported type', async () => {
      const res = await gql(
        `query Fed($q: String!, $type: String) { federation(q: $q, type: $type) { stellar_address } }`,
        { q: 'alice', type: 'invalid' },
      );

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions.code).toBe('INVALID_INPUT');
    });
  });

  // ── Mutation: registerUser ────────────────────────────────────────────

  describe('Mutation.registerUser', () => {
    const REGISTER_MUTATION = `
      mutation Register($input: RegisterInput!) {
        registerUser(input: $input) {
          ok username address federation_address
        }
      }
    `;

    it('registers a new user and returns ok=true', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(null); // no existing
      mockPrisma.user.create.mockResolvedValueOnce(FAKE_USER);

      const res = await gql(REGISTER_MUTATION, {
        input: { username: 'alice', address: 'GABC1234567890ALICE' },
      });

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.registerUser.ok).toBe(true);
      expect(res.body.data.registerUser.username).toMatch(/alice/);
      expect(res.body.data.registerUser.federation_address).toContain('localhost');
    });

    it('returns a CONFLICT error when the address is already registered', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(FAKE_USER); // existing found

      const res = await gql(REGISTER_MUTATION, {
        input: { username: 'alice', address: FAKE_USER.address },
      });

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions.code).toBe('CONFLICT');
    });

    it('returns INVALID_INPUT when a secret key is passed as address', async () => {
      const res = await gql(REGISTER_MUTATION, {
        input: { username: 'alice', address: 'SABC1234567890SECRET' },
      });

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions.code).toBe('INVALID_INPUT');
    });

    it('returns FORBIDDEN when a reserved username is used', async () => {
      const res = await gql(REGISTER_MUTATION, {
        input: { username: 'admin', address: 'GABC1234567890ALICE' },
      });

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
    });

    it('validates memo fields: memo without memo_type is rejected', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(null);

      const res = await gql(REGISTER_MUTATION, {
        input: {
          username: 'alice',
          address: 'GABC1234567890ALICE',
          memo: 'some-memo',
          // memo_type intentionally omitted
        },
      });

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions.code).toBe('INVALID_INPUT');
    });
  });

  // ── Mutation: deleteUser ──────────────────────────────────────────────

  describe('Mutation.deleteUser', () => {
    const DELETE_MUTATION = `
      mutation Delete($username: String!) {
        deleteUser(username: $username) { ok username deleted }
      }
    `;

    it('soft-deletes a user and returns ok=true', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(FAKE_USER);
      mockPrisma.user.update.mockResolvedValueOnce({ ...FAKE_USER, deletedAt: new Date() });

      const res = await gql(DELETE_MUTATION, { username: 'alice' });

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.deleteUser.ok).toBe(true);
      expect(res.body.data.deleteUser.deleted).toBe(true);
    });

    it('returns NOT_FOUND when the user does not exist', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(null);

      const res = await gql(DELETE_MUTATION, { username: 'nobody' });

      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].extensions.code).toBe('NOT_FOUND');
    });
  });

  // ── Auth context ──────────────────────────────────────────────────────

  describe('auth context', () => {
    it('X-Stellar-Address header is visible to resolvers (webhooks field returns null for non-owner)', async () => {
      // getUser with a different address in context: webhooks should be null
      mockPrisma.user.findFirst.mockResolvedValueOnce(FAKE_USER);

      const res = await gql(
        `query { getUser(username: "alice") { username webhooks { id } } }`,
        {},
        { 'X-Stellar-Address': 'GDIFFERENT_ADDRESS' },
      );

      expect(res.body.errors).toBeUndefined();
      // The webhooks field resolver returns null when the context address
      // doesn't match the user's address.
      expect(res.body.data.getUser.webhooks).toBeNull();
    });

    it('webhooks are returned when the context address matches the user', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(FAKE_USER);
      mockPrisma.webhook.findMany.mockResolvedValueOnce([
        {
          id: 'wh-1',
          username: FAKE_USER.username,
          url: 'https://example.com/hook',
          createdAt: new Date('2025-06-01T00:00:00Z'),
          lastSentAt: null,
          failingSince: null,
        },
      ]);

      const res = await gql(
        `query { getUser(username: "alice") { username webhooks { id url } } }`,
        {},
        { 'X-Stellar-Address': FAKE_USER.address },
      );

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.getUser.webhooks).not.toBeNull();
      expect(res.body.data.getUser.webhooks[0].id).toBe('wh-1');
    });
  });

  // ── Schema introspection ──────────────────────────────────────────────

  describe('introspection (dev mode)', () => {
    it('returns the schema type list via introspection', async () => {
      const res = await gql('{ __schema { types { name } } }');

      expect(res.body.errors).toBeUndefined();
      const names = res.body.data.__schema.types.map((t) => t.name);
      expect(names).toContain('User');
      expect(names).toContain('Webhook');
      expect(names).toContain('Query');
      expect(names).toContain('Mutation');
    });
  });
});
