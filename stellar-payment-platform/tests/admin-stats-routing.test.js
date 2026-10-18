'use strict';

/**
 * tests/admin-stats-routing.test.js
 *
 * Tests for GET /admin/stats/routing (issue #484).
 */

const request = require('supertest');

// ── mocks ────────────────────────────────────────────────────────────────────

jest.mock('redis', () => ({ createClient: jest.fn(() => null) }));
jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

const mockFindMany = jest.fn();
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
    payment: {
      findMany: mockFindMany,
      aggregate: jest.fn(),
      groupBy: jest.fn(),
      count: jest.fn(),
    },
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
const { getBucketKey, buildDateFilter } = require('../src/services/statsService');

// ── helpers ──────────────────────────────────────────────────────────────────

const makeRecord = ({
  id = 'txn-1',
  createdAt = new Date('2026-08-15T12:00:00Z'),
  amount = 100,
  fee = 1.5,
  assetCode = 'XLM',
  status = 'completed',
} = {}) => ({
  id,
  createdAt,
  amount,
  fee,
  assetCode,
  status,
});

// ── tests ────────────────────────────────────────────────────────────────────

describe('GET /admin/stats/routing', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
  });

  describe('Authentication', () => {
    it('returns 401 without API key', async () => {
      const res = await request(app).get('/api/v1/admin/stats/routing');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Unauthorized/);
    });

    it('returns 401 with wrong API key', async () => {
      const res = await request(app)
        .get('/api/v1/admin/stats/routing')
        .set('x-api-key', 'wrong-key');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Unauthorized/);
    });

    it('accepts API key in x-api-key header', async () => {
      mockFindMany.mockResolvedValueOnce([]);

      const res = await request(app)
        .get('/api/v1/admin/stats/routing')
        .set('x-api-key', 'test-admin-key');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('accepts API key in api_key query param', async () => {
      mockFindMany.mockResolvedValueOnce([]);

      const res = await request(app)
        .get('/api/v1/admin/stats/routing?api_key=test-admin-key');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('Validation', () => {
    it('rejects invalid startDate format with 400', async () => {
      const res = await request(app)
        .get('/api/v1/admin/stats/routing?startDate=not-a-date')
        .set('x-api-key', 'test-admin-key');

      expect(res.status).toBe(400);
    });

    it('rejects invalid endDate format with 400', async () => {
      const res = await request(app)
        .get('/api/v1/admin/stats/routing?endDate=2026/08/15')
        .set('x-api-key', 'test-admin-key');

      expect(res.status).toBe(400);
    });

    it('rejects startDate after endDate with 400', async () => {
      const res = await request(app)
        .get('/api/v1/admin/stats/routing?startDate=2026-08-20&endDate=2026-08-10')
        .set('x-api-key', 'test-admin-key');

      expect(res.status).toBe(400);
    });

    it('rejects invalid groupBy option with 400', async () => {
      const res = await request(app)
        .get('/api/v1/admin/stats/routing?groupBy=yearly')
        .set('x-api-key', 'test-admin-key');

      expect(res.status).toBe(400);
    });
  });

  describe('Aggregation & Grouping', () => {
    it('returns zeroed summary and empty data array when no records found', async () => {
      mockFindMany.mockResolvedValueOnce([]);

      const res = await request(app)
        .get('/api/v1/admin/stats/routing')
        .set('x-api-key', 'test-admin-key');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        interval: 'day',
        startDate: null,
        endDate: null,
        summary: {
          total_volume: 0,
          total_fees: 0,
          total_count: 0,
        },
        data: [],
      });
    });

    it('groups records by day by default', async () => {
      const records = [
        makeRecord({ id: '1', createdAt: new Date('2026-08-10T10:00:00Z'), amount: 100, fee: 1 }),
        makeRecord({ id: '2', createdAt: new Date('2026-08-10T15:30:00Z'), amount: 50, fee: 0.5 }),
        makeRecord({ id: '3', createdAt: new Date('2026-08-11T09:00:00Z'), amount: 200, fee: 2 }),
      ];
      mockFindMany.mockResolvedValueOnce(records);

      const res = await request(app)
        .get('/api/v1/admin/stats/routing')
        .set('x-api-key', 'test-admin-key');

      expect(res.status).toBe(200);
      expect(res.body.interval).toBe('day');
      expect(res.body.summary).toEqual({
        total_volume: 350,
        total_fees: 3.5,
        total_count: 3,
      });
      expect(res.body.data).toEqual([
        { period: '2026-08-10', volume: 150, fees: 1.5, count: 2 },
        { period: '2026-08-11', volume: 200, fees: 2, count: 1 },
      ]);
    });

    it('groups records by week when groupBy=week', async () => {
      const records = [
        // 2026-08-10 is Monday
        makeRecord({ id: '1', createdAt: new Date('2026-08-10T10:00:00Z'), amount: 100, fee: 1 }),
        // 2026-08-14 is Friday of same week
        makeRecord({ id: '2', createdAt: new Date('2026-08-14T10:00:00Z'), amount: 150, fee: 1.5 }),
        // 2026-08-17 is Monday of next week
        makeRecord({ id: '3', createdAt: new Date('2026-08-17T10:00:00Z'), amount: 300, fee: 3 }),
      ];
      mockFindMany.mockResolvedValueOnce(records);

      const res = await request(app)
        .get('/api/v1/admin/stats/routing?groupBy=week')
        .set('x-api-key', 'test-admin-key');

      expect(res.status).toBe(200);
      expect(res.body.interval).toBe('week');
      expect(res.body.summary).toEqual({
        total_volume: 550,
        total_fees: 5.5,
        total_count: 3,
      });
      expect(res.body.data).toEqual([
        { period: '2026-08-10', volume: 250, fees: 2.5, count: 2 },
        { period: '2026-08-17', volume: 300, fees: 3, count: 1 },
      ]);
    });

    it('groups records by month when groupBy=month or interval=month', async () => {
      const records = [
        makeRecord({ id: '1', createdAt: new Date('2026-07-15T10:00:00Z'), amount: 500, fee: 5 }),
        makeRecord({ id: '2', createdAt: new Date('2026-08-01T10:00:00Z'), amount: 200, fee: 2 }),
        makeRecord({ id: '3', createdAt: new Date('2026-08-20T10:00:00Z'), amount: 300, fee: 3 }),
      ];
      mockFindMany.mockResolvedValueOnce(records);

      const res = await request(app)
        .get('/api/v1/admin/stats/routing?interval=month')
        .set('x-api-key', 'test-admin-key');

      expect(res.status).toBe(200);
      expect(res.body.interval).toBe('month');
      expect(res.body.summary).toEqual({
        total_volume: 1000,
        total_fees: 10,
        total_count: 3,
      });
      expect(res.body.data).toEqual([
        { period: '2026-07', volume: 500, fees: 5, count: 1 },
        { period: '2026-08', volume: 500, fees: 5, count: 2 },
      ]);
    });

    it('passes date filters and assetCode to prisma query', async () => {
      mockFindMany.mockResolvedValueOnce([]);

      await request(app)
        .get('/api/v1/admin/stats/routing?startDate=2026-08-01&endDate=2026-08-31&assetCode=USDC')
        .set('x-api-key', 'test-admin-key');

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            assetCode: 'USDC',
            createdAt: expect.objectContaining({
              gte: expect.any(Date),
              lte: expect.any(Date),
            }),
          }),
        }),
      );
    });
  });

  describe('statsService Helper Units', () => {
    it('getBucketKey extracts day, week, and month correctly', () => {
      const date = new Date('2026-08-12T14:30:00Z'); // Wednesday
      expect(getBucketKey(date, 'day')).toBe('2026-08-12');
      expect(getBucketKey(date, 'week')).toBe('2026-08-10'); // Monday of that week
      expect(getBucketKey(date, 'month')).toBe('2026-08');
    });

    it('buildDateFilter constructs valid gte and lte dates', () => {
      const empty = buildDateFilter();
      expect(empty).toEqual({});

      const filtered = buildDateFilter('2026-08-01', '2026-08-15');
      expect(filtered.createdAt.gte.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(filtered.createdAt.lte.toISOString()).toBe('2026-08-15T23:59:59.999Z');
    });
  });
});
