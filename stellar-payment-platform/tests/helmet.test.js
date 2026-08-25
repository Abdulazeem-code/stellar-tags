const request = require('supertest');

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));
jest.mock('bad-words', () => {
  return jest.fn().mockImplementation(() => ({
    isProfane: jest.fn(() => false),
  }));
});
jest.mock('../prismaClient', () => ({ prisma: {}, isPrismaConnectionError: () => false }));
jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));
jest.mock('../src/db-pool-monitor', () => ({ schedulePoolMonitoring: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../middleware/correlation', () => ({ correlationId: (req, res, next) => next() }));
jest.mock('../middleware/idempotency', () => ({ idempotencyMiddleware: () => (req, res, next) => next() }));
jest.mock('sqlite3', () => ({}));
jest.mock('../src/multisigner-verifier', () => ({}));
jest.mock('../src/db', () => ({}));
jest.mock('../src/logger', () => ({ logger: require('pino')({ level: 'silent' }) }));
jest.mock('../src/metrics', () => ({ metricsMiddleware: (req, res, next) => next(), getMetrics: jest.fn(), getContentType: jest.fn(), setMetricsSources: jest.fn() }));
jest.mock('@sentry/node', () => ({ init: jest.fn(), setupExpressErrorHandler: jest.fn() }));
jest.mock('../src/cache', () => ({}));
jest.mock('../src/pagination', () => ({}));
jest.mock('../src/utils', () => ({}));
jest.mock('../src/routes/v1', () => () => {
  const express = require('express');
  return express.Router();
});
jest.mock('../src/routes/v1/authRoutes', () => () => {
  const express = require('express');
  return express.Router();
});

const { app } = require('../server');

describe('Helmet Security Headers', () => {
  it('should remove the X-Powered-By header', async () => {
    const response = await request(app).get('/health');
    expect(response.header).not.toHaveProperty('x-powered-by');
  });

  it('should set security headers (e.g., X-Content-Type-Options)', async () => {
    const response = await request(app).get('/health');
    expect(response.header).toHaveProperty('x-content-type-options', 'nosniff');
  });

  it('should deny all framing via X-Frame-Options', async () => {
    const response = await request(app).get('/health');
    expect(response.header).toHaveProperty('x-frame-options', 'DENY');
  });

  it('should enforce strict Content-Security-Policy with frame-ancestors none', async () => {
    const response = await request(app).get('/health');
    expect(response.header).toHaveProperty('content-security-policy');
    const csp = response.header['content-security-policy'];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });
});
