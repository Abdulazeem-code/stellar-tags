'use strict';

const request = require('supertest');

jest.mock('./prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
  isPrismaConnectionError: jest.fn().mockReturnValue(false),
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
}));

jest.mock('pdfkit', () => jest.fn());
jest.mock('./src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));

const { app } = require('./server');
const { prisma } = require('./prismaClient');

describe('GET /federation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 400 if q parameter is missing', async () => {
    const response = await request(app).get('/federation');
    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty('error');
    expect(response.body.error.details[0].message).toBe("Missing 'q' parameter");
  });

  test('successfully looks up username and formats Stellar TOML response', async () => {
    prisma.user.findFirst.mockResolvedValue({
      username: 'alice',
      address: 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G',
      memoType: 'text',
      memo: 'PlatformPayment',
    });

    const response = await request(app).get('/federation?q=alice*localhost');
    
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      stellar_address: 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G',
      account_id: 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G',
      memo_type: 'text',
      memo: 'PlatformPayment',
    });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { username: 'alice*localhost', deletedAt: null },
      select: { address: true, memoType: true, memo: true, flaggedAt: true },
    });
  });

  test('returns 404 for missing username lookup', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    const response = await request(app).get('/federation?q=unknown*localhost');
    
    expect(response.status).toBe(404);
    expect(response.body.error.message).toBe('Name tag not found');
  });

  test('successfully looks up address when type=id', async () => {
    prisma.user.findFirst.mockResolvedValue({
      username: 'bob',
      address: 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G',
    });

    // process.env.DOMAIN can be empty, defaulting to localhost
    const response = await request(app).get('/federation?type=id&q=GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G');
    
    expect(response.status).toBe(200);
    expect(response.body.stellar_address).toMatch(/^bob\*/);
    expect(response.body.account_id).toBe('GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G');
  });

  test('returns 404 for missing address lookup when type=id', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    const response = await request(app).get('/federation?type=id&q=UNKNOWNADDRESS');
    
    expect(response.status).toBe(404);
    expect(response.body.error.message).toBe('Address not found');
  });
});
