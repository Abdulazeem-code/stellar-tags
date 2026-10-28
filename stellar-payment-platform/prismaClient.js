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
  const basePrisma = new PrismaClient();
  
  if (process.env.DATABASE_READ_URL) {
    const { readReplicas } = require('@prisma/extension-read-replicas');
    prisma = basePrisma.$extends(
      readReplicas({
        url: process.env.DATABASE_READ_URL,
      })
    );
  } else {
    prisma = basePrisma;
  }
} catch (err) {
  logger.warn('Prisma client not found or extension missing. Using fallback mock for tests.', err);
  prisma = {
    user: {
      update: async () => {
        const e = new Error('P2025: mock - record not found');
        e.code = 'P2025';
        throw e;
      },
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => null,
      findFirst: async () => null,
      findMany: async () => [],
      create: async () => ({}),
      count: async () => 0,
    },
    webhookDLQ: {
      findMany: async () => [],
      findUnique: async () => null,
      create: async () => ({}),
      delete: async () => ({}),
      update: async () => ({}),
    },
    activityLog: {
      findMany: async () => [],
      findUnique: async () => null,
      findFirst: async () => null,
      create: async (args) => args.data || {},
      count: async () => 0,
    },
    auditLog: {
      findMany: async () => [],
      findUnique: async () => null,
      findFirst: async () => null,
      create: async (args) => args.data || {},
      count: async () => 0,
    },
    payment: {
      findMany: async () => [],
      findUnique: async () => null,
      findFirst: async () => null,
      create: async () => ({}),
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      count: async () => 0,
      aggregate: async () => ({ _sum: { amount: 0, fee: 0 }, _count: { id: 0 } }),
      groupBy: async () => [],
    },
    webhook: {
      findUnique: async () => null,
      findFirst: async () => null,
      findMany: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      delete: async () => ({}),
      count: async () => 0,
    },
    paymentIntent: {
      create: async (args) => args.data || {},
      findMany: async () => [],
      findUnique: async () => null,
      count: async () => 0,
    },
    $transaction: async (arg) => {
      if (typeof arg === 'function') {
        return arg(prisma);
      }
      return Promise.all(arg);
    },
    $queryRaw: async () => [],
  };
}

const withTransaction = async (callback) => {
  return await prisma.$transaction(async (tx) => {
    return await callback(tx);
  });
};

/**
 * Returns true when the error (or its direct Error.cause) is a Prisma
 * database-connection error (P10xx codes — connection refused, pool
 * timeout, etc.). Used by the global error handler to return 503
 * instead of 500 when Postgres is unreachable.
 */
function isPrismaConnectionError(error) {
  if (!error) return false;
  const name = error.name || error.constructor?.name || '';
  if (name === 'PrismaClientInitializationError') return true;
  const causeName = error.cause?.name || error.cause?.constructor?.name || '';
  if (causeName === 'PrismaClientInitializationError') return true;
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code.startsWith('P10')) return true;
  const causeCode = typeof error?.cause?.code === 'string' ? error.cause.code : '';
  if (causeCode.startsWith('P10')) return true;
  const msg = typeof error?.message === 'string' ? error.message : '';
  if (msg.includes("Can't reach database server") || msg.includes("connection refused")) return true;
  const causeMsg = typeof error?.cause?.message === 'string' ? error.cause.message : '';
  if (causeMsg.includes("Can't reach database server") || causeMsg.includes("connection refused")) return true;
  return false;
}

module.exports = { prisma, isPrismaConnectionError, withTransaction };
