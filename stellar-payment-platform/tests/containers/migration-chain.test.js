'use strict';

/**
 * #686 — the migration chain itself.
 *
 * The bug that motivated this phase was not a wrong assertion, it was a
 * database that could not be built: `payments`, `routing_rules` and
 * `wallet_balances` were declared in `schema.prisma` but no migration created
 * them, so `prisma migrate deploy` aborted on the fraud-detection ALTER and every
 * other suite had been papering over it with a mock.
 *
 * These tests treat the migration chain as the subject. They assert that the
 * chain applies end to end, that the result matches `schema.prisma` with no
 * drift, and that the constraints the application relies on (uniqueness,
 * cascade, defaults) exist in the database rather than only in the ORM.
 */

jest.mock('../../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pgPool, prisma, resetTestState } = require('./support/harness');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'prisma', 'migrations');
const SCHEMA_PATH = path.join(BACKEND_ROOT, 'prisma', 'schema.prisma');
const SHADOW_DATABASE = 'stellar_tags_shadow';

/** Table → column names, for the tables this phase's fix restored. */
const REQUIRED_TABLES = {
  payments: [
    'id',
    'created_at',
    'from_address',
    'to_address',
    'amount',
    'fee',
    'asset_code',
    'transaction_hash',
    'status',
    'risk_score',
    'fraud_status',
    'fraud_flagged_at',
  ],
  routing_rules: [
    'id',
    'name',
    'description',
    'priority',
    'active',
    'client_org',
    'conditions',
    'actions',
    'metadata',
    'created_at',
    'updated_at',
  ],
  wallet_balances: ['id', 'username', 'asset_code', 'amount', 'created_at', 'updated_at'],
};

describe('migration chain (real PostgreSQL)', () => {
  const pool = pgPool();

  beforeAll(async () => {
    // `migrate diff --from-migrations` needs a scratch database it may create
    // and drop freely; the container's superuser can provision one.
    await pool.query(`DROP DATABASE IF EXISTS ${SHADOW_DATABASE}`);
    await pool.query(`CREATE DATABASE ${SHADOW_DATABASE}`);
  });

  beforeEach(async () => {
    await resetTestState();
  });

  afterAll(async () => {
    await pool.query(`DROP DATABASE IF EXISTS ${SHADOW_DATABASE}`).catch(() => {});
    await pool.end();
  });

  const columnNames = async (table) => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1`,
      [table],
    );
    return rows.map((row) => row.column_name).sort();
  };

  const indexNames = async (table) => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = $1`,
      [table],
    );
    return rows.map((row) => row.indexname);
  };

  it('records every migration in the directory as applied', async () => {
    const onDisk = fs
      .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const { rows } = await pool.query(
      'SELECT migration_name, finished_at, rolled_back_at, logs FROM _prisma_migrations ORDER BY migration_name',
    );

    // globalSetup already ran `prisma migrate deploy`; if the chain had aborted
    // part-way, this is where it would show.
    expect(rows.map((row) => row.migration_name)).toEqual(onDisk);
    for (const row of rows) {
      expect(row.finished_at).not.toBeNull();
      expect(row.rolled_back_at ?? null).toBeNull();
    }
  });

  it('creates the tables the chain used to leave out', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = ANY($1)`,
      [Object.keys(REQUIRED_TABLES)],
    );

    expect(rows.map((row) => row.table_name).sort()).toEqual(Object.keys(REQUIRED_TABLES).sort());
  });

  for (const [table, columns] of Object.entries(REQUIRED_TABLES)) {
    it(`gives ${table} the columns the Prisma model declares`, async () => {
      expect(await columnNames(table)).toEqual([...columns].sort());
    });
  }

  it('applies the fraud columns after the table exists', async () => {
    // Ordering guarantee: `payments` is created before
    // 20260926000000_add_fraud_detection can ALTER it.
    const columns = await columnNames('payments');
    expect(columns).toEqual(expect.arrayContaining(['risk_score', 'fraud_status', 'fraud_flagged_at']));

    const { rows } = await pool.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'payments' AND column_name = 'fraud_status'`,
    );
    expect(rows[0].column_default).toBe("'clear'::text");
  });

  it('creates the indexes the query plans depend on', async () => {
    expect(await indexNames('payments')).toEqual(
      expect.arrayContaining([
        'payments_created_at_idx',
        'payments_created_at_id_idx',
        'payments_from_address_idx',
        'payments_to_address_idx',
      ]),
    );
    expect(await indexNames('username_registry')).toEqual(
      expect.arrayContaining([
        'username_registry_address_idx',
        'username_registry_created_at_username_idx',
      ]),
    );
    expect(await indexNames('webhooks')).toEqual(
      expect.arrayContaining(['webhooks_username_url_key', 'webhooks_username_idx']),
    );
    expect(await indexNames('wallet_balances')).toEqual(
      expect.arrayContaining([
        'wallet_balances_username_idx',
        'wallet_balances_username_asset_code_key',
      ]),
    );
  });

  it('keeps the wallet-balance foreign key pointing at the registry, cascading on delete', async () => {
    const { rows } = await pool.query(
      `SELECT conname, confdeltype
         FROM pg_constraint
        WHERE conrelid = 'wallet_balances'::regclass AND contype = 'f'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].conname).toBe('wallet_balances_username_fkey');
    expect(rows[0].confdeltype).toBe('c'); // 'c' = CASCADE

    await prisma().user.create({ data: { username: 'fkowner*localhost', address: 'GFKADDRESS' } });
    await prisma().walletBalance.create({
      data: { username: 'fkowner*localhost', assetCode: 'XLM', amount: 1 },
    });

    await prisma().user.delete({ where: { username: 'fkowner*localhost' } });
    expect(await prisma().walletBalance.count()).toBe(0);
  });

  it('refuses a balance for a username that does not exist', async () => {
    await expect(
      prisma().walletBalance.create({
        data: { username: 'ghost*localhost', assetCode: 'XLM', amount: 1 },
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  it('applies the column defaults the application relies on', async () => {
    const row = await prisma().payment.create({
      data: { fromAddress: 'GDEFAULTFROM', toAddress: 'GDEFAULTTO', amount: 1 },
    });

    expect(row).toMatchObject({ fee: 0, status: 'completed', fraudStatus: 'clear' });
    expect(row.assetCode).toBeNull();
    expect(row.transactionHash).toBeNull();
  });

  it('has no drift between the migration chain and schema.prisma', () => {
    // The decisive check for this issue. `--from-migrations` replays the whole
    // chain into a throwaway database, so a chain that is not valid SQL, or
    // that no longer agrees with the datamodel, fails here.
    const databaseUrl = new URL(process.env.DATABASE_URL);
    databaseUrl.pathname = `/${SHADOW_DATABASE}`;
    databaseUrl.search = '';

    const result = spawnSync(
      'node',
      [
        require.resolve('prisma/build/index.js'),
        'migrate',
        'diff',
        '--from-migrations',
        MIGRATIONS_DIR,
        '--to-schema-datamodel',
        SCHEMA_PATH,
        '--shadow-database-url',
        databaseUrl.toString(),
        '--exit-code',
      ],
      { cwd: BACKEND_ROOT, encoding: 'utf8' },
    );

    // 0 = empty diff, 2 = drift found, anything else = the command itself broke.
    // stderr is not asserted on: the CLI emits deprecation warnings there on
    // every run, and a warning is not drift.
    if (result.status !== 0) {
      throw new Error(
        `prisma migrate diff exited ${result.status}; the migration chain and schema.prisma ` +
          `do not agree.\n--- stdout ---\n${result.stdout || '(empty)'}\n` +
          `--- stderr ---\n${result.stderr || '(empty)'}`,
      );
    }

    expect(result.status).toBe(0);
  }, 120_000);
});
