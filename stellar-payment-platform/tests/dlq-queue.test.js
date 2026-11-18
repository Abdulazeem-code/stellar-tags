'use strict';

/**
 * tests/dlq-queue.test.js
 *
 * Covers the dead letter queue: routing an exhausted job into it, the graceful
 * degradation when Redis is not configured, replay/discard, and the
 * rate-limited depth alert.
 *
 * BullMQ and the Redis connection are mocked because the suite runs without a
 * Redis server; everything else (payload shaping, redaction, job options) is
 * the real module.
 */

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../src/logger', () => ({ logger: mockLogger, httpLogger: (req, res, next) => next() }));

// BullMQ stands in for a live Redis: an in-memory queue that honours the slice
// of getJobs() and the counting the DLQ module relies on.
class MockQueue {
  constructor(name) {
    this.name = name;
    this.jobs = new Map();
    this.seq = 0;
    this.closed = false;
  }

  on() {
    return this;
  }

  async add(name, data, opts = {}) {
    this.seq += 1;
    const id = opts.jobId || `${this.name}-${this.seq}`;
    const job = {
      id,
      name,
      data,
      opts,
      queueName: this.name,
      attemptsMade: 0,
      remove: async () => {
        this.jobs.delete(id);
      },
    };
    this.jobs.set(id, job);
    return job;
  }

  async getJob(id) {
    return this.jobs.get(id) || null;
  }

  // BullMQ returns newest first when `asc` is false.
  async getJobs(_types, start = 0, end = -1, asc = false) {
    const ordered = asc ? [...this.jobs.values()] : [...this.jobs.values()].reverse();
    return ordered.slice(start, end === -1 ? undefined : end + 1);
  }

  async getWaitingCount() {
    return this.jobs.size;
  }

  async close() {
    this.closed = true;
  }
}

const mockQueues = new Map();
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((name) => {
    const queue = new MockQueue(name);
    mockQueues.set(name, queue);
    return queue;
  }),
  Worker: jest.fn(),
}));

const mockQuit = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/config/redis', () => ({
  createRedisConnection: jest.fn(() => ({ quit: mockQuit })),
  withRedisRetry: jest.fn((operation) => operation()),
}));

const dlq = require('../src/dlq');

const exhaustedJob = (overrides = {}) => ({
  id: 'job-original-1',
  name: 'deliver',
  queueName: 'webhook-deliveries',
  attemptsMade: 5,
  opts: { attempts: 5 },
  data: {
    webhook: { id: 'wh-1', username: 'alice', url: 'https://merchant.example/hook', secret: 'super-secret' },
    payload: { event: 'payment.received', event_id: 'tx-1', data: { amount: '10.00' } },
  },
  ...overrides,
});

const failure = () => {
  const error = new Error('Webhook responded with HTTP 503');
  return error;
};

const dlqQueue = () => mockQueues.get(dlq.DLQ_QUEUE_NAME);
const mainQueue = () => mockQueues.get('webhook-deliveries');

beforeEach(() => {
  jest.clearAllMocks();
  mockQueues.clear();
  process.env.REDIS_URL = 'redis://localhost:6379';
  dlq._resetAlertState();
});

afterEach(async () => {
  await dlq.closeDlqQueue();
  mockQueues.clear();
  delete process.env.REDIS_URL;
});

describe('routing an exhausted job to the DLQ', () => {
  test('preserves the payload, original job id, attempts, reason, stack and failedAt', async () => {
    const error = failure();
    const result = await dlq.routeToDlq(exhaustedJob(), error);

    expect(result).toMatchObject({
      originalJobId: 'job-original-1',
      queue: 'webhook-deliveries',
      jobName: 'deliver',
      attemptsMade: 5,
      maxAttempts: 5,
      failureReason: 'Webhook responded with HTTP 503',
    });
    // The real payload survives, which is what the previous Prisma DLQ lost.
    expect(result.payload.payload.event_id).toBe('tx-1');
    expect(result.payload.webhook.url).toBe('https://merchant.example/hook');
    expect(result.stack).toContain('Error: Webhook responded with HTTP 503');
    expect(new Date(result.failedAt).toString()).not.toBe('Invalid Date');
  });

  test('lands the message on the dedicated DLQ queue, not the main queue', async () => {
    await dlq.routeToDlq(exhaustedJob(), failure());

    expect(dlq.DLQ_QUEUE_NAME).toBe('payment-retries-dlq');
    expect(dlqQueue().jobs.size).toBe(1);
    expect(mainQueue()).toBeUndefined();
  });

  test('is not retried and is never auto-removed once parked', async () => {
    await dlq.routeToDlq(exhaustedJob(), failure());

    const [parked] = [...dlqQueue().jobs.values()];

    expect(parked.opts.attempts).toBe(1);
    expect(parked.opts.removeOnComplete).toBe(false);
    expect(parked.opts.removeOnFail).toBe(false);
  });

  test('truncates an oversized stack rather than storing all of it', async () => {
    const error = new Error('boom');
    error.stack = 'x'.repeat(dlq.MAX_STACK_LENGTH + 500);

    const result = await dlq.routeToDlq(exhaustedJob(), error);

    expect(result.stack.endsWith('...[truncated]')).toBe(true);
    expect(result.stack.length).toBe(dlq.MAX_STACK_LENGTH + '...[truncated]'.length);
  });

  test('counts every message routed to the DLQ', async () => {
    const before = await counterValue();

    await dlq.routeToDlq(exhaustedJob(), failure());
    await dlq.routeToDlq(exhaustedJob({ id: 'job-original-2' }), failure());

    expect(await counterValue()).toBe(before + 2);
  });
});

// The counter is a process-wide prom-client instance, so its value is read
// through the registry rather than a module-level handle.
async function counterValue() {
  const { register } = require('prom-client');
  const metric = register.getSingleMetric('stellar_tags_dlq_messages_total');
  const { values } = await metric.get();
  return values.reduce((sum, entry) => sum + entry.value, 0);
}

describe('graceful degradation without Redis', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_CLUSTER_NODES;
  });

  test('reports Redis as not configured and never opens a queue', () => {
    expect(dlq.isRedisConfigured()).toBe(false);
    expect(dlq.isDlqAvailable()).toBe(false);
    expect(dlq.getDlqQueue()).toBeNull();
  });

  test('returns null from routeToDlq so the caller can keep its old behaviour', async () => {
    await expect(dlq.routeToDlq(exhaustedJob(), failure())).resolves.toBeNull();
  });

  test('reports zero depth instead of failing a scrape', async () => {
    await expect(dlq.getDlqDepth()).resolves.toBe(0);
  });

  test('lists an empty page rather than erroring', async () => {
    await expect(dlq.listDlqMessages()).resolves.toEqual({
      available: false,
      messages: [],
      total: 0,
      page: 1,
      limit: dlq.DEFAULT_PAGE_SIZE,
    });
  });

  test('answers SERVICE_UNAVAILABLE for get, replay, bulk replay and discard', async () => {
    for (const call of [
      () => dlq.getDlqMessage('any'),
      () => dlq.replayDlqMessage('any'),
      () => dlq.replayDlqMessages(),
      () => dlq.discardDlqMessage('any'),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        statusCode: 503,
      });
    }
  });

  test('treats REDIS_CLUSTER_NODES alone as configured', () => {
    process.env.REDIS_CLUSTER_NODES = 'redis-1:6379';
    expect(dlq.isRedisConfigured()).toBe(true);
  });
});

describe('listing and reading messages', () => {
  beforeEach(async () => {
    await dlq.routeToDlq(exhaustedJob({ id: 'job-a' }), failure());
    await dlq.routeToDlq(exhaustedJob({ id: 'job-b' }), failure());
  });

  test('lists newest first with the total', async () => {
    const { messages, total, page, limit } = await dlq.listDlqMessages({ limit: 10, page: 1 });

    expect(total).toBe(2);
    expect(page).toBe(1);
    expect(limit).toBe(10);
    expect(messages.map((m) => m.originalJobId)).toEqual(['job-b', 'job-a']);
  });

  test('clamps the page size and the page number', async () => {
    const capped = await dlq.listDlqMessages({ limit: 10_000, page: 0 });

    expect(capped.limit).toBe(dlq.MAX_PAGE_SIZE);
    expect(capped.page).toBe(1);
  });

  test('narrows the listing to one merchant', async () => {
    const other = exhaustedJob({ id: 'job-c' });
    other.data.webhook.username = 'bob';
    await dlq.routeToDlq(other, failure());

    const { messages, total } = await dlq.listDlqMessages({ username: 'alice' });

    expect(total).toBe(2);
    expect(messages.every((m) => m.payload.webhook.username === 'alice')).toBe(true);
  });

  test('redacts the webhook secret in returned payloads', async () => {
    const { messages } = await dlq.listDlqMessages();
    const withPayload = messages.find((m) => m.payload && m.payload.webhook);

    expect(withPayload.payload.webhook.secret).toBe('[REDACTED]');
    // Non-secret fields stay readable, otherwise the message is useless.
    expect(withPayload.payload.webhook.url).toBe('https://merchant.example/hook');
  });

  test('reads a single message by id', async () => {
    const [first] = (await dlq.listDlqMessages()).messages;

    const message = await dlq.getDlqMessage(first.id);

    expect(message.id).toBe(first.id);
    expect(message.failureReason).toBe('Webhook responded with HTTP 503');
  });

  test('answers NOT_FOUND for an unknown id', async () => {
    await expect(dlq.getDlqMessage('does-not-exist')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('replay', () => {
  beforeEach(async () => {
    await dlq.routeToDlq(exhaustedJob(), failure());
  });

  test('re-enqueues onto the main queue with the attempt budget reset', async () => {
    const [message] = (await dlq.listDlqMessages()).messages;

    const result = await dlq.replayDlqMessage(message.id);

    const target = mainQueue();
    expect(result.queue).toBe('webhook-deliveries');
    expect(target.jobs.size).toBe(1);

    const [replayed] = [...target.jobs.values()];
    // A replay starts fresh: full attempts, and attemptsMade back at zero
    // rather than inheriting the exhausted count from the failed job.
    expect(replayed.opts.attempts).toBe(dlq.MAX_RETRY_ATTEMPTS);
    expect(replayed.attemptsMade).toBe(0);
    expect(replayed.opts.backoff).toEqual({
      type: 'exponential',
      delay: dlq.RETRY_BACKOFF_MS,
    });
  });

  test('carries the original payload back onto the main queue', async () => {
    const [message] = (await dlq.listDlqMessages()).messages;

    await dlq.replayDlqMessage(message.id);

    const [replayed] = [...mainQueue().jobs.values()];
    expect(replayed.data.payload.event_id).toBe('tx-1');
    expect(replayed.name).toBe('deliver');
  });

  test('removes the message from the DLQ once replayed', async () => {
    const [message] = (await dlq.listDlqMessages()).messages;

    await dlq.replayDlqMessage(message.id);

    expect(dlqQueue().jobs.size).toBe(0);
  });

  test('gives the replayed job its own id, since BullMQ rejects ":" in custom ids', async () => {
    const [message] = (await dlq.listDlqMessages()).messages;

    await dlq.replayDlqMessage(message.id);

    const [replayed] = [...mainQueue().jobs.values()];
    expect(replayed.id).not.toContain(':');
    expect(replayed.id).toMatch(/^job-original-1-replay-/);
  });

  test('answers NOT_FOUND for an unknown id', async () => {
    await expect(dlq.replayDlqMessage('nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });

  test('bulk replays up to the cap and reports what it did', async () => {
    await dlq.routeToDlq(exhaustedJob({ id: 'job-b' }), failure());
    await dlq.routeToDlq(exhaustedJob({ id: 'job-c' }), failure());

    const result = await dlq.replayDlqMessages({ limit: 2 });

    expect(result.replayed).toHaveLength(2);
    expect(result.failed).toEqual([]);
    expect(result.capped).toBe(true);
    expect(dlqQueue().jobs.size).toBe(1);
  });

  test('bulk replay caps the batch size so one call cannot flood the queue', async () => {
    await dlq.routeToDlq(exhaustedJob({ id: 'job-b' }), failure());

    const result = await dlq.replayDlqMessages({ limit: 100_000 });

    expect(result.replayed.length).toBeLessThanOrEqual(dlq.MAX_REPLAY_BATCH_SIZE);
  });

  test('bulk replay can be narrowed to one merchant', async () => {
    const other = exhaustedJob({ id: 'job-b' });
    other.data.webhook.username = 'bob';
    await dlq.routeToDlq(other, failure());

    const result = await dlq.replayDlqMessages({ username: 'bob' });

    expect(result.replayed).toHaveLength(1);
    // Alice's message is untouched.
    expect(dlqQueue().jobs.size).toBe(1);
  });
});

describe('discard', () => {
  test('removes the message without replaying it', async () => {
    await dlq.routeToDlq(exhaustedJob(), failure());
    const [message] = (await dlq.listDlqMessages()).messages;

    const result = await dlq.discardDlqMessage(message.id);

    expect(result).toEqual({ id: message.id, discarded: true });
    expect(dlqQueue().jobs.size).toBe(0);
    expect(mainQueue()).toBeUndefined();
  });

  test('answers NOT_FOUND for an unknown id', async () => {
    await expect(dlq.discardDlqMessage('nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('depth alert', () => {
  test('logs an error once the depth reaches the threshold', () => {
    expect(dlq.maybeAlertOnDepth(dlq.DLQ_ALERT_THRESHOLD)).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('DLQ_ALERT_THRESHOLD'));
  });

  test('stays quiet below the threshold', () => {
    expect(dlq.maybeAlertOnDepth(dlq.DLQ_ALERT_THRESHOLD - 1)).toBe(false);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  test('is rate limited so a queue that stays deep does not log on every job', () => {
    let clock = 1_000_000;
    dlq._setNow(() => clock);

    expect(dlq.maybeAlertOnDepth(50)).toBe(true);
    expect(dlq.maybeAlertOnDepth(51)).toBe(false);
    clock += dlq.DLQ_ALERT_COOLDOWN_MS + 1;
    expect(dlq.maybeAlertOnDepth(52)).toBe(true);

    dlq._setNow(() => Date.now());
  });

  test('re-arms as soon as the queue drains back below the threshold', () => {
    let clock = 2_000_000;
    dlq._setNow(() => clock);

    expect(dlq.maybeAlertOnDepth(50)).toBe(true);
    expect(dlq.maybeAlertOnDepth(50)).toBe(false);
    clock += 1;
    expect(dlq.maybeAlertOnDepth(0)).toBe(false);
    expect(dlq.maybeAlertOnDepth(50)).toBe(true);

    dlq._setNow(() => Date.now());
  });
});
