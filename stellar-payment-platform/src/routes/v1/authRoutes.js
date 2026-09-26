const express = require('express');
const crypto = require('crypto');
const xss = require('xss');
const { validateSchema } = require('../../middleware/validateSchema');
const { ApiError } = require('../../errors');
const { requireJson } = require('../../middleware/requireJson');
const { verifyEmailBodySchema, verifyEmailConfirmBodySchema } = require('../../schemas');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { signToken } = require('../../utils/jwt');

const REFRESH_COOKIE = 'stellar_refresh_token';
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

const parseCookies = (header = '') => Object.fromEntries(
  header.split(';').map((part) => part.trim().split('='))
    .filter(([name, value]) => name && value)
    .map(([name, ...value]) => [name, decodeURIComponent(value.join('='))]),
);

const refreshKey = (token) => `auth:refresh:${crypto.createHash('sha256').update(token).digest('hex')}`;

const setRefreshCookie = (res, token, maxAge = REFRESH_TTL_SECONDS) => {
  const attributes = [
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/auth',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (process.env.NODE_ENV === 'production') attributes.push('Secure');
  res.append('Set-Cookie', attributes.join('; '));
};

const issueRefreshToken = async (redisClient, email, res) => {
  const token = crypto.randomBytes(48).toString('base64url');
  await redisClient.set(refreshKey(token), JSON.stringify({ email }), { EX: REFRESH_TTL_SECONDS });
  setRefreshCookie(res, token);
};

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
  
/**
 * @openapi
 * /verify-email:
 *   post:
 *     tags:
 *       - v1
 *     description: POST /verify-email
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/verify-email', requireRedis, requireJson, validateSchema({ body: verifyEmailBodySchema }), asyncHandler(async (req, res, next) => {
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
  }));

  // POST /auth/verify-email/confirm
  // Body: { email, code }
  
/**
 * @openapi
 * /verify-email/confirm:
 *   post:
 *     tags:
 *       - v1
 *     description: POST /verify-email/confirm
 *     responses:
 *       200:
 *         description: Success
 */
router.post('/verify-email/confirm', requireRedis, requireJson, validateSchema({ body: verifyEmailConfirmBodySchema }), asyncHandler(async (req, res, next) => {
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

      // Issue a signed RS256 JWT so the caller can authenticate subsequent requests.
      let token = null;
      try {
        token = signToken({ sub: safeEmail, email: safeEmail }, { expiresIn: process.env.ACCESS_TOKEN_TTL || '15m' });
      } catch {
        // JWT keys not configured — return verification result without a token.
      }

      if (token) await issueRefreshToken(redisClient, safeEmail, res);

      return res.json({ ok: true, verified: true, ...(token && { token }) });
    } catch (err) {
      return next(err);
    }
  }));

  // Rotate the refresh token on every use. A replayed or revoked cookie is
  // rejected because its hashed key has already been deleted from Redis.
  router.post('/refresh', requireRedis, asyncHandler(async (req, res, next) => {
    try {
      const current = parseCookies(req.headers.cookie || '')[REFRESH_COOKIE];
      if (!current) return next(new ApiError('UNAUTHENTICATED', 'Refresh token is missing'));

      const key = refreshKey(current);
      const stored = await redisClient.get(key);
      if (!stored) return next(new ApiError('UNAUTHENTICATED', 'Refresh token is invalid or expired'));

      const session = JSON.parse(stored);
      await redisClient.del(key);
      const token = signToken({ sub: session.email, email: session.email }, { expiresIn: process.env.ACCESS_TOKEN_TTL || '15m' });
      await issueRefreshToken(redisClient, session.email, res);
      return res.json({ ok: true, token });
    } catch (err) {
      return next(err);
    }
  }));

  router.post('/logout', requireRedis, asyncHandler(async (req, res, next) => {
    try {
      const current = parseCookies(req.headers.cookie || '')[REFRESH_COOKIE];
      if (current) await redisClient.del(refreshKey(current));
      setRefreshCookie(res, '', 0);
      return res.status(204).send();
    } catch (err) {
      return next(err);
    }
  }));

  return router;
};
