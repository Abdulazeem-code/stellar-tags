const { createTokenBucketLimiter } = require('./tokenBucketLimiter');

// Stricter secondary limit for endpoints that run signature verification
// (Horizon lookups + crypto). Keyed by IP so a single client cannot exhaust
// CPU by hammering these routes. Apply only to the heavy POST handlers.
const MAX_REQUESTS = Number(process.env.SIGNATURE_RATE_LIMIT_MAX) || 10;
const REFILL_RATE = MAX_REQUESTS / 60; // Refill max requests per minute

const createSignatureRateLimiter = (redisClient) =>
  createTokenBucketLimiter(redisClient, {
    capacity: MAX_REQUESTS,
    refillRate: REFILL_RATE,
    prefix: 'sig-rl:',
    keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
  });

module.exports = { createSignatureRateLimiter };
