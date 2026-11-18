'use strict';

/**
 * #686 — multi-tenancy row-level security against a real PostgreSQL.
 *
 * RLS is the one part of this backend that *cannot* be meaningfully faked: it
 * lives entirely in the database, and a superuser connection is exempt from it.
 * These tests therefore create an unprivileged role on the container and drive
 * `withTenantTransaction` through that role, so the isolation is enforced by
 * PostgreSQL rather than by application code that happens to add a WHERE clause.
 *
 * The privilege boundary under test:
 *   - a tenant sees its own rows and nothing else;
 *   - a query with no tenant context sees nothing;
 *   - a tenant cannot write a row belonging to another tenant (WITH CHECK).
 */

const express = require('express');
const request = require('supertest');
const { initMultiTenancySchema, withTenantTransaction } = require('../../src/db');
const { isValidTenantId, tenantContextMiddleware } = require('../../src/middleware/tenantContext');
const { pgPool, pgPoolAs, resetTestState } = require('./support/harness');

const LOW_PRIVILEGE_ROLE = 'integration_app';
const LOW_PRIVILEGE_PASSWORD = 'integration_app_pw';
const TENANT_TABLES = ['tenant_enterprises', 'tenant_payment_configs'];

describe('multi-tenancy RLS (real PostgreSQL)', () => {
  let privileged;
  let unprivileged;

  beforeAll(async () => {
    privileged = pgPool();
    unprivileged = pgPoolAs(LOW_PRIVILEGE_ROLE, LOW_PRIVILEGE_PASSWORD);

    await initMultiTenancySchema(privileged);

    // The container's `postgres` role is a superuser, so RLS never applies to
    // it. Everything below runs as this ordinary role instead.
    await privileged.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOW_PRIVILEGE_ROLE}') THEN
          CREATE ROLE ${LOW_PRIVILEGE_ROLE} LOGIN PASSWORD '${LOW_PRIVILEGE_PASSWORD}';
        END IF;
      END $$;
    `);
    await privileged.query(
      `GRANT USAGE ON SCHEMA public TO ${LOW_PRIVILEGE_ROLE}`,
    );
    for (const table of TENANT_TABLES) {
      await privileged.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${LOW_PRIVILEGE_ROLE}`,
      );
    }
  });

  beforeEach(async () => {
    await resetTestState();
  });

  afterAll(async () => {
    if (unprivileged) await unprivileged.end();
  });

  const seedEnterprise = (id, tenantId, name) =>
    privileged.query(
      `INSERT INTO tenant_enterprises (id, tenant_id, name, stellar_address)
       VALUES ($1, $2, $3, $4)`,
      [id, tenantId, name, `GTEST-ENTERPRISE-${id}`],
    );

  const listEnterprises = (client) =>
    client
      .query('SELECT id, tenant_id, name FROM tenant_enterprises ORDER BY id')
      .then((result) => result.rows);

  it('applies the isolation policy to both tenant tables', async () => {
    const { rows } = await privileged.query(
      `SELECT c.relname AS table, c.relrowsecurity AS rls
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = ANY($1)`,
      [TENANT_TABLES],
    );

    expect(rows.map((row) => row.table).sort()).toEqual([...TENANT_TABLES].sort());
    for (const row of rows) {
      expect(row.rls).toBe(true);
    }
  });

  it('shows a tenant only its own rows', async () => {
    await seedEnterprise('ent-a1', 'tenant-a', 'Acme A');
    await seedEnterprise('ent-a2', 'tenant-a', 'Acme A2');
    await seedEnterprise('ent-b1', 'tenant-b', 'Globex B');

    const seenByA = await withTenantTransaction(unprivileged, 'tenant-a', listEnterprises);

    expect(seenByA.map((row) => row.id)).toEqual(['ent-a1', 'ent-a2']);
    expect(seenByA.every((row) => row.tenant_id === 'tenant-a')).toBe(true);
  });

  it('shows a different tenant a disjoint set of rows', async () => {
    await seedEnterprise('ent-a1', 'tenant-a', 'Acme A');
    await seedEnterprise('ent-b1', 'tenant-b', 'Globex B');

    const seenByB = await withTenantTransaction(unprivileged, 'tenant-b', listEnterprises);
    const seenByA = await withTenantTransaction(unprivileged, 'tenant-a', listEnterprises);

    expect(seenByB.map((row) => row.id)).toEqual(['ent-b1']);
    expect(seenByA.map((row) => row.id)).toEqual(['ent-a1']);
  });

  it('shows nothing when no tenant context is set', async () => {
    await seedEnterprise('ent-a1', 'tenant-a', 'Acme A');
    await seedEnterprise('ent-b1', 'tenant-b', 'Globex B');

    const client = await unprivileged.connect();
    try {
      const rows = await listEnterprises(client);
      // `tenant_id = NULLIF(current_setting(...), '')` is never true without a
      // context, so the policy hides every row rather than leaking them.
      expect(rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('lets a tenant insert its own row and refuses another tenant’s', async () => {
    await withTenantTransaction(unprivileged, 'tenant-a', (client) =>
      client.query(
        `INSERT INTO tenant_payment_configs (id, tenant_id, routing_asset, max_limit)
         VALUES ('cfg-a', 'tenant-a', 'XLM', 500)`,
      ),
    );

    const own = await withTenantTransaction(unprivileged, 'tenant-a', (client) =>
      client.query('SELECT id, routing_asset FROM tenant_payment_configs'),
    );
    expect(own.rows).toEqual([{ id: 'cfg-a', routing_asset: 'XLM' }]);

    await expect(
      withTenantTransaction(unprivileged, 'tenant-a', (client) =>
        client.query(
          `INSERT INTO tenant_payment_configs (id, tenant_id, routing_asset, max_limit)
           VALUES ('cfg-b', 'tenant-b', 'USDC', 500)`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('rejects an update that would move a row to another tenant', async () => {
    await seedEnterprise('ent-a1', 'tenant-a', 'Acme A');

    await expect(
      withTenantTransaction(unprivileged, 'tenant-a', (client) =>
        client.query("UPDATE tenant_enterprises SET tenant_id = 'tenant-b' WHERE id = 'ent-a1'"),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('rolls the transaction back when the callback throws', async () => {
    await expect(
      withTenantTransaction(unprivileged, 'tenant-a', async (client) => {
        await client.query(
          `INSERT INTO tenant_enterprises (id, tenant_id, name, stellar_address)
           VALUES ('ent-roll', 'tenant-a', 'Rollback', 'GTEST-ROLL')`,
        );
        throw new Error('callback failed');
      }),
    ).rejects.toThrow('callback failed');

    // The insert must not have survived the ROLLBACK, and the pool must be
    // usable again afterwards.
    const rows = await withTenantTransaction(unprivileged, 'tenant-a', listEnterprises);
    expect(rows).toEqual([]);
  });

  it('refuses to open a transaction for a malformed tenant id', async () => {
    for (const tenantId of ['', 'tenant a', 'a'.repeat(65), 'tenant;DROP TABLE users', null]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(withTenantTransaction(unprivileged, tenantId, listEnterprises)).rejects.toThrow(
        /Invalid tenant/,
      );
    }

    expect(isValidTenantId('tenant-a')).toBe(true);
    expect(isValidTenantId('tenant_a-1')).toBe(true);
    expect(isValidTenantId('tenant a')).toBe(false);
  });
});

describe('tenant context middleware', () => {
  const buildApp = (options) => {
    const scoped = express();
    scoped.get(
      '/tenant',
      tenantContextMiddleware(options),
      (req, res) => res.json({ tenantId: req.tenantId ?? null }),
    );
    return scoped;
  };

  it('echoes a valid X-Tenant-ID and rejects a malformed one', async () => {
    const app = buildApp();

    const ok = await request(app).get('/tenant').set('X-Tenant-ID', ' tenant-a ');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ tenantId: 'tenant-a' });
    expect(ok.headers['x-tenant-id']).toBe('tenant-a');

    const bad = await request(app).get('/tenant').set('X-Tenant-ID', 'tenant a; DROP TABLE users');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'InvalidTenantContext' });
  });

  it('passes a request with no tenant through when the context is optional', async () => {
    const res = await request(buildApp()).get('/tenant');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tenantId: null });
  });

  it('refuses a request with no tenant when the context is required', async () => {
    const res = await request(buildApp({ required: true })).get('/tenant');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'MissingTenantContext' });
  });
});
