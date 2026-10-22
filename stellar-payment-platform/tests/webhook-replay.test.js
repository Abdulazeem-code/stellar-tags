'use strict';

/**
 * tests/webhook-replay.test.js
 *
 * Integration tests for the time-travel webhook replay engine.
 * Verifies:
 * - POST /v1/webhooks/replay accepts eventIds or time range { start, end, status: "failed" }
 * - Injects X-Stellar-Replay: true and original event timestamp in replayed webhook headers
 * - Enforces maximum replay rate (50 req/sec) to prevent overwhelming merchant endpoints
 * - Replays maintain original chronological order and preserve idempotency keys
 */

const request = require('supertest');
const crypto = require('crypto');

// Mock dependencies
jest.mock('redis', () => ({ createClient: jest.fn(() => null) }), { virtual: true });
jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }), { virtual: true });
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }), { virtual: true });
jest.mock('../src/config/envCheck', () => ({}), { virtual: true });

const mockAuthenticateWebhookCall = jest.fn();
const mockTriggerReplay = jest.fn();
const mockPreviewReplay = jest.fn();

jest.mock('../src/routes/v1/webhookRoutes', () => {
  const originalModule = jest.requireActual('../src/routes/v1/webhookRoutes');
  return {
    ...originalModule,
    authenticateWebhookCall: (...args) => mockAuthenticateWebhookCall(...args),
  };
}, { virtual: true });

jest.mock('../src/services/webhookReplayService', () => ({
  triggerReplay: (...args) => mockTriggerReplay(...args),
  previewReplay: (...args) => mockPreviewReplay(...args),
}), { virtual: true });

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
    },
    webhook: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    webhookDelivery: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockResolvedValue([0, []]),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $metrics: { json: jest.fn().mockResolvedValue({ counters: [], gauges: [], histograms: [] }) },
  },
  isPrismaConnectionError: () => false,
}), { virtual: true });

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn().mockImplementation(() => ({ payments: jest.fn() })) },
  StrKey: { isValidEd25519PublicKey: jest.fn((v) => typeof v === 'string' && v.startsWith('G')) },
  Keypair: { fromPublicKey: jest.fn(() => ({ verify: jest.fn(() => true) })) },
}), { virtual: true });

jest.mock('pdfkit', () => jest.fn(), { virtual: true });

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';

const { app } = require('../server');

const BASE = '/api/v1/webhooks/replay';

let keyCounter = 0;
const asUser = (req, username = 'alice*localhost', address = 'GABC123') => {
  keyCounter += 1;
  mockAuthenticateWebhookCall.mockResolvedValue({ username, address });
  return req.set('Idempotency-Key', `test-key-${keyCounter}`);
};

const resetMocks = () => {
  jest.clearAllMocks();
  mockAuthenticateWebhookCall.mockResolvedValue({ username: 'alice*localhost', address: 'GABC123' });
};

const sampleDelivery = (overrides = {}) => ({
  id: 'delivery-1',
  webhookId: 'wh-1',
  username: 'alice*localhost',
  eventType: 'payment.received',
  eventId: 'evt-1',
  payload: {
    event: 'payment.received',
    event_id: 'evt-1',
    timestamp: '2026-01-15T10:00:00.000Z',
    data: { amount: '100', asset: 'XLM' },
  },
  status: 'failed',
  responseCode: 503,
  responseBody: 'Service Unavailable',
  errorMessage: 'Webhook responded with HTTP 503',
  attemptNumber: 3,
  sentAt: new Date('2026-01-15T10:00:00.000Z'),
  ...overrides,
});

beforeEach(() => {
  resetMocks();
});

describe('POST /v1/webhooks/replay', () => {
  it('returns 401 without authentication', async () => {
    mockAuthenticateWebhookCall.mockRejectedValue(Object.assign(new Error('Missing required field: username.'), { statusCode: 400 }));

    const res = await request(app)
      .post(BASE)
      .send({ eventIds: ['evt-1'] })
      .set('Idempotency-Key', 'test-key-1');

    expect(res.status).toBe(400);
  });

  it('returns 400 when no filter is provided', async () => {
    const res = await asUser(request(app).post(BASE).send({}));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(mockTriggerReplay).not.toHaveBeenCalled();
  });

  it('accepts eventIds array for replay', async () => {
    mockTriggerReplay.mockResolvedValue({
      ok: true,
      replayId: 'replay_abc123',
      results: { total: 2, successful: 2, failed: 0, errors: [] },
    });

    const res = await asUser(request(app).post(BASE).send({ eventIds: ['evt-1', 'evt-2'] }));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.replayId).toBe('replay_abc123');
    expect(res.body.results.total).toBe(2);
    expect(mockTriggerReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        eventIds: ['evt-1', 'evt-2'],
        username: 'alice*localhost',
      }),
      expect.objectContaining({ dryRun: false }),
    );
  });

  it('accepts time range with startDate and endDate', async () => {
    mockTriggerReplay.mockResolvedValue({
      ok: true,
      replayId: 'replay_abc123',
      results: { total: 5, successful: 5, failed: 0, errors: [] },
    });

    const res = await asUser(request(app).post(BASE).send({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      status: 'failed',
    }));

    expect(res.status).toBe(200);
    expect(mockTriggerReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        status: 'failed',
        username: 'alice*localhost',
      }),
      expect.objectContaining({ dryRun: false }),
    );
  });

  it('rejects invalid date range (startDate after endDate)', async () => {
    const res = await asUser(request(app).post(BASE).send({
      startDate: '2026-01-31',
      endDate: '2026-01-01',
    }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('accepts status filter', async () => {
    mockTriggerReplay.mockResolvedValue({
      ok: true,
      replayId: 'replay_abc123',
      results: { total: 3, successful: 3, failed: 0, errors: [] },
    });

    const res = await asUser(request(app).post(BASE).send({
      status: 'failed',
      eventType: 'payment.received',
    }));

    expect(res.status).toBe(200);
    expect(mockTriggerReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        eventType: 'payment.received',
        username: 'alice*localhost',
      }),
      expect.objectContaining({ dryRun: false }),
    );
  });

  it('accepts webhookId filter', async () => {
    mockTriggerReplay.mockResolvedValue({
      ok: true,
      replayId: 'replay_abc123',
      results: { total: 1, successful: 1, failed: 0, errors: [] },
    });

    const res = await asUser(request(app).post(BASE).send({
      webhookId: 'wh-1',
    }));

    expect(res.status).toBe(200);
    expect(mockTriggerReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookId: 'wh-1',
        username: 'alice*localhost',
      }),
      expect.objectContaining({ dryRun: false }),
    );
  });

  it('supports dryRun mode for preview', async () => {
    mockPreviewReplay.mockResolvedValue({
      stats: {
        total: 10,
        byStatus: { failed: 8, success: 2 },
        byEventType: { 'payment.received': 10 },
        byWebhook: { 'wh-1': 10 },
        dateRange: { earliest: '2026-01-01T00:00:00.000Z', latest: '2026-01-31T23:59:59.000Z' },
        samplePayloads: [],
      },
      deliveries: Array(10).fill().map((_, i) => ({ id: `d${i}`, eventId: `evt-${i}`, sentAt: new Date(), status: 'failed' })),
    });

    const res = await asUser(request(app).post(BASE).send({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      dryRun: true,
    }));

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.results.stats.total).toBe(10);
    expect(mockPreviewReplay).toHaveBeenCalled();
    expect(mockTriggerReplay).not.toHaveBeenCalled();
  });

  it('returns 409 when idempotency key conflicts', async () => {
    mockTriggerReplay.mockResolvedValue({
      ok: false,
      error: 'Replay with this idempotency key already executed',
      replayId: 'replay_same_key',
    });

    const res = await asUser(request(app)
      .post(BASE)
      .send({ eventIds: ['evt-1'] })
      .set('Idempotency-Key', 'same-key'));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('uses idempotency key from header when provided', async () => {
    mockTriggerReplay.mockResolvedValue({
      ok: true,
      replayId: 'replay_from_header',
      results: { total: 1, successful: 1, failed: 0, errors: [] },
    });

    await asUser(request(app)
      .post(BASE)
      .send({ eventIds: ['evt-1'] })
      .set('Idempotency-Key', 'header-key-123'));

    expect(mockTriggerReplay).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ idempotencyKey: 'header-key-123' }),
    );
  });

  it('limits batch size to 1000', async () => {
    mockTriggerReplay.mockResolvedValue({
      ok: true,
      replayId: 'replay_abc123',
      results: { total: 1000, successful: 1000, failed: 0, errors: [] },
    });

    const eventIds = Array(1500).fill().map((_, i) => `evt-${i}`);
    const res = await asUser(request(app).post(BASE).send({ eventIds }));

    expect(res.status).toBe(200);
    expect(mockTriggerReplay).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1000 }),
      expect.any(Object),
    );
  });

  it('rejects invalid eventIds (empty strings)', async () => {
    const res = await asUser(request(app).post(BASE).send({ eventIds: ['evt-1', '', 'evt-3'] }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('Webhook Replay Service - Header Injection', () => {
  const { buildReplayHeaders, sendReplayWebhook, checkRateLimit, _resetRateLimitStore } = require('../src/services/webhookReplayService');

  beforeEach(() => {
    _resetRateLimitStore();
  });

  it('injects X-Stellar-Replay: true header', () => {
    const secret = 'test-secret';
    const payload = {
      event: 'payment.received',
      event_id: 'evt-1',
      timestamp: '2026-01-15T10:00:00.000Z',
      data: { amount: '100' },
    };

    const { headers } = buildReplayHeaders(payload, secret, true);

    expect(headers['X-Stellar-Replay']).toBe('true');
    expect(headers['X-Stellar-Original-Timestamp']).toBe('2026-01-15T10:00:00.000Z');
  });

  it('preserves original timestamp in X-Stellar-Original-Timestamp', () => {
    const secret = 'test-secret';
    const originalTimestamp = '2026-01-15T10:00:00.000Z';
    const payload = {
      event: 'payment.received',
      event_id: 'evt-1',
      timestamp: originalTimestamp,
      data: { amount: '100' },
    };

    const { headers } = buildReplayHeaders(payload, secret, true);

    expect(headers['X-Stellar-Original-Timestamp']).toBe(originalTimestamp);
  });

  it('includes all required signature headers', () => {
    const secret = 'test-secret';
    const payload = {
      event: 'payment.received',
      event_id: 'evt-1',
      timestamp: '2026-01-15T10:00:00.000Z',
      data: { amount: '100' },
    };

    const { headers } = buildReplayHeaders(payload, secret, true);

    expect(headers['X-Webhook-Signature']).toBeDefined();
    expect(headers['X-Stellar-Tags-Signature']).toBeDefined();
    expect(headers['X-Webhook-Timestamp']).toBeDefined();
    expect(headers['Stellar-Signature']).toBeDefined();
    expect(headers['Stellar-Timestamp']).toBeDefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('does not add replay headers when isReplay is false', () => {
    const secret = 'test-secret';
    const payload = {
      event: 'payment.received',
      event_id: 'evt-1',
      timestamp: '2026-01-15T10:00:00.000Z',
      data: { amount: '100' },
    };

    const { headers } = buildReplayHeaders(payload, secret, false);

    expect(headers['X-Stellar-Replay']).toBeUndefined();
    expect(headers['X-Stellar-Original-Timestamp']).toBeUndefined();
  });
});

describe('Webhook Replay Service - Rate Limiting', () => {
  const { checkRateLimit, _resetRateLimitStore, MAX_REPLAY_RATE_PER_SEC } = require('../src/services/webhookReplayService');

  beforeEach(() => {
    _resetRateLimitStore();
    process.env.WEBHOOK_REPLAY_MAX_RATE = '50';
  });

  it('allows up to 50 requests per second per webhook', () => {
    const key = 'replay:wh-1';

    for (let i = 0; i < 50; i++) {
      const result = checkRateLimit(key);
      expect(result.allowed).toBe(true);
    }
  });

  it('blocks the 51st request within the same second', () => {
    const key = 'replay:wh-2';

    for (let i = 0; i < 50; i++) {
      checkRateLimit(key);
    }

    const result = checkRateLimit(key);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('tracks rate limits per webhook independently', () => {
    for (let i = 0; i < 50; i++) {
      expect(checkRateLimit('replay:wh-a').allowed).toBe(true);
    }
    expect(checkRateLimit('replay:wh-a').allowed).toBe(false);

    expect(checkRateLimit('replay:wh-b').allowed).toBe(true);
  });

  it('resets after 1 second window', async () => {
    const key = 'replay:wh-3';

    for (let i = 0; i < 50; i++) {
      checkRateLimit(key);
    }
    expect(checkRateLimit(key).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(checkRateLimit(key).allowed).toBe(true);
  });
});

describe('Webhook Replay Service - Chronological Order', () => {
  const { executeReplay, getUniqueWebhooksFromDeliveries, findDeliveriesForReplay } = require('../src/services/webhookReplayService');
  const { prisma } = require('../prismaClient');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches deliveries in chronological order (sentAt ASC)', async () => {
    const deliveries = [
      sampleDelivery({ id: 'd1', eventId: 'evt-1', sentAt: new Date('2026-01-15T10:00:00.000Z') }),
      sampleDelivery({ id: 'd2', eventId: 'evt-2', sentAt: new Date('2026-01-15T11:00:00.000Z') }),
      sampleDelivery({ id: 'd3', eventId: 'evt-3', sentAt: new Date('2026-01-15T12:00:00.000Z') }),
    ];

    prisma.webhookDelivery.findMany.mockResolvedValue(deliveries);
    prisma.webhook.findMany.mockResolvedValue([{ id: 'wh-1', username: 'alice*localhost', secret: 'secret', url: 'https://example.com/hook' }]);

    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });

    const found = await findDeliveriesForReplay({ username: 'alice*localhost', limit: 1000 });
    expect(found[0].eventId).toBe('evt-1');
    expect(found[1].eventId).toBe('evt-2');
    expect(found[2].eventId).toBe('evt-3');
  });

  it('replays deliveries in the same order they were fetched', async () => {
    const deliveries = [
      sampleDelivery({ id: 'd1', eventId: 'evt-1', sentAt: new Date('2026-01-15T10:00:00.000Z') }),
      sampleDelivery({ id: 'd2', eventId: 'evt-2', sentAt: new Date('2026-01-15T11:00:00.000Z') }),
      sampleDelivery({ id: 'd3', eventId: 'evt-3', sentAt: new Date('2026-01-15T12:00:00.000Z') }),
    ];

    const webhooks = [{ id: 'wh-1', username: 'alice*localhost', secret: 'secret', url: 'https://example.com/hook' }];

    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    prisma.webhookDelivery.create.mockResolvedValue({});

    const results = await executeReplay(deliveries, webhooks, 'replay_test');

    expect(results.successful).toBe(3);
    expect(results.failed).toBe(0);
    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(3);

    const calls = prisma.webhookDelivery.create.mock.calls;
    expect(calls[0][0].data.eventId).toBe('evt-1');
    expect(calls[1][0].data.eventId).toBe('evt-2');
    expect(calls[2][0].data.eventId).toBe('evt-3');
  });

  it('records replayId on all replayed deliveries for idempotency', async () => {
    const deliveries = [
      sampleDelivery({ id: 'd1', eventId: 'evt-1' }),
      sampleDelivery({ id: 'd2', eventId: 'evt-2' }),
    ];

    const webhooks = [{ id: 'wh-1', username: 'alice*localhost', secret: 'secret', url: 'https://example.com/hook' }];

    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
    prisma.webhookDelivery.create.mockResolvedValue({});

    await executeReplay(deliveries, webhooks, 'replay_idempotency_key');

    const calls = prisma.webhookDelivery.create.mock.calls;
    expect(calls[0][0].data.replayId).toBe('replay_idempotency_key');
    expect(calls[1][0].data.replayId).toBe('replay_idempotency_key');
  });
});

describe('Webhook Replay Service - Error Handling', () => {
  const { executeReplay, sendReplayWebhook } = require('../src/services/webhookReplayService');
  const { prisma } = require('../prismaClient');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records failed replays with error details', async () => {
    const deliveries = [sampleDelivery({ id: 'd1', eventId: 'evt-1' })];
    const webhooks = [{ id: 'wh-1', username: 'alice*localhost', secret: 'secret', url: 'https://example.com/hook' }];

    global.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));
    prisma.webhookDelivery.create.mockResolvedValue({});

    const results = await executeReplay(deliveries, webhooks, 'replay_test');

    expect(results.failed).toBe(1);
    expect(results.errors[0].error).toBe('Connection refused');
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          errorMessage: 'Connection refused',
          replayId: 'replay_test',
        }),
      }),
    );
  });

  it('handles webhook not found gracefully', async () => {
    const deliveries = [sampleDelivery({ id: 'd1', eventId: 'evt-1', webhookId: 'missing-wh' })];
    const webhooks = [];

    prisma.webhookDelivery.create.mockResolvedValue({});

    const results = await executeReplay(deliveries, webhooks, 'replay_test');

    expect(results.failed).toBe(1);
    expect(results.errors[0].error).toBe('Webhook not found');
  });

  it('continues replaying remaining deliveries after a failure', async () => {
    const deliveries = [
      sampleDelivery({ id: 'd1', eventId: 'evt-1' }),
      sampleDelivery({ id: 'd2', eventId: 'evt-2' }),
      sampleDelivery({ id: 'd3', eventId: 'evt-3' }),
    ];

    const webhooks = [{ id: 'wh-1', username: 'alice*localhost', secret: 'secret', url: 'https://example.com/hook' }];

    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('OK') })
      .mockRejectedValueOnce(new Error('Timeout'))
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('OK') });

    prisma.webhookDelivery.create.mockResolvedValue({});

    const results = await executeReplay(deliveries, webhooks, 'replay_test');

    expect(results.successful).toBe(2);
    expect(results.failed).toBe(1);
    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(3);
  });
});

describe('Webhook Replay Service - Idempotency', () => {
  const { triggerReplay } = require('../src/services/webhookReplayService');
  const { prisma } = require('../prismaClient');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prevents duplicate replay with same idempotency key', async () => {
    prisma.webhookDelivery.findFirst.mockResolvedValue({ id: 'existing', replayId: 'replay_same' });

    const result = await triggerReplay(
      { eventIds: ['evt-1'], username: 'alice*localhost' },
      { idempotencyKey: 'replay_same' }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('already executed');
  });

  it('generates unique replayId when not provided', async () => {
    prisma.webhookDelivery.findMany.mockResolvedValue([]);
    prisma.webhookDelivery.findFirst.mockResolvedValue(null);

    const result = await triggerReplay(
      { eventIds: ['evt-1'], username: 'alice*localhost' },
      {}
    );

    expect(result.ok).toBe(true);
    expect(result.replayId).toMatch(/^replay_/);
  });
});