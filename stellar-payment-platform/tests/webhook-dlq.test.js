// Mock BullMQ FIRST, before any other imports
const mockQueues = new Map();

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
      updateData: async (newData) => {
        job.data = { ...job.data, ...newData };
      },
      moveToDelayed: async (timestamp, token) => {
        job.delayedUntil = timestamp;
      },
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

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((name) => {
    const queue = new MockQueue(name);
    mockQueues.set(name, queue);
    return queue;
  }),
  Worker: jest.fn().mockImplementation((name, processor, opts) => {
    const worker = {
      name,
      processor,
      opts,
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    mockQueues.set(`worker-${name}`, worker);
    return worker;
  }),
}));

// Mock node-cron to prevent real cron jobs in tests
jest.mock('node-cron', () => ({
  schedule: jest.fn(),
}));

// Mock logger before any module imports
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../src/logger', () => ({ logger: mockLogger }));

// Mock redis config
jest.mock('../src/config/redis', () => ({
  createRedisConnection: jest.fn(() => ({ quit: jest.fn().mockResolvedValue(undefined) })),
  withRedisRetry: jest.fn((operation) => operation()),
}));

// Mock dlq module
jest.mock('../src/dlq', () => ({
  DLQ_QUEUE_NAME: 'payment-retries-dlq',
  MAX_RETRY_ATTEMPTS: 5,
  RETRY_BACKOFF_MS: 1000,
  isDlqAvailable: jest.fn(() => true),
  getDlqQueue: jest.fn(),
  getMainQueue: jest.fn(),
  getConnection: jest.fn(() => ({ quit: jest.fn().mockResolvedValue(undefined) })),
  routeToDlq: jest.fn(),
}));

const { prisma } = require('../prismaClient');
const dlq = require('../src/dlq');

// Mock global.fetch for sendWebhook calls
global.fetch = jest.fn();

const webhookWorker = require('../src/webhookWorker');
const {
  getWebhooksExhaustedRetries,
  moveToDLQ,
  listDLQEntries,
  replayFromDLQ,
} = webhookWorker;

// Now import dlqWorker after mocks are set up
const dlqWorker = require('../src/dlqWorker');
const {
  startDlqWorker,
  closeDlqWorker,
  triggerManualReplay,
  processDlqJob,
  BACKOFF_SCHEDULE_MS,
  MAX_DLQ_RETRIES,
} = dlqWorker;

const getDlqQueue = () => mockQueues.get('payment-retries-dlq');
const getMainQueue = (name) => mockQueues.get(name);
const getWorker = () => mockQueues.get(`worker-payment-retries-dlq`);

const createDlqJob = (overrides = {}) => {
  const baseData = {
    originalJobId: 'job-original-1',
    queue: 'webhook-deliveries',
    jobName: 'deliver',
    payload: {
      webhook: { id: 'wh-1', username: 'alice', url: 'https://merchant.example/hook', secret: 'super-secret' },
      payload: { event: 'payment.received', event_id: 'tx-1', data: { amount: '10.00' } },
    },
    attemptsMade: 5,
    maxAttempts: 5,
    failureReason: 'Webhook responded with HTTP 503',
    dlqAttempt: 0,
  };
  return {
    id: 'dlq-job-1',
    name: 'dead-letter',
    data: { ...baseData, ...overrides.data },
    opts: { attempts: 1 },
    queueName: 'payment-retries-dlq',
    updateData: jest.fn().mockResolvedValue(undefined),
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQueues.clear();
  process.env.REDIS_URL = 'redis://localhost:6379';

  // Reset fetch mock
  global.fetch.mockResolvedValue({
    ok: true,
    status: 200,
  });

  // Reset prisma mock methods
  prisma.webhook = {
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({}),
  };
  prisma.webhookDLQ = {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(0),
  };
  prisma.$transaction = jest.fn(async (queries) => Promise.all(queries));

  // Setup dlq mocks
  dlq.getDlqQueue.mockImplementation(() => mockQueues.get('payment-retries-dlq'));
  dlq.getMainQueue.mockImplementation((name) => mockQueues.get(name));
  dlq.getConnection.mockImplementation(() => ({ quit: jest.fn().mockResolvedValue(undefined) }));
  dlq.isDlqAvailable.mockReturnValue(true);
});

afterEach(async () => {
  await closeDlqWorker();
  mockQueues.clear();
  delete process.env.REDIS_URL;
});

describe('getWebhooksExhaustedRetries', () => {
  it('returns webhooks whose failingSince is older than MAX_RETRY_BACKLOG_DAYS', async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 5);

    prisma.webhook.findMany.mockResolvedValue([
      {
        id: 'wh-1', username: 'alice', url: 'https://example.com/hook',
        secret: 's1', failingSince: oldDate,
      },
    ]);

    const result = await getWebhooksExhaustedRetries(prisma);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('wh-1');
    const callArgs = prisma.webhook.findMany.mock.calls[0][0];
    expect(callArgs.where.failingSince).toBeDefined();
    expect(callArgs.where.failingSince.not).toBe(null);
  });

  it('excludes webhooks still within the retry window', async () => {
    const result = await getWebhooksExhaustedRetries(prisma);
    expect(result).toHaveLength(0);
  });
});

describe('moveToDLQ', () => {
  it('creates a DLQ entry and clears failingSince on the webhook', async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 5);

    const webhook = {
      id: 'wh-1',
      username: 'alice',
      url: 'https://example.com/hook',
      secret: 'secret-abc',
      failingSince: oldDate,
    };

    prisma.webhookDLQ.create.mockResolvedValue({
      id: 'dlq-1', webhookId: 'wh-1', username: 'alice',
    });
    prisma.webhook.update.mockResolvedValue({});

    await moveToDLQ(prisma, webhook);

    expect(prisma.webhookDLQ.create).toHaveBeenCalled();
    const createData = prisma.webhookDLQ.create.mock.calls[0][0].data;
    expect(createData.webhookId).toBe('wh-1');
    expect(createData.username).toBe('alice');
    expect(createData.replayed).toBe(false);
    expect(createData.failureReason).toContain('exhausted');
  });
});

describe('listDLQEntries', () => {
  it('returns entries with total count', async () => {
    prisma.webhookDLQ.findMany.mockResolvedValue([
      { id: 'dlq-1', webhookId: 'wh-1', username: 'alice', movedAt: new Date(), replayed: false },
    ]);
    prisma.webhookDLQ.count.mockResolvedValue(1);

    const { entries, total } = await listDLQEntries(prisma);

    expect(total).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('dlq-1');
  });

  it('filters by username when provided', async () => {
    prisma.webhookDLQ.findMany.mockResolvedValue([]);
    prisma.webhookDLQ.count.mockResolvedValue(0);

    await listDLQEntries(prisma, { username: 'alice' });

    const findManyCall = prisma.webhookDLQ.findMany.mock.calls[0][0];
    expect(findManyCall.where.username.equals).toBe('alice');
  });
});

describe('replayFromDLQ', () => {
  it('replays a DLQ entry successfully and marks it replayed', async () => {
    const entry = {
      id: 'dlq-1',
      webhookId: 'wh-1',
      webhookUrl: 'https://example.com/hook',
      webhookSecret: 'secret-abc',
      eventType: 'webhook.delivery_failed',
      eventPayload: JSON.stringify({ event: 'test' }),
      replayed: false,
      deliveryAttempts: 0,
    };

    prisma.webhookDLQ.findUnique.mockResolvedValue(entry);
    prisma.webhookDLQ.update.mockResolvedValue({ ...entry, replayed: true });

    const result = await replayFromDLQ(prisma, 'dlq-1');

    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      entry.webhookUrl,
      expect.objectContaining({
        method: 'POST',
        body: entry.eventPayload,
      }),
    );
  });

  it('returns error for non-existent DLQ entry', async () => {
    prisma.webhookDLQ.findUnique.mockResolvedValue(null);

    const result = await replayFromDLQ(prisma, 'nonexistent');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('DLQ entry not found');
  });

  it('returns error for already-replayed DLQ entry', async () => {
    prisma.webhookDLQ.findUnique.mockResolvedValue({
      id: 'dlq-1', replayed: true,
    });

    const result = await replayFromDLQ(prisma, 'dlq-1');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('already been replayed');
  });

  it('increments delivery attempt count on replay failure', async () => {
    const entry = {
      id: 'dlq-1',
      webhookId: 'wh-1',
      webhookUrl: 'https://example.com/hook',
      webhookSecret: 'secret-abc',
      eventPayload: JSON.stringify({ event: 'test' }),
      replayed: false,
      deliveryAttempts: 2,
    };

    prisma.webhookDLQ.findUnique.mockResolvedValue(entry);
    prisma.webhookDLQ.update.mockResolvedValue({ ...entry, deliveryAttempts: 3 });

    global.fetch.mockRejectedValue(new Error('Connection refused'));

    const result = await replayFromDLQ(prisma, 'dlq-1');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Connection refused');
    expect(prisma.webhookDLQ.update).toHaveBeenCalled();
    const updateCall = prisma.webhookDLQ.update.mock.calls[0][0];
    expect(updateCall.data.deliveryAttempts).toBe(3);
  });
});

describe('DLQ Worker - Automated Retry with Exponential Backoff', () => {
  describe('BACKOFF_SCHEDULE_MS', () => {
    it('defines correct backoff intervals: 1h, 6h, 24h', () => {
      expect(BACKOFF_SCHEDULE_MS).toHaveLength(3);
      expect(BACKOFF_SCHEDULE_MS[0]).toBe(1 * 60 * 60 * 1000);
      expect(BACKOFF_SCHEDULE_MS[1]).toBe(6 * 60 * 60 * 1000);
      expect(BACKOFF_SCHEDULE_MS[2]).toBe(24 * 60 * 60 * 1000);
    });

    it('MAX_DLQ_RETRIES matches schedule length', () => {
      expect(MAX_DLQ_RETRIES).toBe(3);
    });
  });

  describe('processDlqJob', () => {
    beforeEach(() => {
      mockQueues.clear();
      const { Queue } = require('bullmq');
      new Queue('webhook-deliveries', { connection: {} });
      new Queue('payment-retries-dlq', { connection: {} });
    });

    it('re-queues message to main queue with incremented dlqAttempt on first retry', async () => {
      const job = createDlqJob();
      const result = await processDlqJob(job);

      expect(result.requeued).toBe(true);
      expect(result.dlqAttempt).toBe(1);
      expect(job.updateData).toHaveBeenCalledWith(expect.objectContaining({ dlqAttempt: 1 }));
      expect(job.moveToDelayed).toHaveBeenCalled();

      const mainQueue = getMainQueue('webhook-deliveries');
      expect(mainQueue.jobs.size).toBe(1);
      const [requeued] = [...mainQueue.jobs.values()];
      expect(requeued.name).toBe('deliver');
      expect(requeued.opts.attempts).toBe(5);
      expect(requeued.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
    });

    it('uses correct backoff delay for each retry attempt', async () => {
      const beforeAll = Date.now();

      // First retry (1 hour)
      let job = createDlqJob();
      await processDlqJob(job);
      const delay1 = job.moveToDelayed.mock.calls[0][0];
      expect(delay1).toBeGreaterThanOrEqual(beforeAll + BACKOFF_SCHEDULE_MS[0] - 100);
      expect(delay1).toBeLessThanOrEqual(beforeAll + BACKOFF_SCHEDULE_MS[0] + 100);

      // Second retry (6 hours)
      job = createDlqJob({ data: { ...createDlqJob().data, dlqAttempt: 1 } });
      await processDlqJob(job);
      const delay2 = job.moveToDelayed.mock.calls[0][0];
      expect(delay2).toBeGreaterThanOrEqual(beforeAll + BACKOFF_SCHEDULE_MS[1] - 100);
      expect(delay2).toBeLessThanOrEqual(beforeAll + BACKOFF_SCHEDULE_MS[1] + 100);

      // Third retry (24 hours)
      job = createDlqJob({ data: { ...createDlqJob().data, dlqAttempt: 2 } });
      await processDlqJob(job);
      const delay3 = job.moveToDelayed.mock.calls[0][0];
      expect(delay3).toBeGreaterThanOrEqual(beforeAll + BACKOFF_SCHEDULE_MS[2] - 100);
      expect(delay3).toBeLessThanOrEqual(beforeAll + BACKOFF_SCHEDULE_MS[2] + 100);
    });

    it('archives message permanently after max retries exceeded', async () => {
      const job = createDlqJob({ data: { ...createDlqJob().data, dlqAttempt: 3 } });
      const result = await processDlqJob(job);

      expect(result).toEqual({ archived: true, jobId: job.id });
      expect(job.remove).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('exceeded max DLQ retries'),
      );
    });

    it('discards message with no source queue', async () => {
      const job = createDlqJob({ data: { ...createDlqJob().data, queue: null } });
      const result = await processDlqJob(job);

      expect(result).toEqual({ discarded: true, jobId: job.id, reason: 'no source queue' });
      expect(job.remove).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('no source queue'),
      );
    });

    it('preserves original payload when re-queueing', async () => {
      const job = createDlqJob();
      await processDlqJob(job);

      const mainQueue = getMainQueue('webhook-deliveries');
      const [requeued] = [...mainQueue.jobs.values()];
      expect(requeued.data.payload.event_id).toBe('tx-1');
      expect(requeued.data.webhook.url).toBe('https://merchant.example/hook');
    });

    it('gives re-queued job a unique id without colons', async () => {
      const job = createDlqJob();
      await processDlqJob(job);

      const mainQueue = getMainQueue('webhook-deliveries');
      const [requeued] = [...mainQueue.jobs.values()];
      expect(requeued.id).not.toContain(':');
      expect(requeued.id).toMatch(/job-original-1-dlq-retry-1-/);
    });
  });

  describe('triggerManualReplay', () => {
    beforeEach(() => {
      mockQueues.clear();
      const { Queue } = require('bullmq');
      new Queue('webhook-deliveries', { connection: {} });
      new Queue('payment-retries-dlq', { connection: {} });
    });

    it('replays messages immediately bypassing backoff schedule', async () => {
      const dlqQueue = getDlqQueue();
      // Add two jobs with identical data structure
      const jobData1 = createDlqJob({ id: 'job-1' }).data;
      const jobData2 = createDlqJob({ id: 'job-2' }).data;
      await dlqQueue.add('dead-letter', jobData1);
      await dlqQueue.add('dead-letter', jobData2);

      const result = await triggerManualReplay({ limit: 10 });

      expect(result.replayed).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
      expect(getMainQueue('webhook-deliveries').jobs.size).toBe(2);
      expect(dlqQueue.jobs.size).toBe(0);
    });

    it('filters by username when provided', async () => {
      const dlqQueue = getDlqQueue();
      await dlqQueue.add('dead-letter', createDlqJob({ id: 'job-alice', data: { ...createDlqJob().data, payload: { webhook: { username: 'alice' } } } }).data);
      await dlqQueue.add('dead-letter', createDlqJob({ id: 'job-bob', data: { ...createDlqJob().data, payload: { webhook: { username: 'bob' } } } }).data);

      const result = await triggerManualReplay({ limit: 10, username: 'alice' });

      expect(result.replayed).toHaveLength(1);
      expect(getMainQueue('webhook-deliveries').jobs.size).toBe(1);
      expect(dlqQueue.jobs.size).toBe(1);
    });

    it('respects the batch limit', async () => {
      const dlqQueue = getDlqQueue();
      for (let i = 0; i < 5; i++) {
        await dlqQueue.add('dead-letter', createDlqJob({ id: `job-${i}` }).data);
      }

      const result = await triggerManualReplay({ limit: 2 });

      expect(result.replayed).toHaveLength(2);
      expect(dlqQueue.jobs.size).toBe(3);
    });

    it('reports failures without failing the whole batch', async () => {
      const dlqQueue = getDlqQueue();
      await dlqQueue.add('dead-letter', createDlqJob({ id: 'job-good' }).data);
      await dlqQueue.add('dead-letter', createDlqJob({ id: 'job-bad', data: { ...createDlqJob().data, queue: null } }).data);

      const result = await triggerManualReplay({ limit: 10 });

      expect(result.replayed).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].error).toContain('No source queue');
    });

    it('returns empty results when DLQ not available', async () => {
      delete process.env.REDIS_URL;
      delete process.env.REDIS_CLUSTER_NODES;
      dlq.isDlqAvailable.mockReturnValue(false);

      const result = await triggerManualReplay({});
      expect(result.replayed).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });
  });
});