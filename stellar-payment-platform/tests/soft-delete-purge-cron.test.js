jest.mock('node-cron', () => ({
  schedule: jest.fn(),
}));

const cron = require('node-cron');
const {
  runSoftDeletePurge,
  scheduleSoftDeletePurgeJob,
  SOFT_DELETE_RETENTION_DAYS,
} = require('../src/soft-delete-purge-cron');

describe('soft-delete-purge-cron', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('runSoftDeletePurge', () => {
    it('permanently deletes users soft-deleted before the retention window', async () => {
      const prisma = {
        user: {
          deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
      };

      const purged = await runSoftDeletePurge(prisma);

      expect(purged).toBe(2);
      expect(prisma.user.deleteMany).toHaveBeenCalledTimes(1);

      const { where } = prisma.user.deleteMany.mock.calls[0][0];
      const cutoff = where.deletedAt.lt;
      const expectedCutoff = new Date();
      expectedCutoff.setDate(expectedCutoff.getDate() - SOFT_DELETE_RETENTION_DAYS);

      expect(cutoff).toBeInstanceOf(Date);
      expect(Math.abs(cutoff.getTime() - expectedCutoff.getTime())).toBeLessThan(2000);
    });
  });

  describe('scheduleSoftDeletePurgeJob', () => {
    it('registers a daily midnight cron job', () => {
      const prisma = { user: { deleteMany: jest.fn() } };

      scheduleSoftDeletePurgeJob(prisma);

      expect(cron.schedule).toHaveBeenCalledWith('0 0 * * *', expect.any(Function));
    });
  });
});
