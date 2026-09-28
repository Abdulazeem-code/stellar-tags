'use strict';

/**
 * tests/admin-dlq.test.js
 *
 * HTTP-level tests for the admin dead letter queue routes. The DLQ module is
 * mocked so the routes can be driven without Redis; the auth, validation and
 * error-envelope behaviour are the real middleware.
 */

const request = require('supertest');

jest.mock('redis', () => ({ createClient: jest.fn(() => null) }));
jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

const mockListDlqMessages = jest.fn();
const mockGetDlqMessage = jest.fn();
const mockReplayDlqMessage = jest.fn();
const mockReplayDlqMessages = jest.fn();
const mockDiscardDlqMessage = jest.fn();
const mockAuditLogCreate = jest.fn().mockResolvedValue({});

jest.mock('../src/dlq', () => ({
  DLQ_QUEUE_NAME: 'payment-retries-dlq',
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  closeDlqQueue: jest.fn().mockResolvedValue(undefined),
  listDlqMessages: (...args) => mockListDlqMessages(...args),
  getDlqMessage: (...args) => mockGetDlqMessage(...args),
  replayDlqMessage: (...args) => mockReplayDlqMessage(...args),
  replayDlqMessages: (...args) => mockReplayDlqMessages(...args),
  discardDlqMessage: (...args) => mockDiscardDlqMessage(...args),
}));

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
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    webhook: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: (...args) => mockAuditLogCreate(...args) },
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

const { ApiError } = require('../src/errors');

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';

const { app } = require('../server');

const BASE = '/api/v1/admin/dlq';
// Every mutating /api/v1 request must carry an Idempotency-Key: paymentRoutes
// mounts idempotencyMiddleware(redisClient, { enforce: true }) at the v1 root,
// so the requirement covers the admin routes too.
let keyCounter = 0;
const asAdmin = (req) => {
  keyCounter += 1;
  return req.set('x-api-key', 'test-admin-key').set('Idempotency-Key', `test-key-${keyCounter}`);
};
// No API key, but a valid Idempotency-Key, so the 401 comes from auth rather
// than from the idempotency guard.
const asAnonymous = (req) => {
  keyCounter += 1;
  return req.set('Idempotency-Key', `anon-key-${keyCounter}`);
};

const message = (overrides = {}) => ({
  id: 'dlq-1',
  originalJobId: 'job-1',
  queue: 'webhook-deliveries',
  jobName: 'deliver',
  payload: { webhook: { id: 'wh-1', username: 'alice', secret: '[REDACTED]' } },
  attemptsMade: 5,
  maxAttempts: 5,
  failureReason: 'Webhook responded with HTTP 503',
  stack: 'Error: Webhook responded with HTTP 503',
  failedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockListDlqMessages.mockResolvedValue({
    available: true,
    messages: [message()],
    total: 1,
    page: 1,
    limit: 20,
  });
  mockGetDlqMessage.mockResolvedValue(message());
  mockReplayDlqMessage.mockResolvedValue({ id: 'dlq-1', replayedJobId: 'job-1-replay-1', queue: 'webhook-deliveries' });
  mockReplayDlqMessages.mockResolvedValue({ replayed: ['a', 'b'], failed: [], capped: false });
  mockDiscardDlqMessage.mockResolvedValue({ id: 'dlq-1', discarded: true });
});

describe('GET /admin/dlq', () => {
  it('returns 401 without an API key', async () => {
    const res = await request(app).get(BASE);

    expect(res.status).toBe(401);
    expect(mockListDlqMessages).not.toHaveBeenCalled();
  });

  it('returns 401 with the wrong API key', async () => {
    const res = await request(app).get(BASE).set('x-api-key', 'wrong');

    expect(res.status).toBe(401);
  });

  it('lists messages with pagination metadata', async () => {
    const res = await asAdmin(request(app).get(BASE));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      available: true,
      meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
    });
    expect(res.body.messages[0]).toMatchObject({ id: 'dlq-1', attemptsMade: 5 });
  });

  it('passes the validated limit and page through', async () => {
    await asAdmin(request(app).get(`${BASE}?limit=5&page=3`));

    expect(mockListDlqMessages).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, page: 3 }),
    );
  });

  it('clamps an oversized limit instead of rejecting it', async () => {
    const res = await asAdmin(request(app).get(`${BASE}?limit=1000`));

    expect(res.status).toBe(200);
    expect(mockListDlqMessages).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('falls back to the default when the limit is not a number', async () => {
    const res = await asAdmin(request(app).get(`${BASE}?limit=abc`));

    expect(res.status).toBe(200);
    expect(mockListDlqMessages).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
    );
  });

  it('falls back to page 1 when the page is zero or negative', async () => {
    await asAdmin(request(app).get(`${BASE}?page=-4`));

    expect(mockListDlqMessages).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
  });

  it('reports available:false when Redis is not configured', async () => {
    mockListDlqMessages.mockResolvedValue({
      available: false,
      messages: [],
      total: 0,
      page: 1,
      limit: 20,
    });

    const res = await asAdmin(request(app).get(BASE));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, available: false, messages: [] });
  });
});

describe('GET /admin/dlq/:id', () => {
  it('returns 401 without an API key', async () => {
    const res = await request(app).get(`${BASE}/dlq-1`);

    expect(res.status).toBe(401);
  });

  it('returns the message with its payload redacted', async () => {
    const res = await asAdmin(request(app).get(`${BASE}/dlq-1`));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message.payload.webhook.secret).toBe('[REDACTED]');
    expect(res.body.message.failureReason).toBe('Webhook responded with HTTP 503');
  });

  it('returns 404 NOT_FOUND for an unknown id', async () => {
    mockGetDlqMessage.mockRejectedValue(new ApiError('NOT_FOUND', 'DLQ message nope not found'));

    const res = await asAdmin(request(app).get(`${BASE}/nope`));

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('POST /admin/dlq/:id/replay', () => {
  it('returns 401 without an API key', async () => {
    const res = await asAnonymous(request(app).post(`${BASE}/dlq-1/replay`));

    expect(res.status).toBe(401);
    expect(mockReplayDlqMessage).not.toHaveBeenCalled();
  });

  it('replays the message and reports the new job id', async () => {
    const res = await asAdmin(request(app).post(`${BASE}/dlq-1/replay`));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      replayed: true,
      replayedJobId: 'job-1-replay-1',
      queue: 'webhook-deliveries',
    });
  });

  it('returns 404 NOT_FOUND for an unknown id', async () => {
    mockReplayDlqMessage.mockRejectedValue(new ApiError('NOT_FOUND', 'DLQ message nope not found'));

    const res = await asAdmin(request(app).post(`${BASE}/nope/replay`));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('is recorded by the audit log middleware', async () => {
    await asAdmin(request(app).post(`${BASE}/dlq-1/replay`));
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ method: 'POST', userId: 'admin' }),
      }),
    );
  });
});

describe('POST /admin/dlq/replay', () => {
  it('returns 401 without an API key', async () => {
    const res = await asAnonymous(request(app).post(`${BASE}/replay`));

    expect(res.status).toBe(401);
  });

  it('replays a batch with an empty body', async () => {
    const res = await asAdmin(request(app).post(`${BASE}/replay`).send({}));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, replayed: 2, failed: [], capped: false });
  });

  it('passes the batch filter through', async () => {
    await asAdmin(request(app).post(`${BASE}/replay`).send({ limit: 10, username: 'alice' }));

    expect(mockReplayDlqMessages).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, username: 'alice' }),
    );
  });

  it('caps an oversized batch limit', async () => {
    await asAdmin(request(app).post(`${BASE}/replay`).send({ limit: 5000 }));

    expect(mockReplayDlqMessages).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('reports per-message failures without failing the whole batch', async () => {
    mockReplayDlqMessages.mockResolvedValue({
      replayed: ['a'],
      failed: [{ id: 'dlq-9', error: 'CONFLICT' }],
      capped: true,
    });

    const res = await asAdmin(request(app).post(`${BASE}/replay`).send({}));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      replayed: 1,
      capped: true,
      failed: [{ id: 'dlq-9', error: 'CONFLICT' }],
    });
  });

  it('falls back to the default when the batch limit is not a number', async () => {
    const res = await asAdmin(request(app).post(`${BASE}/replay`).send({ limit: 'lots' }));

    expect(res.status).toBe(200);
    expect(mockReplayDlqMessages).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });
});

describe('DELETE /admin/dlq/:id', () => {
  it('returns 401 without an API key', async () => {
    const res = await asAnonymous(request(app).delete(`${BASE}/dlq-1`));

    expect(res.status).toBe(401);
    expect(mockDiscardDlqMessage).not.toHaveBeenCalled();
  });

  it('discards the message', async () => {
    const res = await asAdmin(request(app).delete(`${BASE}/dlq-1`));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, id: 'dlq-1', discarded: true });
  });

  it('returns 404 NOT_FOUND for an unknown id', async () => {
    mockDiscardDlqMessage.mockRejectedValue(new ApiError('NOT_FOUND', 'DLQ message nope not found'));

    const res = await asAdmin(request(app).delete(`${BASE}/nope`));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('is recorded by the audit log middleware', async () => {
    await asAdmin(request(app).delete(`${BASE}/dlq-1`));
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ method: 'DELETE' }),
      }),
    );
  });
});

describe('DLQ without Redis', () => {
  it('answers 503 SERVICE_UNAVAILABLE when a message operation needs Redis', async () => {
    mockGetDlqMessage.mockRejectedValue(
      new ApiError('SERVICE_UNAVAILABLE', 'The dead letter queue requires Redis'),
    );

    const res = await asAdmin(request(app).get(`${BASE}/dlq-1`));

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('idempotency', () => {
  it('rejects a replay with no Idempotency-Key', async () => {
    const res = await request(app)
      .post(`${BASE}/dlq-1/replay`)
      .set('x-api-key', 'test-admin-key');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Idempotency-Key/);
    expect(mockReplayDlqMessage).not.toHaveBeenCalled();
  });

  it('replays only once when the same key is retried', async () => {
    const first = await request(app)
      .post(`${BASE}/dlq-1/replay`)
      .set('x-api-key', 'test-admin-key')
      .set('Idempotency-Key', 'replay-once');
    const second = await request(app)
      .post(`${BASE}/dlq-1/replay`)
      .set('x-api-key', 'test-admin-key')
      .set('Idempotency-Key', 'replay-once');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect(mockReplayDlqMessage).toHaveBeenCalledTimes(1);
  });
});
