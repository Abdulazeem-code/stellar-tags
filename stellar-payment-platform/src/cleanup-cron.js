const cron = require('node-cron');
const logger = require('../logger');

const STALE_THRESHOLD_DAYS = 90;

const ACTIVE_NETWORK_ADDRESSES = new Set([
  'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
]);

async function runCleanup(prisma) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - STALE_THRESHOLD_DAYS);

  const activeAddresses = [...ACTIVE_NETWORK_ADDRESSES];

  const pruneResult = await prisma.user.deleteMany({
    where: {
      createdAt: { lt: cutoff },
      address: { notIn: activeAddresses },
    },
  });

  const flagResult = await prisma.user.updateMany({
    where: {
      createdAt: { lt: cutoff },
      address: { in: activeAddresses },
      flaggedAt: null,
    },
    data: { flaggedAt: new Date() },
  });

  return { pruned: pruneResult.count, flagged: flagResult.count };
}

function scheduleCleanupJob(prisma) {
  cron.schedule('0 0 * * 0', async () => {
    logger.info('Starting stale-account sweep');
    try {
      const { pruned, flagged } = await runCleanup(prisma);
      logger.info({ pruned, flagged }, 'Sweep complete');
    } catch (err) {
      logger.error({ err: err.message }, 'Sweep failed');
    }
  });

  logger.info('Weekly cleanup job scheduled (Sundays at midnight)');
}

module.exports = { scheduleCleanupJob, runCleanup, STALE_THRESHOLD_DAYS };
