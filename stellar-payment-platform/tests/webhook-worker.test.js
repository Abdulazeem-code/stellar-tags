const mockQueueAdd = jest.fn();
const mockQueueOn = jest.fn();
const mockQueueClose = jest.fn().mockResolvedValue(undefined);
const mockWorkerOn = jest.fn();
const mockWorkerClose = jest.fn().mockResolvedValue(undefined);
const mockCloseRabbitMQ = jest.fn().mockResolvedValue(undefined);
const mockWithQueueRetry = jest.fn((operation) => operation());
const mockRoutingKeyForEvent = jest.fn((event) =>
  `webhook.${String(event || 'deliver').toLowerCase()}`,
);

let mockWorkerProcessor;
let mockWorkerOptions;

jest.mock('../src/queue/rabbitmqQueue', () => ({
  Queue: jest.fn().mockImplementation((name, options) => ({
    name,
    options,
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
  withQueueRetry: mockWithQueueRetry,
  closeRabbitMQ: mockCloseRabbitMQ,
  routingKeyForEvent: mockRoutingKeyForEvent,
}));

const { Queue, Worker } = require('../src/queue/rabbitmqQueue');
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

describe('webhook RabbitMQ delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterAll(async () => {
    await closeWebhookQueue();
    delete global.fetch;
  });

  test('enqueues deliveries with five attempts, exponential backoff and an event routing key', async () => {
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
        routingKey: 'webhook.payment.received',
      }),
    );
    expect(MAX_WEBHOOK_ATTEMPTS).toBe(5);
  });

  test('worker throws failed deliveries so RabbitMQ retries them', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 503 });
    const prisma = {
      webhook: {
        findUnique: jest.fn().mockResolvedValue({ failingSince: null }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    await expect(processWebhookJob(
      { data: { webhook, payload }, attemptsMade: 0 },
      { prisma },
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
      { prisma },
    );

    expect(prisma.webhook.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: webhook.id },
      data: expect.objectContaining({ failingSince: null }),
    }));
  });

  test('delivery includes timestamp-bound Stellar headers alongside legacy ones', async () => {
    const crypto = require('crypto');
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    const prisma = {
      webhook: {
        update: jest.fn().mockResolvedValue({}),
      },
    };

    await processWebhookJob(
      { data: { webhook, payload }, attemptsMade: 0 },
      { prisma, poolRunFn: jest.fn() },
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, options] = global.fetch.mock.calls[0];
    const rawBody = JSON.stringify(payload);
    const expectedLegacy = crypto.createHmac('sha256', webhook.secret).update(rawBody).digest('hex');
    const expectedBound = crypto
      .createHmac('sha256', webhook.secret)
      .update(`${payload.timestamp}.${rawBody}`)
      .digest('hex');

    expect(options.headers).toMatchObject({
      'X-Webhook-Signature': expectedLegacy,
      'X-Stellar-Tags-Signature': expectedLegacy,
      'X-Webhook-Timestamp': payload.timestamp,
      'Stellar-Signature': expectedBound,
      'Stellar-Timestamp': payload.timestamp,
    });
  });

  test('configures and starts an AMQP webhook worker', () => {
    const dependencies = {
      prisma: { webhook: {} },
    };

    startWebhookWorker(dependencies);

    expect(Worker).toHaveBeenCalledWith(
      WEBHOOK_QUEUE_NAME,
      expect.any(Function),
      expect.objectContaining({ concurrency: 5 }),
    );
    expect(mockWorkerOptions).not.toHaveProperty('connection');
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

  test('routes enqueues through the transient-failure retry helper', async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    await enqueueWebhookDelivery(webhook, payload, queue);

    expect(mockWithQueueRetry).toHaveBeenCalledTimes(1);
    expect(mockWithQueueRetry.mock.calls[0][0]).toEqual(expect.any(Function));
    expect(mockWithQueueRetry.mock.calls[0][1]).toEqual(
      expect.objectContaining({ attempts: expect.any(Number), baseDelayMs: expect.any(Number) }),
    );
  });

  test('creates a lazy AMQP queue when no queue is injected', async () => {
    mockQueueAdd.mockResolvedValue({ id: 'job-1' });

    await enqueueWebhookDelivery(webhook, payload);

    expect(Queue).toHaveBeenCalledWith(WEBHOOK_QUEUE_NAME);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  test('closeWebhookQueue closes the worker, the queue and the shared connection', async () => {
    await closeWebhookQueue();

    expect(mockWorkerClose).toHaveBeenCalled();
    expect(mockQueueClose).toHaveBeenCalled();
    expect(mockCloseRabbitMQ).toHaveBeenCalled();
  });
});
