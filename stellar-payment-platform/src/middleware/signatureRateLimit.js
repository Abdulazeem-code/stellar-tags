const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');

// Stricter secondary limit for endpoints that run signature verification
// (Horizon lookups + crypto). Keyed by IP so a single client cannot exhaust
// CPU by hammering these routes. Apply only to the heavy POST handlers.
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = Number(process.env.SIGNATURE_RATE_LIMIT_MAX) || 10;

const createSignatureRateLimiter = (redisClient) =>
  rateLimit({
    windowMs: WINDOW_MS,
    max: MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
    store: redisClient
      ? new RedisStore({
          prefix: 'sig-rl:',
          sendCommand: (...args) => redisClient.sendCommand(args),
        })
      : undefined,
    message: { error: 'Too many requests, please try again later.' },
  });

module.exports = { createSignatureRateLimiter };
