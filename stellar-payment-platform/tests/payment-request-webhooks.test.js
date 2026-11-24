'use strict';

const crypto = require('crypto');

let mockWorkerHandlers = {};
let mockWorkerProcessor;

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Worker: jest.fn().mockImplementation((_name, processor) => {
    mockWorkerProcessor = processor;
    return {
      on: jest.fn((event, handler) => { mockWorkerHandlers[event] = handler; }),
      close: jest.fn().mockResolvedValue(undefined),
    };
  }),
}));

jest.mock('../src/config/redis', () => ({
  createRedisConnection: jest.fn(() => ({ quit: jest.fn().mockResolvedValue(undefined) })),
  withRedisRetry: jest.fn((operation) => operation()),
}));

jest.mock('../src/dlq', () => ({
  routeToDlq: jest.fn().mockResolvedValue(undefined),
  isDlqAvailable: jest.fn(() => true),
  DLQ_QUEUE_NAME: 'webhook-dlq',
}));

jest.mock('../src/services/stellarService', () => ({ fetchTransaction: jest.fn() }));
jest.mock('../src/metrics', () => ({ paymentRequestsPaidTotal: { inc: jest.fn() } }));
jest.mock('../src/logger', () => ({ logger: require('pino')({ level: 'silent' }) }));

const { routeToDlq } = require('../src/dlq');
const {
  dispatchPaymentRequestWebhooks,
  dispatchPaymentWebhooks,
  buildPaymentRequestPayload,
  processWebhookJob,
  startWebhookWorker,
  closeWebhookQueue,
  MAX_WEBHOOK_ATTEMPTS,
} = require('../src/webhookWorker');
const { runPaymentRequestExpirySweep } = require('../src/payment-request-expiry-cron');
const { matchPayment } = require('../src/services/paymentRequestMatcher');

const DESTINATION = `G${'D'.repeat(55)}`;
const webhook = {
  id: 'webhook-1',
  username: 'alice*localhost',
  url: 'https://merchant.example/hooks',
  secret: 'whsec_test',
  events: ['*'],
};

const baseRequest = {
  id: 'req-123',
  tag: 'alice*localhost',
  destination: DESTINATION,
  amount: '25.5',
  asset: 'XLM',
  memoType: 'text',
  memo: 'invoice-7',
  status: 'pending',
  expiresAt: new Date('2026-01-02T00:00:00.000Z'),
  paidAt: null,
  transactionHash: null,
};

const paidRequest = {
  ...baseRequest,
  status: 'paid',
  paidAt: new Date('2026-01-01T12:00:00.000Z'),
  transactionHash: 'tx-hash-1',
};

const prismaWith = (webhooks = [webhook]) => ({
  webhook: {
    findMany: jest.fn().mockResolvedValue(webhooks),
    findUnique: jest.fn().mockResolvedValue({ failingSince: null }),
    update: jest.fn().mockResolvedValue({}),
  },
});

const DATA_KEYS = [
  'amount_paid',
  'amount_requested',
  'asset',
  'memo',
  'paid_at',
  'request_id',
  'tag',
  'transaction_hash',
];

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

afterAll(async () => {
  await closeWebhookQueue();
  delete global.fetch;
});

describe('payment_request webhook payloads', () => {
  test('paid payload has the documented shape and a deterministic event_id', () => {
    const payload = buildPaymentRequestPayload({ request: paidRequest, status: 'paid', amountPaid: '30' });

    expect(Object.keys(payload).sort()).toEqual(['data', 'event', 'event_id', 'network', 'timestamp']);
    expect(Object.keys(payload.data).sort()).toEqual(DATA_KEYS);
    expect(payload).toMatchObject({
      event: 'payment_request.paid',
      event_id: 'req-123-paid',
      network: 'testnet',
      data: {
        request_id: 'req-123',
        tag: 'alice*localhost',
        amount_requested: '25.5',
        amount_paid: '30',
        asset: 'XLM',
        memo: 'invoice-7',
        transaction_hash: 'tx-hash-1',
        paid_at: '2026-01-01T12:00:00.000Z',
      },
    });
    expect(new Date(payload.timestamp).toISOString()).toBe(payload.timestamp);
    expect(buildPaymentRequestPayload({ request: paidRequest, status: 'paid' }).event_id).toBe(payload.event_id);
  });

  test.each(['expired', 'cancelled'])('%s payload has the same shape with null payment fields', (status) => {
    const payload = buildPaymentRequestPayload({ request: { ...baseRequest, status }, status });

    expect(Object.keys(payload.data).sort()).toEqual(DATA_KEYS);
    expect(payload).toMatchObject({
      event: `payment_request.${status}`,
      event_id: `req-123-${status}`,
      data: {
        request_id: 'req-123',
        amount_requested: '25.5',
        amount_paid: null,
        transaction_hash: null,
        paid_at: null,
      },
    });
  });

  test('rejects unknown statuses', () => {
    expect(() => buildPaymentRequestPayload({ request: baseRequest, status: 'pending' })).toThrow();
  });
});

describe('dispatchPaymentRequestWebhooks', () => {
  test('enqueues on the shared webhook queue with the shared retry options', async () => {
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const prisma = prismaWith();

    const payload = await dispatchPaymentRequestWebhooks({ prisma, request: paidRequest, queue });

    expect(prisma.webhook.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { user: { address: DESTINATION } },
    }));
    expect(payload.event).toBe('payment_request.paid');
    expect(queue.add).toHaveBeenCalledWith(
      'deliver',
      expect.objectContaining({ webhook, payload }),
      expect.objectContaining({
        attempts: MAX_WEBHOOK_ATTEMPTS,
        backoff: expect.objectContaining({ type: 'exponential' }),
        jobId: crypto.createHash('sha256').update('webhook-1:req-123-paid').digest('hex'),
      }),
    );
  });

  test('respects webhook event subscriptions', async () => {
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const prisma = prismaWith([
      { ...webhook, id: 'only-received', events: ['payment.received'] },
      { ...webhook, id: 'only-paid', events: ['payment_request.paid'] },
    ]);

    await dispatchPaymentRequestWebhooks({ prisma, request: paidRequest, queue });

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][1].webhook.id).toBe('only-paid');
  });

  test('does nothing when the recipient has no webhooks', async () => {
    const queue = { add: jest.fn() };
    const result = await dispatchPaymentRequestWebhooks({ prisma: prismaWith([]), request: paidRequest, queue });
    expect(result).toBeNull();
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('delivery carries an X-Webhook-Signature that verifies against the raw body', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200 });
    const payload = buildPaymentRequestPayload({ request: paidRequest, status: 'paid' });

    await processWebhookJob({ data: { webhook, payload }, attemptsMade: 0 }, { prisma: prismaWith() });

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe(webhook.url);
    // Same check as the Node.js example in docs/webhook-signature-verification.md
    const expected = crypto.createHmac('sha256', webhook.secret).update(init.body).digest('hex');
    expect(init.headers['X-Webhook-Signature']).toBe(expected);
    expect(crypto.timingSafeEqual(
      Buffer.from(init.headers['X-Webhook-Signature'], 'hex'),
      Buffer.from(expected, 'hex'),
    )).toBe(true);
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  test('a failing endpoint is retried and then parked on the DLQ, like payment.received', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 500 });
    const prisma = prismaWith();
    startWebhookWorker({ prisma });

    for (const payload of [
      buildPaymentRequestPayload({ request: paidRequest, status: 'paid' }),
      { event: 'payment.received', event_id: 'tx-1-op-1', timestamp: new Date().toISOString(), data: {} },
    ]) {
      routeToDlq.mockClear();
      const job = { id: payload.event_id, data: { webhook, payload }, attemptsMade: 0, opts: { attempts: MAX_WEBHOOK_ATTEMPTS } };

      // The processor throws so BullMQ schedules a retry.
      await expect(mockWorkerProcessor(job)).rejects.toThrow('HTTP 500');
      await mockWorkerHandlers.failed({ ...job, attemptsMade: 1 }, new Error('HTTP 500'));
      expect(routeToDlq).not.toHaveBeenCalled();

      // Once retries are exhausted the job goes to the DLQ.
      const exhausted = { ...job, attemptsMade: MAX_WEBHOOK_ATTEMPTS };
      const error = new Error('HTTP 500');
      await mockWorkerHandlers.failed(exhausted, error);
      expect(routeToDlq).toHaveBeenCalledWith(exhausted, error);
    }
  });
});

describe('payment.received regression', () => {
  test('payload is unchanged', async () => {
    const queue = { add: jest.fn().mockResolvedValue({}) };
    await dispatchPaymentWebhooks({
      prisma: prismaWith(),
      queue,
      payment: {
        id: 'op-1',
        type: 'payment',
        transaction_hash: 'tx-1',
        from: 'GSOURCE',
        to: DESTINATION,
        amount: '10.0000000',
        asset_type: 'native',
        created_at: '2026-01-01T00:00:00Z',
        paging_token: 'pt-1',
      },
    });

    const { payload } = queue.add.mock.calls[0][1];
    expect(Object.keys(payload).sort()).toEqual(['data', 'event', 'event_id', 'network', 'timestamp']);
    expect(payload).toMatchObject({ event: 'payment.received', event_id: 'tx-1-op-1' });
    expect(payload.data).toEqual({
      transaction_hash: 'tx-1',
      from: 'GSOURCE',
      to: DESTINATION,
      amount: '10.0000000',
      asset: 'native',
      asset_type: 'native',
      asset_code: null,
      asset_issuer: null,
      created_at: '2026-01-01T00:00:00Z',
      paging_token: 'pt-1',
      metadata: null,
    });
  });
});

describe('matcher onPaid hook', () => {
  test('runs once with the paid request and the amount received', async () => {
    const prisma = {
      paymentRequest: {
        findMany: jest.fn().mockResolvedValue([{ ...baseRequest, expiresAt: new Date(Date.now() + 60_000) }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const onPaid = jest.fn();

    const ids = await matchPayment(prisma, {
      to: DESTINATION,
      amount: '26.0000000',
      asset_type: 'native',
      transaction_hash: 'tx-hash-1',
    }, { fetchTransaction: async () => ({ memo: 'invoice-7' }), onPaid });

    expect(ids).toEqual(['req-123']);
    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(onPaid.mock.calls[0][0]).toMatchObject({ id: 'req-123', status: 'paid', transactionHash: 'tx-hash-1' });
    expect(onPaid.mock.calls[0][1]).toEqual({ amountPaid: '26.0000000' });
  });

  test('a failing hook does not undo the match', async () => {
    const prisma = {
      paymentRequest: {
        findMany: jest.fn().mockResolvedValue([{ ...baseRequest, expiresAt: new Date(Date.now() + 60_000) }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const ids = await matchPayment(prisma, {
      to: DESTINATION, amount: '25.5', asset_type: 'native', transaction_hash: 'tx',
    }, { fetchTransaction: async () => ({ memo: 'invoice-7' }), onPaid: () => { throw new Error('boom'); } });
    expect(ids).toEqual(['req-123']);
  });
});

describe('expiry sweep', () => {
  test('marks due requests expired and sends payment_request.expired once', async () => {
    const prisma = {
      paymentRequest: {
        findMany: jest.fn().mockResolvedValue([baseRequest, { ...baseRequest, id: 'req-raced' }]),
        updateMany: jest.fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }), // paid or cancelled in the meantime
      },
    };
    const dispatch = jest.fn().mockResolvedValue(null);
    const notify = jest.fn().mockResolvedValue(true);

    const result = await runPaymentRequestExpirySweep(prisma, { dispatch, notify, now: new Date('2026-01-03T00:00:00Z') });

    expect(result).toEqual({ expired: 1 });
    expect(prisma.paymentRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'pending', expiresAt: { lte: new Date('2026-01-03T00:00:00Z') } },
    }));
    expect(prisma.paymentRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req-123', status: 'pending' },
      data: { status: 'expired' },
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ requestId: 'req-123', status: 'expired' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ status: 'expired', request: { id: 'req-123', status: 'expired' } });
  });
});
