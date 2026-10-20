'use strict';

const request = require('supertest');

jest.mock('@stellar/stellar-sdk', () => {
  const mockServer = {
    transactions: () => ({ transaction: () => ({ call: jest.fn() }) }),
    payments: () => ({ forTransaction: () => ({ call: jest.fn() }), forAccount: () => ({ order: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), cursor: jest.fn().mockReturnThis(), call: jest.fn() }) }),
  };
  return {
    Horizon: { Server: jest.fn().mockImplementation(() => mockServer) },
    StrKey: {
      isValidEd25519PublicKey: jest.fn().mockReturnValue(true),
    },
  };
});

// Mock prismaClient
jest.mock('./prismaClient', () => ({
  prisma: {
    user: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn() },
    payment: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn() },
    paymentReceipt: { findUnique: jest.fn(), createMany: jest.fn(), updateMany: jest.fn() },
    receiptAnchor: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
    webhook: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn((ops) => Promise.all(ops)),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
}));

jest.mock('pdfkit', () => {
  const { Readable } = require('stream');
  return jest.fn().mockImplementation(() => {
    const doc = new Readable({ read() {} });
    doc.fontSize = jest.fn().mockReturnThis();
    doc.text = jest.fn().mockReturnThis();
    doc.moveDown = jest.fn().mockReturnThis();
    doc.fillColor = jest.fn().mockReturnThis();
    doc.end = jest.fn(() => {
      doc.push(Buffer.from('%PDF-1.4 mock'));
      doc.push(null);
    });
    return doc;
  });
});

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('./src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('./src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));
jest.mock('./src/reconciliation-cron', () => ({ scheduleReconciliationJob: jest.fn() }));
jest.mock('./src/receipt-notarization-cron', () => ({ scheduleReceiptNotarizationJob: jest.fn() }));
jest.mock('./src/db-pool-monitor', () => ({ schedulePoolMonitoring: jest.fn() }));

jest.mock('bad-words', () => {
  return jest.fn().mockImplementation(() => ({
    isProfane: jest.fn(() => false),
  }));
});

let app;
let mockReceiptFindUnique;
let mockAnchorFindUnique;
let mockPaymentFindUnique;

const { MerkleTree } = require('./src/settlement/merkleTree');

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_HASH = 'a'.repeat(64);

beforeEach(() => {
  jest.resetModules();
  ({ app } = require('./server'));
  const { prisma } = require('./prismaClient');

  mockReceiptFindUnique = jest.fn().mockResolvedValue(null);
  mockAnchorFindUnique = jest.fn().mockResolvedValue(null);
  mockPaymentFindUnique = jest.fn().mockResolvedValue(null);

  prisma.paymentReceipt.findUnique.mockImplementation((args) => mockReceiptFindUnique(args));
  prisma.receiptAnchor.findUnique.mockImplementation((args) => mockAnchorFindUnique(args));
  prisma.payment.findUnique.mockImplementation((args) => mockPaymentFindUnique(args));
});

const MOCK_PAYMENT = {
  id: VALID_UUID,
  transactionHash: VALID_HASH,
  fromAddress: 'GSENDER000000000000000000000000000000000000000000000000',
  toAddress: 'GRECEIVER0000000000000000000000000000000000000000000000',
  amount: 100.5,
  assetCode: 'XLM',
  createdAt: new Date('2024-01-15T10:30:00Z'),
};

const MOCK_LEAF_DATA = {
  paymentId: MOCK_PAYMENT.id,
  transactionHash: MOCK_PAYMENT.transactionHash,
  from: MOCK_PAYMENT.fromAddress,
  to: MOCK_PAYMENT.toAddress,
  amount: MOCK_PAYMENT.amount,
  assetCode: MOCK_PAYMENT.assetCode || 'XLM',
  timestamp: MOCK_PAYMENT.createdAt.getTime(),
  index: 0,
};

const MOCK_PROOF = new MerkleTree([MOCK_LEAF_DATA]).getProof(0);
const COMPUTED_ROOT = new MerkleTree([MOCK_LEAF_DATA]).getRootHex();

const MOCK_RECEIPT = {
  paymentId: VALID_UUID,
  merkleRoot: COMPUTED_ROOT,
  leafIndex: 0,
  proof: MOCK_PROOF,
  batchId: 'batch_20240115T10',
  batchTimestamp: BigInt(1705312800000),
  anchorTxHash: VALID_HASH,
  anchorStatus: 'confirmed',
  confirmedAt: new Date(),
};

const MOCK_ANCHOR = {
  batchId: 'batch_20240115T10',
  merkleRoot: COMPUTED_ROOT,
  anchorTxHash: VALID_HASH,
  prevBatchHash: '0'.repeat(64),
  chainHash: 'e'.repeat(64),
  batchTimestamp: BigInt(1705312800000),
  leafCount: 10,
  status: 'confirmed',
};

describe('GET /api/v1/payments/:paymentId/receipt-proof', () => {
  test('returns 404 when receipt not found', async () => {
    mockReceiptFindUnique.mockResolvedValue(null);

    const res = await request(app).get(`/api/v1/payments/${VALID_UUID}/receipt-proof`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Payment receipt not found');
  });

  test('returns receipt proof with verified=true when anchor confirmed', async () => {
    mockReceiptFindUnique.mockResolvedValue(MOCK_RECEIPT);
    mockAnchorFindUnique.mockResolvedValue(MOCK_ANCHOR);
    mockPaymentFindUnique.mockResolvedValue(MOCK_PAYMENT);

    const res = await request(app).get(`/api/v1/payments/${VALID_UUID}/receipt-proof`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.paymentId).toBe(VALID_UUID);
    expect(res.body.data.merkleRoot).toBe(COMPUTED_ROOT);
    expect(res.body.data.leafIndex).toBe(0);
    expect(res.body.data.proof).toHaveLength(0);
    expect(res.body.data.batchId).toBe('batch_20240115T10');
    expect(res.body.data.batchTimestamp).toBe('1705312800000');
    expect(res.body.data.anchorTxHash).toBe(VALID_HASH);
    expect(res.body.data.anchorStatus).toBe('confirmed');
    expect(res.body.data.verified).toBe(true);
  });

  test('returns receipt proof with verified=false when anchor pending', async () => {
    mockReceiptFindUnique.mockResolvedValue({
      ...MOCK_RECEIPT,
      anchorStatus: 'pending',
      anchorTxHash: null,
    });
    mockAnchorFindUnique.mockResolvedValue({
      ...MOCK_ANCHOR,
      status: 'pending',
      anchorTxHash: null,
    });
    mockPaymentFindUnique.mockResolvedValue(MOCK_PAYMENT);

    const res = await request(app).get(`/api/v1/payments/${VALID_UUID}/receipt-proof`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.anchorStatus).toBe('pending');
    expect(res.body.data.anchorTxHash).toBeNull();
    expect(res.body.data.verified).toBe(false);
  });

  test('returns receipt proof with verified=false when anchor failed', async () => {
    mockReceiptFindUnique.mockResolvedValue({
      ...MOCK_RECEIPT,
      anchorStatus: 'failed',
      anchorTxHash: VALID_HASH,
    });
    mockAnchorFindUnique.mockResolvedValue({
      ...MOCK_ANCHOR,
      status: 'failed',
    });
    mockPaymentFindUnique.mockResolvedValue(MOCK_PAYMENT);

    const res = await request(app).get(`/api/v1/payments/${VALID_UUID}/receipt-proof`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.anchorStatus).toBe('failed');
    expect(res.body.data.verified).toBe(false);
  });
});

describe('GET /api/v1/receipt-anchors', () => {
  test('returns paginated list of anchors', async () => {
    const { prisma } = require('./prismaClient');
    prisma.receiptAnchor.findMany.mockResolvedValue([MOCK_ANCHOR]);
    prisma.receiptAnchor.count.mockResolvedValue(1);

    const res = await request(app).get('/api/v1/receipt-anchors?limit=10&page=1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].batchId).toBe('batch_20240115T10');
    expect(res.body.meta.total).toBe(1);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(10);
  });

  test('filters anchors by status', async () => {
    const { prisma } = require('./prismaClient');
    prisma.receiptAnchor.findMany.mockResolvedValue([]);
    prisma.receiptAnchor.count.mockResolvedValue(0);

    const res = await request(app).get('/api/v1/receipt-anchors?status=pending');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prisma.receiptAnchor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'pending' },
      })
    );
  });
});

describe('POST /api/v1/receipts/verify', () => {
  test('verifies a valid proof', async () => {
    const leafData = MOCK_LEAF_DATA;
    const proof = MOCK_PROOF;
    const root = COMPUTED_ROOT;

    const res = await request(app)
      .post('/api/v1/receipts/verify')
      .send({ leafData, proof, root });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.merkleRoot).toBe(COMPUTED_ROOT);
  });

  test('rejects invalid proof', async () => {
    const leafData = MOCK_LEAF_DATA;
    const proof = [{ position: 'right', hash: 'wrong'.repeat(64) }];
    const root = COMPUTED_ROOT;

    const res = await request(app)
      .post('/api/v1/receipts/verify')
      .send({ leafData, proof, root });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.valid).toBe(false);
  });

  test('returns 400 when leafData is missing', async () => {
    const res = await request(app)
      .post('/api/v1/receipts/verify')
      .send({ proof: [], root: COMPUTED_ROOT });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  test('returns 400 when proof is missing', async () => {
    const res = await request(app)
      .post('/api/v1/receipts/verify')
      .send({ leafData: {}, root: COMPUTED_ROOT });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  test('returns 400 when root is missing', async () => {
    const res = await request(app)
      .post('/api/v1/receipts/verify')
      .send({ leafData: {}, proof: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });
});