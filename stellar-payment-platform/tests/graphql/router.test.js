'use strict';

/**
 * #685 — HTTP layer for /graphql.
 *
 * Covers the three jobs the endpoint does: execute operations, serve the
 * development playground, and stay out of the way when the playground is off.
 */

// The GraphQL context reaches for the ownership service, which loads the Stellar
// SDK; that has its own test file, so here it is only a boundary.
jest.mock('../../src/services/ownershipService', () => ({
  authenticateUsernameOwner: jest.fn(async () => ({
    username: 'alice*localhost',
    address: 'G_ALICE',
  })),
  verifyFreighterSignedMessage: jest.fn(),
}));

jest.mock('../../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  httpLogger: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const { registerGraphQL } = require('../../src/graphql/router');
const { rejectNestedObjects } = require('../../src/middleware/rejectNestedObjects');
const { createFakePrisma } = require('./support/fakePrisma');

const user = (name, address) => ({
  username: name,
  address,
  isPrimary: true,
  memoType: null,
  memo: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  flaggedAt: null,
  deletedAt: null,
});

const buildApp = (prisma) => {
  const app = express();
  app.use(express.json());
  // Same order as server.js: the guard runs before the GraphQL handler, so these
  // requests prove the /graphql exemption is what lets variables through.
  app.use(rejectNestedObjects);
  app.post('/api/v1/echo', (req, res) => res.json({ body: req.body }));
  registerGraphQL(app, { prisma, redisClient: null, poolGet: jest.fn() });
  app.use((_req, res) => res.status(404).json({ error: 'Not Found' }));
  return app;
};

const withEnv = async (overrides, run) => {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    // Awaited so the environment is still in place while the request runs:
    // supertest does not dispatch until the returned object is consumed.
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe('POST /graphql', () => {
  it('executes a query', async () => {
    const prisma = createFakePrisma({ users: [user('alice*localhost', 'G_ALICE')] });
    const res = await request(buildApp(prisma))
      .post('/graphql')
      .send({ query: '{ users { totalCount nodes { username } } }' });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.users.totalCount).toBe(1);
    expect(res.body.data.users.nodes[0].username).toBe('alice*localhost');
  });

  it('accepts nested variables, which the REST body guard would otherwise reject', async () => {
    const app = buildApp(createFakePrisma({ users: [user('alice*localhost', 'G_ALICE')] }));

    // Control: the very same payload is still refused off /graphql.
    const guarded = await request(app)
      .post('/api/v1/echo')
      .send({ query: 'q', variables: { filter: { search: 'alice' } } });
    expect(guarded.status).toBe(400);
    expect(guarded.body.error.code).toBe('INVALID_INPUT');

    const res = await request(app)
      .post('/graphql')
      .send({
        query: 'query Q($filter: UserFilter) { users(filter: $filter) { totalCount } }',
        variables: { filter: { search: 'alice' } },
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.users.totalCount).toBe(1);
  });

  it('returns a 200 with an errors array for a resolver failure', async () => {
    const prisma = createFakePrisma({});
    prisma.user.count = () => Promise.reject(Object.assign(new Error('boom'), { code: 'WHATEVER' }));

    const res = await request(buildApp(prisma)).post('/graphql').send({ query: '{ users { totalCount } }' });

    // 200, not 5xx: a resolver failure is a GraphQL error, and the client reads
    // it from `errors`. `users` is non-null, so the failure propagates to the
    // root and `data` is null.
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(res.body.errors[0].message).toMatch(/boom/);
  });

  it('exposes the REST error code in extensions', async () => {
    const prisma = createFakePrisma({ users: [] });
    const res = await request(buildApp(prisma))
      .post('/graphql')
      .send({ query: '{ federation(q: "  ") { accountId } }' });

    expect(res.status).toBe(200);
    expect(res.body.errors[0].extensions.code).toBe('INVALID_INPUT');
    expect(res.body.errors[0].extensions.statusCode).toBe(400);
  });

  it('rejects a malformed query before any resolver runs', async () => {
    const prisma = createFakePrisma({ users: [user('alice*localhost', 'G_ALICE')] });
    const res = await request(buildApp(prisma)).post('/graphql').send({ query: '{ users {' });

    expect(prisma.__calls).toHaveLength(0);
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors[0].message).toMatch(/Syntax Error/);
  });

  it('answers 400 for a malformed query when the client asks for the spec media type', async () => {
    // graphql-http follows the GraphQL-over-HTTP spec here: under
    // application/graphql-response+json a request that is not a well-formed
    // GraphQL request gets 400, while the legacy application/json mode keeps
    // 200 and puts the failure in `errors`.
    const prisma = createFakePrisma({ users: [user('alice*localhost', 'G_ALICE')] });
    const res = await request(buildApp(prisma))
      .post('/graphql')
      .set('Accept', 'application/graphql-response+json')
      .send({ query: '{ users {' });

    expect(res.status).toBe(400);
    expect(prisma.__calls).toHaveLength(0);
  });
});

describe('GET /graphql', () => {
  it('runs a query passed in the query string', async () => {
    const prisma = createFakePrisma({ users: [user('alice*localhost', 'G_ALICE')] });
    const res = await request(buildApp(prisma))
      .get('/graphql')
      .query({ query: '{ users { totalCount } }' });

    expect(res.status).toBe(200);
    expect(res.body.data.users.totalCount).toBe(1);
  });

  it('serves the playground outside production', async () => {
    const app = buildApp(createFakePrisma({}));
    const res = await withEnv({ GRAPHQL_PLAYGROUND: undefined }, () => request(app).get('/graphql'));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('graphiql');
  });

  it('relaxes the CSP for the playground document only', async () => {
    const app = buildApp(createFakePrisma({}));
    const res = await withEnv({ GRAPHQL_PLAYGROUND: undefined }, () => request(app).get('/graphql'));

    const policy = res.headers['content-security-policy'];
    expect(policy).toContain('https://unpkg.com');
    expect(policy).toContain("connect-src 'self'");
  });

  it('never serves the playground in production', async () => {
    const app = buildApp(createFakePrisma({}));
    const res = await withEnv({ NODE_ENV: 'production' }, () => request(app).get('/graphql'));

    expect(res.status).toBe(404);
    expect(res.text || '').not.toContain('graphiql');
  });

  it('can be switched off explicitly', async () => {
    const app = buildApp(createFakePrisma({}));
    const res = await withEnv({ GRAPHQL_PLAYGROUND: '0' }, () => request(app).get('/graphql'));

    expect(res.status).toBe(404);
  });

  it('still executes queries in production', async () => {
    const prisma = createFakePrisma({ users: [user('alice*localhost', 'G_ALICE')] });
    const res = await withEnv({ NODE_ENV: 'production' }, () =>
      request(buildApp(prisma)).post('/graphql').send({ query: '{ users { totalCount } }' }),
    );

    expect(res.status).toBe(200);
    expect(res.body.data.users.totalCount).toBe(1);
  });
});

describe('error masking in production', () => {
  it('masks an incidental error and keeps its detail out of the response', async () => {
    const prisma = createFakePrisma({ users: [] });
    prisma.user.count = () => Promise.reject(new Error('connection string postgres://user:hunter2@db/x'));

    const res = await withEnv({ NODE_ENV: 'production' }, () =>
      request(buildApp(prisma)).post('/graphql').send({ query: '{ users { totalCount } }' }),
    );

    expect(res.body.errors[0].message).toBe('Internal Server Error');
    expect(res.body.errors[0].extensions.code).toBe('INTERNAL_ERROR');
    expect(res.body.errors[0].extensions.statusCode).toBe(500);
    expect(res.text).not.toContain('hunter2');
  });

  it('shows the same message in development, where the stack is the point', async () => {
    const prisma = createFakePrisma({ users: [] });
    prisma.user.count = () => Promise.reject(new Error('kaboom'));

    const res = await request(buildApp(prisma))
      .post('/graphql')
      .send({ query: '{ users { totalCount } }' });

    expect(res.body.errors[0].message).toBe('kaboom');
  });

  it('keeps the actionable message of an ownership rejection', async () => {
    // authenticateUsernameOwner throws a plain Error with a 401, not an ApiError.
    // Masking it would tell a caller with a bad signature nothing useful.
    const { authenticateUsernameOwner } = require('../../src/services/ownershipService');
    authenticateUsernameOwner.mockRejectedValueOnce(
      Object.assign(new Error('Signature verification failed'), { statusCode: 401 }),
    );

    const res = await withEnv({ NODE_ENV: 'production' }, () =>
      request(buildApp(createFakePrisma({})))
        .post('/graphql')
        .set('x-stellar-signature', 'GSIGNATURE')
        .set('x-stellar-tags-username', 'alice')
        .send({ query: '{ webhooks { id } }' }),
    );

    expect(res.body.errors[0].message).toBe('Signature verification failed');
    expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
    expect(res.body.errors[0].extensions.statusCode).toBe(401);
  });
});
