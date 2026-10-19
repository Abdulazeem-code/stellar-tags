'use strict';

const { OutboxEngine, STATUS } = require('../src/settlement/outboxEngine');

describe('Feature 27: OutboxEngine & Sharded Settlement Architecture', () => {
  let engine;

  beforeEach(() => {
    engine = new OutboxEngine({
      numShards: 4,
      batchSize: 10,
      maxRetries: 3,
    });
  });

  afterEach(() => {
    engine.reset();
  });

  describe('Validation & Ingestion', () => {
    test('rejects missing or empty idempotency key', async () => {
      const payload = { from: 'G_FROM', to: 'G_TO', amount: '10' };
      await expect(engine.enqueuePayment(payload, null)).rejects.toThrow('Missing or empty idempotency key');
      await expect(engine.enqueuePayment(payload, '')).rejects.toThrow('Missing or empty idempotency key');
      await expect(engine.enqueuePayment(payload, '   ')).rejects.toThrow('Missing or empty idempotency key');
    });

    test('rejects invalid payload objects and parameters', async () => {
      await expect(engine.enqueuePayment(null, 'key-1')).rejects.toThrow('Payload must be a non-null object');
      await expect(engine.enqueuePayment({ to: 'G_TO', amount: '10' }, 'key-1')).rejects.toThrow('Invalid sender address (from)');
      await expect(engine.enqueuePayment({ from: '   ', to: 'G_TO', amount: '10' }, 'key-1')).rejects.toThrow('Invalid sender address (from)');
      await expect(engine.enqueuePayment({ from: 'G_FROM', amount: '10' }, 'key-1')).rejects.toThrow('Invalid recipient address (to)');
      await expect(engine.enqueuePayment({ from: 'G_FROM', to: '   ', amount: '10' }, 'key-1')).rejects.toThrow('Invalid recipient address (to)');
      await expect(engine.enqueuePayment({ from: 'G_FROM', to: 'G_TO', amount: '-5' }, 'key-1')).rejects.toThrow('Payment amount must be a positive number');
      await expect(engine.enqueuePayment({ from: 'G_FROM', to: 'G_TO', amount: 'abc' }, 'key-1')).rejects.toThrow('Payment amount must be a positive number');
      await expect(
        engine.enqueuePayment(
          { from: 'G_FROM', to: 'G_TO', amount: '10', assetCode: 'WAY_TOO_LONG_ASSET_CODE_VALUE' },
          'key-1'
        )
      ).rejects.toThrow('Invalid assetCode format');
    });

    test('successfully enqueues a valid payment and partitions deterministically', async () => {
      const payload = { from: 'G_ALICE', to: 'G_BOB', amount: '50.00', assetCode: 'XLM' };
      const res = await engine.enqueuePayment(payload, 'idem-1');

      expect(res.trackingId).toMatch(/^tx_/);
      expect(res.shardId).toBeGreaterThanOrEqual(0);
      expect(res.shardId).toBeLessThan(4);
      expect(res.status).toBe(STATUS.PENDING);
      expect(res.isReplay).toBe(false);

      const status = engine.getItemStatus(res.trackingId);
      expect(status).toBeDefined();
      expect(status.id).toBe(res.trackingId);
      expect(status.status).toBe(STATUS.PENDING);
    });
  });

  describe('Multi-Tier Idempotency & Conflict Detection', () => {
    test('returns idempotent replay for identical idempotency key and matching payload', async () => {
      const payload = { from: 'G_ALICE', to: 'G_BOB', amount: '50.00', assetCode: 'XLM' };
      const first = await engine.enqueuePayment(payload, 'idem-replay-key');
      const second = await engine.enqueuePayment(payload, 'idem-replay-key');

      expect(first.isReplay).toBe(false);
      expect(second.isReplay).toBe(true);
      expect(second.trackingId).toBe(first.trackingId);
      expect(engine.metrics.replaysTotal).toBe(1);
    });

    test('throws CONFLICT / IDEMPOTENCY_PAYLOAD_MISMATCH when payload is modified for same key', async () => {
      const payload1 = { from: 'G_ALICE', to: 'G_BOB', amount: '50.00' };
      const payload2 = { from: 'G_ALICE', to: 'G_BOB', amount: '75.00' };

      await engine.enqueuePayment(payload1, 'idem-conflict-key');

      await expect(engine.enqueuePayment(payload2, 'idem-conflict-key')).rejects.toMatchObject({
        code: 'CONFLICT',
        subCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
      });
    });

    test('handles Redis L2 idempotency checks and caching', async () => {
      const redisStore = new Map();
      const mockRedis = {
        get: jest.fn(async (k) => redisStore.get(k) || null),
        set: jest.fn(async (k, v) => redisStore.set(k, v)),
      };

      const redisEngine = new OutboxEngine({
        numShards: 4,
        redisClient: mockRedis,
      });

      const payload = { from: 'G_USER_REDIS', to: 'G_MERCHANT', amount: '25.00' };
      const res1 = await redisEngine.enqueuePayment(payload, 'redis-key-1');
      expect(res1.isReplay).toBe(false);
      expect(mockRedis.set).toHaveBeenCalled();

      // Clear memory idempotency cache to force L2 Redis fallback
      redisEngine.idempotencyStore.clear();

      const res2 = await redisEngine.enqueuePayment(payload, 'redis-key-1');
      expect(res2.isReplay).toBe(true);
      expect(res2.trackingId).toBe(res1.trackingId);

      // Mismatch through L2
      const modified = { ...payload, amount: '999.00' };
      await expect(redisEngine.enqueuePayment(modified, 'redis-key-1')).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });
  });

  describe('Batch Settlement & Cryptographic Merkle State Chaining', () => {
    test('settles items in a shard and generates cryptographic Merkle receipt', async () => {
      const payload1 = { from: 'G_USER_1', to: 'G_RECV_1', amount: '10.00' };
      const payload2 = { from: 'G_USER_1', to: 'G_RECV_2', amount: '20.00' };

      const res1 = await engine.enqueuePayment(payload1, 'k1');
      const res2 = await engine.enqueuePayment(payload2, 'k2');

      const shardId = res1.shardId;
      const processRes = await engine.processShard(shardId);

      expect(processRes.settled).toBeGreaterThanOrEqual(1);
      expect(processRes.batchId).toBeDefined();
      expect(processRes.merkleRoot).toBeDefined();

      const status1 = engine.getItemStatus(res1.trackingId);
      expect(status1.status).toBe(STATUS.SETTLED);
      expect(status1.receipt).toBeDefined();
      expect(status1.receipt.batchId).toBe(processRes.batchId);
      expect(status1.receipt.merkleRoot).toBe(processRes.merkleRoot);
      expect(Array.isArray(status1.receipt.proof)).toBe(true);

      // Verify the cryptographic inclusion proof
      const verification = engine.verifyItemProof(res1.trackingId);
      expect(verification.valid).toBe(true);
      expect(verification.chainValid).toBe(true);
    });

    test('processAllShards processes all queues concurrently and links batch chain', async () => {
      // Enqueue payments across various senders to distribute across shards
      for (let i = 0; i < 20; i++) {
        await engine.enqueuePayment(
          { from: `G_SENDER_${i}`, to: `G_RECEIVER_${i}`, amount: (10 + i).toFixed(2) },
          `batch-key-${i}`
        );
      }

      const allStatsBefore = engine.getQueueStats();
      expect(allStatsBefore.totalPending).toBe(20);

      const summary = await engine.processAllShards();
      expect(summary.itemsSettled).toBe(20);
      expect(summary.itemsFailed).toBe(0);
      expect(summary.batchesCreated).toBeGreaterThanOrEqual(1);

      const allStatsAfter = engine.getQueueStats();
      expect(allStatsAfter.totalPending).toBe(0);
      expect(allStatsAfter.metrics.settledTotal).toBe(20);
    });

    test('returns empty summary when processing empty shard', async () => {
      const res = await engine.processShard(0);
      expect(res.processed).toBe(0);
      expect(res.settled).toBe(0);
    });

    test('throws RangeError on invalid shard ID', async () => {
      await expect(engine.processShard(-1)).rejects.toThrow(RangeError);
      await expect(engine.processShard(99)).rejects.toThrow(RangeError);
    });
  });

  describe('Error Handling, Retries & Dead Letter Queue (DLQ)', () => {
    test('retries transient failures and moves to DLQ when maxRetries is reached', async () => {
      let attemptsCount = 0;
      const failingEngine = new OutboxEngine({
        numShards: 2,
        maxRetries: 2,
        processorFn: async () => {
          attemptsCount++;
          throw new Error('Transient Horizon RPC timeout');
        },
      });

      const res = await failingEngine.enqueuePayment(
        { from: 'G_TRANSIENT_USER', to: 'G_RECEIVER', amount: '10.00' },
        'retry-key-1'
      );

      // Attempt 1: fails, re-queued to FAILED
      await failingEngine.processShard(res.shardId);
      let status = failingEngine.getItemStatus(res.trackingId);
      expect(status.status).toBe(STATUS.FAILED);
      expect(status.attempts).toBe(1);

      // Attempt 2: fails again, reaches maxRetries (2) -> moved to DLQ
      await failingEngine.processShard(res.shardId);
      status = failingEngine.getItemStatus(res.trackingId);
      expect(status.status).toBe(STATUS.DLQ);
      expect(status.attempts).toBe(2);
      expect(failingEngine.dlq.has(res.trackingId)).toBe(true);

      const queueStats = failingEngine.getQueueStats();
      expect(queueStats.dlqDepth).toBe(1);
    });

    test('moves fatal errors immediately to DLQ without retrying', async () => {
      const fatalEngine = new OutboxEngine({
        numShards: 2,
        processorFn: async () => {
          const err = new Error('Invalid account sequence or corrupted key');
          err.fatal = true;
          throw err;
        },
      });

      const res = await fatalEngine.enqueuePayment(
        { from: 'G_FATAL_USER', to: 'G_RECEIVER', amount: '10.00' },
        'fatal-key-1'
      );

      await fatalEngine.processShard(res.shardId);
      const status = fatalEngine.getItemStatus(res.trackingId);
      expect(status.status).toBe(STATUS.DLQ);
      expect(status.attempts).toBe(1);
    });
  });

  describe('Adaptive Concurrency and Backpressure Control', () => {
    test('scales down batch size under simulated high downstream latency', () => {
      engine.adaptiveBatchSize = 50;
      engine.emaLatencyMs = 20;

      // Simulate a slow batch taking 10,000ms for 20 items (500ms/item)
      engine.updateAdaptiveConcurrency(10000, 20);

      expect(engine.adaptiveBatchSize).toBeLessThan(50);
      expect(engine.backpressureFactor).toBeLessThan(1.0);
    });

    test('scales up batch size when downstream latency is minimal', () => {
      engine.adaptiveBatchSize = 20;
      engine.emaLatencyMs = 15;

      // Simulate very fast batch (10ms for 20 items = 0.5ms/item)
      engine.updateAdaptiveConcurrency(10, 20);

      expect(engine.adaptiveBatchSize).toBeGreaterThanOrEqual(20);
    });
  });

  describe('Audit Proof Verification edge cases', () => {
    test('returns invalid when item does not exist or has no receipt', () => {
      expect(engine.verifyItemProof('non-existent')).toEqual({
        valid: false,
        chainValid: false,
        error: 'Item not found or not yet settled',
      });
    });

    test('returns invalid if batch record is missing', async () => {
      const res = await engine.enqueuePayment(
        { from: 'G_A', to: 'G_B', amount: '10' },
        'key-orphan-batch'
      );
      await engine.processShard(res.shardId);

      const item = engine.items.get(res.trackingId);
      engine.batches.clear(); // Simulate corrupted/missing batch record

      const verification = engine.verifyItemProof(res.trackingId);
      expect(verification.valid).toBe(false);
      expect(verification.error).toBe('Batch record not found');
    });

    test('handles Redis L2 connection/write errors gracefully', async () => {
      const mockRedis = {
        get: jest.fn(async () => {
          throw new Error('Redis connection timeout');
        }),
        set: jest.fn(async () => {
          throw new Error('Redis set failure');
        }),
      };

      const fallbackEngine = new OutboxEngine({
        numShards: 2,
        redisClient: mockRedis,
      });

      const res = await fallbackEngine.enqueuePayment(
        { from: 'G_FALLBACK_USER', to: 'G_RCV', amount: '100' },
        'key-redis-fail'
      );

      expect(res.trackingId).toBeDefined();
      expect(res.isReplay).toBe(false);
    });

    test('getItemStatus returns null for empty or non-string trackingId', () => {
      expect(engine.getItemStatus(null)).toBeNull();
      expect(engine.getItemStatus(123)).toBeNull();
      expect(engine.getItemStatus('')).toBeNull();
    });

    test('processShard handles items that were already in non-processable state', async () => {
      const res = await engine.enqueuePayment(
        { from: 'G_USER_SKIP', to: 'G_RCV', amount: '10' },
        'key-skip-state'
      );
      // Manually set status to DLQ while still in shard queue
      const item = engine.items.get(res.trackingId);
      item.status = STATUS.DLQ;

      const procRes = await engine.processShard(res.shardId);
      expect(procRes.processed).toBe(0);
      expect(procRes.settled).toBe(0);
    });

    test('processAllShards handles shard errors logged gracefully', async () => {
      jest.spyOn(engine, 'processShard').mockRejectedValueOnce(new Error('Internal shard fault'));
      // Enqueue so there is at least one shard with items
      await engine.enqueuePayment(
        { from: 'G_S1', to: 'G_S2', amount: '10' },
        'key-fault-1'
      );

      const summary = await engine.processAllShards();
      expect(summary).toBeDefined();
    });
  });
});
