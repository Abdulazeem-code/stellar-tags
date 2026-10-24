'use strict';

/**
 * Route tests for the admin soft-delete / restore endpoints (#731).
 *
 * The router is mounted on a bare Express app so the tests exercise only the
 * handlers; Prisma, the federation cache and the stats cache are mocked.
 */

const express = require('express');
const request = require('supertest');

const mockUserUpdateMany = jest.fn();
const mockUserFindFirst = jest.fn();
const mockUserFindMany = jest.fn();
const mockPaymentUpdateMany = jest.fn();
const mockPaymentFindFirst = jest.fn();
const mockPaymentFindMany = jest.fn();
const mockActivityCreate = jest.fn();

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      updateMany: mockUserUpdateMany,
      findFirst: mockUserFindFirst,
      findMany: mockUserFindMany,
    },
    payment: {
      updateMany: mockPaymentUpdateMany,
      findFirst: mockPaymentFindFirst,
      findMany: mockPaymentFindMany,
    },
    activityLog: { create: mockActivityCreate },
  },
  isPrismaConnectionError: () => false,
}));

jest.mock('../src/federationCache', () => ({
  invalidateFederationCache: jest.fn(),
}));

jest.mock('../src/cache/statsCache', () => ({
  invalidateStatsCache: jest.fn(),
}));

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';

const buildAdminRouter = require('../src/routes/v1/adminRoutes');

const ADMIN_KEY = { 'x-api-key': 'test-admin-key' };

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/', buildAdminRouter(null));
  return app;
};

describe('admin soft-delete endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_API_KEY = 'test-admin-key';

    mockUserUpdateMany.mockResolvedValue({ count: 1 });
    mockUserFindFirst.mockResolvedValue({
      username: 'alice*localhost',
      address: 'GABC',
      deletedAt: new Date('2026-09-01T00:00:00Z'),
    });
    mockUserFindMany.mockResolvedValue([
      {
        username: 'bob*localhost',
        address: 'GDEF',
        deletedAt: new Date('2026-09-01T00:00:00Z'),
      },
    ]);

    mockPaymentUpdateMany.mockResolvedValue({ count: 1 });
    mockPaymentFindFirst.mockResolvedValue({
      id: 'pay-1',
      deletedAt: new Date('2026-09-02T00:00:00Z'),
    });
    mockPaymentFindMany.mockResolvedValue([
      {
        id: 'pay-2',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        fromAddress: 'GFROM',
        toAddress: 'GTO',
        amount: 5,
        status: 'completed',
        deletedAt: new Date('2026-09-02T00:00:00Z'),
      },
    ]);

    mockActivityCreate.mockResolvedValue({});
  });

  it('rejects a request without the admin API key', async () => {
    const res = await request(buildApp()).delete('/admin/payments/pay-1');
    expect(res.status).toBe(401);
  });

  it('soft-deletes a payment', async () => {
    const res = await request(buildApp())
      .delete('/admin/payments/pay-1')
      .set(ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: 'pay-1', deleted: true });
    expect(mockPaymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it('returns 404 when the payment is missing or already deleted', async () => {
    mockPaymentUpdateMany.mockResolvedValue({ count: 0 });

    const res = await request(buildApp())
      .delete('/admin/payments/ghost')
      .set(ADMIN_KEY);

    expect(res.status).toBe(404);
  });

  it('restores a soft-deleted payment', async () => {
    const res = await request(buildApp())
      .post('/admin/payments/pay-1/restore')
      .set(ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: 'pay-1', restored: true });
    expect(mockPaymentUpdateMany).toHaveBeenCalledWith({
      where: { id: 'pay-1', deletedAt: { not: null } },
      data: { deletedAt: null },
    });
  });

  it('returns 404 when restoring an unknown payment', async () => {
    mockPaymentFindFirst.mockResolvedValue(null);

    const res = await request(buildApp())
      .post('/admin/payments/ghost/restore')
      .set(ADMIN_KEY);

    expect(res.status).toBe(404);
  });

  it('restores a soft-deleted username and records the activity', async () => {
    const res = await request(buildApp())
      .post('/admin/users/alice/restore')
      .set(ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      username: 'alice*localhost',
      restored: true,
    });
    expect(mockUserUpdateMany).toHaveBeenCalledWith({
      where: { username: 'alice*localhost', deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    expect(mockActivityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'user.restored' }),
      }),
    );
  });

  it('returns 404 when restoring an unknown username', async () => {
    mockUserFindFirst.mockResolvedValue(null);

    const res = await request(buildApp())
      .post('/admin/users/ghost/restore')
      .set(ADMIN_KEY);

    expect(res.status).toBe(404);
  });

  it('lists soft-deleted usernames', async () => {
    const res = await request(buildApp())
      .get('/admin/users/deleted')
      .set(ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      username: 'bob*localhost',
      address: 'GDEF',
      deleted_at: '2026-09-01T00:00:00.000Z',
    });
    expect(mockUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: { not: null } } }),
    );
  });

  it('lists soft-deleted payments', async () => {
    const res = await request(buildApp())
      .get('/admin/payments/deleted')
      .set(ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      id: 'pay-2',
      amount: 5,
      deleted_at: '2026-09-02T00:00:00.000Z',
    });
  });
});
