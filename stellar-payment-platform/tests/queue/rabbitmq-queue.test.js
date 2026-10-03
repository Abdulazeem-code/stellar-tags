const mockChannel = {
  assertExchange: jest.fn().mockResolvedValue({}),
  assertQueue: jest.fn().mockResolvedValue({}),
  bindQueue: jest.fn().mockResolvedValue({}),
  publish: jest.fn(() => true),
  waitForConfirms: jest.fn().mockResolvedValue(undefined),
  prefetch: jest.fn().mockResolvedValue({}),
  consume: jest.fn().mockResolvedValue({ consumerTag: 'tag-1' }),
  ack: jest.fn(),
  nack: jest.fn(),
  cancel: jest.fn().mockResolvedValue({}),
  close: jest.fn().mockResolvedValue(undefined),
  once: jest.fn(),
  on: jest.fn(),
};

const mockConnection = {
  createChannel: jest.fn().mockResolvedValue(mockChannel),
  createConfirmChannel: jest.fn().mockResolvedValue(mockChannel),
  on: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
};

jest.mock('amqplib', () => ({ connect: jest.fn() }));

const amqp = require('amqplib');
const {
  Queue,
  Worker,
  createChannel,
  assertTopology,
  closeRabbitMQ,
  withQueueRetry,
  isTransientQueueError,
  routingKeyForEvent,
  DELIVERIES_EXCHANGE,
  DLX_EXCHANGE,
  WORK_QUEUE,
  RETRY_QUEUE,
  DEAD_LETTER_QUEUE,
  ATTEMPTS_HEADER,
  MAX_RETRY_DELAY_MS,
} = require('../../src/queue/rabbitmqQueue');

const flush = () => new Promise((resolve) => setImmediate(resolve));

const makeMessage = (payload, attempts = 0) => ({
  content: Buffer.from(JSON.stringify(payload)),
  properties: { messageId: 'job-1', headers: { [ATTEMPTS_HEADER]: attempts } },
});

describe('rabbitmqQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    amqp.connect.mockResolvedValue(mockConnection);
  });

  afterEach(async () => {
    await closeRabbitMQ();
  });

  test('declares a durable topic exchange, work queue, retry queue and DLQ', async () => {
    const channel = await createChannel();
    await assertTopology(channel);

    expect(channel.assertExchange).toHaveBeenCalledWith(DELIVERIES_EXCHANGE, 'topic', { durable: true });
    expect(channel.assertExchange).toHaveBeenCalledWith(DLX_EXCHANGE, 'fanout', { durable: true });

    expect(channel.assertQueue).toHaveBeenCalledWith(WORK_QUEUE, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': DLX_EXCHANGE },
    });
    expect(channel.assertQueue).toHaveBeenCalledWith(
      RETRY_QUEUE,
      expect.objectContaining({
        durable: true,
        arguments: expect.objectContaining({
          'x-dead-letter-exchange': DELIVERIES_EXCHANGE,
          'x-dead-letter-routing-key': 'webhook.deliver',
        }),
      }),
    );
    expect(channel.assertQueue).toHaveBeenCalledWith(DEAD_LETTER_QUEUE, { durable: true });
    expect(channel.bindQueue).toHaveBeenCalledWith(WORK_QUEUE, DELIVERIES_EXCHANGE, 'webhook.#');
    expect(channel.bindQueue).toHaveBeenCalledWith(DEAD_LETTER_QUEUE, DLX_EXCHANGE, '');
  });

  test('publishes persistent messages with an event routing key and awaits broker confirmation', async () => {
    const queue = new Queue(WORK_QUEUE);

    await queue.add(
      'deliver',
      { payload: { event: 'payment.received' } },
      { attempts: 5, jobId: 'job-1' },
    );

    expect(mockChannel.publish).toHaveBeenCalledWith(
      DELIVERIES_EXCHANGE,
      'webhook.payment.received',
      expect.any(Buffer),
      expect.objectContaining({ persistent: true, messageId: 'job-1' }),
    );
    expect(mockChannel.waitForConfirms).toHaveBeenCalledTimes(1);
  });

  test('worker acknowledges a job that the processor completes', async () => {
    const processor = jest.fn().mockResolvedValue(undefined);
    const worker = new Worker(WORK_QUEUE, processor, { concurrency: 3 });
    await worker.ready();

    expect(mockChannel.prefetch).toHaveBeenCalledWith(3);

    const handler = mockChannel.consume.mock.calls.at(-1)[1];
    const message = makeMessage({ name: 'deliver', data: { payload: { event: 'payment.received' } }, opts: { attempts: 5 } });
    handler(message);
    await flush();

    expect(processor).toHaveBeenCalledWith(expect.objectContaining({ name: 'deliver', attemptsMade: 1 }));
    expect(mockChannel.ack).toHaveBeenCalledWith(message);
    expect(mockChannel.nack).not.toHaveBeenCalled();

    await worker.close();
  });

  test('worker republishes a failed job onto the retry queue with exponential TTL', async () => {
    const processor = jest.fn().mockRejectedValue(new Error('boom'));
    const worker = new Worker(WORK_QUEUE, processor, { concurrency: 1 });
    await worker.ready();

    const handler = mockChannel.consume.mock.calls.at(-1)[1];
    const message = makeMessage(
      { name: 'deliver', data: {}, opts: { attempts: 5, backoff: { delay: 1000 } } },
      0,
    );
    handler(message);
    await flush();

    expect(mockChannel.publish).toHaveBeenCalledWith(
      '',
      RETRY_QUEUE,
      expect.any(Buffer),
      expect.objectContaining({ persistent: true, expiration: '1000', headers: { [ATTEMPTS_HEADER]: 1 } }),
    );
    expect(mockChannel.ack).toHaveBeenCalledWith(message);
    expect(mockChannel.nack).not.toHaveBeenCalled();

    await worker.close();
  });

  test('worker dead-letters a job that exhausted its attempts', async () => {
    const processor = jest.fn().mockRejectedValue(new Error('boom'));
    const worker = new Worker(WORK_QUEUE, processor, { concurrency: 1 });
    await worker.ready();

    const handler = mockChannel.consume.mock.calls.at(-1)[1];
    const message = makeMessage({ name: 'deliver', data: {}, opts: { attempts: 1 } }, 0);
    handler(message);
    await flush();

    expect(mockChannel.nack).toHaveBeenCalledWith(message, false, false);
    expect(mockChannel.publish).not.toHaveBeenCalledWith(
      '',
      RETRY_QUEUE,
      expect.any(Buffer),
      expect.anything(),
    );

    await worker.close();
  });

  test('withQueueRetry retries transient failures and rethrows permanent ones', async () => {
    const transient = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }))
      .mockResolvedValue('ok');

    await expect(withQueueRetry(transient, { attempts: 3, baseDelayMs: 1, sleep: async () => {} })).resolves.toBe('ok');
    expect(transient).toHaveBeenCalledTimes(2);

    const permanent = jest.fn().mockRejectedValue(new Error('invalid payload'));
    await expect(withQueueRetry(permanent, { attempts: 3, sleep: async () => {} })).rejects.toThrow('invalid payload');
    expect(permanent).toHaveBeenCalledTimes(1);
  });

  test('routingKeyForEvent prefixes and normalizes the event name', () => {
    expect(routingKeyForEvent('payment.received')).toBe('webhook.payment.received');
    expect(routingKeyForEvent(' Payment.Received ')).toBe('webhook.payment.received');
    expect(routingKeyForEvent(undefined)).toBe('webhook.deliver');
  });

  test('exposes a bounded retry delay and transient-error classifier', () => {
    expect(MAX_RETRY_DELAY_MS).toBe(60_000);
    expect(isTransientQueueError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientQueueError(new Error('validation failed'))).toBe(false);
  });
});
