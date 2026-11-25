'use strict';

/**
 * Regression tests for #683 — background SSE stream cleanup.
 *
 * The Horizon listener must release the underlying EventSource (socket +
 * reconnect timer) whenever a stream errors or an account is unregistered.
 * Dropping the map entry without invoking the SDK close function leaked one
 * live connection per failed stream.
 */

jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../prismaClient', () => ({
  prisma: {
    user: { findMany: jest.fn() },
    payment: { create: jest.fn() },
    outboxMessage: { create: jest.fn().mockResolvedValue({ id: 'outbox-1' }) },
    $transaction: jest.fn((callback) => callback(require('../prismaClient').prisma)),
    $disconnect: jest.fn(),
  },
}));

jest.mock('../src/config/redis', () => ({
  createRedisConnection: jest.fn(() => ({ quit: jest.fn(), on: jest.fn() })),
}));

jest.mock('../src/fraudDetection', () => ({ PAYMENT_STREAM: 'payments' }));

jest.mock('../src/webhookWorker', () => ({
  dispatchPaymentWebhooks: jest.fn(),
  dispatchPaymentRequestWebhooks: jest.fn(),
  startWebhookWorker: jest.fn(),
  scheduleWebhookRetryJob: jest.fn(),
  closeWebhookQueue: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/stellarService', () => ({
  horizon: { payments: jest.fn() },
  createBreaker: jest.fn(() => ({ fire: jest.fn().mockResolvedValue(true) })),
}));

jest.mock('../src/sse', () => ({
  publishPaymentUpdate: jest.fn().mockResolvedValue(undefined),
  initSse: jest.fn(),
  closeSse: jest.fn().mockResolvedValue(undefined),
  emitPaymentUpdate: jest.fn(),
  addClient: jest.fn(),
  sendClientEvent: jest.fn(),
  getSseClientCount: jest.fn().mockReturnValue(0),
  isSseStreamPath: jest.fn().mockReturnValue(false),
}));

const { horizon } = require('../src/services/stellarService');
const { prisma } = require('../prismaClient');
const { publishPaymentUpdate } = require('../src/sse');
const {
  watchAccount,
  syncWatchedAccounts,
  stop,
  shutdown,
  main,
  activeStreams,
} = require('../horizonListener');
const { startWebhookWorker } = require('../src/webhookWorker');

const mockCloseStream = jest.fn();
const mockStream = jest.fn(() => mockCloseStream);
const mockCursor = jest.fn(() => ({ stream: mockStream }));
const mockForAccount = jest.fn(() => ({ cursor: mockCursor }));

describe('Horizon listener stream cleanup (#683)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeStreams.clear();
    mockStream.mockImplementation(() => mockCloseStream);
    horizon.payments.mockReturnValue({ forAccount: mockForAccount });
  });

  it('registers exactly one stream per account', () => {
    watchAccount('GACCOUNT1');
    watchAccount('GACCOUNT1'); // duplicate must be a no-op

    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(activeStreams.has('GACCOUNT1')).toBe(true);
  });

  it('closes the underlying stream when it errors', () => {
    watchAccount('GACCOUNT2');
    const options = mockStream.mock.calls[0][0];

    options.onerror(new Error('stream dropped'));

    expect(mockCloseStream).toHaveBeenCalledTimes(1);
    expect(activeStreams.has('GACCOUNT2')).toBe(false);

    // A second error must not double-close.
    options.onerror(new Error('stream dropped again'));
    expect(mockCloseStream).toHaveBeenCalledTimes(1);
  });

  it('closes streams for accounts removed from the registry', async () => {
    watchAccount('GSTALE');
    prisma.user.findMany.mockResolvedValue([]);

    await syncWatchedAccounts();

    expect(mockCloseStream).toHaveBeenCalledTimes(1);
    expect(activeStreams.has('GSTALE')).toBe(false);
  });

  it('re-opens a stream after an error on the next sync', async () => {
    watchAccount('GRECONNECT');
    mockStream.mock.calls[0][0].onerror(new Error('boom'));
    expect(activeStreams.has('GRECONNECT')).toBe(false);

    prisma.user.findMany.mockResolvedValue([{ address: 'GRECONNECT' }]);
    await syncWatchedAccounts();

    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(activeStreams.has('GRECONNECT')).toBe(true);
  });

  it('shutdown closes every stream and disconnects Prisma', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    watchAccount('GSHUT');

    await shutdown();

    expect(mockCloseStream).toHaveBeenCalledTimes(1);
    expect(activeStreams.size).toBe(0);
    expect(prisma.$disconnect).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });
});

describe('Horizon listener publishes status updates to SSE (#730)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeStreams.clear();
    mockStream.mockImplementation(() => mockCloseStream);
    horizon.payments.mockReturnValue({ forAccount: mockForAccount });
    prisma.payment.create.mockResolvedValue({
      id: 'PAY-123',
      status: 'completed',
      transactionHash: 'deadbeef',
      fromAddress: 'GFROM',
      toAddress: 'GTO',
      amount: 1.5,
      assetCode: 'XLM',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('emits the update in-process when Redis is not configured', async () => {
    const { emitPaymentUpdate } = require('../src/sse');
    watchAccount('GLOCAL');

    mockStream.mock.calls[0][0].onmessage({
      type: 'payment',
      transaction_hash: 'deadbeef',
      from: 'GFROM',
      to: 'GTO',
      amount: '1.5',
      asset_type: 'native',
      created_at: '2026-01-01T00:00:00Z',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(publishPaymentUpdate).not.toHaveBeenCalled();
    expect(emitPaymentUpdate).toHaveBeenCalledWith('PAY-123', expect.objectContaining({
      status: 'completed',
      transactionHash: 'deadbeef',
    }));
  });

  it('publishes a payment update to Redis when Redis is configured', async () => {
    let isolated;
    process.env.REDIS_URL = 'redis://redis.test:6379';
    jest.isolateModules(() => {
      isolated = {
        listener: require('../horizonListener'),
        sse: require('../src/sse'),
        stellar: require('../src/services/stellarService'),
        prisma: require('../prismaClient').prisma,
      };
    });
    delete process.env.REDIS_URL;
    isolated.stellar.horizon.payments.mockReturnValue({ forAccount: mockForAccount });
    isolated.prisma.payment.create.mockResolvedValue(await prisma.payment.create());
    const { watchAccount: watchIsolated } = isolated.listener;
    const { publishPaymentUpdate: publishIsolated, emitPaymentUpdate: emitIsolated } = isolated.sse;
    watchIsolated('GPUBLISH');

    const options = mockStream.mock.calls[0][0];
    options.onmessage({
      type: 'payment',
      transaction_hash: 'deadbeef',
      from: 'GFROM',
      to: 'GTO',
      amount: '1.5',
      asset_type: 'native',
      created_at: '2026-01-01T00:00:00Z',
    });

    // Flush prisma.payment.create(...).then(publishPaymentUpdate)
    await new Promise((resolve) => setImmediate(resolve));

    expect(isolated.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(isolated.prisma.outboxMessage.create).toHaveBeenCalledWith({
      data: { eventType: 'payment.created', payload: expect.objectContaining({ paymentId: 'PAY-123' }) },
    });
    expect(emitIsolated).not.toHaveBeenCalled();
    expect(publishIsolated).toHaveBeenCalledTimes(1);
    const [, paymentId, payload] = publishIsolated.mock.calls[0];
    expect(paymentId).toBe('PAY-123');
    expect(payload).toMatchObject({
      status: 'completed',
      transactionHash: 'deadbeef',
      fromAddress: 'GFROM',
      toAddress: 'GTO',
      amount: 1.5,
      assetCode: 'XLM',
    });
  });

  it('still logs (and does not throw) when the insert fails', async () => {
    const { logger } = require('../src/logger');
    prisma.payment.create.mockRejectedValue(new Error('db down'));
    watchAccount('GFAIL');

    const options = mockStream.mock.calls[0][0];
    expect(() =>
      options.onmessage({
        type: 'payment',
        transaction_hash: 'abc',
        from: 'GFROM',
        to: 'GTO',
        amount: '1',
        asset_type: 'native',
      }),
    ).not.toThrow();

    await new Promise((resolve) => setImmediate(resolve));

    expect(publishPaymentUpdate).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('Horizon listener health check', () => {
  test('asks Horizon for the newest ledger with calls the SDK actually has', async () => {
    let isolated;
    jest.isolateModules(() => {
      isolated = {
        stellar: require('../src/services/stellarService'),
        listener: require('../horizonListener'),
      };
    });
    const [check] = isolated.stellar.createBreaker.mock.calls[0];

    // Only order/limit/call exist on the builder, as in @stellar/stellar-sdk;
    // a missing method (the old ledgers().latest()) makes this throw.
    const call = jest.fn().mockResolvedValue({ records: [{ sequence: 1 }] });
    const limit = jest.fn(() => ({ call }));
    const order = jest.fn(() => ({ limit }));
    isolated.stellar.horizon.ledgers = jest.fn(() => ({ order }));

    await expect(check()).resolves.toEqual({ records: [{ sequence: 1 }] });
    expect(order).toHaveBeenCalledWith('desc');
    expect(limit).toHaveBeenCalledWith(1);
  });
});

describe('Horizon listener startup', () => {
  afterEach(() => {
    delete process.env.REDIS_URL;
  });

  test('starts the webhook delivery worker when Redis is configured', async () => {
    process.env.REDIS_URL = 'redis://redis.test:6379';
    prisma.user.findMany.mockResolvedValue([]);
    const { syncInterval } = await main();
    clearInterval(syncInterval);
    expect(startWebhookWorker).toHaveBeenCalledWith({ prisma });
  });

  test('skips webhook delivery, with a warning, when Redis is not configured', async () => {
    const { logger } = require('../src/logger');
    const { scheduleWebhookRetryJob } = require('../src/webhookWorker');
    jest.clearAllMocks();
    prisma.user.findMany.mockResolvedValue([]);
    const { syncInterval } = await main();
    clearInterval(syncInterval);
    expect(startWebhookWorker).not.toHaveBeenCalled();
    expect(scheduleWebhookRetryJob).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('webhooks will not be delivered'));
  });

  test('stop() closes streams without disconnecting Prisma or exiting', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    jest.clearAllMocks();
    horizon.payments.mockReturnValue({ forAccount: mockForAccount });
    mockStream.mockImplementation(() => mockCloseStream);
    watchAccount('GSTOP');

    await stop();

    expect(mockCloseStream).toHaveBeenCalledTimes(1);
    expect(activeStreams.size).toBe(0);
    expect(prisma.$disconnect).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
