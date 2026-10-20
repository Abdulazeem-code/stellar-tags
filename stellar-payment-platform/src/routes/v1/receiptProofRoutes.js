'use strict';

const express = require('express');
const { ApiError } = require('../../errors');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { logger } = require('../../logger');
const { MerkleTree } = require('../../settlement/merkleTree');

module.exports = (redisClient) => {
  const router = express.Router();

  const getPrisma = () => require('../../../prismaClient');

  /**
   * @openapi
   * /v1/payments/{paymentId}/receipt-proof:
   *   get:
   *     tags:
   *       - v1
   *     summary: Get cryptographic Merkle inclusion proof for a payment
   *     description: Returns the Merkle proof, leaf index, and anchor transaction hash for verifying a payment's inclusion in an hourly notarized batch
   *     parameters:
   *       - name: paymentId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *         description: UUID of the payment
   *     responses:
   *       200:
   *         description: Merkle inclusion proof retrieved successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 data:
   *                   type: object
   *                   properties:
   *                     paymentId:
   *                       type: string
   *                     merkleRoot:
   *                       type: string
   *                       description: 32-byte Merkle root as hex string
   *                     leafIndex:
   *                       type: integer
   *                     proof:
   *                       type: array
   *                       items:
   *                         type: object
   *                         properties:
   *                           position:
   *                             type: string
   *                             enum: [left, right]
   *                           hash:
   *                             type: string
   *                     batchId:
   *                       type: string
   *                     batchTimestamp:
   *                       type: string
   *                       format: int64
   *                     anchorTxHash:
   *                       type: string
   *                       nullable: true
   *                     anchorStatus:
   *                       type: string
   *                       enum: [pending, confirmed, failed]
   *                     verified:
   *                       type: boolean
   *       404:
   *         description: Payment receipt not found
   *       500:
   *         description: Internal server error
   */
  router.get('/v1/payments/:paymentId/receipt-proof', asyncHandler(async (req, res, next) => {
    const { paymentId } = req.params;

    const { prisma } = getPrisma();

    const receipt = await prisma.paymentReceipt.findUnique({
      where: { paymentId },
    });

    if (!receipt) {
      return next(new ApiError('NOT_FOUND', 'Payment receipt not found'));
    }

    const anchor = await prisma.receiptAnchor.findUnique({
      where: { batchId: receipt.batchId },
    });

    let verified = false;
    if (receipt.anchorStatus === 'confirmed' && anchor?.anchorTxHash) {
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        select: {
          id: true,
          transactionHash: true,
          fromAddress: true,
          toAddress: true,
          amount: true,
          assetCode: true,
          createdAt: true,
        },
      });

      if (payment) {
        const leafData = {
          paymentId: payment.id,
          transactionHash: payment.transactionHash,
          from: payment.fromAddress,
          to: payment.toAddress,
          amount: payment.amount,
          assetCode: payment.assetCode || 'XLM',
          timestamp: payment.createdAt.getTime(),
          index: receipt.leafIndex,
        };

        verified = MerkleTree.verifyProof(
          leafData,
          receipt.proof,
          receipt.merkleRoot
        );
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        paymentId: receipt.paymentId,
        merkleRoot: receipt.merkleRoot,
        leafIndex: receipt.leafIndex,
        proof: receipt.proof,
        batchId: receipt.batchId,
        batchTimestamp: receipt.batchTimestamp.toString(),
        anchorTxHash: receipt.anchorTxHash,
        anchorStatus: receipt.anchorStatus,
        verified,
      },
    });
  }));

  /**
   * @openapi
   * /v1/receipt-anchors:
   *   get:
   *     tags:
   *       - v1
   *     summary: List all Merkle root anchors
   *     description: Returns paginated list of hourly Merkle root anchors with their Stellar transaction hashes
   *     parameters:
   *       - name: limit
   *         in: query
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 100
   *           default: 20
   *       - name: page
   *         in: query
   *         schema:
   *           type: integer
   *           minimum: 1
   *           default: 1
   *       - name: status
   *         in: query
   *         schema:
   *           type: string
   *           enum: [pending, confirmed, failed]
   *     responses:
   *       200:
   *         description: List of anchors
   */
  router.get('/receipt-anchors', asyncHandler(async (req, res) => {
    const { prisma } = getPrisma();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const status = req.query.status;

    const where = status ? { status } : {};

    const [total, anchors] = await Promise.all([
      prisma.receiptAnchor.count({ where }),
      prisma.receiptAnchor.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    // Convert BigInt fields to strings for JSON serialization
    const serializedAnchors = anchors.map(anchor => ({
      ...anchor,
      batchTimestamp: anchor.batchTimestamp?.toString?.() ?? anchor.batchTimestamp,
    }));

    return res.status(200).json({
      success: true,
      data: serializedAnchors,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  }));

  /**
   * @openapi
   * /v1/receipts/verify:
   *   post:
   *     tags:
   *       - v1
   *     summary: Verify a Merkle inclusion proof offline
   *     description: Verifies a payment's inclusion in a Merkle tree without API dependencies. Provide leafData, proof, and root.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [leafData, proof, root]
   *             properties:
   *               leafData:
   *                 type: object
   *               proof:
   *                 type: array
   *                 items:
   *                   type: object
   *                   properties:
   *                     position:
   *                       type: string
   *                       enum: [left, right]
   *                     hash:
   *                       type: string
   *               root:
   *                 type: string
   *     responses:
   *       200:
   *         description: Verification result
   */
  router.post('/receipts/verify', asyncHandler(async (req, res, next) => {
    const { leafData, proof, root } = req.body;

    if (!leafData || !proof || !root) {
      return next(new ApiError('INVALID_INPUT', 'Missing leafData, proof, or root in request body'));
    }

    const isValid = MerkleTree.verifyProof(leafData, proof, root);

    return res.status(200).json({
      success: true,
      data: {
        valid: isValid,
        merkleRoot: root,
      },
    });
  }));

  return router;
};