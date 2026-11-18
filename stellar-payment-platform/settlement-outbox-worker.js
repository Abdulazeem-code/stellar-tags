'use strict';

require('dotenv').config();
const { prisma } = require('./prismaClient');
const { logger } = require('./src/logger');
const { startOutboxPoller } = require('./src/services/settlementOutbox');
const { createRabbitOutboxPublisher } = require('./src/services/rabbitOutboxPublisher');

async function main() {
  const publisher = createRabbitOutboxPublisher();
  const poller = startOutboxPoller({
    prismaClient: prisma,
    publisher,
    logger,
    intervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS || 2000),
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await poller.stop();
    await prisma.$disconnect();
  };
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)).catch(() => process.exit(1)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)).catch(() => process.exit(1)));
  logger.info('Transactional payment outbox worker started');
  return poller;
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'Unable to start outbox worker');
    process.exitCode = 1;
  });
}

module.exports = { main };
