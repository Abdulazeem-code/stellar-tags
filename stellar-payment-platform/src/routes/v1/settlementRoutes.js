'use strict';

const express = require('express');
const { getSettlementEngine } = require('../../services/settlementService');
const { MerkleTree } = require('../../settlement/merkleTree');
const benchmarkRunner = require('../../settlement/benchmarkRunner');
const { ApiError } = require('../../errors');

/**
 * Feature 27: Settlement & Outbox API Routes
 *
 * RESTful interface for managing high-scale payment outbox queues,
 * batch processing, cryptographic Merkle audit verification, and benchmarks.
 */

module.exports = (redisClient) => {
  const router = express.Router();
  const engine = getSettlementEngine(redisClient);

  /**
   * POST /outbox/enqueue
   * Enqueues a payment into the sharded outbox with multi-tier idempotency protection.
   */
  router.post('/outbox/enqueue', async (req, res, next) => {
    try {
      const idempotencyKey =
        req.headers['x-idempotency-key'] ||
        req.headers['idempotency-key'] ||
        (req.body && req.body.idempotencyKey);

      if (!idempotencyKey) {
        throw new ApiError('INVALID_INPUT', 'Missing required X-Idempotency-Key header or idempotencyKey in body');
      }

      const { from, to, amount, assetCode, metadata } = req.body || {};
      const payload = { from, to, amount, assetCode, metadata };

      const result = await engine.enqueuePayment(payload, idempotencyKey);

      if (result.isReplay) {
        res.setHeader('x-idempotent-replay', 'true');
        res.setHeader('x-shard-id', String(result.shardId));
        return res.status(200).json({
          status: 'success',
          message: 'Payment request already exists (idempotent replay)',
          data: result,
        });
      }

      res.setHeader('x-shard-id', String(result.shardId));
      return res.status(201).json({
        status: 'success',
        message: 'Payment successfully enqueued into outbox',
        data: result,
      });
    } catch (err) {
      if (err.code === 'CONFLICT' || err.subCode === 'IDEMPOTENCY_PAYLOAD_MISMATCH') {
        return next(
          new ApiError(
            'CONFLICT',
            'Idempotency key reused with mismatched payload. Transactions are immutable.',
            { statusCode: 409 }
          )
        );
      }
      if (err.code === 'INVALID_INPUT') {
        return next(new ApiError('INVALID_INPUT', err.message, { statusCode: 400 }));
      }
      next(err);
    }
  });

  /**
   * GET /outbox/status/:trackingId
   * Retrieves transaction outbox status, shard information, and Merkle receipt.
   */
  router.get('/outbox/status/:trackingId', (req, res, next) => {
    try {
      const { trackingId } = req.params;
      const status = engine.getItemStatus(trackingId);

      if (!status) {
        throw new ApiError('NOT_FOUND', `Transaction tracking ID '${trackingId}' not found`, {
          statusCode: 404,
        });
      }

      res.setHeader('x-shard-id', String(status.shardId));
      return res.status(200).json({
        status: 'success',
        data: status,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /outbox/process
   * Triggers processing across all shards or a specific shard.
   */
  router.post('/outbox/process', async (req, res, next) => {
    try {
      const { shardId } = req.body || {};

      let result;
      if (shardId !== undefined && shardId !== null) {
        const id = parseInt(shardId, 10);
        result = await engine.processShard(id);
      } else {
        result = await engine.processAllShards();
      }

      return res.status(200).json({
        status: 'success',
        message: 'Outbox processing completed',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /outbox/queue
   * Retrieves queue depths, active shards, and backpressure statistics.
   */
  router.get('/outbox/queue', (req, res) => {
    const stats = engine.getQueueStats();
    return res.status(200).json({
      status: 'success',
      data: stats,
    });
  });

  /**
   * GET /audit/verify/:trackingId
   * Verifies the cryptographic Merkle inclusion proof for a settled item.
   */
  router.get('/audit/verify/:trackingId', (req, res, next) => {
    try {
      const { trackingId } = req.params;
      const verification = engine.verifyItemProof(trackingId);

      if (!verification.valid && verification.error === 'Item not found or not yet settled') {
        throw new ApiError('NOT_FOUND', verification.error, { statusCode: 404 });
      }

      return res.status(200).json({
        status: 'success',
        data: verification,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /audit/verify-proof
   * Verifies an arbitrary leaf against a Merkle root and proof steps.
   */
  router.post('/audit/verify-proof', (req, res, next) => {
    try {
      const { leafData, proof, root } = req.body || {};

      if (!leafData || !proof || !root) {
        throw new ApiError('INVALID_INPUT', 'Missing leafData, proof, or root in request body');
      }

      const isValid = MerkleTree.verifyProof(leafData, proof, root);

      return res.status(200).json({
        status: 'success',
        data: {
          valid: isValid,
          merkleRoot: root,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /metrics
   * Exposes JSON metrics summary for settlement outbox telemetry.
   */
  router.get('/metrics', (req, res) => {
    const stats = engine.getQueueStats();
    return res.status(200).json({
      status: 'success',
      data: stats,
    });
  });

  /**
   * GET /benchmarks
   * Runs the automated benchmark comparison between uncoordinated vs sharded settlement.
   */
  router.get('/benchmarks', async (req, res, next) => {
    try {
      const totalItems = parseInt(req.query.totalItems || '500', 10);
      const numShards = parseInt(req.query.numShards || '8', 10);

      const benchmarkResult = await benchmarkRunner.runSettlementBenchmark({ totalItems, numShards });

      return res.status(200).json({
        status: 'success',
        message: 'Settlement performance benchmark executed successfully',
        data: benchmarkResult,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
