const { createSlidingWindowRateLimiter } = require('./slidingWindowRateLimit');

// Stricter secondary limit for endpoints that run signature verification
// (Horizon lookups + crypto). Keyed by IP so a single client cannot exhaust
// CPU by hammering these routes. Apply only to the heavy POST handlers.
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = Number(process.env.SIGNATURE_RATE_LIMIT_MAX) || 10;

const { errorBody } = require('../errors');

const createSignatureRateLimiter = (redisClient) =>
  createSlidingWindowRateLimiter({
    redisClient,
    windowMs: WINDOW_MS,
    max: MAX_REQUESTS,
    prefix: 'sig-rl:',
    keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
    message: errorBody("RATE_LIMITED", "Too many requests, please try again later."),
  });

module.exports = { createSignatureRateLimiter };
