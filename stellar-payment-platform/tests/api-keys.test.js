const request = require('supertest');
const crypto = require('crypto');

// Mock the Stellar SDK to prevent Jest ESM syntax errors
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) }
}));

// Mock Prisma so it doesn't try to connect to a real database
const mockApiKeyCreate = jest.fn();
const mockApiKeyFindUnique = jest.fn();
const mockApiKeyFindMany = jest.fn();
const mockApiKeyUpdate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        username: 'alice123',
        address: 'GABC123',
      }),
    },
    apiKey: {
      create: mockApiKeyCreate,
      findUnique: mockApiKeyFindUnique,
      findMany: mockApiKeyFindMany,
      update: mockApiKeyUpdate,
    },
    $transaction: mockTransaction,
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
}));

// Mock the pool functions
jest.mock('../src/db', () => ({
  poolGet: jest.fn().mockResolvedValue(null),
  poolRun: jest.fn().mockResolvedValue({ changes: 1 }),
  poolAll: jest.fn().mockResolvedValue([]),
}));

// Mock the v1 routes (factory function since v1/index.js now exports a function)
jest.mock('../src/routes/v1', () => {
  return () => require('express').Router();
});

// Mock JWT requireAuth to always pass in tests
jest.mock('../src/utils/jwt', () => ({
  signToken: jest.fn(() => 'mock-token'),
  verifyToken: jest.fn(() => ({ sub: 'test@example.com', email: 'test@example.com' })),
  getJwks: jest.fn(() => ({ keys: [] })),
  requireAuth: (req, res, next) => {
    req.user = { sub: 'test@example.com', email: 'test@example.com' };
    next();
  },
}));

const { app } = require('../server');

const KEY_PREFIX = 'sk_live_';
const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

describe('API Key Management Endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /auth/api-keys - Generate new API key', () => {
    it('should create a new API key successfully', async () => {
      const fakeId = 'test-api-key-id-123';
      mockApiKeyCreate.mockResolvedValue({
        id: fakeId,
        name: 'Test Key',
        ownerId: 'merchant@example.com',
        keyHash: 'mock-hash',
        keyPrefix: 'sk_live_abc',
        scopes: ['read', 'write'],
        expiresAt: null,
        createdAt: new Date(),
      });

      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Test Key',
          owner_id: 'merchant@example.com',
        });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(fakeId);
      expect(res.body.data.name).toBe('Test Key');
      expect(res.body.data.key).toMatch(/^sk_live_/);
      expect(res.body.data.key_prefix).toMatch(/^sk_live_/);
      expect(res.body.data.owner_id).toBe('merchant@example.com');
      expect(mockApiKeyCreate).toHaveBeenCalledTimes(1);
    });

    it('should create API key with custom scopes', async () => {
      const fakeId = 'test-api-key-id-456';
      mockApiKeyCreate.mockResolvedValue({
        id: fakeId,
        name: 'Read Only Key',
        ownerId: 'merchant@example.com',
        keyHash: 'mock-hash',
        keyPrefix: 'sk_live_abc',
        scopes: ['read'],
        expiresAt: null,
        createdAt: new Date(),
      });

      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Read Only Key',
          owner_id: 'merchant@example.com',
        });

      expect(res.statusCode).toBe(201);
      expect(mockApiKeyCreate).toHaveBeenCalled();
    });

    it('should create API key with expiration', async () => {
      const fakeId = 'test-api-key-id-789';
      mockApiKeyCreate.mockResolvedValue({
        id: fakeId,
        name: 'Expiring Key',
        ownerId: 'merchant@example.com',
        keyHash: 'mock-hash',
        keyPrefix: 'sk_live_abc',
        scopes: ['read', 'write'],
        expiresAt: new Date(),
        createdAt: new Date(),
      });

      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Expiring Key',
          owner_id: 'merchant@example.com',
          expires_in_hours: 24,
        });

      expect(res.statusCode).toBe(201);
      expect(mockApiKeyCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            expiresAt: expect.any(Date),
          }),
        }),
      );
    });

    it('should return 422 when name is missing', async () => {
      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          owner_id: 'merchant@example.com',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body.success).toBe(false);
    });

    it('should return 422 when owner_id is missing', async () => {
      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Test Key',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body.success).toBe(false);
    });

    it('should return 422 when scopes contain invalid values', async () => {
      const res = await request(app)
        .post('/auth/api-keys')
        .set('Content-Type', 'application/json')
        .send({
          name: 'Test Key',
          owner_id: 'merchant@example.com',
          scopes: 'invalid_scope',
        });

      expect(res.statusCode).toBe(422);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /auth/api-keys - List API keys', () => {
    it('should list API keys for an owner', async () => {
      const fakeKeys = [
        {
          id: 'key-1',
          name: 'Key 1',
          keyPrefix: 'sk_live_abc',
          ownerId: 'merchant@example.com',
          scopes: ['read', 'write'],
          expiresAt: null,
          revokedAt: null,
          revokedBy: null,
          lastUsedAt: new Date(),
          createdAt: new Date(),
        },
      ];
      mockApiKeyFindMany.mockResolvedValue(fakeKeys);

      const res = await request(app)
        .get('/auth/api-keys')
        .query({ owner_id: 'merchant@example.com' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Key 1');
    });

    it('should return 400 when owner_id is missing', async () => {
      const res = await request(app)
        .get('/auth/api-keys');

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return empty array when no keys exist', async () => {
      mockApiKeyFindMany.mockResolvedValue([]);

      const res = await request(app)
        .get('/auth/api-keys')
        .query({ owner_id: 'merchant@example.com' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(0);
    });
  });

  describe('POST /auth/api-keys/:id/revoke - Revoke API key', () => {
    it('should revoke an API key successfully', async () => {
      const fakeId = 'key-to-revoke';
      mockApiKeyFindUnique.mockResolvedValue({
        id: fakeId,
        name: 'Test Key',
        ownerId: 'merchant@example.com',
        revokedAt: null,
      });
      mockApiKeyUpdate.mockResolvedValue({
        id: fakeId,
        name: 'Test Key',
        revokedAt: new Date(),
        revokedBy: 'merchant@example.com',
      });

      const res = await request(app)
        .post(`/auth/api-keys/${fakeId}/revoke`)
        .set('Content-Type', 'application/json')
        .send({ revoked_by: 'merchant@example.com' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockApiKeyUpdate).toHaveBeenCalledTimes(1);
    });

    it('should return 404 when API key is not found', async () => {
      mockApiKeyFindUnique.mockResolvedValue(null);

      const res = await request(app)
        .post('/auth/api-keys/nonexistent-id/revoke')
        .set('Content-Type', 'application/json')
        .send({ revoked_by: 'merchant@example.com' });

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should return 409 when API key is already revoked', async () => {
      const fakeId = 'key-already-revoked';
      mockApiKeyFindUnique.mockResolvedValue({
        id: fakeId,
        name: 'Test Key',
        ownerId: 'merchant@example.com',
        revokedAt: new Date(),
      });

      const res = await request(app)
        .post(`/auth/api-keys/${fakeId}/revoke`)
        .set('Content-Type', 'application/json')
        .send({ revoked_by: 'merchant@example.com' });

      expect(res.statusCode).toBe(409);
      expect(res.body.success).toBe(false);
    });

    it('should return 422 when revoked_by is missing', async () => {
      const fakeId = 'key-to-revoke';
      mockApiKeyFindUnique.mockResolvedValue({
        id: fakeId,
        name: 'Test Key',
        ownerId: 'merchant@example.com',
        revokedAt: null,
      });

      const res = await request(app)
        .post(`/auth/api-keys/${fakeId}/revoke`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.statusCode).toBe(422);
      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /auth/api-keys/:id/rotate - Rotate API key', () => {
    it('should rotate an API key successfully', async () => {
      const oldKeyId = 'old-key-id';
      const newKeyId = 'new-key-id';
      const oldRecord = {
        id: oldKeyId,
        name: 'Old Key',
        ownerId: 'merchant@example.com',
        keyHash: 'old-hash',
        keyPrefix: 'sk_live_old',
        scopes: ['read', 'write'],
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(),
      };

      mockApiKeyFindUnique.mockResolvedValue(oldRecord);
      mockTransaction.mockResolvedValue([
        {
          id: newKeyId,
          name: 'Old Key',
          ownerId: 'merchant@example.com',
          keyHash: 'new-hash',
          keyPrefix: 'sk_live_new',
          scopes: ['read', 'write'],
          expiresAt: null,
          createdAt: new Date(),
        },
        {
          id: oldKeyId,
          revokedAt: new Date(),
          revokedBy: 'rotation',
        },
      ]);

      const res = await request(app)
        .post(`/auth/api-keys/${oldKeyId}/rotate`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.new_key).toBeDefined();
      expect(res.body.data.old_key).toBeDefined();
      expect(res.body.data.new_key.key).toMatch(/^sk_live_/);
      expect(res.body.data.old_key.grace_period_expires_at).toBeDefined();
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it('should rotate with custom name', async () => {
      const oldKeyId = 'old-key-id';
      const oldRecord = {
        id: oldKeyId,
        name: 'Old Key',
        ownerId: 'merchant@example.com',
        keyHash: 'old-hash',
        keyPrefix: 'sk_live_old',
        scopes: ['read', 'write'],
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(),
      };

      mockApiKeyFindUnique.mockResolvedValue(oldRecord);
      mockTransaction.mockResolvedValue([
        {
          id: 'new-key-id',
          name: 'New Key Name',
          ownerId: 'merchant@example.com',
          keyHash: 'new-hash',
          keyPrefix: 'sk_live_new',
          scopes: ['read', 'write'],
          expiresAt: null,
          createdAt: new Date(),
        },
        { id: oldKeyId, revokedAt: new Date(), revokedBy: 'rotation' },
      ]);

      const res = await request(app)
        .post(`/auth/api-keys/${oldKeyId}/rotate`)
        .set('Content-Type', 'application/json')
        .send({ name: 'New Key Name' });

      expect(res.statusCode).toBe(201);
      expect(res.body.data.new_key.name).toBe('New Key Name');
    });

    it('should return 404 when API key is not found', async () => {
      mockApiKeyFindUnique.mockResolvedValue(null);

      const res = await request(app)
        .post('/auth/api-keys/nonexistent-id/rotate')
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should return 409 when API key is already revoked', async () => {
      const oldKeyId = 'already-revoked-key';
      mockApiKeyFindUnique.mockResolvedValue({
        id: oldKeyId,
        name: 'Revoked Key',
        ownerId: 'merchant@example.com',
        revokedAt: new Date(),
      });

      const res = await request(app)
        .post(`/auth/api-keys/${oldKeyId}/rotate`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.statusCode).toBe(409);
      expect(res.body.success).toBe(false);
    });

    it('should default grace period to 1 hour', async () => {
      const oldKeyId = 'old-key-id';
      mockApiKeyFindUnique.mockResolvedValue({
        id: oldKeyId,
        name: 'Old Key',
        ownerId: 'merchant@example.com',
        keyHash: 'old-hash',
        keyPrefix: 'sk_live_old',
        scopes: ['read'],
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(),
      });
      mockTransaction.mockResolvedValue([
        {
          id: 'new-key-id',
          name: 'Old Key',
          ownerId: 'merchant@example.com',
          scopes: ['read'],
          expiresAt: null,
          createdAt: new Date(),
        },
        { id: oldKeyId, revokedAt: new Date(), revokedBy: 'rotation' },
      ]);

      const res = await request(app)
        .post(`/auth/api-keys/${oldKeyId}/rotate`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.statusCode).toBe(201);
      const graceExpires = new Date(res.body.data.old_key.grace_period_expires_at);
      const now = new Date();
      const diffHours = (graceExpires - now) / (1000 * 60 * 60);
      expect(diffHours).toBeCloseTo(1, 0);
    });
  });
});
