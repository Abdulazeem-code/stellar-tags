'use strict';

const { fetchAdminStats } = require('../../src/services/statsService');

describe('fetchAdminStats', () => {
  test('happy path: prisma.$transaction resolves → returns correct field mapping', async () => {
    const prisma = {
      $transaction: jest.fn().mockResolvedValue([5, 3]),
      user: { count: jest.fn() },
    };

    const result = await fetchAdminStats(prisma);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      total_registered_users: 5,
      active_tokens: 3,
      platform_uptime_seconds: expect.any(Number),
      platform_uptime_started_at: expect.any(String),
    });
  });

  test('error: prisma.$transaction rejects → error is re-thrown', async () => {
    const unknownError = new Error('DB connection failed');
    const prisma = {
      $transaction: jest.fn().mockRejectedValue(unknownError),
      user: { count: jest.fn() },
    };

    await expect(fetchAdminStats(prisma)).rejects.toEqual(unknownError);
  });
});
