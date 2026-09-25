const mockQueueAdd = jest.fn();
const mockQueueOn = jest.fn();
const mockQueueClose = jest.fn().mockResolvedValue(undefined);
const mockWorkerOn = jest.fn();
const mockWorkerClose = jest.fn().mockResolvedValue(undefined);
const mockRedisQuit = jest.fn().mockResolvedValue(undefined);

let mockWorkerProcessor;
let mockWorkerOptions;

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    on: mockQueueOn,
    close: mockQueueClose,
  })),
  Worker: jest.fn().mockImplementation((_name, processor, options) => {
    mockWorkerProcessor = processor;
    mockWorkerOptions = options;
    return {
      on: mockWorkerOn,
      close: mockWorkerClose,
    };
  }),
}));

jest.mock('../src/config/redis', () => ({
  createRedisConnection: jest.fn(() => ({ quit: mockRedisQuit })),
}));

const { Queue, Worker } = require('bullmq');
const {
  dispatchPaymentWebhooks,
  enqueueWebhookDelivery,
  startWebhookWorker,
  closeWebhookQueue,
  processWebhookJob,
  MAX_WEBHOOK_ATTEMPTS,
  WEBHOOK_BACKOFF_DELAY_MS,
  WEBHOOK_QUEUE_NAME,
} = require('../src/webhookWorker');

const webhook = {
  id: 'webhook-1',
  username: 'merchant',
  url: 'https://merchant.example/webhooks',
  secret: 'secret',
};

const payload = {
  event: 'payment.received',
  event_id: 'transaction-1-payment-1',
  timestamp: '2026-08-25T12:00:00.000Z',
  data: { amount: '10.00' },
};

describe('webhook BullMQ delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterAll(async () => {
    await closeWebhookQueue();
    delete global.fetch;
  });

  test('enqueues deliveries with five attempts and exponential backoff', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    await enqueueWebhookDelivery(webhook, payload, queue);

    expect(queue.add).toHaveBeenCalledWith(
      'deliver',
      { webhook, payload },
      expect.objectContaining({
        attempts: MAX_WEBHOOK_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: WEBHOOK_BACKOFF_DELAY_MS,
        },
        jobId: expect.any(String),
      }),
    );
    expect(MAX_WEBHOOK_ATTEMPTS).toBe(5);
  });

  test('worker throws failed deliveries so BullMQ retries them', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 503 });
    const prisma = {
      webhook: {
        findUnique: jest.fn().mockResolvedValue({ failingSince: null }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    await expect(processWebhookJob(
      { data: { webhook, payload }, attemptsMade: 0 },
      { prisma, poolRunFn: jest.fn() },
    )).rejects.toThrow('HTTP 503');

    expect(prisma.webhook.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: webhook.id },
      data: expect.objectContaining({ failingSince: expect.any(Date) }),
    }));
  });

  test('worker marks a recovered webhook as successful', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    const prisma = {
      webhook: {
        update: jest.fn().mockResolvedValue({}),
      },
    };

    await processWebhookJob(
      { data: { webhook, payload }, attemptsMade: 2 },
      { prisma, poolRunFn: jest.fn() },
    );

    expect(prisma.webhook.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: webhook.id },
      data: expect.objectContaining({ failingSince: null }),
    }));
  });

  test('configures and starts a BullMQ webhook worker', () => {
    const dependencies = {
      prisma: { webhook: {} },
      poolRunFn: jest.fn(),
    };

    startWebhookWorker(dependencies);

    expect(Worker).toHaveBeenCalledWith(
      WEBHOOK_QUEUE_NAME,
      expect.any(Function),
      expect.objectContaining({ concurrency: 5 }),
    );
    expect(mockWorkerOptions.connection).toEqual(expect.objectContaining({ quit: mockRedisQuit }));
    expect(mockWorkerProcessor).toEqual(expect.any(Function));
  });

  test('queues a payment event for every registered webhook', async () => {
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const prisma = {
      webhook: {
        findMany: jest.fn().mockResolvedValue([
          webhook,
          { ...webhook, id: 'webhook-2', url: 'https://second.example/webhooks' },
        ]),
      },
    };

    await dispatchPaymentWebhooks({
      prisma,
      poolGetFn: jest.fn(),
      queue,
      payment: {
        id: 'payment-1',
        type: 'payment',
        transaction_hash: 'transaction-1',
        to: 'GDESTINATION',
        from: 'GSOURCE',
        amount: '10.00',
        asset_type: 'native',
      },
    });

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      'deliver',
      expect.objectContaining({
        payload: expect.objectContaining({
          event: 'payment.received',
          event_id: 'transaction-1-payment-1',
        }),
      }),
      expect.objectContaining({ attempts: 5 }),
    );
  });

  test('creates a lazy queue when no queue is injected', async () => {
    mockQueueAdd.mockResolvedValue({ id: 'job-1' });

    await enqueueWebhookDelivery(webhook, payload);

    expect(Queue).toHaveBeenCalledWith(
      WEBHOOK_QUEUE_NAME,
      expect.objectContaining({ connection: expect.any(Object) }),
    );
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });
});
