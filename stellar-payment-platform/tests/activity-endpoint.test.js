'use strict';

const request = require('supertest');
const express = require('express');

jest.mock('../src/logger', () => ({ logger: require('pino')({ level: 'silent' }) }));

jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: { isValidEd25519PublicKey: jest.fn(() => false) },
  Keypair: { fromPublicKey: jest.fn() },
}));

jest.mock('../prismaClient', () => ({
  prisma: {
    activityLog: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
  isPrismaConnectionError: () => false,
}));

jest.mock('../src/services/ownershipService', () => ({
  authenticateUsernameOwner: jest.fn(),
}));

jest.mock('../src/multisigner-verifier', () => ({ verifyMultiSignerThreshold: jest.fn() }));
jest.mock('../src/db', () => ({
  poolGet: jest.fn(),
  poolRun: jest.fn(),
  poolAll: jest.fn(),
  etagCache: (req, res, next) => next(),
  normalizeNameTag: require('../src/utils').normalizeNameTag,
}));
jest.mock('../src/cache', () => ({
  lookupCached: jest.fn(),
  invalidateFederationCache: jest.fn(),
}));
jest.mock('../src/services/registrationService', () => ({ transferAccount: jest.fn() }));

const { prisma } = require('../prismaClient');
const { authenticateUsernameOwner } = require('../src/services/ownershipService');
const { buildErrorHandler } = require('../src/middleware/errorHandler');
const userRoutes = require('../src/routes/v1/userRoutes');

// The real router, so the test covers the mounted path and its middleware
// rather than a copy of the handler.
const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/', userRoutes);
  app.use(buildErrorHandler(() => false));
  return app;
};

const OWNER = { username: 'ada*localhost', address: 'GABC' };

beforeEach(() => {
  jest.clearAllMocks();
  authenticateUsernameOwner.mockResolvedValue(OWNER);
  prisma.activityLog.count.mockResolvedValue(0);
  prisma.activityLog.findMany.mockResolvedValue([]);
});

describe('GET /users/:username/activity', () => {
  test('signs over activity:<username> with the normalised name', async () => {
    await request(buildApp())
      .get('/users/ada/activity')
      .set('X-Stellar-Signature', 'sig')
      .set('X-Stellar-Signer', 'GABC');

    expect(authenticateUsernameOwner).toHaveBeenCalledWith({
      username: 'ada*localhost',
      signature: 'sig',
      signerAddress: 'GABC',
      operation: 'activity',
    });
  });

  test('propagates the status of a failed ownership check', async () => {
    const denied = new Error('Signature verification failed.');
    denied.statusCode = 401;
    authenticateUsernameOwner.mockRejectedValue(denied);

    const res = await request(buildApp())
      .get('/users/ada*localhost/activity')
      .set('X-Stellar-Signature', 'sig');

    expect(res.status).toBe(401);
  });

  test('answers 404 when the username is not registered', async () => {
    const missing = new Error('Username not registered.');
    missing.statusCode = 404;
    authenticateUsernameOwner.mockRejectedValue(missing);

    const res = await request(buildApp()).get('/users/nobody*localhost/activity');
    expect(res.status).toBe(404);
  });

  test('reads the trail of the authenticated owner, not the path parameter', async () => {
    authenticateUsernameOwner.mockResolvedValue({ username: 'canonical*localhost' });

    await request(buildApp())
      .get('/users/ADA*localhost/activity')
      .set('X-Stellar-Signature', 'sig');

    expect(prisma.activityLog.findMany.mock.calls[0][0].where.username).toBe(
      'canonical*localhost',
    );
  });

  test('returns the page and its meta block', async () => {
    prisma.activityLog.count.mockResolvedValue(3);
    prisma.activityLog.findMany.mockResolvedValue([
      {
        id: 'row-1',
        action: 'webhook.created',
        metadata: { url: 'https://example.test' },
        ipAddress: '10.0.0.9',
        createdAt: new Date('2026-03-04T05:06:07.000Z'),
      },
    ]);

    const res = await request(buildApp())
      .get('/users/ada*localhost/activity')
      .set('X-Stellar-Signature', 'sig');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        id: 'row-1',
        action: 'webhook.created',
        metadata: { url: 'https://example.test' },
        ip_address: '10.0.0.9',
        created_at: '2026-03-04T05:06:07.000Z',
      },
    ]);
    expect(res.body.meta).toEqual({ total: 3, page: 1, limit: 10, totalPages: 1 });
  });

  test('passes page and limit through to the query', async () => {
    await request(buildApp())
      .get('/users/ada*localhost/activity?page=3&limit=5')
      .set('X-Stellar-Signature', 'sig');

    expect(prisma.activityLog.findMany.mock.calls[0][0]).toMatchObject({ skip: 10, take: 5 });
  });

  test('clamps an oversized limit instead of rejecting it', async () => {
    const res = await request(buildApp())
      .get('/users/ada*localhost/activity?limit=10000')
      .set('X-Stellar-Signature', 'sig');

    expect(res.status).toBe(200);
    expect(prisma.activityLog.findMany.mock.calls[0][0].take).toBe(100);
  });

  test('filters by a date range', async () => {
    await request(buildApp())
      .get('/users/ada*localhost/activity?startDate=2026-01-01&endDate=2026-02-01')
      .set('X-Stellar-Signature', 'sig');

    expect(prisma.activityLog.findMany.mock.calls[0][0].where.createdAt).toEqual({
      gte: new Date('2026-01-01'),
      lte: new Date('2026-02-01'),
    });
  });

  test('rejects an unparseable date without touching the database', async () => {
    const res = await request(buildApp())
      .get('/users/ada*localhost/activity?startDate=whenever')
      .set('X-Stellar-Signature', 'sig');

    expect(res.status).toBe(400);
    expect(prisma.activityLog.findMany).not.toHaveBeenCalled();
  });

  test('rejects an inverted date range', async () => {
    const res = await request(buildApp())
      .get('/users/ada*localhost/activity?startDate=2026-06-01&endDate=2026-01-01')
      .set('X-Stellar-Signature', 'sig');

    expect(res.status).toBe(400);
  });

  test('accepts the signature in the body, as the webhook routes do', async () => {
    await request(buildApp())
      .get('/users/ada*localhost/activity')
      .set('Content-Type', 'application/json')
      .send({ signature: 'body-sig', signerAddress: 'GBODY' });

    expect(authenticateUsernameOwner).toHaveBeenCalledWith(
      expect.objectContaining({ signature: 'body-sig', signerAddress: 'GBODY' }),
    );
  });
});
