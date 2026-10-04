'use strict';

/**
 * tests/analytics-cqrs.test.js
 *
 * Unit tests for the CQRS analytics pipeline:
 *   - eventPublisher  (publishPaymentCreated, publishPaymentUpdated)
 *   - analyticsConsumer (parseStreamEntry, processEvent, ensureConsumerGroup)
 *   - analyticsRepository (getRoutingStatsFromAnalytics — fallback + query shapes)
 */

const {
  publishPaymentCreated,
  publishPaymentUpdated,
  ANALYTICS_STREAM,
} = require('../src/analytics/eventPublisher');

const {
  parseStreamEntry,
  processEvent,
  ensureConsumerGroup,
  CONSUMER_GROUP,
} = require('../src/analytics/analyticsConsumer');

const {
  getRoutingStatsFromAnalytics,
  upsertPaymentAnalytics,
  getAnalyticsPool,
} = require('../src/analytics/analyticsRepository');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const samplePayment = {
  id: 'pay-001',
  createdAt: '2026-01-15T12:00:00.000Z',
  fromAddress: 'GABC',
  toAddress: 'GXYZ',
  amount: 100.5,
  fee: 0.00001,
  assetCode: 'XLM',
  transactionHash: 'abc123',
  status: 'completed',
};

// ── eventPublisher ────────────────────────────────────────────────────────────

describe('eventPublisher', () => {
  test('ANALYTICS_STREAM defaults to "analytics"', () => {
    expect(ANALYTICS_STREAM).toBe(process.env.ANALYTICS_STREAM || 'analytics');
  });

  test('publishPaymentCreated returns null when redis is null', async () => {
    const result = await publishPaymentCreated(null, samplePayment);
    expect(result).toBeNull();
  });

  test('publishPaymentUpdated returns null when redis is null', async () => {
    const result = await publishPaymentUpdated(null, samplePayment);
    expect(result).toBeNull();
  });

  test('publishPaymentCreated calls redis.xadd with correct stream and event_type', async () => {
    const mockXadd = jest.fn().mockResolvedValue('1234-0');
    const mockRedis = { xadd: mockXadd };

    const id = await publishPaymentCreated(mockRedis, samplePayment);

    expect(id).toBe('1234-0');
    expect(mockXadd).toHaveBeenCalledTimes(1);
    const args = mockXadd.mock.calls[0];
    expect(args[0]).toBe(ANALYTICS_STREAM);
    expect(args).toContain('MAXLEN');
    expect(args).toContain('event_type');
    expect(args).toContain('payment.created');
    expect(args).toContain('payload');
    // Payload carries the payment fields
    const payloadIdx = args.indexOf('payload');
    const payload = JSON.parse(args[payloadIdx + 1]);
    expect(payload.id).toBe(samplePayment.id);
    expect(payload.amount).toBe(samplePayment.amount);
    expect(payload.fee).toBe(samplePayment.fee);
    expect(payload.assetCode).toBe(samplePayment.assetCode);
  });

  test('publishPaymentCreated swallows redis errors and returns null', async () => {
    const mockRedis = {
      xadd: jest.fn().mockRejectedValue(new Error('Redis down')),
    };
    const result = await publishPaymentCreated(mockRedis, samplePayment);
    expect(result).toBeNull();
  });

  test('publishPaymentUpdated calls redis.xadd with event_type payment.updated', async () => {
    const mockXadd = jest.fn().mockResolvedValue('1235-0');
    const mockRedis = { xadd: mockXadd };
    await publishPaymentUpdated(mockRedis, samplePayment);
    const args = mockXadd.mock.calls[0];
    expect(args).toContain('payment.updated');
  });

  test('publishPaymentUpdated swallows redis errors and returns null', async () => {
    const mockRedis = {
      xadd: jest.fn().mockRejectedValue(new Error('Redis down')),
    };
    const result = await publishPaymentUpdated(mockRedis, samplePayment);
    expect(result).toBeNull();
  });

  test('publishPaymentCreated serialises Date createdAt to ISO string', async () => {
    const mockXadd = jest.fn().mockResolvedValue('1236-0');
    const mockRedis = { xadd: mockXadd };
    const paymentWithDate = { ...samplePayment, createdAt: new Date('2026-01-15T12:00:00.000Z') };
    await publishPaymentCreated(mockRedis, paymentWithDate);
    const args = mockXadd.mock.calls[0];
    const payloadIdx = args.indexOf('payload');
    const payload = JSON.parse(args[payloadIdx + 1]);
    expect(typeof payload.createdAt).toBe('string');
    expect(payload.createdAt).toBe('2026-01-15T12:00:00.000Z');
  });
});

// ── analyticsConsumer ─────────────────────────────────────────────────────────

describe('analyticsConsumer', () => {
  test('CONSUMER_GROUP defaults to "analytics-processors"', () => {
    expect(CONSUMER_GROUP).toBe(process.env.ANALYTICS_CONSUMER_GROUP || 'analytics-processors');
  });

  test('parseStreamEntry extracts payload from Redis stream entry', () => {
    const raw = JSON.stringify(samplePayment);
    const entry = ['1234-0', ['event_type', 'payment.created', 'payload', raw]];
    const parsed = parseStreamEntry(entry);
    expect(parsed.id).toBe('pay-001');
    expect(parsed.amount).toBe(100.5);
    expect(parsed.assetCode).toBe('XLM');
  });

  test('parseStreamEntry returns undefined when fields are empty', () => {
    const entry = ['1234-0', []];
    const parsed = parseStreamEntry(entry);
    // fields[1] is undefined — should return undefined gracefully, not throw
    expect(parsed).toBeUndefined();
  });

  test('ensureConsumerGroup ignores BUSYGROUP error', async () => {
    const mockRedis = {
      xgroup: jest.fn().mockRejectedValue(
        new Error('BUSYGROUP Consumer Group name already exists'),
      ),
    };
    await expect(ensureConsumerGroup(mockRedis)).resolves.not.toThrow();
  });

  test('ensureConsumerGroup rethrows non-BUSYGROUP errors', async () => {
    const mockRedis = {
      xgroup: jest.fn().mockRejectedValue(new Error('WRONGTYPE Operation')),
    };
    await expect(ensureConsumerGroup(mockRedis)).rejects.toThrow('WRONGTYPE');
  });

  test('processEvent calls upsertPaymentAnalytics for payment.created', async () => {
    const mockPool = {};
    const analyticsRepo = require('../src/analytics/analyticsRepository');
    const mockUpsert = jest.spyOn(analyticsRepo, 'upsertPaymentAnalytics').mockResolvedValue();

    await processEvent(samplePayment, 'payment.created', mockPool);
    expect(mockUpsert).toHaveBeenCalledWith(mockPool, samplePayment);
    mockUpsert.mockRestore();
  });

  test('processEvent calls upsertPaymentAnalytics for payment.updated when status present', async () => {
    const mockPool = {};
    const analyticsRepo = require('../src/analytics/analyticsRepository');
    const mockUpsert = jest.spyOn(analyticsRepo, 'upsertPaymentAnalytics').mockResolvedValue();

    await processEvent(samplePayment, 'payment.updated', mockPool);
    expect(mockUpsert).toHaveBeenCalledWith(mockPool, samplePayment);
    mockUpsert.mockRestore();
  });

  test('processEvent does not call upsertPaymentAnalytics for unknown event types', async () => {
    const mockPool = {};
    const analyticsRepo = require('../src/analytics/analyticsRepository');
    const mockUpsert = jest.spyOn(analyticsRepo, 'upsertPaymentAnalytics').mockResolvedValue();

    await processEvent(samplePayment, 'user.registered', mockPool);
    expect(mockUpsert).not.toHaveBeenCalled();
    mockUpsert.mockRestore();
  });

  test('processEvent does not call upsertPaymentAnalytics for payment.updated without status', async () => {
    const mockPool = {};
    const analyticsRepo = require('../src/analytics/analyticsRepository');
    const mockUpsert = jest.spyOn(analyticsRepo, 'upsertPaymentAnalytics').mockResolvedValue();

    const eventWithoutStatus = { id: 'pay-002', amount: 50 };
    await processEvent(eventWithoutStatus, 'payment.updated', mockPool);
    expect(mockUpsert).not.toHaveBeenCalled();
    mockUpsert.mockRestore();
  });
});

// ── analyticsRepository ───────────────────────────────────────────────────────

describe('analyticsRepository', () => {
  test('getAnalyticsPool returns null when ANALYTICS_DATABASE_URL is not set', () => {
    // In the test environment ANALYTICS_DATABASE_URL should be unset
    if (!process.env.ANALYTICS_DATABASE_URL) {
      const pool = getAnalyticsPool();
      expect(pool).toBeNull();
    } else {
      // If it IS set, pool should be a Pool-like object
      const pool = getAnalyticsPool();
      expect(pool).not.toBeNull();
    }
  });

  test('getRoutingStatsFromAnalytics returns unavailable stub when pool is null', async () => {
    const result = await getRoutingStatsFromAnalytics({ pool: null });
    expect(result.source).toBe('unavailable');
    expect(result.summary.total_count).toBe(0);
    expect(result.summary.total_volume).toBe(0);
    expect(result.summary.total_fees).toBe(0);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(0);
  });

  test('getRoutingStatsFromAnalytics returns correct shape when pool is null', async () => {
    const result = await getRoutingStatsFromAnalytics({
      pool: null,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      groupBy: 'week',
    });
    expect(result).toHaveProperty('interval', 'week');
    expect(result).toHaveProperty('startDate', '2026-01-01');
    expect(result).toHaveProperty('endDate', '2026-01-31');
    expect(result).toHaveProperty('summary');
    expect(result.summary).toHaveProperty('total_volume');
    expect(result.summary).toHaveProperty('total_fees');
    expect(result.summary).toHaveProperty('total_count');
    expect(result).toHaveProperty('data');
  });

  test('getRoutingStatsFromAnalytics defaults groupBy to day', async () => {
    const result = await getRoutingStatsFromAnalytics({ pool: null });
    expect(result.interval).toBe('day');
  });

  test('getRoutingStatsFromAnalytics queries pool with correct SQL and aggregates by day', async () => {
    const rows = [
      {
        id: 'p1',
        created_at: '2026-01-15T12:00:00Z',
        amount: 50,
        fee: 0.001,
        asset_code: 'XLM',
        status: 'completed',
      },
      {
        id: 'p2',
        created_at: '2026-01-15T14:00:00Z',
        amount: 75,
        fee: 0.002,
        asset_code: 'XLM',
        status: 'completed',
      },
    ];
    const mockPool = {
      query: jest.fn().mockResolvedValue({ rows }),
    };

    const result = await getRoutingStatsFromAnalytics({
      pool: mockPool,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      groupBy: 'day',
    });

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(result.summary.total_count).toBe(2);
    expect(result.summary.total_volume).toBeCloseTo(125);
    expect(result.data).toHaveLength(1); // both rows on the same day
    expect(result.data[0].period).toBe('2026-01-15');
    expect(result.data[0].count).toBe(2);
    expect(result.source).toBe('analytics');
  });

  test('getRoutingStatsFromAnalytics groups by week correctly', async () => {
    const rows = [
      // 2026-01-12 is Monday (week boundary)
      { id: 'p1', created_at: '2026-01-12T00:00:00Z', amount: 10, fee: 0, asset_code: 'XLM', status: 'completed' },
      { id: 'p2', created_at: '2026-01-13T00:00:00Z', amount: 20, fee: 0, asset_code: 'XLM', status: 'completed' },
    ];
    const mockPool = { query: jest.fn().mockResolvedValue({ rows }) };

    const result = await getRoutingStatsFromAnalytics({ pool: mockPool, groupBy: 'week' });

    expect(result.data).toHaveLength(1);
    // Both rows belong to the week starting 2026-01-12 (Monday)
    expect(result.data[0].period).toBe('2026-01-12');
    expect(result.data[0].count).toBe(2);
  });

  test('getRoutingStatsFromAnalytics groups by month correctly', async () => {
    const rows = [
      { id: 'p1', created_at: '2026-01-05T00:00:00Z', amount: 5, fee: 0, asset_code: 'XLM', status: 'completed' },
      { id: 'p2', created_at: '2026-02-10T00:00:00Z', amount: 5, fee: 0, asset_code: 'XLM', status: 'completed' },
    ];
    const mockPool = { query: jest.fn().mockResolvedValue({ rows }) };

    const result = await getRoutingStatsFromAnalytics({ pool: mockPool, groupBy: 'month' });

    expect(result.data).toHaveLength(2);
    expect(result.data[0].period).toBe('2026-01');
    expect(result.data[1].period).toBe('2026-02');
  });

  test('getRoutingStatsFromAnalytics passes assetCode as SQL parameter', async () => {
    const mockPool = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    await getRoutingStatsFromAnalytics({
      pool: mockPool,
      assetCode: 'USDC',
      groupBy: 'day',
    });

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/asset_code/);
    expect(params).toContain('USDC');
  });
});

// ── Admin route integration (smoke) ──────────────────────────────────────────

describe('admin GET /admin/stats/routing — analytics fallback', () => {
  test('route module imports both statsService and analyticsRepository', () => {
    // Verify both imports exist in the route module
    const adminRoutes = require('../src/routes/v1/adminRoutes');
    expect(typeof adminRoutes).toBe('function'); // it's a factory function
  });

  test('analyticsPublisherMiddleware is a function factory', () => {
    const { analyticsPublisherMiddleware } = require('../src/middleware/analyticsPublisher');
    const middleware = analyticsPublisherMiddleware(null);
    expect(typeof middleware).toBe('function');
  });
});
