'use strict';

// Mock @stellar/stellar-sdk because real SDK relies on ESM @noble/hashes which Jest 29 cannot parse
jest.mock('@stellar/stellar-sdk', () => {
  class MockAsset {
    constructor(code = 'XLM', issuer = null) {
      this.code = code;
      this.issuer = issuer;
    }
    static native() {
      return new MockAsset('XLM', null);
    }
    isNative() {
      return this.code === 'XLM' && !this.issuer;
    }
  }

  class MockAccount {
    constructor(accountId, sequence = '0') {
      this._accountId = accountId;
      this.sequence = sequence;
    }
    accountId() {
      return this._accountId;
    }
  }

  class MockTransaction {
    constructor(sourceAccount, opts, operations) {
      this.source = sourceAccount.accountId();
      this.fee = opts.fee;
      this.networkPassphrase = opts.networkPassphrase;
      this.operations = operations;
      this._hash = 'mock_tx_hash_' + Math.random().toString(16).slice(2).padEnd(32, '0');
    }
    hash() {
      return Buffer.from(this._hash);
    }
  }

  class MockTransactionBuilder {
    constructor(sourceAccount, opts = {}) {
      this.sourceAccount = sourceAccount;
      this.opts = opts;
      this.operations = [];
      this.timeout = 30;
    }
    addOperation(op) {
      this.operations.push(op);
      return this;
    }
    setTimeout(t) {
      this.timeout = t;
      return this;
    }
    build() {
      return new MockTransaction(this.sourceAccount, this.opts, this.operations);
    }
  }

  const Operation = {
    payment: jest.fn((opts) => ({
      type: 'payment',
      ...opts,
    })),
  };

  const Keypair = {
    random: jest.fn(() => {
      const pub = 'G' + Math.random().toString(36).substring(2, 15).toUpperCase().padEnd(55, 'A');
      return {
        publicKey: () => pub,
        secret: () => 'S' + Math.random().toString(36).substring(2, 15).toUpperCase().padEnd(55, 'A'),
      };
    }),
    fromPublicKey: jest.fn((pub) => ({
      publicKey: () => pub,
    })),
  };

  const StrKey = {
    isValidEd25519PublicKey: jest.fn(
      (val) => typeof val === 'string' && val.startsWith('G') && val.length === 56
    ),
  };

  const Networks = {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC: 'Public Global Stellar Network ; September 2015',
  };

  const Horizon = {
    Server: jest.fn().mockImplementation(() => ({
      submitTransaction: jest.fn(),
      loadAccount: jest.fn(),
    })),
  };

  return {
    Asset: MockAsset,
    Account: MockAccount,
    TransactionBuilder: MockTransactionBuilder,
    Operation,
    Keypair,
    StrKey,
    Networks,
    Horizon,
  };
});

jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  httpLogger: (req, res, next) => next(),
}));

jest.mock('../src/services/eventStore', () => ({
  appendEvent: jest.fn().mockResolvedValue({ id: 'mock-event-id' }),
  PaymentEventTypes: {
    PAYMENT_CREATED: 'PAYMENT_CREATED',
    PAYMENT_ROUTED: 'PAYMENT_ROUTED',
    PAYMENT_COMPLETED: 'PAYMENT_COMPLETED',
    PAYMENT_FAILED: 'PAYMENT_FAILED',
    PAYMENT_FLAGGED_FRAUD: 'PAYMENT_FLAGGED_FRAUD',
    PAYMENT_CLEARED_FRAUD: 'PAYMENT_CLEARED_FRAUD',
  },
  getEventsByAggregate: jest.fn().mockResolvedValue([]),
}));

jest.mock('../prismaClient', () => ({
  prisma: {
    paymentEvent: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
  },
}));

const { Keypair, Networks } = require('@stellar/stellar-sdk');
const {
  queuePayment,
  queueMicroPayment,
  bufferPayment,
  flushBatch,
  resetBatchQueue,
  setBatchSubmitter,
  buildBatchTransaction,
  PaymentBatchQueue,
  createPayment,
  MAX_BATCH_SIZE,
  MAX_WAIT_MS,
  MICRO_PAYMENT_THRESHOLD,
} = require('../src/services/paymentCommandService');

describe('PaymentCommandService — Micro-Payment Batch Queue Buffer', () => {
  let mockSubmitter;
  const sourceKp = Keypair.random();
  const destKp = Keypair.random();

  beforeEach(() => {
    jest.clearAllMocks();
    resetBatchQueue();
    mockSubmitter = jest.fn().mockImplementation(async (tx) => {
      return {
        hash: tx.hash().toString('hex'),
        successful: true,
        ledger: 1000,
      };
    });
    setBatchSubmitter(mockSubmitter);
  });

  afterEach(() => {
    resetBatchQueue();
  });

  describe('Configuration and Constants', () => {
    test('exports expected constants', () => {
      expect(MAX_BATCH_SIZE).toBe(50);
      expect(MAX_WAIT_MS).toBe(3000);
      expect(MICRO_PAYMENT_THRESHOLD).toBe(1.0);
    });
  });

  describe('Capacity Trigger', () => {
    test('flushes immediately when MAX_BATCH_SIZE (50) payments accumulate', async () => {
      const promises = [];
      const paymentCount = 50;

      for (let i = 0; i < paymentCount; i++) {
        const dest = Keypair.random().publicKey();
        promises.push(
          queuePayment({
            fromAddress: sourceKp.publicKey(),
            toAddress: dest,
            amount: 0.05,
            assetCode: 'XLM',
          })
        );
      }

      // Flushes immediately without waiting for the 3000ms timer
      const results = await Promise.all(promises);

      expect(results).toHaveLength(50);
      expect(mockSubmitter).toHaveBeenCalledTimes(1);

      const submittedTx = mockSubmitter.mock.calls[0][0];
      expect(submittedTx.operations).toHaveLength(50);

      // Verify each operation is a payment operation
      for (const op of submittedTx.operations) {
        expect(op.type).toBe('payment');
      }

      // Verify each individual promise resolved with respective operation index and transaction hash
      const expectedTxHash = submittedTx.hash().toString('hex');
      for (let i = 0; i < paymentCount; i++) {
        expect(results[i].operationIndex).toBe(i);
        expect(results[i].transactionHash).toBe(expectedTxHash);
        expect(results[i].status).toBe('submitted');
        expect(results[i].paymentId).toBeDefined();
      }
    });

    test('handles overflow past 50: first 50 flush on capacity, remaining on subsequent trigger', async () => {
      jest.useFakeTimers();

      const promises = [];
      const totalPayments = 75;

      for (let i = 0; i < totalPayments; i++) {
        promises.push(
          queuePayment({
            fromAddress: sourceKp.publicKey(),
            toAddress: Keypair.random().publicKey(),
            amount: 0.01,
          })
        );
      }

      // First batch (50) should have flushed immediately
      expect(mockSubmitter).toHaveBeenCalledTimes(1);
      const firstBatchTx = mockSubmitter.mock.calls[0][0];
      expect(firstBatchTx.operations).toHaveLength(50);

      // 25 should remain in queue
      // Fast forward time to trigger timeout for the remaining 25
      jest.advanceTimersByTime(3000);

      const results = await Promise.all(promises);
      expect(results).toHaveLength(75);
      expect(mockSubmitter).toHaveBeenCalledTimes(2);

      const secondBatchTx = mockSubmitter.mock.calls[1][0];
      expect(secondBatchTx.operations).toHaveLength(25);

      // First 50 indices: 0..49
      for (let i = 0; i < 50; i++) {
        expect(results[i].operationIndex).toBe(i);
        expect(results[i].transactionHash).toBe(firstBatchTx.hash().toString('hex'));
      }

      // Next 25 indices: 0..24
      for (let i = 50; i < 75; i++) {
        expect(results[i].operationIndex).toBe(i - 50);
        expect(results[i].transactionHash).toBe(secondBatchTx.hash().toString('hex'));
      }

      jest.useRealTimers();
    });
  });

  describe('Timeout Trigger', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('buffers payments and flushes after MAX_WAIT_MS (3000ms)', async () => {
      const promises = [
        queuePayment({
          fromAddress: sourceKp.publicKey(),
          toAddress: Keypair.random().publicKey(),
          amount: 0.25,
        }),
        queuePayment({
          fromAddress: sourceKp.publicKey(),
          toAddress: Keypair.random().publicKey(),
          amount: 0.1,
        }),
        queuePayment({
          fromAddress: sourceKp.publicKey(),
          toAddress: Keypair.random().publicKey(),
          amount: 0.05,
        }),
      ];

      // At 1000ms, batch should not have flushed yet
      jest.advanceTimersByTime(1000);
      expect(mockSubmitter).not.toHaveBeenCalled();

      // At 2999ms, still pending
      jest.advanceTimersByTime(1999);
      expect(mockSubmitter).not.toHaveBeenCalled();

      // At 3000ms, timer fires and flushes batch
      jest.advanceTimersByTime(1);
      expect(mockSubmitter).toHaveBeenCalledTimes(1);

      const results = await Promise.all(promises);
      expect(results).toHaveLength(3);

      const tx = mockSubmitter.mock.calls[0][0];
      expect(tx.operations).toHaveLength(3);
      expect(tx.operations[0].amount).toBe('0.25');
      expect(tx.operations[1].amount).toBe('0.1');
      expect(tx.operations[2].amount).toBe('0.05');

      const expectedTxHash = tx.hash().toString('hex');
      expect(results[0]).toEqual({
        transactionHash: expectedTxHash,
        txHash: expectedTxHash,
        operationIndex: 0,
        paymentId: expect.any(String),
        status: 'submitted',
        batchSize: 3,
      });
      expect(results[1]).toEqual({
        transactionHash: expectedTxHash,
        txHash: expectedTxHash,
        operationIndex: 1,
        paymentId: expect.any(String),
        status: 'submitted',
        batchSize: 3,
      });
      expect(results[2]).toEqual({
        transactionHash: expectedTxHash,
        txHash: expectedTxHash,
        operationIndex: 2,
        paymentId: expect.any(String),
        status: 'submitted',
        batchSize: 3,
      });
    });
  });

  describe('Micro-Payment Threshold Validation', () => {
    test('queueMicroPayment accepts payments < $1.00', async () => {
      const p = queueMicroPayment({
        fromAddress: sourceKp.publicKey(),
        toAddress: destKp.publicKey(),
        amount: 0.99,
      });

      await flushBatch();
      const res = await p;
      expect(res.operationIndex).toBe(0);
      expect(res.transactionHash).toBeDefined();
    });

    test('queueMicroPayment rejects payments >= $1.00', async () => {
      await expect(
        queueMicroPayment({
          fromAddress: sourceKp.publicKey(),
          toAddress: destKp.publicKey(),
          amount: 1.0,
        })
      ).rejects.toThrow(/exceeds micro-payment threshold/);

      await expect(
        queueMicroPayment({
          fromAddress: sourceKp.publicKey(),
          toAddress: destKp.publicKey(),
          amount: 5.0,
        })
      ).rejects.toThrow(/exceeds micro-payment threshold/);
    });

    test('queuePayment accepts payments of any valid amount', async () => {
      const p = queuePayment({
        fromAddress: sourceKp.publicKey(),
        toAddress: destKp.publicKey(),
        amount: 10.5,
      });

      await flushBatch();
      const res = await p;
      expect(res.operationIndex).toBe(0);
      expect(res.transactionHash).toBeDefined();
    });
  });

  describe('Validation and Error Handling', () => {
    test('rejects if fromAddress or toAddress is missing', async () => {
      await expect(queuePayment({ toAddress: destKp.publicKey(), amount: 0.1 })).rejects.toThrow(
        'fromAddress and toAddress are required'
      );
      await expect(queuePayment({ fromAddress: sourceKp.publicKey(), amount: 0.1 })).rejects.toThrow(
        'fromAddress and toAddress are required'
      );
    });

    test('rejects if amount <= 0 or invalid', async () => {
      await expect(
        queuePayment({ fromAddress: sourceKp.publicKey(), toAddress: destKp.publicKey(), amount: 0 })
      ).rejects.toThrow('amount must be greater than 0');

      await expect(
        queuePayment({ fromAddress: sourceKp.publicKey(), toAddress: destKp.publicKey(), amount: -1 })
      ).rejects.toThrow('amount must be greater than 0');
    });

    test('rejects all individual promises if transaction submission fails', async () => {
      mockSubmitter.mockRejectedValueOnce(new Error('Horizon submission error: tx_failed'));

      const p1 = queuePayment({
        fromAddress: sourceKp.publicKey(),
        toAddress: Keypair.random().publicKey(),
        amount: 0.1,
      });
      const p2 = queuePayment({
        fromAddress: sourceKp.publicKey(),
        toAddress: Keypair.random().publicKey(),
        amount: 0.2,
      });

      await expect(flushBatch()).rejects.toThrow('Horizon submission error: tx_failed');
      await expect(p1).rejects.toThrow('Horizon submission error: tx_failed');
      await expect(p2).rejects.toThrow('Horizon submission error: tx_failed');
    });
  });

  describe('Transaction Building', () => {
    test('buildBatchTransaction builds multi-operation PaymentOp transaction with scaled fees', () => {
      const batch = [
        {
          fromAddress: sourceKp.publicKey(),
          toAddress: Keypair.random().publicKey(),
          amount: 0.05,
          assetCode: 'XLM',
        },
        {
          fromAddress: sourceKp.publicKey(),
          toAddress: Keypair.random().publicKey(),
          amount: 0.15,
          assetCode: 'XLM',
        },
      ];

      const tx = buildBatchTransaction(batch, {
        baseFee: 100,
        networkPassphrase: Networks.TESTNET,
      });

      expect(tx.fee).toBe('200'); // 100 * 2 operations
      expect(tx.operations).toHaveLength(2);
      expect(tx.operations[0].type).toBe('payment');
      expect(tx.operations[0].amount).toBe('0.05');
      expect(tx.operations[1].type).toBe('payment');
      expect(tx.operations[1].amount).toBe('0.15');
    });

    test('buildBatchTransaction throws on empty batch', () => {
      expect(() => buildBatchTransaction([])).toThrow('Cannot build transaction from empty payment batch');
    });
  });

  describe('Isolated PaymentBatchQueue Instance', () => {
    test('supports custom batch size and wait time', async () => {
      jest.useFakeTimers();

      const customSubmitter = jest.fn().mockResolvedValue({ hash: 'custom-hash-123' });
      const customQueue = new PaymentBatchQueue({
        maxBatchSize: 3,
        maxWaitMs: 500,
        submitTransaction: customSubmitter,
      });

      const promises = [
        customQueue.enqueue({ fromAddress: sourceKp.publicKey(), toAddress: destKp.publicKey(), amount: 0.1 }),
        customQueue.enqueue({ fromAddress: sourceKp.publicKey(), toAddress: destKp.publicKey(), amount: 0.2 }),
        customQueue.enqueue({ fromAddress: sourceKp.publicKey(), toAddress: destKp.publicKey(), amount: 0.3 }),
      ];

      // Flushed immediately on capacity (3)
      const results = await Promise.all(promises);
      expect(customSubmitter).toHaveBeenCalledTimes(1);
      expect(results[0].operationIndex).toBe(0);
      expect(results[1].operationIndex).toBe(1);
      expect(results[2].operationIndex).toBe(2);

      jest.useRealTimers();
    });
  });

  describe('Integration with createPayment and aliases', () => {
    test('bufferPayment behaves as queuePayment alias', async () => {
      const p = bufferPayment({
        fromAddress: sourceKp.publicKey(),
        toAddress: destKp.publicKey(),
        amount: 0.05,
      });

      await flushBatch();
      const res = await p;
      expect(res.operationIndex).toBe(0);
      expect(res.transactionHash).toBeDefined();
    });

    test('createPayment with batch: true routes into batch queue', async () => {
      const p = createPayment(
        {
          fromAddress: sourceKp.publicKey(),
          toAddress: destKp.publicKey(),
          amount: 0.05,
          batch: true,
        }
      );

      await flushBatch();
      const res = await p;
      expect(res.operationIndex).toBe(0);
      expect(res.transactionHash).toBeDefined();
    });
  });
});
