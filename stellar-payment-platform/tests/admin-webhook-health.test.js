'use strict';

/**
 * tests/admin-webhook-health.test.js
 *
 * Tests for GET /admin/webhooks/health (issue: webhook delivery observability).
 */

const request = require('supertest');

// ── mocks ────────────────────────────────────────────────────────────────────

jest.mock('redis', () => ({ createClient: jest.fn(() => null) }));
jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

const mockWebhookCount = jest.fn();
const mockWebhookFindMany = jest.fn();

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    webhook: {
      count: mockWebhookCount,
      findMany: mockWebhookFindMany,
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockResolvedValue([0, []]),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $metrics: { json: jest.fn().mockResolvedValue({ counters: [], gauges: [], histograms: [] }) },
  },
  isPrismaConnectionError: () => false,
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn().mockImplementation(() => ({ payments: jest.fn() })) },
  StrKey: { isValidEd25519PublicKey: jest.fn((v) => typeof v === 'string' && v.startsWith('G')) },
  Keypair: { fromPublicKey: jest.fn(() => ({ verify: jest.fn(() => true) })) },
}));
jest.mock('pdfkit', () => jest.fn());

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';

// Load app after mocks are in place.
const { app } = require('../server');

describe('GET /admin/webhooks/health', () => {
  beforeEach(() => {
    mockWebhookCount.mockReset();
    mockWebhookFindMany.mockReset();
  });

  it('returns 401 without API key', async () => {
    const res = await request(app).get('/api/v1/admin/webhooks/health');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong API key', async () => {
    const res = await request(app)
      .get('/api/v1/admin/webhooks/health')
      .set('x-api-key', 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('aggregates totals, success rate, and stale failures', async () => {
    // total, failing, activeLast24h, failingLast24h
    mockWebhookCount
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1);

    const staleFailure = {
      id: 'wh-1',
      username: 'alice',
      url: 'https://broken.example.com/hook',
      failingSince: new Date('2026-01-01T00:00:00Z'),
    };
    mockWebhookFindMany.mockResolvedValueOnce([staleFailure]);

    const res = await request(app)
      .get('/api/v1/admin/webhooks/health')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      summary: {
        total: 10,
        healthy: 7,
        failing: 3,
        successRate24h: 75,
      },
      failingOver24h: [
        {
          id: 'wh-1',
          username: 'alice',
          url: 'https://broken.example.com/hook',
          failingSince: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('returns null successRate24h when nothing has been active', async () => {
    mockWebhookCount
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    mockWebhookFindMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/webhooks/health')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.body.summary.successRate24h).toBeNull();
  });

  it('scopes all queries by username when provided', async () => {
    mockWebhookCount
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    mockWebhookFindMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/v1/admin/webhooks/health?username=alice')
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(mockWebhookCount).toHaveBeenCalledWith({ where: { username: 'alice' } });
    expect(mockWebhookFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ username: 'alice' }),
      }),
    );
  });
});
