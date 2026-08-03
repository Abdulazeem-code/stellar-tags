'use strict';

// Mock cleanup-cron so background cron doesn't interfere during tests
jest.mock('./src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('./src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

// Mock @stellar/stellar-sdk to prevent Jest from trying to parse ESM dependencies
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

jest.mock('pdfkit', () => jest.fn());

// ---------------------------------------------------------------------------
// In-memory mock database for integration lifecycle tests
// ---------------------------------------------------------------------------
const mockDb = new Map();

jest.mock('./prismaClient', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where, select }) => {
        let row = null;
        if (where.username) {
          for (const entry of mockDb.values()) {
            if (entry.username === where.username) {
              row = entry;
              break;
            }
          }
        } else if (where.address) {
          row = mockDb.get(where.address) || null;
        }
        if (!row) return null;
        if (select) {
          const result = {};
          for (const key of Object.keys(select)) {
            if (select[key]) result[key] = row[key];
          }
          return result;
        }
        return { ...row };
      }),
      findFirst: jest.fn(async ({ where, select }) => {
        const addr = where?.address?.equals;
        if (!addr) return null;
        for (const entry of mockDb.values()) {
          if (entry.address.toLowerCase() === addr.toLowerCase()) {
            if (select) {
              const result = {};
              for (const key of Object.keys(select)) {
                if (select[key]) result[key] = entry[key];
              }
              return result;
            }
            return { ...entry };
          }
        }
        return null;
      }),
      findMany: jest.fn(async ({ where, skip, take } = {}) => {
        let results = Array.from(mockDb.values());
        if (where?.OR) {
          results = results.filter((row) =>
            where.OR.some((cond) => {
              for (const [field, filter] of Object.entries(cond)) {
                if (filter.contains) {
                  const hay = row[field] || '';
                  const needle = filter.contains;
                  if (filter.mode === 'insensitive') {
                    return hay.toLowerCase().includes(needle.toLowerCase());
                  }
                  return hay.includes(needle);
                }
              }
              return false;
            }),
          );
        }
        if (typeof skip === 'number') results = results.slice(skip);
        if (typeof take === 'number') results = results.slice(0, take);
        return results;
      }),
      count: jest.fn(async ({ where } = {}) => {
        if (!where) return mockDb.size;
        let results = Array.from(mockDb.values());
        if (where?.OR) {
          results = results.filter((row) =>
            where.OR.some((cond) => {
              for (const [field, filter] of Object.entries(cond)) {
                if (filter.contains) {
                  const hay = row[field] || '';
                  const needle = filter.contains;
                  if (filter.mode === 'insensitive') {
                    return hay.toLowerCase().includes(needle.toLowerCase());
                  }
                  return hay.includes(needle);
                }
              }
              return false;
            }),
          );
        }
        return results.length;
      }),
      create: jest.fn(async ({ data }) => {
        for (const entry of mockDb.values()) {
          if (entry.username === data.username) {
            const err = new Error('Unique constraint failed on the fields: (`username`)');
            err.code = 'SQLITE_CONSTRAINT';
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
    },
    $transaction: jest.fn(async (ops) => Promise.all(ops)),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  };
  return { prisma };
});

// Mock multi-signer verifier (loaded by v1 userRoutes)
jest.mock('./src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn().mockResolvedValue({ success: true }),
  isSingleSignerAccount: jest.fn().mockReturnValue(true),
}));

const request = require('supertest');
const { app } = require('./server');

describe('API Integration Lifecycle Suite', () => {
  // Clients submit a bare username; the server appends the federation suffix,
  // so `federationTag` is what gets stored and returned.
  const user1 = {
    username: 'integrationuser',
    federationTag: 'integrationuser*localhost',
    address: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
  };

  const user2 = {
    username: 'integrationuser',
    federationTag: 'integrationuser*localhost',
    address: 'GBDQD3WTQ6W2VQ2W4V74UZ5WYF6B72GZ6EHD7I3L3WYH357Y4K5H3E4W',
  };

  beforeAll(() => {
    // Clear mock database rows automatically before running
    mockDb.clear();
  });

  afterAll(() => {
    // Clear mock database rows automatically after running
    mockDb.clear();
  });

  test('Full lifecycle: register a user, query the user, and attempt to register a duplicate username', async () => {
    // 1. Register a user hitting /api/v1/register
    const registerRes = await request(app)
      .post('/api/v1/register')
      .send({
        username: user1.username,
        address: user1.address,
      });

    expect(registerRes.status).toBe(201);
    expect(registerRes.body).toMatchObject({
      ok: true,
      username: user1.federationTag,
      address: user1.address,
    });

    // 2. Query the user via /api/v1/lookup
    const queryRes = await request(app)
      .get(`/api/v1/lookup?address=${user1.address}`);

    expect(queryRes.status).toBe(200);
    expect(queryRes.body).toMatchObject({
      username: user1.federationTag,
      address: user1.address,
    });

    // Also query the user via search parameter on /api/v1/lookup
    const searchRes = await request(app)
      .get('/api/v1/lookup?search=integrationuser');

    expect(searchRes.status).toBe(200);
    expect(searchRes.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          username: user1.federationTag,
          address: user1.address,
        }),
      ]),
    );

    // Also query the user via /api/v1/federation
    const fedRes = await request(app)
      .get(`/api/v1/federation?q=${user1.federationTag}&type=name`);

    expect(fedRes.status).toBe(200);
    expect(fedRes.body).toMatchObject({
      stellar_address: user1.address,
      account_id: user1.address,
    });

    // 3. Attempt to register a duplicate username hitting /api/v1/register
    const duplicateRes = await request(app)
      .post('/api/v1/register')
      .send({
        username: user2.username,
        address: user2.address,
      });

    // Assess expected JSON status returns (409 Conflict for duplicate username)
    expect(duplicateRes.status).toBe(409);
    expect(duplicateRes.body).toHaveProperty("error");
  });

  test('v1 /register sanitizes memo of type text — strips HTML/script tags before save', async () => {
    const address = 'GBDQD3WTQ6W2VQ2W4V74UZ5WYF6B72GZ6EHD7I3L3WYH357Y4K5H3E4W';

    // Mixed payload: inner safe text + dangerous tag — inner text must remain
    // in the saved row, dangerous tags must be removed.
    const malicious = '<b>payment</b><script>alert("xss")</script><a href="javascript:alert(1)">x</a>';

    const res = await request(app)
      .post('/api/v1/register')
      .send({
        username: 'memo_xss',
        address,
        memo_type: 'text',
        memo: malicious,
      });

    expect(res.status).toBe(201);

    // Saved/returned memo must not contain any angle brackets, script tags,
    // javascript: scheme, etc. Inner text 'payment' is preserved.
    expect(res.body.memo).not.toMatch(/[<>]/);
    expect(res.body.memo).not.toMatch(/script/i);
    expect(res.body.memo).not.toMatch(/javascript:/i);
    expect(res.body.memo).toContain('payment');

    // Lookup confirms the sanitized value is what is actually stored.
    const lookup = await request(app).get(`/api/v1/lookup?address=${address}`);
    expect(lookup.status).toBe(200);
    expect(lookup.body).toHaveProperty('username', 'memo_xss*localhost');

    // Federation response echoes the sanitized memo.
    const fed = await request(app).get(`/api/v1/federation?q=GBDQD3WTQ6W2VQ2W4V74UZ5WYF6B72GZ6EHD7I3L3WYH357Y4K5H3E4W&type=id`);
    expect(fed.status).toBe(200);
    expect(fed.body.memo_type).toBe('text');
    expect(fed.body.memo).not.toMatch(/[<>]/);
    expect(fed.body.memo).not.toMatch(/script/i);
  });

  test('v1 /register rejects memo whose sanitization removes all content', async () => {
    const address = 'GFFZF43FJB7Q5K6SWFKJQTNAXYVF7KAVN4GYJ3ZU3VZMYR5SX5QGYBS3';

    const malicious = '<script>alert("xss")</script>';

    const res = await request(app)
      .post('/api/v1/register')
      .send({
        username: 'memo_xss_empty',
        address,
        memo_type: 'text',
        memo: malicious,
      });

    // Sanitization emptied the memo, validateMemo rejects; no row is created.
    expect(res.status).toBe(400);

    const lookup = await request(app).get(`/api/v1/lookup?address=${address}`);
    expect(lookup.status).toBe(404);
  });
});
