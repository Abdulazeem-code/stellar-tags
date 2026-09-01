// Mock node-cron to prevent real cron jobs in tests
jest.mock('node-cron', () => ({
  schedule: jest.fn(),
}));

const webhookWorker = require('../src/webhookWorker');
const {
  getWebhooksExhaustedRetries,
  moveToDLQ,
  listDLQEntries,
  replayFromDLQ,
} = webhookWorker;

const { prisma } = require('../prismaClient');

// Mock global.fetch for sendWebhook calls
global.fetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetAllMocks();

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
});

describe('getWebhooksExhaustedRetries', () => {
  it('returns webhooks whose failingSince is older than MAX_RETRY_BACKLOG_DAYS', async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 5); // 5 days ago, > 3

    prisma.webhook.findMany.mockResolvedValue([
      {
        id: 'wh-1', username: 'alice', url: 'https://example.com/hook',
        secret: 's1', failingSince: oldDate,
      },
    ]);

    const result = await getWebhooksExhaustedRetries(prisma);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('wh-1');
    // Verify where clause includes lt cutoff
    const callArgs = prisma.webhook.findMany.mock.calls[0][0];
    expect(callArgs.where.failingSince).toBeDefined();
    expect(callArgs.where.failingSince.not).toBe(null);
  });

  it('excludes webhooks still within the retry window', async () => {
    // Default mock returns [], which means nothing qualifies
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

    await moveToDLQ(prisma, async () => {}, webhook);

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

    const { entries, total } = await listDLQEntries(prisma, async () => []);

    expect(total).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('dlq-1');
  });

  it('filters by username when provided', async () => {
    prisma.webhookDLQ.findMany.mockResolvedValue([]);
    prisma.webhookDLQ.count.mockResolvedValue(0);

    await listDLQEntries(prisma, async () => [], { username: 'alice' });

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

    const result = await replayFromDLQ(prisma, async () => {}, 'dlq-1');

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

    const result = await replayFromDLQ(prisma, async () => {}, 'nonexistent');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('DLQ entry not found');
  });

  it('returns error for already-replayed DLQ entry', async () => {
    prisma.webhookDLQ.findUnique.mockResolvedValue({
      id: 'dlq-1', replayed: true,
    });

    const result = await replayFromDLQ(prisma, async () => {}, 'dlq-1');

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

    // Make fetch fail to simulate a delivery failure
    global.fetch.mockRejectedValue(new Error('Connection refused'));

    const result = await replayFromDLQ(prisma, async () => {}, 'dlq-1');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Connection refused');
    expect(prisma.webhookDLQ.update).toHaveBeenCalled();
    const updateCall = prisma.webhookDLQ.update.mock.calls[0][0];
    expect(updateCall.data.deliveryAttempts).toBe(3);
  });
});