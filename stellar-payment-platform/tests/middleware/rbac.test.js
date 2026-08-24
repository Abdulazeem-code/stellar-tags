'use strict';

const express = require('express');
const request = require('supertest');

const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock('../../src/logger', () => ({ logger: mockLogger }));

const {
  ROLES,
  normalizeRole,
  canWrite,
  canRead,
  requireRole,
} = require('../../src/middleware/rbac');
const { buildErrorHandler, notFoundHandler } = require('../../src/middleware/errorHandler');

const mockAdminStore = new Map();

jest.mock('../../prismaClient', () => ({
  prisma: {
    admin: {
      findUnique: async ({ where }) => mockAdminStore.get(where.apiKey) || null,
      update: async ({ where, data }) => {
        for (const admin of mockAdminStore.values()) {
          if (admin.id === where.id) {
            Object.assign(admin, data);
            return admin;
          }
        }
        const e = new Error('not found');
        e.code = 'P2025';
        throw e;
      },
    },
    user: {
      update: async ({ where, data }) => {
        if (where.address === 'GVALID') {
          return {
            username: 'alice',
            address: where.address,
            flaggedAt: data.flaggedAt,
          };
        }
        const e = new Error('not found');
        e.code = 'P2025';
        throw e;
      },
    },
  },
  isPrismaConnectionError: () => false,
}));

function seedAdmin({ apiKey, role, email = `${role.toLowerCase()}@example.com`, id = role }) {
  mockAdminStore.set(apiKey, { id, email, apiKey, role });
}

function buildApp() {
  const app = express();
  app.use((req, res, next) => {
    req.correlationId = 'test-correlation-id';
    next();
  });
  app.use(express.json());
  const adminRoutes = require('../../src/routes/v1/adminRoutes')(null);
  app.use('/v1', adminRoutes);
  app.use(notFoundHandler);
  app.use(buildErrorHandler(() => false));
  return app;
}

describe('RBAC helpers', () => {
  test('normalizes known roles case-insensitively', () => {
    expect(normalizeRole('superadmin')).toBe(ROLES.SUPER_ADMIN);
    expect(normalizeRole('Viewer')).toBe(ROLES.VIEWER);
    expect(normalizeRole('SUPPORT')).toBe(ROLES.SUPPORT);
    expect(normalizeRole('hacker')).toBeNull();
  });

  test('Support and Viewer cannot write; SuperAdmin can', () => {
    expect(canWrite(ROLES.SUPPORT)).toBe(false);
    expect(canWrite(ROLES.VIEWER)).toBe(false);
    expect(canWrite(ROLES.SUPER_ADMIN)).toBe(true);
    expect(canRead(ROLES.SUPPORT)).toBe(true);
    expect(canRead(ROLES.VIEWER)).toBe(true);
  });
});

describe('RBAC middleware on admin routes', () => {
  let app;

  beforeEach(() => {
    mockAdminStore.clear();
    delete process.env.ADMIN_API_KEY;
    seedAdmin({ apiKey: 'super-key', role: ROLES.SUPER_ADMIN });
    seedAdmin({ apiKey: 'viewer-key', role: ROLES.VIEWER });
    seedAdmin({ apiKey: 'support-key', role: ROLES.SUPPORT });
    app = buildApp();
  });

  test('rejects missing API key', async () => {
    const res = await request(app).get('/v1/admin/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  test('rejects unknown API key', async () => {
    const res = await request(app).get('/v1/admin/me').set('x-api-key', 'nope');
    expect(res.status).toBe(401);
  });

  test('Support can read /admin/me', async () => {
    const res = await request(app).get('/v1/admin/me').set('x-api-key', 'support-key');
    expect(res.status).toBe(200);
    expect(res.body.role).toBe(ROLES.SUPPORT);
  });

  test('Support cannot POST mutating admin actions', async () => {
    const res = await request(app)
      .post('/v1/admin/block')
      .set('x-api-key', 'support-key')
      .send({ address: 'GVALID' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toMatch(/mutating/i);
  });

  test('Viewer cannot PUT', async () => {
    const res = await request(app)
      .put('/v1/admin/admins/Support/role')
      .set('x-api-key', 'viewer-key')
      .send({ role: 'Viewer' });
    expect(res.status).toBe(403);
  });

  test('SuperAdmin can POST /admin/block', async () => {
    const res = await request(app)
      .post('/v1/admin/block')
      .set('x-api-key', 'super-key')
      .send({ address: 'GVALID' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Address successfully blocked');
  });

  test('legacy ADMIN_API_KEY is treated as SuperAdmin', async () => {
    process.env.ADMIN_API_KEY = 'legacy-secret';
    const res = await request(app)
      .post('/v1/admin/block')
      .set('x-api-key', 'legacy-secret')
      .send({ address: 'GVALID' });
    expect(res.status).toBe(200);
  });

  test('requireRole can restrict to SuperAdmin only', async () => {
    const mini = express();
    mini.use(express.json());
    mini.delete('/secret', requireRole({ roles: [ROLES.SUPER_ADMIN] }), (req, res) => {
      res.json({ ok: true });
    });
    mini.use(buildErrorHandler(() => false));

    const denied = await request(mini).delete('/secret').set('x-api-key', 'support-key');
    expect(denied.status).toBe(403);

    const allowed = await request(mini).delete('/secret').set('x-api-key', 'super-key');
    expect(allowed.status).toBe(200);
  });
});
