const express = require('express');
const xss = require('xss');

module.exports = (redisClient) => {
  const router = express.Router();
  const { logger } = require('../../logger');

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const makeKey = (email) => `email_verification:${email.toLowerCase()}`;

  // POST /auth/verify-email
  // Body: { email }
  router.post('/verify-email', async (req, res, next) => {
    try {
      if (!redisClient) {
        const err = new Error('Redis is not configured');
        err.statusCode = 503;
        return next(err);
      }

      if (!req.is('application/json')) {
        return res.status(415).json({ error: 'Unsupported Media Type. Please send application/json' });
      }

      const rawEmail = typeof req.body.email === 'string' ? req.body.email.trim() : '';
      const safeEmail = xss(rawEmail);

      if (!safeEmail || !EMAIL_RE.test(safeEmail)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }

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
  router.post('/verify-email/confirm', async (req, res, next) => {
    try {
      if (!redisClient) {
        const err = new Error('Redis is not configured');
        err.statusCode = 503;
        return next(err);
      }

      if (!req.is('application/json')) {
        return res.status(415).json({ error: 'Unsupported Media Type. Please send application/json' });
      }

      const rawEmail = typeof req.body.email === 'string' ? req.body.email.trim() : '';
      const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
      const safeEmail = xss(rawEmail);

      if (!safeEmail || !EMAIL_RE.test(safeEmail) || !/^[0-9]{6}$/.test(code)) {
        return res.status(400).json({ error: 'Invalid email or code' });
      }

      const key = makeKey(safeEmail);
      const stored = await redisClient.get(key);

      if (!stored) {
        return res.status(404).json({ error: 'Verification code not found or expired' });
      }

      if (stored !== code) {
        return res.status(400).json({ error: 'Invalid verification code' });
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
