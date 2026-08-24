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
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }
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
    webhook: {
      findMany: async () => [],
      update: async () => ({}),
      findUnique: async () => null,
    },
    webhookDLQ: {
      findMany: async () => [],
      findUnique: async () => null,
      create: async () => ({}),
      delete: async () => ({}),
      update: async () => ({}),
      count: async () => 0,
    },
    $transaction: async (queries) => Promise.all(queries),
    $queryRaw: async () => [],
  };
}

/**
 * Returns true when the error (or its direct Error.cause) is a Prisma
 * database-connection error (P10xx codes — connection refused, pool
 * timeout, etc.). Used by the global error handler to return 503
 * instead of 500 when Postgres is unreachable.
 */
function isPrismaConnectionError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code.startsWith('P10')) return true;
  const causeCode = typeof error?.cause?.code === 'string' ? error.cause.code : '';
  return causeCode.startsWith('P10');
}

module.exports = { prisma, isPrismaConnectionError };
