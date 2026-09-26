'use strict';

jest.mock('../../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));
jest.mock('pdfkit', () => jest.fn());

const mockDb = new Map();

jest.mock('../../prismaClient', () => {
  const prisma = {
    user: {
      findFirst: jest.fn(async ({ where }) => {
        let row = null;
        if (where.username) {
          const u = typeof where.username === 'string' ? where.username : where.username.equals;
          for (const entry of mockDb.values()) {
            if (entry.username === u) {
              row = entry;
              break;
            }
          }
        } else if (where.address) {
          const a = typeof where.address === 'string' ? where.address : where.address.equals;
          for (const entry of mockDb.values()) {
            if (entry.address.toLowerCase() === a.toLowerCase()) {
              row = entry;
              break;
            }
          }
        }
        return row ? { ...row } : null;
      }),
      create: jest.fn(async ({ data }) => {
        const row = {
          username: data.username,
          address: data.address,
          memoType: data.memoType || null,
          memo: data.memo || null,
          createdAt: new Date(),
        };
        mockDb.set(data.address, row);
        return row;
      }),
    },
    $transaction: jest.fn(async (ops) => Promise.all(ops)),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  };
  return { prisma, isPrismaConnectionError: () => false };
});

jest.mock('../../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn().mockResolvedValue({ success: true }),
  isSingleSignerAccount: jest.fn().mockReturnValue(true),
}));

jest.mock('bad-words', () => {
  return jest.fn().mockImplementation(() => ({
    isProfane: jest.fn(() => false),
  }));
});

const request = require('supertest');
const { app } = require('../../server');
const { prisma } = require('../../prismaClient');

describe('E2E: Federation Flow', () => {
  beforeEach(() => {
    mockDb.clear();
  });

  it('should successfully lookup a user by name and ID', async () => {
    const validUser = {
      username: 'federationtest*localhost',
      address: 'GABC123XYZ456789FEDERATION',
    };
    mockDb.set(validUser.address, validUser);

    // 1. Lookup by Name (default behavior)
    let res = await request(app)
      .get(`/api/v1/federation?q=${encodeURIComponent(validUser.username)}&type=name`);

    expect(res.status).toBe(200);
    expect(res.body.account_id).toBe(validUser.address);

    // 2. Lookup by ID
    res = await request(app)
      .get(`/api/v1/federation?q=${validUser.address}&type=id`);

    expect(res.status).toBe(200);
    expect(res.body.stellar_address).toBe(validUser.username);

    // 3. Not Found
    res = await request(app)
      .get(`/api/v1/federation?q=nonexistent*localhost&type=name`);

    expect(res.status).toBe(404);
  });
});
