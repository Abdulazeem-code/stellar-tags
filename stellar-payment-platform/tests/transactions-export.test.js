'use strict';

const request = require('supertest');

const mockPayments = jest.fn();
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn().mockImplementation(() => ({ payments: mockPayments })) },
  StrKey: { isValidEd25519PublicKey: jest.fn((v) => typeof v === 'string' && v.startsWith('G')) },
  Keypair: { fromPublicKey: jest.fn(() => ({ verify: jest.fn(() => true) })) },
}));
jest.mock('pdfkit', () => jest.fn());
jest.mock('redis', () => ({ createClient: jest.fn(() => null) }));
jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));
jest.mock('../prismaClient', () => ({
  prisma: {
    user: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([0, []]),
    $queryRaw: jest.fn().mockResolvedValue([]),
  },
  isPrismaConnectionError: () => false,
}));

process.env.NODE_ENV = 'test';
const ADDRESS = 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ';

const record = (i, overrides = {}) => ({
  id: `id-${i}`,
  created_at: '2026-07-30T00:00:00Z',
  type: 'payment',
  from: ADDRESS,
  to: 'GBDQD3WTQ6W2VQ2W4V74UZ5WYF6B72GZ6EHD7I3L3WYH357Y4K5H3E4W',
  amount: `${i}.0000000`,
  asset_type: 'native',
  transaction_hash: `hash-${i}`,
  ...overrides,
});

/** Builds a Horizon call chain whose pages follow one another via next(). */
const mockPages = (pages) => {
  const build = (index) => ({
    records: pages[index] || [],
    next: jest.fn(() => Promise.resolve(build(index + 1))),
  });
  const chain = {
    forAccount: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    call: jest.fn().mockResolvedValue(build(0)),
  };
  mockPayments.mockReturnValue(chain);
  return chain;
};

const { app } = require('../server');
const { COLUMNS, escapeField } = require('../src/routes/v1/exportRoutes');

describe('GET /transactions/export', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('response framing', () => {
    test('streams CSV with download headers', async () => {
      mockPages([[record(1)]]);
      const res = await request(app).get(`/transactions/export?address=${ADDRESS}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain(`transactions-${ADDRESS}`);
    });

    test('does not set Content-Length, so the body is streamed', async () => {
      mockPages([[record(1)]]);
      const res = await request(app).get(`/transactions/export?address=${ADDRESS}`);

      expect(res.headers['content-length']).toBeUndefined();
      expect(res.headers['transfer-encoding']).toBe('chunked');
    });

    test('emits a header row followed by one row per record', async () => {
      mockPages([[record(1), record(2)]]);
      const res = await request(app).get(`/transactions/export?address=${ADDRESS}`);
      const lines = res.text.trim().split('\r\n');

      expect(lines[0]).toBe(COLUMNS.join(','));
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain('id-1');
      expect(lines[2]).toContain('id-2');
    });

    test('emits only the header row when there are no transactions', async () => {
      mockPages([[]]);
      const res = await request(app).get(`/transactions/export?address=${ADDRESS}`);

      expect(res.status).toBe(200);
      expect(res.text).toBe(`${COLUMNS.join(',')}\r\n`);
    });
  });

  describe('pagination', () => {
    test('follows Horizon cursors until a short page ends the export', async () => {
      const full = Array.from({ length: 200 }, (_, i) => record(i));
      const chain = mockPages([full, [record(999)]]);

      const res = await request(app).get(`/transactions/export?address=${ADDRESS}`);
      const lines = res.text.trim().split('\r\n');

      expect(lines).toHaveLength(202);
      expect(res.text).toContain('id-999');
      expect(chain.call).toHaveBeenCalledTimes(1);
    });

    test('requests the maximum page size so pages are not fetched one row at a time', async () => {
      const chain = mockPages([[record(1)]]);
      await request(app).get(`/transactions/export?address=${ADDRESS}`);

      expect(chain.limit).toHaveBeenCalledWith(200);
    });

    test('passes the requested order through', async () => {
      const chain = mockPages([[record(1)]]);
      await request(app).get(`/transactions/export?address=${ADDRESS}&order=asc`);

      expect(chain.order).toHaveBeenCalledWith('asc');
    });

    test('defaults to desc for an unknown order', async () => {
      const chain = mockPages([[record(1)]]);
      await request(app).get(`/transactions/export?address=${ADDRESS}&order=sideways`);

      expect(chain.order).toHaveBeenCalledWith('desc');
    });
  });

  describe('CSV correctness', () => {
    test('quotes fields containing a comma, quote or newline', () => {
      expect(escapeField('a,b')).toBe('"a,b"');
      expect(escapeField('say "hi"')).toBe('"say ""hi"""');
      expect(escapeField('line1\nline2')).toBe('"line1\nline2"');
    });

    test('renders empty strings for absent fields', () => {
      expect(escapeField(undefined)).toBe('');
      expect(escapeField(null)).toBe('');
    });

    test('neutralises spreadsheet formula injection', () => {
      expect(escapeField('=1+1')).toBe("'=1+1");
      expect(escapeField('@SUM(A1)')).toBe("'@SUM(A1)");
    });

    test('escapes a malicious memo inside a streamed row', async () => {
      mockPages([[record(1, { to: 'a,b"c' })]]);
      const res = await request(app).get(`/transactions/export?address=${ADDRESS}`);

      expect(res.text).toContain('"a,b""c"');
    });
  });

  describe('errors before the stream is committed', () => {
    test('rejects a missing address with the standard envelope', async () => {
      const res = await request(app).get('/transactions/export');

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'INVALID_INPUT' },
      });
    });

    test('rejects a non-Stellar address', async () => {
      const res = await request(app).get('/transactions/export?address=not-a-key');

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Invalid Stellar account');
    });

    test('reports an unknown account as NOT_FOUND', async () => {
      mockPayments.mockReturnValue({
        forAccount: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        call: jest.fn().mockRejectedValue({ response: { status: 404 } }),
      });

      const res = await request(app).get(`/transactions/export?address=${ADDRESS}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    test('reports a Horizon failure as UPSTREAM_ERROR', async () => {
      mockPayments.mockReturnValue({
        forAccount: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        call: jest.fn().mockRejectedValue(new Error('network down')),
      });

      const res = await request(app).get(`/transactions/export?address=${ADDRESS}`);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPSTREAM_ERROR');
    });
  });
});
