'use strict';

/**
 * Multi-Tenancy Context Middleware & RLS Helper
 *
 * Enforces PostgreSQL Row-Level Security (RLS) by associating transactions
 * and requests with a verified tenant context (app.current_tenant_id).
 */

const TENANT_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validates whether a tenant ID meets security constraints.
 * @param {string} tenantId
 * @returns {boolean}
 */
function isValidTenantId(tenantId) {
  if (typeof tenantId !== 'string') return false;
  return TENANT_ID_REGEX.test(tenantId.trim());
}

/**
 * Express middleware to extract and validate tenant context.
 * Reads X-Tenant-ID header or req.user.tenantId (from authenticated JWTs).
 */
function tenantContextMiddleware(options = {}) {
  const { required = false } = options;

  return (req, res, next) => {
    const rawTenant = req.headers['x-tenant-id'] || req.user?.tenantId || req.query?.tenant_id;

    if (!rawTenant) {
      if (required) {
        return res.status(400).json({
          error: 'MissingTenantContext',
          message: 'X-Tenant-ID header is required for multi-tenant access',
        });
      }
      req.tenantId = null;
      return next();
    }

    const tenantId = String(rawTenant).trim();
    if (!isValidTenantId(tenantId)) {
      return res.status(400).json({
        error: 'InvalidTenantContext',
        message: 'X-Tenant-ID contains invalid characters or exceeds 64 characters',
      });
    }

    req.tenantId = tenantId;
    res.setHeader('X-Tenant-ID', tenantId);
    next();
  };
}

/**
 * Sets the current tenant context for a PostgreSQL connection/transaction.
 * Uses parameterized queries to prevent SQL injection.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} tenantId
 */
async function setTenantContext(client, tenantId) {
  if (!isValidTenantId(tenantId)) {
    throw new Error(`Invalid tenantId provided: ${tenantId}`);
  }
  await client.query('SET LOCAL app.current_tenant_id = $1', [tenantId]);
}

/**
 * Resets the current tenant context on the client.
 *
 * @param {import('pg').PoolClient} client
 */
async function clearTenantContext(client) {
  await client.query("SET LOCAL app.current_tenant_id = ''");
}

/**
 * Executes a callback within a tenant-scoped database transaction.
 * Automatically handles BEGIN, SET LOCAL app.current_tenant_id, COMMIT, ROLLBACK.
 *
 * @param {import('pg').Pool} pool
 * @param {string} tenantId
 * @param {Function} callback (client) => Promise<any>
 */
async function withTenantTransaction(pool, tenantId, callback) {
  if (!isValidTenantId(tenantId)) {
    throw new Error(`Invalid tenant ID: ${tenantId}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setTenantContext(client, tenantId);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors if connection died
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  isValidTenantId,
  tenantContextMiddleware,
  setTenantContext,
  clearTenantContext,
  withTenantTransaction,
};
