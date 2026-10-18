'use strict';

/**
 * Unit tests for src/cleanup-cron.js.
 */

jest.mock('node-cron', () => ({
  schedule: jest.fn(),
}));

jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

const cron = require('node-cron');
const { logger } = require('../src/logger');
const {
  runCleanup,
  scheduleCleanupJob,
  STALE_THRESHOLD_DAYS,
} = require('../src/cleanup-cron');

describe('runCleanup', () => {
  it('prunes stale rows not in the active set and flags active rows', async () => {
    const prisma = {
      user: {
        deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const result = await runCleanup(prisma);

    expect(result).toEqual({ pruned: 3, flagged: 1 });

    const deleteWhere = prisma.user.deleteMany.mock.calls[0][0].where;
    expect(deleteWhere.address.notIn).toEqual([
      'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
    ]);
    expect(deleteWhere.createdAt.lt).toBeInstanceOf(Date);

    const updateWhere = prisma.user.updateMany.mock.calls[0][0].where;
    expect(updateWhere.address.in).toEqual([
      'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
    ]);
    expect(updateWhere.flaggedAt).toBeNull();
    expect(prisma.user.updateMany.mock.calls[0][0].data.flaggedAt).toBeInstanceOf(Date);
  });

  it('computes the cutoff from STALE_THRESHOLD_DAYS', async () => {
    const prisma = {
      user: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    await runCleanup(prisma);

    const cutoff = prisma.user.deleteMany.mock.calls[0][0].where.createdAt.lt;
    const expected = new Date();
    expected.setDate(expected.getDate() - STALE_THRESHOLD_DAYS);
    expect(Math.abs(cutoff.getTime() - expected.getTime())).toBeLessThan(2000);
  });
});

describe('scheduleCleanupJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers a weekly Sunday-midnight cron job', () => {
    scheduleCleanupJob({ user: {} });
    expect(cron.schedule).toHaveBeenCalledWith('0 0 * * 0', expect.any(Function));
    expect(logger.info).toHaveBeenCalledWith(
      '[cleanup-cron] Weekly cleanup job scheduled (Sundays at midnight).',
    );
  });

  it('runs the purge and logs the result when the callback fires', async () => {
    let scheduledCallback;
    cron.schedule.mockImplementation((expr, cb) => {
      scheduledCallback = cb;
    });

    const prisma = {
      user: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    scheduleCleanupJob(prisma);
    await scheduledCallback();

    expect(prisma.user.deleteMany).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('[cleanup-cron] Sweep complete – pruned: 2, flagged: 1');
  });

  it('logs an error when the sweep fails', async () => {
    let scheduledCallback;
    cron.schedule.mockImplementation((expr, cb) => {
      scheduledCallback = cb;
    });

    const prisma = {
      user: {
        deleteMany: jest.fn().mockRejectedValue(new Error('db down')),
        updateMany: jest.fn(),
      },
    };

    scheduleCleanupJob(prisma);
    await scheduledCallback();

    expect(logger.error).toHaveBeenCalledWith('[cleanup-cron] Sweep failed:', 'db down');
  });
});