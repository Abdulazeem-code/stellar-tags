'use strict';

/**
 * #686 — per-worker helpers for the container-backed integration phase.
 *
 * Everything in here assumes `tests/containers/globalSetup.js` has already
 * run, i.e. that `DATABASE_URL` and `REDIS_URL` point at real, running
 * services and that the Prisma migration chain has been applied to them.
 *
 * The single most important helper is `resetTestState()`. Because the whole
 * phase shares one database and one Redis, every test starts from an empty
 * schema and an empty keyspace. That removes cross-file ordering dependencies
 * (the source of the flakiness the mock suites were papering over) and keeps
 * the Redis-backed rate-limit windows from bleeding between tests.
 */

const request = require('supertest');
const { createClient } = require('redis');

const DEFAULT_EVENTUALLY_TIMEOUT_MS = 5000;
const DEFAULT_EVENTUALLY_INTERVAL_MS = 20;

/** Tables owned by the app; `_prisma_migrations` is deliberately excluded. */
const PRISMA_OWNED_TABLES = ['_prisma_migrations'];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The container-backed integration phase must be started with ` +
        '`npm run test:integration` (or `npm run test:all`) so that Jest globalSetup can ' +
        'start PostgreSQL and Redis. Running these files under `npm test` is not supported.',
    );
  }
  return value;
}

/** The shared, real Prisma client. Created lazily so env vars are in place. */
function prisma() {
  return require('../../prismaClient').prisma;
}

/** The `pg` pool used by the raw-SQL modules (src/db.js and friends). */
function pgPool() {
  return require('../../src/db').pool;
}

/**
 * A `pg` pool for a *non-privileged* role on the same container.
 *
 * PostgreSQL exempts superusers and table owners from row-level security, so
 * the container's `postgres` role cannot observe whether an RLS policy works.
 * Tests that assert tenant isolation connect as this role instead.
 */
function pgPoolAs(user, password) {
  const { Pool } = require('pg');
  const databaseUrl = requireEnv('DATABASE_URL');
  const url = new URL(databaseUrl);
  url.username = user;
  url.password = password;
  url.searchParams.delete('schema');
  return new Pool({ connectionString: url.toString() });
}

let redisClientPromise = null;

/** A dedicated, real Redis client owned by the tests (not the app's). */
function redis() {
  if (!redisClientPromise) {
    const url = requireEnv('REDIS_URL');
    const client = createClient({ url });
    // Without a listener node-redis turns connection errors into unhandled
    // rejections; the suite only cares that the client eventually connects.
    client.on('error', () => {});
    redisClientPromise = client.connect().then(() => client);
  }
  return redisClientPromise;
}

async function closeRedis() {
  if (!redisClientPromise) return;
  const client = await redisClientPromise;
  redisClientPromise = null;
  await client.quit();
}

/**
 * Poll until `probe` resolves truthy, or fail after `timeoutMs`.
 *
 * Several production paths write to the database or to Redis *after* the
 * response is sent (`setImmediate` in the audit-log middleware, fire-and-forget
 * `setEx` in the idempotency middleware). Asserting on them needs a wait, and
 * a fixed `sleep` would be exactly the kind of timing guess that makes a suite
 * flaky, so poll instead.
 */
async function eventually(probe, { timeoutMs = DEFAULT_EVENTUALLY_TIMEOUT_MS, intervalMs = DEFAULT_EVENTUALLY_INTERVAL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  for (;;) {
    try {
      const result = await probe();
      if (result) return result;
      lastError = null;
    } catch (err) {
      lastError = err;
    }

    if (Date.now() >= deadline) {
      const suffix = lastError ? ` Last error: ${lastError.message}` : '';
      throw new Error(`Condition not met within ${timeoutMs}ms.${suffix}`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Wait until the app's own clients are connected.
 *
 * `server.js` opens its Redis connection while it is being required, without
 * awaiting it, so the first request of a test file can otherwise be served by
 * the in-memory fallbacks in the cache/idempotency/rate-limit middlewares. The
 * `/health` endpoint reports the real state of both dependencies, so poll it
 * until they are up. (Horizon is expected to be down — CI has no Stellar node —
 * which is why only `database` and `redis` are inspected.)
 */
async function waitForDependencies(app) {
  await eventually(
    async () => {
      const res = await request(app).get('/health');
      return res.status === 200 || (res.body && res.body.database === 'up' && res.body.redis === 'up');
    },
    { timeoutMs: 30000 },
  );
}

/** Truncate every app table, so each test starts from an empty schema. */
async function resetPostgres() {
  const client = prisma();
  const { rows } = await client.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`,
  );
  const tables = rows
    .map((row) => row.tablename)
    .filter((name) => !PRISMA_OWNED_TABLES.includes(name));

  if (tables.length === 0) return;

  // RESTART IDENTITY keeps uuid/counter defaults predictable and CASCADE clears
  // the foreign keys in one round trip.
  await client.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.map((name) => `"${name}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

/** Empty the keyspace: caches, rate-limit windows and idempotency records. */
async function resetRedis() {
  const client = await redis();
  await client.flushAll();
}

/**
 * In-process caches that live outside Redis and therefore survive `flushAll`.
 * Flushed explicitly so a value cached by one test cannot answer another.
 */
function resetInMemoryCaches() {
  const { cache } = require('../../src/cache');
  cache.flushAll();
}

/** Full isolation: empty schema, empty keyspace, empty in-process caches. */
async function resetTestState() {
  await resetPostgres();
  await resetRedis();
  resetInMemoryCaches();
}

// ---------------------------------------------------------------------------
// Fixtures — inserted through the real Prisma client so tests fail loudly if a
// column, index or default drifts away from the migration chain.
// ---------------------------------------------------------------------------

/** `username_registry` defaults to the same federation suffix the server uses. */
function nameTag(username) {
  return username.includes('*') ? username : `${username}*localhost`;
}

let addressCounter = 0;

/**
 * A unique Stellar account ID.
 *
 * Horizon is unreachable from CI and `@stellar/stellar-sdk` cannot be required
 * by Jest, so `StrKey` is reimplemented in ./stellarStub — including its
 * checksum rule. Fixtures are therefore minted through that same reimplementation
 * rather than as address-shaped strings, so `isValidEd25519PublicKey` accepts
 * them exactly as the real SDK would and a test can never pass merely because
 * the address looked plausible.
 */
function makeAddress(label = 'ACCT') {
  addressCounter += 1;
  return require('./stellarStub').publicKeyFor(`${label}#${addressCounter}`);
}

/** Insert a user row directly, bypassing the HTTP API. */
async function insertUser({
  username,
  address = makeAddress(),
  isPrimary = true,
  memoType = null,
  memo = null,
  flaggedAt = null,
  deletedAt = null,
  createdAt = new Date(),
} = {}) {
  return prisma().user.create({
    data: {
      username: nameTag(username),
      address,
      isPrimary,
      memoType,
      memo,
      flaggedAt,
      deletedAt,
      createdAt,
    },
  });
}

async function insertWalletBalance(username, assetCode, amount) {
  return prisma().walletBalance.create({
    data: { username: nameTag(username), assetCode, amount },
  });
}

/** Insert `count` payments spread over `minutes` so created_at ordering is unambiguous. */
async function insertPayments(rows) {
  return prisma().payment.createMany({ data: rows });
}

module.exports = {
  closeRedis,
  eventually,
  insertPayments,
  insertUser,
  insertWalletBalance,
  makeAddress,
  nameTag,
  pgPool,
  pgPoolAs,
  prisma,
  redis,
  requireEnv,
  resetInMemoryCaches,
  resetPostgres,
  resetRedis,
  resetTestState,
  waitForDependencies,
};
