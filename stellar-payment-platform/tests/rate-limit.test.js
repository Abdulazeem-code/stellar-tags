'use strict';

const request = require('supertest');

// ── Mocks ────────────────────────────────────────────────────────────────────
jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
  Keypair: {
    fromPublicKey: jest.fn(() => ({
      verify: jest.fn(() => true),
    })),
  },
}));

jest.mock('pdfkit', () => jest.fn());

jest.mock('redis', () => ({
  createClient: jest.fn(() => null),
}));

jest.mock('rate-limit-redis', () => jest.fn());

jest.mock('bad-words', () =>
  jest.fn().mockImplementation(() => ({
    isProfane: jest.fn(() => false),
  })),
);

jest.mock('../middleware/idempotency', () => ({
  idempotencyMiddleware: jest.fn(() => (req, res, next) => next()),
}));

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({
        username: 'test*localhost',
        address: 'GBCDEFGHIJKLMNOPQRSTUVWXYZ',
      }),
    },
    $transaction: jest.fn().mockResolvedValue([0, []]),
  },
}));

jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

jest.mock('../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn().mockResolvedValue({
    success: true,
    accountId: 'GDUMMYACCOUNTIDIIIIIIIIIIIIIIIIIIIIIIIIIIIIII',
    operationType: 'management',
    requiredThreshold: 1,
    totalWeight: 1,
    signatureCount: 1,
    uniqueSignerCount: 1,
    signatures: [{ publicKey: 'GDUMMY', weight: 1, isValid: true }],
    thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
    signerCount: 1,
    errorMessage: null,
  }),
}));

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../src/metrics', () => ({
  metricsMiddleware: (req, res, next) => next(),
  getMetrics: jest.fn().mockResolvedValue(''),
  getContentType: jest.fn(() => 'text/plain'),
  setMetricsSources: jest.fn(),
}));

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  setupExpressErrorHandler: jest.fn(() => (req, res, next) => next()),
}));

// ── Test Suite ───────────────────────────────────────────────────────────────

const VALID_ADDRESS = 'GBCDEFGHIJKLMNOPQRSTUVWXYZ';

describe('Rate Limiting — express-rate-limit', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();
    ({ app } = require('../server'));
  });

  // ── Headers ──────────────────────────────────────────────────────────────

  describe('standard headers', () => {
    it('includes RateLimit-Limit header on /federation', async () => {
      const res = await request(app)
        .get('/api/v1/federation')
        .query({ q: 'client*localhost' });

      expect(res.headers).toHaveProperty('ratelimit-limit');
      expect(res.headers['ratelimit-limit']).toBe('100');
    });

    it('includes RateLimit-Remaining header on /federation', async () => {
      const res = await request(app)
        .get('/api/v1/federation')
        .query({ q: 'client*localhost' });

      expect(res.headers).toHaveProperty('ratelimit-remaining');
    });

    it('includes RateLimit-Limit header on /register', async () => {
      const res = await request(app)
        .post('/api/v1/register')
        .send({ username: 'alice', address: VALID_ADDRESS });

      expect(res.headers).toHaveProperty('ratelimit-limit');
      expect(res.headers['ratelimit-limit']).toBe('100');
    });

    it('includes X-RateLimit-* legacy headers', async () => {
      const res = await request(app)
        .get('/api/v1/federation')
        .query({ q: 'client*localhost' });

      expect(res.headers).toHaveProperty('x-ratelimit-limit');
      expect(res.headers).toHaveProperty('x-ratelimit-remaining');
      expect(res.headers).toHaveProperty('x-ratelimit-reset');
    });
  });

  // ── 429 Too Many Requests ────────────────────────────────────────────────

  describe('429 Too Many Requests', () => {
    it('returns 429 when federation endpoint exceeds 100 requests', async () => {
      // Send 100 requests (should all succeed or get normal responses)
      for (let i = 0; i < 100; i++) {
        await request(app)
          .get('/api/v1/federation')
          .query({ q: 'client*localhost' });
      }

      // The 101st request should be rate limited
      const res = await request(app)
        .get('/api/v1/federation')
        .query({ q: 'client*localhost' });

      expect(res.status).toBe(429);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests, please try again later.',
        },
      });
    });

    it('returns 429 when register endpoint exceeds 100 requests', async () => {
      const payload = { username: 'bob', address: VALID_ADDRESS };

      for (let i = 0; i < 100; i++) {
        await request(app)
          .post('/api/v1/register')
          .send(payload);
      }

      const res = await request(app)
        .post('/api/v1/register')
        .send(payload);

      expect(res.status).toBe(429);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests, please try again later.',
        },
      });
    });

    it('includes Retry-After header on 429 responses', async () => {
      for (let i = 0; i < 100; i++) {
        await request(app)
          .get('/api/v1/federation')
          .query({ q: 'client*localhost' });
      }

      const res = await request(app)
        .get('/api/v1/federation')
        .query({ q: 'client*localhost' });

      expect(res.status).toBe(429);
      expect(res.headers).toHaveProperty('retry-after');
    });
  });

  // ── Rate limit counter is shared across endpoints ────────────────────────

  describe('shared rate limit counter', () => {
    it('counts requests across /federation and /register together', async () => {
      // Exhaust the shared budget using /health
      for (let i = 0; i < 100; i++) {
        await request(app).get('/health');
      }

      // /federation should now be rate limited too
      const res = await request(app)
        .get('/api/v1/federation')
        .query({ q: 'client*localhost' });

      expect(res.status).toBe(429);
    });
  });

  // ── Strict auth/login rate limit ─────────────────────────────────────────

  describe('strict auth rate limit', () => {
    it('applies a stricter limit on /auth endpoints than the global limiter', async () => {
      // The auth limiter allows only 20 requests per window, so the 21st
      // request should be rejected even though the global limit is 100.
      for (let i = 0; i < 20; i++) {
        await request(app)
          .post('/auth/verify-email')
          .send({ email: `user${i}@example.com` });
      }

      const res = await request(app)
        .post('/auth/verify-email')
        .send({ email: 'overflow@example.com' });

      expect(res.status).toBe(429);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests, please try again later.',
        },
      });
    });
  });

  // ── Reset between test modules ───────────────────────────────────────────

  describe('rate limiter resets with new app instance', () => {
    it('fresh app instance has a full budget', async () => {
      // The beforeEach resetModules gives us a fresh app
      const res = await request(app)
        .get('/api/v1/federation')
        .query({ q: 'client*localhost' });

      expect(res.status).toBe(200);
      expect(res.headers).toHaveProperty('ratelimit-limit');
    });
  });
});
