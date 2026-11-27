'use strict';

/**
 * The dashboard (Vercel) calls the API (Render) cross-origin, so every custom
 * request header must pass the CORS preflight.
 */

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
  Keypair: {
    fromSecret: jest.fn((value) => {
      if (typeof value !== 'string' || !value.startsWith('S')) {
        throw new Error('Invalid Secret Seed');
      }
      return { publicKey: () => 'GTESTPUBLICKEYEXAMPLE' };
    }),
  },
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC: 'Public Global Stellar Network ; September 2015',
  },
}));

jest.mock('pdfkit', () => jest.fn());
jest.mock('bad-words', () =>
  jest.fn().mockImplementation(() => ({ isProfane: jest.fn(() => false) })),
);
jest.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    walletBalance: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
  isPrismaConnectionError: () => false,
}));

jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));
jest.mock('../src/reconciliation-cron', () => ({
  scheduleReconciliationJob: jest.fn(),
  scheduleLedgerReconciliationJob: jest.fn(),
}));
jest.mock('../src/graphql', () => ({
  createGraphQLMiddleware: jest.fn(() => (req, res, next) => next()),
}));
jest.mock('../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn(),
  isSingleSignerAccount: jest.fn(() => true),
}));
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: jest.fn().mockResolvedValue({ query: jest.fn(), release: jest.fn() }),
    end: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    options: { max: 10 },
  })),
}));
jest.mock('../src/sse', () => ({
  ...jest.requireActual('../src/sse'),
  initSse: jest.fn(),
  closeSse: jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');

const loadApp = () => {
  let app;
  jest.isolateModules(() => {
    app = require('../server').app;
  });
  return app;
};

const DASHBOARD = 'https://stellar-tags.vercel.app';

describe('CORS preflight for the dashboard', () => {
  let app;
  beforeAll(() => {
    app = loadApp();
  });

  // Exactly what the browser sends before POST /payment-requests from the
  // "Request a payment" form; a missing header here is "Failed to fetch".
  it('allows the payment-request form headers from the dashboard', async () => {
    const res = await request(app)
      .options('/payment-requests')
      .set('Origin', DASHBOARD)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,idempotency-key,x-stellar-signature,x-stellar-signer');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(DASHBOARD);
    const allowed = res.headers['access-control-allow-headers'].toLowerCase().split(/\s*,\s*/);
    expect(allowed).toEqual(expect.arrayContaining([
      'content-type',
      'idempotency-key',
      'x-stellar-signature',
      'x-stellar-signer',
    ]));
  });

  it('allows the same headers on the /api/v1 prefix', async () => {
    const res = await request(app)
      .options('/api/v1/payment-requests/abc/cancel')
      .set('Origin', DASHBOARD)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-stellar-signature,x-stellar-signer');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers'].toLowerCase()).toContain('x-stellar-signer');
  });

  it('still refuses an origin that is not allowed', async () => {
    const res = await request(app)
      .options('/payment-requests')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-stellar-signer');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
