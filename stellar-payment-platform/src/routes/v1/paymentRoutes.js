const express = require('express');
const { prisma } = require('../../../prismaClient');
const { validateSchema } = require('../../middleware/validateSchema');
const { requireJson } = require('../../middleware/requireJson');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { bulkPaymentSchema } = require('../../schemas/paymentSchema');
const { StrKey } = require('@stellar/stellar-sdk');
const { logger } = require('../../logger');
const { idempotencyMiddleware } = require('../../../middleware/idempotency');
const routingRuleService = require('../../services/routingRuleService');

module.exports = (redisClient) => {
  const router = express.Router();
  


  // POST /payments/route — Evaluate payment context against dynamic routing rules
  router.post('/payments/route', requireJson, asyncHandler(async (req, res) => {
    const { clientOrg, client_org, ...paymentData } = req.body;
    const org = clientOrg || client_org || null;
    const evaluation = await routingRuleService.routePayment(paymentData, org);
    return res.status(200).json({
      ok: true,
      route: evaluation.routingResult.route,
      targetAddress: evaluation.routingResult.to,
      originalTo: evaluation.routingResult.originalTo,
      fee: evaluation.routingResult.fee,
      priorityTier: evaluation.routingResult.priorityTier,
      appliedRule: evaluation.appliedRule,
      fullResult: evaluation.routingResult,
      auditLog: evaluation.auditLog,
      durationMs: evaluation.durationMs,
    });
  }));
// --- Idempotency protection for payment intent creation (POST /payments/bulk).
// Duplicate submissions within 24h return the originally created intents. ---
router.use(idempotencyMiddleware(redisClient, { enforce: true }));

  // POST /payments/bulk

/**
 * @openapi
 * /payments/bulk:
 *   post:
 *     tags:
 *       - v1
 *     description: POST /payments/bulk
 *     responses:
 *       200:
 *         description: Success
 */
  router.post('/payments/bulk', requireJson, validateSchema({ body: bulkPaymentSchema }), asyncHandler(async (req, res, next) => {
  const intents = req.body;

  // Additional per-item validation that requires runtime logic
  for (const idx in intents) {
    const intent = intents[idx];
    if (!StrKey.isValidEd25519PublicKey(intent.from)) {
      const err = new Error(`Invalid Stellar public key for 'from' at index ${idx}`);
      err.statusCode = 400;
      throw err;
    }
    if (!StrKey.isValidEd25519PublicKey(intent.to)) {
      const err = new Error(`Invalid Stellar public key for 'to' at index ${idx}`);
      err.statusCode = 400;
      throw err;
    }
  }

  try {
    const createOps = await Promise.all(intents.map(async (intent) => {
      let targetTo = intent.to;
      let targetMemo = intent.memo;
      let targetMemoType = intent.memo_type;
      let mergedMetadata = { ...(intent.metadata || {}) };

      try {
        const evalResult = await routingRuleService.routePayment({
          from: intent.from,
          to: intent.to,
          amount: intent.amount,
          asset: intent.asset,
          memo: intent.memo,
          memoType: intent.memo_type,
          metadata: intent.metadata,
        }, intent.client_org || intent.clientOrg || null);

        if (evalResult && evalResult.matched) {
          targetTo = evalResult.routingResult.to || intent.to;
          targetMemo = evalResult.routingResult.memo || intent.memo;
          targetMemoType = evalResult.routingResult.memoType || intent.memo_type;
          mergedMetadata.routingEngine = {
            applied: true,
            ruleId: evalResult.appliedRule.id,
            ruleName: evalResult.appliedRule.name,
            route: evalResult.routingResult.route,
            originalTo: evalResult.routingResult.originalTo,
            fee: evalResult.routingResult.fee,
            priorityTier: evalResult.routingResult.priorityTier,
          };
        }
      } catch (routingErr) {
        logger.warn('Dynamic routing evaluation skipped:', routingErr.message);
      }

      return prisma.paymentIntent.create({
        data: {
          externalId: intent.external_id,
          from: intent.from,
          to: targetTo,
          amount: intent.amount,
          asset: intent.asset,
          memoType: targetMemoType,
          memo: targetMemo,
          metadata: mergedMetadata,
        },
      });
    }));

    const created = await prisma.$transaction(createOps);

    return res.status(201).json({ ok: true, count: created.length, data: created.map((c) => ({ id: c.id, external_id: c.externalId })) });
  } catch (error) {
    logger.error('Bulk payment registration failed:', error);
    const dbErr = new Error('Failed to register payment intents');
    dbErr.statusCode = 500;
    return next(dbErr);
  }
}));

  return router;
};
