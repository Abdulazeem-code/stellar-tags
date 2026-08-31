'use strict';

const { fetchAdminStats } = require('../../src/services/statsService');

describe('fetchAdminStats', () => {
  test('happy path: prisma.$transaction resolves → returns correct field mapping', async () => {
    const prisma = {
      $transaction: jest.fn().mockResolvedValue([5, 3]),
      user: { count: jest.fn() },
    };
    const poolGet = jest.fn();

    const result = await fetchAdminStats(prisma, poolGet);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(poolGet).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      total_registered_users: 5,
      active_tokens: 3,
      platform_uptime_seconds: expect.any(Number),
      platform_uptime_started_at: expect.any(String),
    });
  });

  test('fallback path: prisma.$transaction rejects with P2021 → poolGet called with correct SQL', async () => {
    const fallbackError = { code: 'P2021', message: 'table not found' };
    const prisma = {
      $transaction: jest.fn().mockRejectedValue(fallbackError),
      user: { count: jest.fn() },
    };
    const poolGet = jest
      .fn()
      .mockResolvedValueOnce({ totalCount: '7' })
      .mockResolvedValueOnce({ activeCount: '4' });

    const result = await fetchAdminStats(prisma, poolGet);

    expect(poolGet).toHaveBeenCalledTimes(2);
    expect(poolGet).toHaveBeenNthCalledWith(
      1,
      'SELECT COUNT(*) AS totalCount FROM username_registry',
    );
    expect(poolGet).toHaveBeenNthCalledWith(
      2,
      'SELECT COUNT(*) AS activeCount FROM username_registry WHERE flagged_at IS NULL',
    );
    expect(result).toMatchObject({
      total_registered_users: 7,
      active_tokens: 4,
      platform_uptime_seconds: expect.any(Number),
      platform_uptime_started_at: expect.any(String),
    });
  });

  test('non-fallback error: prisma.$transaction rejects with UNKNOWN code → error is re-thrown', async () => {
    const unknownError = { code: 'UNKNOWN', message: 'something unexpected' };
    const prisma = {
      $transaction: jest.fn().mockRejectedValue(unknownError),
      user: { count: jest.fn() },
    };
    const poolGet = jest.fn();

    await expect(fetchAdminStats(prisma, poolGet)).rejects.toEqual(unknownError);
    expect(poolGet).not.toHaveBeenCalled();
  });
});
