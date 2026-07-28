const crypto = require('crypto');
const { logger } = require('../src/logger');

const IDEMPOTENCY_HEADER = 'X-Idempotency-Key';
const CACHE_EXPIRATION_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * Idempotency Middleware Factory
 * 
 * If an X-Idempotency-Key header is provided, this middleware:
 * 1. Checks Redis (or an in-memory Map fallback) for a cached response.
 * 2. Returns the cached response immediately if found.
 * 3. Otherwise, intercepts res.json() to save successful responses (2xx) for future identical requests.
 * 
 * @param {import('redis').RedisClientType | null} redisClient 
 */
const idempotencyMiddleware = (redisClient) => {
  // Fallback memory cache if redis is not available
  const memoryCache = new Map();

  return async (req, res, next) => {
    // 1. Only process POST requests (or ones that modify state)
    if (req.method !== 'POST') {
      return next();
    }

    const idempotencyKey = req.get(IDEMPOTENCY_HEADER);
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return next();
    }

    // 2. Validate the key (basic length check to prevent massive keys)
    const key = idempotencyKey.trim();
    if (!key || key.length > 128) {
      return res.status(400).json({ error: 'Invalid or too long X-Idempotency-Key' });
    }

    // Include the path in the cache key to avoid collisions across different endpoints
    const cacheKey = `idempotency:${req.path}:${crypto.createHash('sha256').update(key).digest('hex')}`;

    try {
      // 3. Check for existing cached response
      if (redisClient && redisClient.isReady) {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          const { status, body } = JSON.parse(cached);
          res.setHeader('X-Idempotent-Replay', 'true');
          return res.status(status).json(body);
        }
      } else {
        const cached = memoryCache.get(cacheKey);
        if (cached) {
          // Check expiration for memory cache manually
          if (Date.now() > cached.expiresAt) {
            memoryCache.delete(cacheKey);
          } else {
            res.setHeader('X-Idempotent-Replay', 'true');
            return res.status(cached.status).json(cached.body);
          }
        }
      }
    } catch (err) {
      logger.error('Error reading idempotency key from cache:', err);
      // Fail open: proceed with request if cache is unavailable
    }

    // 4. Intercept the response
    const originalJson = res.json.bind(res);

    res.json = (body) => {
      // Only cache successful responses (2xx status codes)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const cacheData = {
          status: res.statusCode,
          body
        };

        try {
          if (redisClient && redisClient.isReady) {
            // Save to redis asynchronously
            redisClient.setEx(cacheKey, CACHE_EXPIRATION_SECONDS, JSON.stringify(cacheData)).catch((err) => {
              logger.error('Error saving idempotency key to redis:', err);
            });
          } else {
            memoryCache.set(cacheKey, {
              ...cacheData,
              expiresAt: Date.now() + CACHE_EXPIRATION_SECONDS * 1000
            });

            // Very basic memory cleanup to prevent memory leaks (probabilistic)
            if (memoryCache.size > 1000) {
              const now = Date.now();
              for (const [k, v] of memoryCache.entries()) {
                if (now > v.expiresAt) {
                  memoryCache.delete(k);
                }
              }
            }
          }
        } catch (err) {
          logger.error('Error saving idempotency key to cache:', err);
        }
      }

      // Restore original json method to prevent recursive loops if body modification happens
      res.json = originalJson;
      return originalJson(body);
    };

    next();
  };
};

module.exports = { idempotencyMiddleware, IDEMPOTENCY_HEADER };
