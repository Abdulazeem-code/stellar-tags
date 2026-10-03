const crypto = require('crypto');
const { Pool } = require('pg');
const { logger } = require('./logger');
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  logger.error(err, 'Unexpected error on idle PostgreSQL client');
});

(async () => {
  if (process.env.NODE_ENV === 'test') {
    logger.warn('PostgreSQL schema init skipped in test environment');
    return;
  }
  let retries = 5;
  while (retries > 0) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS username_registry (
          username TEXT PRIMARY KEY,
          address TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS webhooks (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          url TEXT NOT NULL,
          secret TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_sent_at TIMESTAMPTZ,
          failing_since TIMESTAMPTZ,
          UNIQUE(username, url),
          FOREIGN KEY (username) REFERENCES username_registry(username) ON DELETE CASCADE
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS webhooks_username_idx ON webhooks(username)`).catch(() => {});
      await pool.query(`CREATE INDEX IF NOT EXISTS webhooks_last_sent_at_idx ON webhooks(last_sent_at)`).catch(() => {});
      logger.info(`PostgreSQL pool initialised — max ${pool.options.max} connections`);
      return;
    } catch (err) {
      retries -= 1;
      logger.error(err, `Failed to initialise PostgreSQL schema. Retries left: ${retries}`);
      if (retries === 0) {
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
})();

const poolGet = async (sql, params = []) => {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
};

const poolRun = async (sql, params = []) => {
  const result = await pool.query(sql, params);
  return { changes: result.rowCount };
};

const poolAll = async (sql, params = []) => {
  const { rows } = await pool.query(sql, params);
  return rows;
};

const { USER_DATABASE, normalizeNameTag } = require('./utils');

const etagCache = (req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    const bodyString = JSON.stringify(body);
    const hash = crypto.createHash('sha256').update(bodyString).digest('hex');
    const etag = `"${hash}"`;

    res.set('ETag', etag);

    const clientEtag = req.get('If-None-Match');
    if (clientEtag && clientEtag === etag) {
      return res.status(304).end();
    }

    return originalJson(body);
  };

  next();
};

const {
  setTenantContext,
  clearTenantContext,
  withTenantTransaction,
} = require('./middleware/tenantContext');

/**
 * Initializes multi-tenant tables and PostgreSQL Row-Level Security (RLS) policies.
 */
async function initMultiTenancySchema(dbPool = pool) {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS tenant_enterprises (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      stellar_address TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS tenant_enterprises_tenant_id_idx ON tenant_enterprises(tenant_id);

    CREATE TABLE IF NOT EXISTS tenant_payment_configs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      routing_asset TEXT NOT NULL,
      max_limit NUMERIC NOT NULL DEFAULT 10000,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS tenant_payment_configs_tenant_id_idx ON tenant_payment_configs(tenant_id);
  `);

  const tables = ['tenant_enterprises', 'tenant_payment_configs'];
  for (const table of tables) {
    await dbPool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`).catch(() => {});
    await dbPool.query(`DROP POLICY IF EXISTS ${table}_isolation_policy ON ${table};`).catch(() => {});
    await dbPool.query(`
      CREATE POLICY ${table}_isolation_policy ON ${table}
        FOR ALL
        USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''));
    `).catch(() => {});
  }
}

module.exports = {
  poolGet,
  poolRun,
  poolAll,
  pool,
  USER_DATABASE,
  normalizeNameTag,
  etagCache,
  initMultiTenancySchema,
  setTenantContext,
  clearTenantContext,
  withTenantTransaction,
};

