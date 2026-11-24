'use strict';

const crypto = require('crypto');
const express = require('express');
const xss = require('xss');
const Filter = require('bad-words');
const { StrKey } = require('@stellar/stellar-sdk');
const { prisma } = require('../../../prismaClient');
const { logger } = require('../../logger');
const { ApiError } = require('../../errors');
const { normalizeNameTag, validateMemo } = require('../../utils');
const { authenticateUsernameOwner } = require('../../services/ownershipService');
const { validateSchema } = require('../../middleware/validateSchema');
const { requireJson } = require('../../middleware/requireJson');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { idempotencyMiddleware } = require('../../../middleware/idempotency');
const { createSignatureRateLimiter } = require('../../middleware/signatureRateLimit');
const { paymentRequestBodySchema } = require('../../schemas');
const { buildPaymentLink, toSep7Uri } = require('../../utils/paymentLink');
const { dispatchPaymentRequestWebhooks } = require('../../webhookWorker');

const profanityFilter = new Filter();
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;
const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

const validateAmount = (amount) => {
  if (typeof amount !== 'string' || !/^\d+(?:\.\d{1,7})?$/.test(amount)) return false;
  return Number(amount) > 0;
};

const validateAsset = (asset) => {
  if (asset === 'XLM' || asset === 'native') return true;
  const match = /^([A-Za-z0-9]{1,12}):(.+)$/.exec(asset);
  return Boolean(match && StrKey.isValidEd25519PublicKey(match[2]));
};

const computedStatus = (request, now = new Date()) => {
  if (request.status === 'pending' && request.expiresAt && new Date(request.expiresAt) <= now) {
    return 'expired';
  }
  return request.status;
};

const serializeRequest = (request) => ({
  id: request.id,
  tag: request.tag,
  destination: request.destination,
  amount: request.amount,
  asset: request.asset,
  memoType: request.memoType,
  memo: request.memo,
  description: request.description,
  status: computedStatus(request),
  expiresAt: request.expiresAt,
  paidAt: request.paidAt,
  transactionHash: request.transactionHash,
  createdAt: request.createdAt,
});

const getBaseUrl = (req) => {
  const configured = process.env.PUBLIC_API_URL || process.env.DOMAIN;
  if (configured) {
    return /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
  }
  const host = req.get('host') || 'localhost';
  if (/^(localhost|127\.0\.0\.1)(:|$)/i.test(host)) return `https://${host}`;
  return `${req.protocol}://${host}`;
};

module.exports = (redisClient) => {
  const router = express.Router();
  const signatureRateLimiter = createSignatureRateLimiter(redisClient);
  const idempotency = idempotencyMiddleware(redisClient, { enforce: true });

  router.post(
    '/payment-requests',
    signatureRateLimiter,
    idempotency,
    requireJson,
    validateSchema({ body: paymentRequestBodySchema }),
    asyncHandler(async (req, res, next) => {
      const body = req.body;
      const tag = normalizeNameTag(body.tag).toLowerCase();
      if (!validateAmount(body.amount)) {
        return next(new ApiError('VALIDATION_FAILED', 'amount must be a positive decimal with at most 7 decimal places'));
      }
      if (!validateAsset(body.asset)) {
        return next(new ApiError('VALIDATION_FAILED', 'asset must be XLM or CODE:G...'));
      }

      let resolvedMemoType = body.memoType || body.memo_type;
      if (resolvedMemoType || body.memo) {
        const memoError = validateMemo(resolvedMemoType || 'text', body.memo);
        if (memoError) return next(new ApiError('VALIDATION_FAILED', memoError));
        resolvedMemoType = resolvedMemoType || 'text';
      }

      const description = body.description ? xss(body.description).trim() : undefined;
      if (description && profanityFilter.isProfane(description)) {
        return next(new ApiError('VALIDATION_FAILED', 'description contains restricted words'));
      }

      const now = new Date();
      const expiryValue = body.expiresAt || body.expires_at;
      let expiresAt = new Date(now.getTime() + DEFAULT_EXPIRY_MS);
      if (expiryValue) {
        expiresAt = new Date(expiryValue);
        if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
          return next(new ApiError('VALIDATION_FAILED', 'expiresAt must be a future ISO-8601 date'));
        }
        if (expiresAt.getTime() - now.getTime() > MAX_EXPIRY_MS) {
          return next(new ApiError('VALIDATION_FAILED', 'expiresAt cannot be more than 30 days in the future'));
        }
      }

      const user = await prisma.user.findUnique({
        where: { username: tag },
        select: { username: true, address: true, deletedAt: true },
      }).catch((error) => {
        logger.error('[payment-request] tag lookup failed:', error);
        throw error;
      });
      if (!user || user.deletedAt) return next(new ApiError('NOT_FOUND', 'Tag not found'));

      const signature = req.get('x-stellar-signature') || body.signature;
      const signerAddress = req.get('x-stellar-signer') || body.signerAddress;
      if (!signature) {
        return next(new ApiError(
          'UNAUTHENTICATED',
          `Sign "payment-request:${tag}" with the account key and send it as X-Stellar-Signature.`,
        ));
      }

      try {
        await authenticateUsernameOwner({
          username: tag,
          signature,
          signerAddress,
          operation: 'payment-request',
          allowPublicKeySignature: false,
        });
      } catch (error) {
        if (error.statusCode === 404) return next(new ApiError('NOT_FOUND', 'Tag not found'));
        if (error.statusCode) return next(new ApiError(error.statusCode === 401 ? 'UNAUTHENTICATED' : 'INVALID_INPUT', error.message));
        return next(new ApiError('UNAUTHENTICATED', 'Signature verification failed', { cause: error }));
      }

      let memo = body.memo;
      if (!memo) {
        resolvedMemoType = 'text';
        memo = crypto.randomBytes(12).toString('base64url').slice(0, 20);
      }
      const asset = body.asset === 'native' ? 'XLM' : body.asset;

      let created;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          created = await prisma.paymentRequest.create({
            data: {
              tag,
              destination: user.address,
              amount: body.amount,
              asset,
              memoType: resolvedMemoType,
              memo,
              description,
              status: 'pending',
              expiresAt,
            },
          });
          break;
        } catch (error) {
          if (error.code !== 'P2002' || body.memo) throw error;
          memo = crypto.randomBytes(12).toString('base64url').slice(0, 20);
        }
      }
      if (!created) throw new ApiError('CONFLICT', 'Could not generate a unique memo');

      const baseUrl = getBaseUrl(req);
      const link = buildPaymentLink({
        baseUrl,
        tag,
        amount: created.amount,
        asset: created.asset,
        memo: created.memo,
        memoType: created.memoType,
        requestId: created.id,
      });
      const sep7 = toSep7Uri({
        destination: created.destination,
        amount: created.amount,
        asset: created.asset,
        memo: created.memo,
        memoType: created.memoType,
      });

      return res.status(201).json({
        ok: true,
        data: serializeRequest(created),
        link,
        sep7,
      });
    }),
  );

  router.get('/payment-requests/:id', asyncHandler(async (req, res) => {
    const request = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
    if (!request) throw new ApiError('NOT_FOUND', 'Payment request not found');
    return res.json({ ok: true, data: serializeRequest(request) });
  }));

  router.post('/payment-requests/:id/cancel', signatureRateLimiter, asyncHandler(async (req, res, next) => {
    const request = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return next(new ApiError('NOT_FOUND', 'Payment request not found'));

    if (computedStatus(request) !== 'pending') {
      return next(new ApiError('CONFLICT', `Cannot cancel a ${computedStatus(request)} payment request`));
    }

    const signature = req.get('x-stellar-signature') || req.body?.signature;
    const signerAddress = req.get('x-stellar-signer') || req.body?.signerAddress;
    if (!signature) {
      return next(new ApiError(
        'UNAUTHENTICATED',
        `Sign "payment-request:${request.tag}" with the account key and send it as X-Stellar-Signature.`,
      ));
    }

    try {
      await authenticateUsernameOwner({
        username: request.tag,
        signature,
        signerAddress,
        operation: 'payment-request',
        allowPublicKeySignature: false,
      });
    } catch (error) {
      if (error.statusCode === 404) return next(new ApiError('NOT_FOUND', 'Tag not found'));
      if (error.statusCode) return next(new ApiError(error.statusCode === 401 ? 'UNAUTHENTICATED' : 'INVALID_INPUT', error.message));
      return next(new ApiError('UNAUTHENTICATED', 'Signature verification failed', { cause: error }));
    }

    const updated = await prisma.paymentRequest.update({
      where: { id: request.id },
      data: { status: 'cancelled' },
    });
    // The cancel already succeeded; a webhook problem must not fail the request.
    dispatchPaymentRequestWebhooks({ prisma, request: updated, status: 'cancelled' }).catch((error) =>
      logger.error({ err: error, paymentRequestId: updated.id }, '[payment-request] cancelled webhook dispatch failed'),
    );
    return res.json({ ok: true, data: serializeRequest(updated) });
  }));

  return router;
};
