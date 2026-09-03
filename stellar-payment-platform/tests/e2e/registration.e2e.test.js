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
      findUnique: jest.fn(async ({ where }) => {
        let row = null;
        if (where.username) {
          for (const entry of mockDb.values()) {
            if (entry.username === where.username) {
              row = entry;
              break;
            }
          }
        }
        return row ? { ...row } : null;
      }),
      findFirst: jest.fn(async ({ where }) => {
        let row = null;
        if (where.username) {
          for (const entry of mockDb.values()) {
            if (entry.username === where.username) {
              row = entry;
              break;
            }
          }
        } else if (where.address) {
          for (const entry of mockDb.values()) {
            if (entry.address === where.address) {
              row = entry;
              break;
            }
          }
        }
        return row ? { ...row } : null;
      }),
      create: jest.fn(async ({ data }) => {
        for (const entry of mockDb.values()) {
          if (entry.username === data.username || entry.address === data.address) {
            const err = new Error('Unique constraint failed');
            err.code = 'P2002';
            throw err;
          }
        }
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
      count: jest.fn().mockResolvedValue(0),
    },
    activityLog: {
      create: jest.fn().mockResolvedValue({}),
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

describe('E2E: Registration Flow', () => {
  beforeEach(() => {
    mockDb.clear();
  });

  it('should successfully register a new user and handle duplicate registration gracefully', async () => {
    // 1. Successful Registration
    const validUser = {
      username: 'e2eregistertest',
      address: 'GABC123XYZ456789REGISTRATION',
    };

    let res = await request(app)
      .post('/api/v1/register')
      .send(validUser);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.username).toContain(validUser.username);
    expect(res.body.address).toBe(validUser.address);

    // 2. Duplicate Registration should return 409
    res = await request(app)
      .post('/api/v1/register')
      .send(validUser);

    expect(res.status).toBe(409);
    expect(res.body.error).toBeDefined();
    
    // 3. Invalid input (e.g., empty username)
    res = await request(app)
      .post('/api/v1/register')
      .send({ address: 'GDEF456XYZ' });
    
    expect(res.status).toBe(422); // Validation error
  });
});
