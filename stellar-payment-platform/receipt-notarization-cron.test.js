'use strict';

const { buildHourlyMerkleTree, anchorMerkleRootToStellar, runReceiptNotarization, retryFailedAnchors } = require('./src/receipt-notarization-cron');
const { MerkleTree } = require('./src/settlement/merkleTree');

jest.mock('./src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('./src/services/kmsSigner', () => ({
  defaultSigner: {
    getPublicKey: jest.fn().mockReturnValue('GTESTKEY000000000000000000000000000000000000000000000000'),
    signTransaction: jest.fn().mockImplementation(async (tx) => tx),
  },
  isKmsEnabled: jest.fn().mockReturnValue(true),
}));

process.env.STELLAR_SECRET_KEY = 'STELLAR_SECRET_KEY_FOR_TESTING';

jest.mock('@stellar/stellar-sdk', () => {
  const mockSendTransaction = jest.fn();
  const mockGetTransaction = jest.fn();
  return {
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        sendTransaction: mockSendTransaction,
        getTransaction: mockGetTransaction,
      })),
    },
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addMemo: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
    Account: jest.fn(),
    Keypair: { fromSecret: jest.fn() },
    Networks: { TESTNET: 'Test SDF Network ; September 2015' },
    BASE_FEE: '100',
    xdr: {
      Memo: { memoHash: jest.fn() },
    },
    __mocks: { mockSendTransaction, mockGetTransaction },
  };
});

const mockPrisma = {
  payment: {
    findMany: jest.fn(),
  },
  paymentReceipt: {
    createMany: jest.fn(),
    updateMany: jest.fn(),
  },
  receiptAnchor: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  $transaction: jest.fn((ops) => Promise.all(ops)),
};

describe('receipt-notarization-cron', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-15T10:30:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('buildHourlyMerkleTree', () => {
    test('returns null when no payments in hour', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([]);

      const result = await buildHourlyMerkleTree(mockPrisma);

      expect(result).toBeNull();
      expect(mockPrisma.payment.findMany).toHaveBeenCalledWith({
        where: {
          createdAt: expect.any(Object),
          status: 'completed',
          transactionHash: { not: null },
        },
        orderBy: { createdAt: 'asc' },
      });
    });

    test('builds Merkle tree and creates receipts for payments', async () => {
      const payments = [
        { id: 'pay1', transactionHash: 'a'.repeat(64), fromAddress: 'G1', toAddress: 'G2', amount: 10, assetCode: 'XLM', createdAt: new Date('2024-01-15T10:15:00Z') },
        { id: 'pay2', transactionHash: 'b'.repeat(64), fromAddress: 'G3', toAddress: 'G4', amount: 20, assetCode: 'XLM', createdAt: new Date('2024-01-15T10:30:00Z') },
        { id: 'pay3', transactionHash: 'c'.repeat(64), fromAddress: 'G5', toAddress: 'G6', amount: 30, assetCode: 'USDC', createdAt: new Date('2024-01-15T10:45:00Z') },
      ];
      mockPrisma.payment.findMany.mockResolvedValue(payments);
      mockPrisma.paymentReceipt.createMany.mockResolvedValue({ count: 3 });

      const result = await buildHourlyMerkleTree(mockPrisma);

      expect(result).not.toBeNull();
      expect(result.batchId).toMatch(/^batch_20240115T10/);
      expect(result.leafCount).toBe(3);
      expect(result.merkleRoot).toHaveLength(64);
      expect(result.receipts).toHaveLength(3);
      expect(result.receipts[0]).toMatchObject({
        paymentId: 'pay1',
        leafIndex: 0,
      });
      expect(result.receipts[0].batchId).toMatch(/^batch_20240115T10/);
      expect(result.receipts[0].proof).toBeDefined();
      expect(mockPrisma.paymentReceipt.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({ paymentId: 'pay1', leafIndex: 0 }),
          expect.objectContaining({ paymentId: 'pay2', leafIndex: 1 }),
          expect.objectContaining({ paymentId: 'pay3', leafIndex: 2 }),
        ]),
        skipDuplicates: true,
      });
    });

    test('verifies generated proofs against the root', async () => {
      const payments = [
        { id: 'pay1', transactionHash: 'a'.repeat(64), fromAddress: 'G1', toAddress: 'G2', amount: 10, assetCode: 'XLM', createdAt: new Date('2024-01-15T10:15:00Z') },
        { id: 'pay2', transactionHash: 'b'.repeat(64), fromAddress: 'G3', toAddress: 'G4', amount: 20, assetCode: 'XLM', createdAt: new Date('2024-01-15T10:30:00Z') },
      ];
      mockPrisma.payment.findMany.mockResolvedValue(payments);
      mockPrisma.paymentReceipt.createMany.mockResolvedValue({ count: 2 });

      const result = await buildHourlyMerkleTree(mockPrisma);

      expect(result).not.toBeNull();
      const tree = new MerkleTree(result.receipts.map(r => ({
        paymentId: r.paymentId,
        transactionHash: payments.find(p => p.id === r.paymentId).transactionHash,
        from: payments.find(p => p.id === r.paymentId).fromAddress,
        to: payments.find(p => p.id === r.paymentId).toAddress,
        amount: payments.find(p => p.id === r.paymentId).amount,
        assetCode: payments.find(p => p.id === r.paymentId).assetCode || 'XLM',
        timestamp: payments.find(p => p.id === r.paymentId).createdAt.getTime(),
        index: r.leafIndex,
      })));
      expect(tree.getRootHex()).toBe(result.merkleRoot);

      for (let i = 0; i < result.receipts.length; i++) {
        const proof = result.receipts[i].proof;
        const leafData = {
          paymentId: payments[i].id,
          transactionHash: payments[i].transactionHash,
          from: payments[i].fromAddress,
          to: payments[i].toAddress,
          amount: payments[i].amount,
          assetCode: payments[i].assetCode || 'XLM',
          timestamp: payments[i].createdAt.getTime(),
          index: i,
        };
        const valid = MerkleTree.verifyProof(leafData, proof, result.merkleRoot);
        expect(valid).toBe(true);
      }
    });
  });

  describe('anchorMerkleRootToStellar', () => {
    let mockSendTransaction, mockGetTransaction;

    beforeEach(() => {
      const { __mocks } = require('@stellar/stellar-sdk');
      mockSendTransaction = __mocks.mockSendTransaction;
      mockGetTransaction = __mocks.mockGetTransaction;
      mockSendTransaction.mockReset();
      mockGetTransaction.mockReset();
    });

    test('returns success when transaction succeeds', async () => {
      mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'tx_hash_123' });
      mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' });

      const result = await anchorMerkleRootToStellar('a'.repeat(64), 'batch_1', 1705312800000, 10);

      expect(result.success).toBe(true);
      expect(result.txHash).toBe('tx_hash_123');
    });

    test('returns failure when transaction fails', async () => {
      mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'tx_hash_123' });
      mockGetTransaction.mockResolvedValue({ status: 'FAILED', resultXdr: 'error_xdr' });

      const result = await anchorMerkleRootToStellar('a'.repeat(64), 'batch_1', 1705312800000, 10);

      expect(result.success).toBe(false);
      expect(result.error).toBe('error_xdr');
    });

    test('returns failure when submission fails', async () => {
      mockSendTransaction.mockResolvedValue({ status: 'ERROR', errorResultXdr: 'submission_error' });

      const result = await anchorMerkleRootToStellar('a'.repeat(64), 'batch_1', 1705312800000, 10);

      expect(result.success).toBe(false);
      expect(result.error).toBe('submission_error');
    });
  });

  describe('runReceiptNotarization', () => {
    let mockSendTransaction, mockGetTransaction;

    beforeEach(() => {
      const { __mocks } = require('@stellar/stellar-sdk');
      mockSendTransaction = __mocks.mockSendTransaction;
      mockGetTransaction = __mocks.mockGetTransaction;
      mockSendTransaction.mockReset();
      mockGetTransaction.mockReset();
    });

    test('skips when no payments', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([]);

      const result = await runReceiptNotarization(mockPrisma);

      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('no payments');
    });

    test('skips when batch already anchored', async () => {
      const payments = [
        { id: 'pay1', transactionHash: 'a'.repeat(64), fromAddress: 'G1', toAddress: 'G2', amount: 10, assetCode: 'XLM', createdAt: new Date('2024-01-15T10:15:00Z') },
      ];
      mockPrisma.payment.findMany.mockResolvedValue(payments);
      mockPrisma.paymentReceipt.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.receiptAnchor.findUnique.mockResolvedValue({ batchId: 'batch_20240115T10' });

      const result = await runReceiptNotarization(mockPrisma);

      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('already anchored');
    });

    test('creates anchor and submits to Stellar when credentials available', async () => {
      const payments = [
        { id: 'pay1', transactionHash: 'a'.repeat(64), fromAddress: 'G1', toAddress: 'G2', amount: 10, assetCode: 'XLM', createdAt: new Date('2024-01-15T10:15:00Z') },
      ];
      mockPrisma.payment.findMany.mockResolvedValue(payments);
      mockPrisma.paymentReceipt.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.receiptAnchor.findUnique.mockResolvedValue(null);
      mockPrisma.receiptAnchor.create.mockResolvedValue({ id: 'anchor1' });
      mockPrisma.receiptAnchor.update.mockResolvedValue({});
      mockPrisma.paymentReceipt.updateMany.mockResolvedValue({ count: 1 });

      mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'tx_success_123' });
      mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' });

      const result = await runReceiptNotarization(mockPrisma);

      expect(result.status).toBe('success');
      expect(result.anchorTxHash).toBe('tx_success_123');
      expect(mockPrisma.receiptAnchor.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'anchor1' },
        data: expect.objectContaining({
          anchorTxHash: 'tx_success_123',
          status: 'confirmed',
        }),
      }));
    });
  });

  describe('retryFailedAnchors', () => {
    let mockSendTransaction, mockGetTransaction;

    beforeEach(() => {
      const { __mocks } = require('@stellar/stellar-sdk');
      mockSendTransaction = __mocks.mockSendTransaction;
      mockGetTransaction = __mocks.mockGetTransaction;
      mockSendTransaction.mockReset();
      mockGetTransaction.mockReset();
    });

    test('retries failed anchors up to 3 attempts', async () => {
      const failedAnchors = [
        { id: 'anchor1', batchId: 'batch_1', merkleRoot: 'a'.repeat(64), batchTimestamp: BigInt(1705312800000), leafCount: 5, attempts: 1 },
        { id: 'anchor2', batchId: 'batch_2', merkleRoot: 'b'.repeat(64), batchTimestamp: BigInt(1705312800000), leafCount: 3, attempts: 2 },
      ];
      mockPrisma.receiptAnchor.findMany.mockResolvedValue(failedAnchors);
      mockPrisma.receiptAnchor.update.mockResolvedValue({});

      mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'tx_retry_123' });
      mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' });

      await retryFailedAnchors(mockPrisma);

      expect(mockPrisma.receiptAnchor.update).toHaveBeenCalledTimes(2);
      expect(mockPrisma.receiptAnchor.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'anchor1' },
        data: expect.objectContaining({
          anchorTxHash: 'tx_retry_123',
          status: 'confirmed',
        }),
      }));
    });

    test('increments attempts on retry failure', async () => {
      const failedAnchors = [
        { id: 'anchor1', batchId: 'batch_1', merkleRoot: 'a'.repeat(64), batchTimestamp: BigInt(1705312800000), leafCount: 5, attempts: 1 },
      ];
      mockPrisma.receiptAnchor.findMany.mockResolvedValue(failedAnchors);
      mockPrisma.receiptAnchor.update.mockResolvedValue({});

      mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'tx_fail_123' });
      mockGetTransaction.mockResolvedValue({ status: 'FAILED', resultXdr: 'retry_error' });

      await retryFailedAnchors(mockPrisma);

      expect(mockPrisma.receiptAnchor.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'anchor1' },
        data: expect.objectContaining({
          attempts: { increment: 1 },
          lastError: 'retry_error',
        }),
      }));
    });

    test('does not retry anchors with 3+ attempts', async () => {
      const failedAnchors = [
        { id: 'anchor1', batchId: 'batch_1', merkleRoot: 'a'.repeat(64), batchTimestamp: BigInt(1705312800000), leafCount: 5, attempts: 3 },
      ];
      mockPrisma.receiptAnchor.findMany.mockResolvedValue(failedAnchors);

      await retryFailedAnchors(mockPrisma);

      expect(mockPrisma.receiptAnchor.update).not.toHaveBeenCalled();
    });
  });
});