'use strict';

process.env.ADMIN_API_KEY = 'e2e-admin-key';

jest.mock('../../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));
jest.mock('pdfkit', () => jest.fn());

const mockDbUsers = new Map();

jest.mock('../../prismaClient', () => {
  const prisma = {
    user: {
      findFirst: jest.fn(async ({ where }) => {
        let row = null;
        if (where.address) {
          for (const entry of mockDbUsers.values()) {
            if (entry.address === where.address) {
              row = entry;
              break;
            }
          }
        }
        return row ? { ...row } : null;
      }),
      update: jest.fn(async ({ where, data }) => {
        const entry = mockDbUsers.get(where.address);
        if (!entry) throw new Error('Not found');
        const updated = { ...entry, ...data };
        mockDbUsers.set(where.address, updated);
        return updated;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        let count = 0;
        for (const [address, entry] of mockDbUsers.entries()) {
          if (where.address && entry.address === where.address) {
            mockDbUsers.set(address, { ...entry, ...data });
            count++;
          }
        }
        return { count };
      }),
      findMany: jest.fn(async () => {
        return Array.from(mockDbUsers.values());
      }),
      count: jest.fn(async () => {
        return mockDbUsers.size;
      })
    },
    payment: {
      findMany: jest.fn().mockResolvedValue([{ id: 'payment_1' }])
    },
    $transaction: jest.fn(async (ops) => Promise.all(ops)),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  };
  return { prisma, isPrismaConnectionError: () => false };
});

const request = require('supertest');
const { app } = require('../../server');

describe('E2E: Admin Flow', () => {
  beforeEach(() => {
    mockDbUsers.clear();
    mockDbUsers.set('GABC123XYZ456789ADMIN', {
      username: 'admin_test_user',
      address: 'GABC123XYZ456789ADMIN',
      flaggedAt: null,
      createdAt: new Date(),
    });
  });

  it('should allow admin to block a user and export users', async () => {
    // 1. Block User
    let res = await request(app)
      .post('/api/v1/admin/block')
      .set('x-api-key', 'e2e-admin-key')
      .send({ address: 'GABC123XYZ456789ADMIN' });

    expect(res.status).toBe(200);
    expect(res.body.address).toBe('GABC123XYZ456789ADMIN');
    expect(res.body.flaggedAt).toBeDefined();

    // 2. Export Payments
    res = await request(app)
      .get('/api/v1/admin/export?format=json')
      .set('x-api-key', 'e2e-admin-key');

    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe('payment_1');
  });

  it('should return 401 for unauthorized admin access', async () => {
    const res = await request(app)
      .post('/api/v1/admin/block')
      .set('x-api-key', 'wrong-key')
      .send({ address: 'GABC123XYZ456789ADMIN' });

    expect(res.status).toBe(401);
  });
});
