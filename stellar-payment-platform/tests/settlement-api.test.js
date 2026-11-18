'use strict';

const express = require('express');
const request = require('supertest');
const settlementRoutes = require('../src/routes/v1/settlementRoutes');
const { getSettlementEngine, resetSettlementEngine } = require('../src/services/settlementService');
const { buildErrorHandler } = require('../src/middleware/errorHandler');

describe('Feature 27: Settlement & Outbox REST API', () => {
  let app;
  let engine;

  beforeEach(() => {
    resetSettlementEngine();
    engine = getSettlementEngine();

    app = express();
    app.use(express.json());
    app.use('/api/v1/settlement', settlementRoutes(null));
    app.use(buildErrorHandler(() => false));
  });

  afterEach(() => {
    resetSettlementEngine();
  });

  describe('POST /api/v1/settlement/outbox/enqueue', () => {
    test('enqueues a valid payment and returns 201 Created with tracking ID and shard ID', async () => {
      const payload = {
        from: 'G_SENDER_ADDR_1',
        to: 'G_RECEIVER_ADDR_1',
        amount: '150.50',
        assetCode: 'USDC',
      };

      const res = await request(app)
        .post('/api/v1/settlement/outbox/enqueue')
        .set('X-Idempotency-Key', 'idem-api-test-1')
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.trackingId).toMatch(/^tx_/);
      expect(res.body.data.status).toBe('PENDING');
      expect(res.headers['x-shard-id']).toBeDefined();
    });

    test('returns 200 OK with x-idempotent-replay header on duplicate submission', async () => {
      const payload = {
        from: 'G_SENDER_ADDR_1',
        to: 'G_RECEIVER_ADDR_1',
        amount: '150.50',
      };

      const first = await request(app)
        .post('/api/v1/settlement/outbox/enqueue')
        .set('X-Idempotency-Key', 'idem-api-test-dup')
        .send(payload);

      expect(first.status).toBe(201);

      const second = await request(app)
        .post('/api/v1/settlement/outbox/enqueue')
        .set('X-Idempotency-Key', 'idem-api-test-dup')
        .send(payload);

      expect(second.status).toBe(200);
      expect(second.headers['x-idempotent-replay']).toBe('true');
      expect(second.body.data.trackingId).toBe(first.body.data.trackingId);
    });

    test('returns 409 Conflict when idempotency key is reused with modified payload', async () => {
      const key = 'idem-conflict-api';
      await request(app)
        .post('/api/v1/settlement/outbox/enqueue')
        .set('X-Idempotency-Key', key)
        .send({ from: 'G_A', to: 'G_B', amount: '10' });

      const res = await request(app)
        .post('/api/v1/settlement/outbox/enqueue')
        .set('X-Idempotency-Key', key)
        .send({ from: 'G_A', to: 'G_B', amount: '999' });

      expect(res.status).toBe(409);
    });

    test('returns 400 Bad Request when idempotency key or payload is invalid', async () => {
      const noKey = await request(app)
        .post('/api/v1/settlement/outbox/enqueue')
        .send({ from: 'G_A', to: 'G_B', amount: '10' });
      expect(noKey.status).toBe(400);

      const badAmount = await request(app)
        .post('/api/v1/settlement/outbox/enqueue')
        .set('X-Idempotency-Key', 'key-bad-amt')
        .send({ from: 'G_A', to: 'G_B', amount: '-50' });
      expect(badAmount.status).toBe(400);
    });
  });

  describe('GET /api/v1/settlement/outbox/status/:trackingId', () => {
    test('returns 200 OK with tracking item details', async () => {
      const enq = await request(app)
        .post('/api/v1/settlement/outbox/enqueue')
        .set('X-Idempotency-Key', 'status-check-key')
        .send({ from: 'G_SRC', to: 'G_DST', amount: '20.00' });

      const trackingId = enq.body.data.trackingId;

      const res = await request(app).get(`/api/v1/settlement/outbox/status/${trackingId}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(trackingId);
      expect(res.body.data.status).toBe('PENDING');
    });

    test('returns 404 Not Found for non-existent tracking ID', async () => {
      const res = await request(app).get('/api/v1/settlement/outbox/status/tx_non_existent');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/settlement/outbox/process', () => {
    test('triggers batch processing and settles pending items with Merkle receipts', async () => {
      await request(app)
        .post('/api/v1/settlement/outbox/enqueue')
        .set('X-Idempotency-Key', 'batch-test-1')
        .send({ from: 'G_BATCH_SRC', to: 'G_BATCH_DST', amount: '35.00' });

      const procRes = await request(app).post('/api/v1/settlement/outbox/process').send({});
      expect(procRes.status).toBe(200);
      expect(procRes.body.data.itemsSettled).toBe(1);
    });

    test('processes specific shard when shardId is provided', async () => {
      const enq = await request(app)
        .post('/api/v1/settlement/outbox/enqueue')
        .set('X-Idempotency-Key', 'shard-specific-key')
        .send({ from: 'G_SHARD_SRC', to: 'G_SHARD_DST', amount: '45.00' });

      const shardId = enq.body.data.shardId;
      const procRes = await request(app)
        .post('/api/v1/settlement/outbox/process')
        .send({ shardId });

      expect(procRes.status).toBe(200);
      expect(procRes.body.data.shardId).toBe(shardId);
      expect(procRes.body.data.settled).toBe(1);
    });
  });

  describe('GET /api/v1/settlement/outbox/queue & /metrics', () => {
    test('returns queue depth, shard breakdown, and metrics summary', async () => {
      const queueRes = await request(app).get('/api/v1/settlement/outbox/queue');
      expect(queueRes.status).toBe(200);
      expect(queueRes.body.data.numShards).toBeDefined();
      expect(Array.isArray(queueRes.body.data.shardDepths)).toBe(true);

      const metricsRes = await request(app).get('/api/v1/settlement/metrics');
      expect(metricsRes.status).toBe(200);
      expect(metricsRes.body.data.metrics).toBeDefined();
    });
  });

  describe('Cryptographic Merkle Audit Verification Endpoints', () => {
    test('verifies settled item Merkle proof via GET /audit/verify/:trackingId', async () => {
      const enq = await request(app)
        .post('/api/v1/settlement/outbox/enqueue')
        .set('X-Idempotency-Key', 'audit-test-key')
        .send({ from: 'G_AUDIT_SRC', to: 'G_AUDIT_DST', amount: '500.00' });

      const trackingId = enq.body.data.trackingId;
      await request(app).post('/api/v1/settlement/outbox/process').send({});

      const auditRes = await request(app).get(`/api/v1/settlement/audit/verify/${trackingId}`);
      expect(auditRes.status).toBe(200);
      expect(auditRes.body.data.valid).toBe(true);
      expect(auditRes.body.data.chainValid).toBe(true);
      expect(auditRes.body.data.merkleRoot).toBeDefined();
    });

    test('verifies arbitrary proof via POST /audit/verify-proof', async () => {
      const { MerkleTree } = require('../src/settlement/merkleTree');
      const leaves = [{ tx: 'a' }, { tx: 'b' }];
      const tree = new MerkleTree(leaves);
      const proof = tree.getProof(0);

      const verifyRes = await request(app)
        .post('/api/v1/settlement/audit/verify-proof')
        .send({
          leafData: leaves[0],
          proof,
          root: tree.getRootHex(),
        });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.data.valid).toBe(true);

      const badVerify = await request(app)
        .post('/api/v1/settlement/audit/verify-proof')
        .send({
          leafData: { tx: 'tampered' },
          proof,
          root: tree.getRootHex(),
        });
      expect(badVerify.status).toBe(200);
      expect(badVerify.body.data.valid).toBe(false);
    });

    test('returns 404 when verifying audit proof for non-existent or unsettled item', async () => {
      const res = await request(app).get('/api/v1/settlement/audit/verify/tx_unsettled_fake');
      expect(res.status).toBe(404);
    });

    test('returns 400 when verify-proof receives missing parameters', async () => {
      const res = await request(app).post('/api/v1/settlement/audit/verify-proof').send({});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/settlement/benchmarks', () => {
    test('executes performance benchmark and returns quantifiable metrics', async () => {
      const res = await request(app)
        .get('/api/v1/settlement/benchmarks')
        .query({ totalItems: 100, numShards: 4 });

      expect(res.status).toBe(200);
      expect(res.body.data.enqueueBenchmark.throughputTps).toBeGreaterThan(0);
      expect(res.body.data.settlementBenchmark.speedupFactor).toBeDefined();
      expect(res.body.data.idempotencyConcurrencyTest.allCorrectlyReplayed).toBe(true);
      expect(res.body.data.cryptographicAuditBenchmark.proofValid).toBe(true);
    });
  });

  describe('Internal Server Error propagation', () => {
    test('propagates unexpected errors in enqueue to error handler', async () => {
      jest.spyOn(engine, 'enqueuePayment').mockRejectedValueOnce(new Error('Unexpected DB lock'));
      const res = await request(app)
        .post('/api/v1/settlement/outbox/enqueue')
        .set('X-Idempotency-Key', 'unexpected-err-key')
        .send({ from: 'G_A', to: 'G_B', amount: '10' });

      expect(res.status).toBe(500);
    });

    test('propagates unexpected errors in process to error handler', async () => {
      jest.spyOn(engine, 'processAllShards').mockRejectedValueOnce(new Error('Fatal worker crash'));
      const res = await request(app).post('/api/v1/settlement/outbox/process').send({});
      expect(res.status).toBe(500);
    });

    test('propagates unexpected errors in benchmarks to error handler', async () => {
      const benchmarkRunner = require('../src/settlement/benchmarkRunner');
      jest.spyOn(benchmarkRunner, 'runSettlementBenchmark').mockRejectedValueOnce(new Error('Benchmark crash'));
      const res = await request(app).get('/api/v1/settlement/benchmarks');
      expect(res.status).toBe(500);
    });
  });
});
