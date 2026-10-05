'use strict';

/**
 * #686 — integration test bootstrap.
 *
 * Boots one real PostgreSQL and one real Redis instance for the whole
 * integration phase and exports their addresses as `DATABASE_URL` /
 * `REDIS_URL`, so every test file in the run exercises the same code paths
 * production does: real SQL through Prisma and `pg`, real unique indexes and
 * foreign keys, real Redis-backed caches, rate limits and idempotency.
 *
 * The containers are only reachable from the Docker host, so they are started
 * here in Jest's main process; the worker processes inherit the exported
 * environment (jest-worker forks them with `process.env`).
 *
 * Two escape hatches exist for environments without a usable Docker daemon:
 *
 *   TEST_DATABASE_URL / TEST_REDIS_URL
 *       Reuse an already-running PostgreSQL/Redis instead of starting a
 *       container. The container-backed `postgres-test` service from
 *       docker-compose.yml (`docker compose --profile test up -d postgres-test`)
 *       can be pointed at with
 *       `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/stellar_tags_test`.
 *
 * Neither is set in CI: the pipeline deliberately orchestrates real containers.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { RedisContainer } = require('@testcontainers/redis');
const { remember, noopResource } = require('./support/containerState');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const PRISMA_SCHEMA = path.join(BACKEND_ROOT, 'prisma', 'schema.prisma');

// Pinned to the same major/minor versions docker-compose.yml runs in dev, so
// the integration phase exercises the same SQL dialect as the deployed stack.
const POSTGRES_IMAGE = process.env.TESTCONTAINERS_POSTGRES_IMAGE || 'postgres:16-alpine';
const REDIS_IMAGE = process.env.TESTCONTAINERS_REDIS_IMAGE || 'redis:7-alpine';

const POSTGRES_DATABASE = 'stellar_tags_test';
const POSTGRES_USERNAME = 'postgres';
const POSTGRES_PASSWORD = 'postgres';

// Prisma's own "a new version is available" nag pollutes CI output.
process.env.PRISMA_HIDE_UPDATE_MESSAGE = 'true';

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[containers] ${message}`);
}

async function startPostgres() {
  if (process.env.TEST_DATABASE_URL) {
    log(`using external PostgreSQL from TEST_DATABASE_URL`);
    return { connectionUri: process.env.TEST_DATABASE_URL, container: noopResource('external-postgres') };
  }

  log(`starting ${POSTGRES_IMAGE}…`);
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(POSTGRES_DATABASE)
    .withUsername(POSTGRES_USERNAME)
    .withPassword(POSTGRES_PASSWORD)
    .start();

  return { connectionUri: container.getConnectionUri(), container };
}

async function startRedis() {
  if (process.env.TEST_REDIS_URL) {
    log('using external Redis from TEST_REDIS_URL');
    return { connectionUrl: process.env.TEST_REDIS_URL, container: noopResource('external-redis') };
  }

  log(`starting ${REDIS_IMAGE}…`);
  const container = await new RedisContainer(REDIS_IMAGE).start();

  return { connectionUrl: container.getConnectionUrl(), container };
}

/**
 * Apply the real migration chain to the freshly created database.
 *
 * This is the step that mock-based suites can never perform, and it is the
 * reason the phase exists: a database built purely from `prisma/migrations`
 * has to be valid SQL end to end, including the zero-downtime ALTERs. Any
 * regression here fails the run before a single assertion executes.
 */
function runMigrations(databaseUrl) {
  log('applying prisma migrations…');
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}

module.exports = async function globalSetup() {
  let postgres;
  let redis;
  try {
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
  } catch (err) {
    throw new Error(
      'Unable to start the integration test containers. This phase needs a reachable Docker ' +
        'daemon (set DOCKER_HOST if it is not the default socket), or pre-started services via ' +
        'TEST_DATABASE_URL / TEST_REDIS_URL.\n' +
        `Underlying error: ${err && err.message ? err.message : err}`,
      { cause: err },
    );
  }

  remember(postgres.container);
  remember(redis.container);

  // `?schema=public` matches the connection strings documented in
  // .env.example; `pg` ignores the unknown parameter, Prisma uses it.
  const databaseUrl = `${postgres.connectionUri}?schema=public`;

  // The integration phase must behave like `npm test` (silent logger, relaxed
  // env gate) or it will fail for reasons unrelated to what it verifies.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redis.connectionUrl;
  process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'testcontainers-admin-key';
  // src/migrate-check only runs under `require.main === module`, but keep the
  // policy permissive so a stray caller can never abort the run.
  process.env.MIGRATION_POLICY = 'off';
  // Headroom above the default of 10: several suites legitimately perform
  // multiple signature-checked POSTs in a single test (e.g. the
  // five-usernames-per-address rule).
  // tests/containers/redis-backed-middleware.test.js lowers this back down in
  // its own module registry to assert the 429.
  process.env.SIGNATURE_RATE_LIMIT_MAX = process.env.SIGNATURE_RATE_LIMIT_MAX || '200';
  // /health also probes Horizon, which CI cannot reach. A short timeout keeps
  // the readiness poll in the harness from stalling on a dependency these tests
  // deliberately stub out.
  process.env.HEALTH_HORIZON_TIMEOUT_MS = process.env.HEALTH_HORIZON_TIMEOUT_MS || '500';

  runMigrations(databaseUrl);

  log('ready.');
};
