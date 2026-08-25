'use strict';

/**
 * tests/audit-log.test.js
 *
 * Tests for Admin Audit Logging System (issue #495).
 */

const request = require('supertest');

// ── mocks ────────────────────────────────────────────────────────────────────

jest.mock('redis', () => ({ createClient: jest.fn(() => null) }));
jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));

const mockAuditLogCreate = jest.fn().mockResolvedValue({});
const mockAuditLogFindMany = jest.fn().mockResolvedValue([]);
const mockUserUpdate = jest.fn();

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: mockUserUpdate,
    },
    auditLog: {
      create: mockAuditLogCreate,
      findMany: mockAuditLogFindMany,
      count: jest.fn(),
    },
    paymentIntent: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn().mockResolvedValue([0, []]),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $metrics: { json: jest.fn().mockResolvedValue({ counters: [], gauges: [], histograms: [] }) },
  },
  isPrismaConnectionError: () => false,
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn().mockImplementation(() => ({ payments: jest.fn() })) },
  StrKey: { isValidEd25519PublicKey: jest.fn((v) => typeof v === 'string' && v.startsWith('G')) },
  Keypair: { fromPublicKey: jest.fn(() => ({ verify: jest.fn(() => true) })) },
}));
jest.mock('pdfkit', () => jest.fn());

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';

// Load app and helpers after mocks are in place.
const { app } = require('../server');
const {
  redactSensitiveData,
  extractUserId,
  extractIpAddress,
  createAuditLogMiddleware,
} = require('../src/middleware/auditLog');

describe('Admin Audit Logging System', () => {
  beforeEach(() => {
    mockAuditLogCreate.mockClear();
    mockAuditLogFindMany.mockClear();
    mockUserUpdate.mockReset();
  });

  describe('redactSensitiveData', () => {
    it('redacts sensitive fields in top-level object', () => {
      const input = {
        username: 'alice',
        password: 'supersecretpassword',
        apiKey: 'key_12345',
        secret: 'mysecret',
        token: 'jwt.token.here',
        signature: 'sig_abc',
        normalField: 'hello',
      };

      const redacted = redactSensitiveData(input);
      expect(redacted).toEqual({
        username: 'alice',
        password: '[REDACTED]',
        apiKey: '[REDACTED]',
        secret: '[REDACTED]',
        token: '[REDACTED]',
        signature: '[REDACTED]',
        normalField: 'hello',
      });
    });

    it('redacts sensitive fields in deeply nested structures', () => {
      const input = {
        admin: {
          profile: {
            name: 'Admin',
            password: 'secretpassword',
          },
          tokens: [
            { id: 1, token: 'token1' },
            { id: 2, token: 'token2', name: 'api-token' },
          ],
        },
      };

      const redacted = redactSensitiveData(input);
      expect(redacted.admin.profile.password).toBe('[REDACTED]');
      expect(redacted.admin.tokens[0].token).toBe('[REDACTED]');
      expect(redacted.admin.tokens[1].token).toBe('[REDACTED]');
      expect(redacted.admin.tokens[1].name).toBe('api-token');
    });

    it('handles primitive, null, and undefined values safely', () => {
      expect(redactSensitiveData(null)).toBeNull();
      expect(redactSensitiveData(undefined)).toBeUndefined();
      expect(redactSensitiveData(123)).toBe(123);
      expect(redactSensitiveData('regular string')).toBe('regular string');
    });

    it('parses and redacts JSON strings if present', () => {
      const jsonStr = JSON.stringify({ password: 'secret', name: 'test' });
      const redacted = redactSensitiveData(jsonStr);
      const parsed = JSON.parse(redacted);
      expect(parsed.password).toBe('[REDACTED]');
      expect(parsed.name).toBe('test');
    });
  });

  describe('extractUserId & extractIpAddress', () => {
    it('extracts user ID from user object, headers, or query', () => {
      expect(extractUserId({ user: { id: 'usr-123' } })).toBe('usr-123');
      expect(extractUserId({ user: { username: 'admin_bob' } })).toBe('admin_bob');
      expect(extractUserId({ headers: { 'x-user-id': 'u-999' } })).toBe('u-999');
      expect(extractUserId({ headers: { 'x-admin-id': 'adm-777' } })).toBe('adm-777');
      expect(extractUserId({ headers: { 'x-api-key': 'test-key' } })).toBe('admin');
      expect(extractUserId({ headers: {}, query: { api_key: 'test-key' } })).toBe('admin');
      expect(extractUserId({ headers: {} })).toBe('anonymous');
    });

    it('extracts client IP from x-forwarded-for or request ip', () => {
      expect(extractIpAddress({ headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' } })).toBe('198.51.100.1');
      expect(extractIpAddress({ headers: {}, ip: '203.0.113.195' })).toBe('203.0.113.195');
      expect(extractIpAddress({ headers: {}, socket: { remoteAddress: '127.0.0.1' } })).toBe('127.0.0.1');
      expect(extractIpAddress({ headers: {} })).toBe('unknown');
    });
  });

  describe('Audit Log Middleware Integration', () => {
    it('records an audit log for mutating admin actions (POST /admin/block)', async () => {
      mockUserUpdate.mockResolvedValueOnce({
        username: 'alice',
        address: 'GABC1234567890123456789012345678901234567890123456789012',
        flaggedAt: new Date(),
      });

      const res = await request(app)
        .post('/api/v1/admin/block')
        .set('x-api-key', 'test-admin-key')
        .set('x-user-id', 'admin-user-1')
        .send({
          address: 'GABC1234567890123456789012345678901234567890123456789012',
          secret: 'should-be-redacted',
        });

      expect(res.status).toBe(200);

      // Wait a tick for async setImmediate callback in middleware
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockAuditLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          method: 'POST',
          action: expect.stringMatching(/POST.*\/admin\/block/),
          userId: 'admin-user-1',
          statusCode: 200,
          payload: expect.any(String),
        }),
      });

      const loggedPayload = JSON.parse(mockAuditLogCreate.mock.calls[0][0].data.payload);
      expect(loggedPayload.secret).toBe('[REDACTED]');
      expect(loggedPayload.address).toBe('GABC1234567890123456789012345678901234567890123456789012');
    });

    it('does not log non-mutating requests (GET /admin/export)', async () => {
      mockAuditLogCreate.mockClear();

      await request(app)
        .get('/api/v1/admin/export')
        .set('x-api-key', 'test-admin-key');

      await new Promise((resolve) => setImmediate(resolve));

      expect(mockAuditLogCreate).not.toHaveBeenCalled();
    });

    it('does not crash request if audit log persistence fails', async () => {
      mockAuditLogCreate.mockRejectedValueOnce(new Error('Database connection failure'));
      mockUserUpdate.mockResolvedValueOnce({
        username: 'bob',
        address: 'GBOB1234567890123456789012345678901234567890123456789012',
        flaggedAt: new Date(),
      });

      const res = await request(app)
        .post('/api/v1/admin/block')
        .set('x-api-key', 'test-admin-key')
        .send({ address: 'GBOB1234567890123456789012345678901234567890123456789012' });

      expect(res.status).toBe(200);

      await new Promise((resolve) => setImmediate(resolve));
      expect(mockAuditLogCreate).toHaveBeenCalled();
    });
  });

  describe('GET /admin/audit-logs', () => {
    it('returns 401 without API key', async () => {
      const res = await request(app).get('/api/v1/admin/audit-logs');
      expect(res.status).toBe(401);
    });

    it('returns 401 with wrong API key', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit-logs')
        .set('x-api-key', 'wrong-key');
      expect(res.status).toBe(401);
    });

    it('returns list of audit logs with valid API key', async () => {
      const mockLogs = [
        {
          id: 'log-1',
          action: 'POST /admin/block',
          method: 'POST',
          path: '/api/v1/admin/block',
          userId: 'admin',
          ipAddress: '127.0.0.1',
          statusCode: 200,
          createdAt: new Date(),
        },
      ];
      mockAuditLogFindMany.mockResolvedValueOnce(mockLogs);

      const res = await request(app)
        .get('/api/v1/admin/audit-logs?limit=10')
        .set('x-api-key', 'test-admin-key');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        count: 1,
        data: expect.any(Array),
      });
      expect(mockAuditLogFindMany).toHaveBeenCalledWith({
        take: 10,
        orderBy: { createdAt: 'desc' },
      });
    });
  });
});
