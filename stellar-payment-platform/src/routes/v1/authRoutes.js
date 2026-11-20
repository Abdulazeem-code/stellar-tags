const express = require('express');
const crypto = require('crypto');
const xss = require('xss');
const { validateSchema } = require('../../middleware/validateSchema');
const { ApiError } = require('../../errors');
const { requireJson } = require('../../middleware/requireJson');
const { verifyEmailBodySchema, verifyEmailConfirmBodySchema } = require('../../schemas');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { signToken } = require('../../utils/jwt');
const { createSep10Challenge, verifySep10Challenge } = require('../../services/sep10');

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

  // SEP-10 requires wildcard CORS on both endpoints, including error responses.
  const setSep10Cors = (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return next();
  };

  // SEP-10 errors use the spec's flat `{ "error": "..." }` body rather than the
  // platform envelope. Only expected ApiErrors are surfaced verbatim; anything
  // unexpected is logged without request/transaction details and generalized.
  const sendSep10Error = (req, res, err) => {
    if (err instanceof ApiError) {
      return res.status(err.statusCode).json({ error: err.message });
    }

    logger.error(
      {
        err: { name: err && err.name, message: err && err.message },
        correlationId: req.correlationId,
      },
      'SEP-10 challenge failed',
    );
    return res.status(500).json({ error: 'Internal server error' });
  };

  /**
   * @openapi
   * /auth:
   *   get:
   *     tags:
   *       - sep-10
   *     description: Issue a SEP-10 challenge transaction
   *     parameters:
   *       - in: query
   *         name: account
   *         required: true
   *         schema:
   *           type: string
   *         description: Client G... or M... account.
   *       - in: query
   *         name: memo
   *         schema:
   *           type: string
   *         description: Optional uint64 ID memo, not allowed with muxed accounts.
   *       - in: query
   *         name: home_domain
   *         schema:
   *           type: string
   *         description: Optional; must match the configured home domain.
   *       - in: query
   *         name: client_domain
   *         schema:
   *           type: string
   *         description: Accepted and ignored pending client-domain support.
   *     responses:
   *       200:
   *         description: Challenge transaction and network passphrase
   *       400:
   *         description: Invalid challenge request
   *       404:
   *         description: SEP-10 is disabled
   *       503:
   *         description: Redis unavailable
   */
  router.get(
    '/',
    setSep10Cors,
    asyncHandler(async (req, res) => {
      try {
        const challenge = await createSep10Challenge(req.query, redisClient);
        return res.json(challenge);
      } catch (err) {
        return sendSep10Error(req, res, err);
      }
    }),
  );

  // SEP-10 browsers may preflight the root auth endpoint from any origin.
  router.options('/', setSep10Cors, (req, res) => {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  });

  /**
   * @openapi
   * /auth:
   *   post:
   *     tags:
   *       - sep-10
   *     description: Exchange a signed SEP-10 challenge for a JWT
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [transaction]
   *             properties:
   *               transaction:
   *                 type: string
   *         application/x-www-form-urlencoded:
   *           schema:
   *             type: object
   *             required: [transaction]
   *             properties:
   *               transaction:
   *                 type: string
   *     responses:
   *       200:
   *         description: Session JWT
   *       400:
   *         description: Invalid challenge
   *       401:
   *         description: Invalid signature or threshold
   *       503:
   *         description: Horizon or Redis unavailable
   */
  router.post(
    '/',
    setSep10Cors,
    express.urlencoded({ extended: false, limit: 1024 }),
    asyncHandler(async (req, res) => {
      try {
        const result = await verifySep10Challenge(req.body, redisClient);
        return res.json(result);
      } catch (err) {
        return sendSep10Error(req, res, err);
      }
    }),
  );

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
