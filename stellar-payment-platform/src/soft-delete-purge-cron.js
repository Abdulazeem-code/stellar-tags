const cron = require('node-cron');
const pino = require('pino');

const logger = pino({
  name: 'soft-delete-purge',
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
});

/** Days after soft-delete before a user row is permanently removed. */
const SOFT_DELETE_RETENTION_DAYS = 30;

/**
 * Permanently deletes user rows whose soft-delete timestamp is older than
 * {@link SOFT_DELETE_RETENTION_DAYS} days.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<number>} Number of purged records.
 */
async function runSoftDeletePurge(prisma) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - SOFT_DELETE_RETENTION_DAYS);

  const result = await prisma.user.deleteMany({
    where: {
      deletedAt: { lt: cutoff },
    },
  });

  return result.count;
}

/**
 * Schedules a daily midnight cron job that purges expired soft-deleted users.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 */
function scheduleSoftDeletePurgeJob(prisma) {
  cron.schedule('0 0 * * *', async () => {
    logger.info('Starting soft-delete purge…');
    try {
      const purged = await runSoftDeletePurge(prisma);
      logger.info({ purged }, 'Soft-delete purge complete');
    } catch (err) {
      logger.error({ err: err.message }, 'Soft-delete purge failed');
    }
  });

  logger.info('Daily soft-delete purge job scheduled (midnight)');
}

module.exports = {
  scheduleSoftDeletePurgeJob,
  runSoftDeletePurge,
  SOFT_DELETE_RETENTION_DAYS,
};
