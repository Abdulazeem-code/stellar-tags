'use strict';

const crypto = require('crypto');
const { logger } = require('../src/logger');
const { ApiError } = require('../src/errors');

const IDEMPOTENCY_HEADER = 'Idempotency-Key';
const CACHE_EXPIRATION_SECONDS = 24 * 60 * 60;
const PENDING_EXPIRATION_SECONDS = 5 * 60;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

const requestFingerprint = (req) => digest(JSON.stringify([
  req.originalUrl,
  req.body,
  req.get('authorization') || '',
  req.get('x-api-key') || '',
  req.get('cookie') || '',
]));

const releaseScript = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

const completeScript = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  end
  return 0
`;

const idempotencyMiddleware = (redisClient, options = {}) => {
  const memoryCache = new Map();

  return async (req, res, next) => {
    if (!MUTATING_METHODS.has(req.method)) return next();

    const rawKey = req.get(IDEMPOTENCY_HEADER);
    if (!rawKey) {
      if (options.enforce) {
        return next(new ApiError('INVALID_INPUT', `Missing required header: ${IDEMPOTENCY_HEADER}`));
      }
      return next();
    }

    const key = rawKey.trim();
    if (!key || key.length > 128) {
      return next(new ApiError('INVALID_INPUT', 'Invalid or too long Idempotency-Key'));
    }

    const cacheKey = `idempotency:${req.method}:${req.path}:${digest(key)}`;
    const fingerprint = requestFingerprint(req);
    const pending = JSON.stringify({ state: 'pending', fingerprint, token: crypto.randomUUID() });
    const usesRedis = Boolean(redisClient);
    let existing;

    try {
      if (usesRedis) {
        if (!redisClient.isReady) throw new Error('Redis is unavailable');
        const claimed = await redisClient.set(cacheKey, pending, {
          NX: true,
          EX: PENDING_EXPIRATION_SECONDS,
        });
        if (!claimed) {
          const stored = await redisClient.get(cacheKey);
          if (!stored) throw new Error('Idempotency claim disappeared');
          existing = JSON.parse(stored);
        }
      } else {
        const saved = memoryCache.get(cacheKey);
        if (saved && saved.expiresAt > Date.now()) existing = saved.record;
        else memoryCache.delete(cacheKey);
        if (!existing) {
          if (memoryCache.size >= 1000) {
            for (const [storedKey, value] of memoryCache) {
              if (value.expiresAt <= Date.now()) memoryCache.delete(storedKey);
            }
          }
          if (memoryCache.size >= 1000) {
            return next(new ApiError('SERVICE_UNAVAILABLE', 'Idempotency cache is full'));
          }
          memoryCache.set(cacheKey, {
            record: JSON.parse(pending),
            expiresAt: Date.now() + PENDING_EXPIRATION_SECONDS * 1000,
          });
        }
      }
    } catch (err) {
      logger.error('Failed to claim idempotency key:', err);
      return next(new ApiError('SERVICE_UNAVAILABLE', 'Idempotency protection is unavailable'));
    }

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return next(new ApiError('CONFLICT', 'Idempotency-Key was used for a different request'));
      }
      if (existing.state === 'pending') {
        return next(new ApiError('CONFLICT', 'Request with this Idempotency-Key is still processing'));
      }
      if (existing.state === 'complete') {
        res.setHeader('X-Idempotent-Replay', 'true');
        if (existing.contentType) res.setHeader('Content-Type', existing.contentType);
        return res.status(existing.status).send(existing.body);
      }
      return next(new ApiError('SERVICE_UNAVAILABLE', 'Invalid idempotency record'));
    }

    const release = async () => {
      if (usesRedis) {
        await redisClient.eval(releaseScript, { keys: [cacheKey], arguments: [pending] });
      } else if (JSON.stringify(memoryCache.get(cacheKey)?.record) === pending) {
        memoryCache.delete(cacheKey);
      }
    };

    const complete = async (status, body, contentType) => {
      const record = { state: 'complete', fingerprint, status, body, contentType };
      if (usesRedis) {
        const saved = await redisClient.eval(completeScript, {
          keys: [cacheKey],
          arguments: [pending, JSON.stringify(record), String(CACHE_EXPIRATION_SECONDS)],
        });
        if (!saved) throw new Error('Idempotency claim expired before completion');
      } else {
        if (JSON.stringify(memoryCache.get(cacheKey)?.record) !== pending) {
          throw new Error('Idempotency claim expired before completion');
        }
        memoryCache.set(cacheKey, {
          record,
          expiresAt: Date.now() + CACHE_EXPIRATION_SECONDS * 1000,
        });
      }
    };

    const originalSend = res.send.bind(res);
    let settled = false;
    res.send = (body) => {
      settled = true;
      res.send = originalSend;

      if (res.statusCode >= 200 && res.statusCode < 300) {
        complete(res.statusCode, body, res.getHeader('Content-Type'))
          .then(() => originalSend(body))
          .catch((err) => {
            logger.error('Failed to save idempotency response:', err);
            next(new ApiError('SERVICE_UNAVAILABLE', 'Idempotency protection is unavailable'));
          });
      } else {
        release()
          .catch((err) => logger.error('Failed to release idempotency key:', err))
          .finally(() => originalSend(body));
      }
      return res;
    };

    res.once('close', () => {
      if (!settled) release().catch((err) => logger.error('Failed to release idempotency key:', err));
    });

    next();
  };
};

module.exports = { idempotencyMiddleware, IDEMPOTENCY_HEADER };
