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
      updateMany: jest.fn(async ({ where, data }) => {
        let count = 0;
        for (const entry of mockDbUsers.values()) {
          if (entry.address === where.address) {
            const updated = { ...entry, ...data };
            mockDbUsers.set(entry.address, updated);
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
    activityLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue([{ id: 1, amount: 100 }]),
    },
    $transaction: jest.fn(async (ops) => Promise.all(ops)),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  };
  return { prisma, isPrismaConnectionError: () => false, getPrisma: () => ({ prisma, isPrismaConnectionError: () => false, withTransaction: async (cb) => cb(prisma) }), withTransaction: async (cb) => cb(prisma) };
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
    expect(res.text).toBeDefined();
    const lines = res.text.trim().split('\n').filter(Boolean);
    const data = lines.map((line) => JSON.parse(line));
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].id).toBe(1);
    expect(data[0].amount).toBe(100);
  });

  it('should return 401 for unauthorized admin access', async () => {
    const res = await request(app)
      .post('/api/v1/admin/block')
      .set('x-api-key', 'wrong-key')
      .send({ address: 'GABC123XYZ456789ADMIN' });

    expect(res.status).toBe(401);
  });
});
