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
  prisma: { user: { findMany: jest.fn() }, $disconnect: jest.fn() },
}));

jest.mock('../src/config/redis', () => ({
  createRedisConnection: jest.fn(() => ({ quit: jest.fn() })),
}));

jest.mock('../src/fraudDetection', () => ({ PAYMENT_STREAM: 'payments' }));

jest.mock('../src/webhookWorker', () => ({
  dispatchPaymentWebhooks: jest.fn(),
  scheduleWebhookRetryJob: jest.fn(),
}));

jest.mock('../src/services/stellarService', () => ({
  horizon: { payments: jest.fn() },
  createBreaker: jest.fn(() => ({ fire: jest.fn().mockResolvedValue(true) })),
}));

const { horizon } = require('../src/services/stellarService');
const { prisma } = require('../prismaClient');
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
