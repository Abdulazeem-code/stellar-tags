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
    $disconnect: jest.fn(),
  },
}));

jest.mock('../src/config/redis', () => ({
  createRedisConnection: jest.fn(() => ({ quit: jest.fn() })),
}));

jest.mock('../src/fraudDetection', () => ({ PAYMENT_STREAM: 'payments' }));

jest.mock('../src/webhookWorker', () => ({
  dispatchPaymentWebhooks: jest.fn(),
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
  shutdown,
  activeStreams,
} = require('../horizonListener');

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

  it('publishes a payment update when an on-chain payment is detected', async () => {
    watchAccount('GPUBLISH');

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

    expect(publishPaymentUpdate).toHaveBeenCalledTimes(1);
    const [, paymentId, payload] = publishPaymentUpdate.mock.calls[0];
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
