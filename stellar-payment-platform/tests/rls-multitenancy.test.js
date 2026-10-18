'use strict';

jest.mock('pg', () => {
  const mClient = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  };
  const mPool = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    on: jest.fn(),
    options: { max: 10 },
    connect: jest.fn().mockResolvedValue(mClient),
  };
  return { Pool: jest.fn(() => mPool) };
});

const {
  isValidTenantId,
  tenantContextMiddleware,
  setTenantContext,
  clearTenantContext,
  withTenantTransaction,
} = require('../src/middleware/tenantContext');
const { initMultiTenancySchema } = require('../src/db');

describe('Multi-Tenancy & Row-Level Security (RLS) Architecture', () => {
  describe('Tenant ID Validation', () => {
    it('accepts valid alphanumeric, dashed, and underscored tenant IDs', () => {
      expect(isValidTenantId('tenant-123')).toBe(true);
      expect(isValidTenantId('enterprise_acme_corp')).toBe(true);
      expect(isValidTenantId('tenant1')).toBe(true);
      expect(isValidTenantId('A1-B2_C3')).toBe(true);
    });

    it('rejects invalid, malicious, or malformed tenant IDs', () => {
      expect(isValidTenantId('')).toBe(false);
      expect(isValidTenantId('   ')).toBe(false);
      expect(isValidTenantId("tenant'; DROP TABLE users; --")).toBe(false);
      expect(isValidTenantId('tenant/123')).toBe(false);
      expect(isValidTenantId('a'.repeat(65))).toBe(false);
      expect(isValidTenantId(null)).toBe(false);
      expect(isValidTenantId(12345)).toBe(false);
    });
  });

  describe('Tenant Context Middleware', () => {
    it('extracts X-Tenant-ID header and binds to req.tenantId', () => {
      const middleware = tenantContextMiddleware();
      const req = {
        headers: { 'x-tenant-id': 'tenant-acme' },
      };
      const res = {
        setHeader: jest.fn(),
      };
      const next = jest.fn();

      middleware(req, res, next);

      expect(req.tenantId).toBe('tenant-acme');
      expect(res.setHeader).toHaveBeenCalledWith('X-Tenant-ID', 'tenant-acme');
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('rejects requests with invalid tenant ID format', () => {
      const middleware = tenantContextMiddleware();
      const req = {
        headers: { 'x-tenant-id': 'invalid/tenant!' },
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const next = jest.fn();

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'InvalidTenantContext' })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('allows missing tenant context when required is false', () => {
      const middleware = tenantContextMiddleware({ required: false });
      const req = { headers: {} };
      const res = { setHeader: jest.fn() };
      const next = jest.fn();

      middleware(req, res, next);

      expect(req.tenantId).toBeNull();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('returns 400 when required is true and X-Tenant-ID is missing', () => {
      const middleware = tenantContextMiddleware({ required: true });
      const req = { headers: {} };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const next = jest.fn();

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'MissingTenantContext' })
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('PostgreSQL Session Context & Transaction Scoping', () => {
    it('sets app.current_tenant_id using parameterized query', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
      };

      await setTenantContext(mockClient, 'tenant-alpha');
      expect(mockClient.query).toHaveBeenCalledWith('SET LOCAL app.current_tenant_id = $1', ['tenant-alpha']);
    });

    it('clears tenant context securely', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
      };

      await clearTenantContext(mockClient);
      expect(mockClient.query).toHaveBeenCalledWith("SET LOCAL app.current_tenant_id = ''");
    });

    it('manages transaction lifecycle within withTenantTransaction', async () => {
      const executed = [];
      const mockClient = {
        query: jest.fn().mockImplementation((sql, params) => {
          executed.push({ sql, params });
          return Promise.resolve({ rows: [] });
        }),
        release: jest.fn(),
      };
      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient),
      };

      const result = await withTenantTransaction(mockPool, 'tenant-beta', async (client) => {
        await client.query('SELECT * FROM tenant_enterprises');
        return 'success-payload';
      });

      expect(result).toBe('success-payload');
      expect(mockPool.connect).toHaveBeenCalled();
      expect(executed[0].sql).toBe('BEGIN');
      expect(executed[1].sql).toBe('SET LOCAL app.current_tenant_id = $1');
      expect(executed[1].params).toEqual(['tenant-beta']);
      expect(executed[2].sql).toBe('SELECT * FROM tenant_enterprises');
      expect(executed[3].sql).toBe('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('rolls back transaction on error and releases connection', async () => {
      const executed = [];
      const mockClient = {
        query: jest.fn().mockImplementation((sql) => {
          executed.push(sql);
          return Promise.resolve({ rows: [] });
        }),
        release: jest.fn(),
      };
      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient),
      };

      await expect(
        withTenantTransaction(mockPool, 'tenant-gamma', async () => {
          throw new Error('Database constraint violation');
        })
      ).rejects.toThrow('Database constraint violation');

      expect(executed).toContain('BEGIN');
      expect(executed).toContain('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('Database RLS Policy Schema Generation', () => {
    it('generates tables with ROW LEVEL SECURITY and isolation policies', async () => {
      const executedQueries = [];
      const mockPool = {
        query: jest.fn().mockImplementation((sql) => {
          executedQueries.push(sql);
          return Promise.resolve({ rows: [] });
        }),
      };

      await initMultiTenancySchema(mockPool);

      const combinedQueries = executedQueries.join('\n');
      expect(combinedQueries).toContain('CREATE TABLE IF NOT EXISTS tenant_enterprises');
      expect(combinedQueries).toContain('ALTER TABLE tenant_enterprises ENABLE ROW LEVEL SECURITY');
      expect(combinedQueries).toContain('CREATE POLICY tenant_enterprises_isolation_policy ON tenant_enterprises');
      expect(combinedQueries).toContain('current_setting(\'app.current_tenant_id\'');
    });
  });
});
