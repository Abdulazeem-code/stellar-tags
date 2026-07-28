const { logger } = require('./src/logger');
logger.info('--- PRISMA CLIENT INITIALIZED ---');
// ---------------------------------------------------------------------------
// Shared Prisma Client
// ---------------------------------------------------------------------------
// A single PrismaClient instance is reused across the server and the Horizon
// listener. Prisma manages its own connection pool internally, so there is no
// need for the manual generic-pool wiring the SQLite implementation required.
//
// The pool size and timeout can be tuned via the DATABASE_URL query string,
// e.g. ?connection_limit=10&pool_timeout=5
// ---------------------------------------------------------------------------

let prisma;
try {
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();
} catch (err) {
  logger.warn('Prisma client not found. Using fallback mock for tests.');
  prisma = {
    user: {
      update: async () => {
        const e = new Error('P2025: mock - record not found');
        e.code = 'P2025';
        throw e;
      },
      findUnique: async () => null,
      findFirst: async () => null,
      findMany: async () => [],
      create: async () => ({}),
      count: async () => 0,
    },
    $transaction: async (queries) => Promise.all(queries),
    $queryRaw: async () => [],
  };
}

module.exports = { prisma };
