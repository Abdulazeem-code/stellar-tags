const request = require('supertest');

// Mock the Stellar SDK to prevent Jest ESM syntax errors
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) }
}));

jest.mock('redis', () => ({
  createClient: jest.fn(() => null),
}));

// Mock Prisma so it doesn't try to connect to a real database and crash
jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null)
    },
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
  isPrismaConnectionError: jest.fn().mockReturnValue(false),
}));

process.env.NODE_ENV = 'test';
const { app } = require('../server');

describe('GET /federation', () => {
  // 'client' is seeded in USER_DATABASE inside server.js
  it('returns 200 with stellar address for a known user', async () => {
    const res = await request(app)
      .get('/api/v1/federation')
      .query({ q: 'client*localhost' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('stellar_address');
    expect(res.body).toHaveProperty('account_id');
  });

  it('returns 404 for an unknown user', async () => {
    const res = await request(app)
      .get('/api/v1/federation')
      .query({ q: 'nonexistentuser*localhost' });

    expect(res.statusCode).toBe(404);
    expect(res.body).toHaveProperty('error');
  });
});
