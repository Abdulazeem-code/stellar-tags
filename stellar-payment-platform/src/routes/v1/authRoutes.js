const express = require('express');
const xss = require('xss');
const { validateSchema } = require('../../middleware/validateSchema');
const { ApiError } = require('../../errors');
const { requireJson } = require('../../middleware/requireJson');
const { verifyEmailBodySchema, verifyEmailConfirmBodySchema } = require('../../schemas');

module.exports = (redisClient) => {
  const router = express.Router();
  const { logger } = require('../../logger');

  const makeKey = (email) => `email_verification:${email.toLowerCase()}`;

  // Redis holds the OTPs, so an unconfigured client is reported before the
  // payload is inspected.
  const requireRedis = (req, res, next) => {
    if (!redisClient) {
      return next(new ApiError('SERVICE_UNAVAILABLE', 'Redis is not configured'));
    }
    return next();
  };

  // POST /auth/verify-email
  // Body: { email }
  router.post('/verify-email', requireRedis, requireJson, validateSchema({ body: verifyEmailBodySchema }), async (req, res, next) => {
    try {
      const safeEmail = xss(req.body.email);

      // Generate 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const key = makeKey(safeEmail);

      // Store in Redis with 10 minute TTL
      await redisClient.set(key, otp, { EX: 600 });

      // In production this should send an email. For now log the OTP so devs can test.
      logger.info(`[Correlation ID: ${req.correlationId}] Sent OTP for ${safeEmail}`);
      logger.debug(`[Correlation ID: ${req.correlationId}] OTP for ${safeEmail}: ${otp}`);

      return res.json({ ok: true, method: 'email', message: 'OTP sent' });
    } catch (err) {
      return next(err);
    }
  });

  // POST /auth/verify-email/confirm
  // Body: { email, code }
  router.post('/verify-email/confirm', requireRedis, requireJson, validateSchema({ body: verifyEmailConfirmBodySchema }), async (req, res, next) => {
    try {
      const safeEmail = xss(req.body.email);
      const { code } = req.body;

      const key = makeKey(safeEmail);
      const stored = await redisClient.get(key);

      if (!stored) {
        return next(new ApiError('NOT_FOUND', 'Verification code not found or expired'));
      }

      if (stored !== code) {
        return next(new ApiError('INVALID_INPUT', 'Invalid verification code'));
      }

      // On success, remove key
      await redisClient.del(key);

      return res.json({ ok: true, verified: true });
    } catch (err) {
      return next(err);
    }
  });

  return router;
};
