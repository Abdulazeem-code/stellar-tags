'use strict';

const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { logger } = require('../logger');
const { ApiError } = require('../errors');

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

// Lua script to safely release lock only if the token/payload matches the holder
const releaseScript = `
  local val = redis.call('GET', KEYS[1])
  if not val then
    return 0
  end
  if val == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  local ok, decoded = pcall(cjson.decode, val)
  if ok and type(decoded) == 'table' and decoded.token == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

// Lua script to safely complete record only if lock is held by the same token/payload
const completeScript = `
  local val = redis.call('GET', KEYS[1])
  if not val then
    return 0
  end
  if val == ARGV[1] then
    return redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  end
  local ok, decoded = pcall(cjson.decode, val)
  if ok and type(decoded) == 'table' and decoded.token == ARGV[1] then
    return redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  end
  return 0
`;

const extractClients = (redisClient, options = {}) => {
  if (options.clients && Array.isArray(options.clients)) {
    return options.clients.filter(Boolean);
  }
  if (!redisClient) return [];
  if (Array.isArray(redisClient)) {
    return redisClient.filter(Boolean);
  }
  if (typeof redisClient.nodes === 'function') {
    const nodes = redisClient.nodes('master');
    if (Array.isArray(nodes) && nodes.length > 0) return nodes;
  }
  return [redisClient];
};

async function evalLua(client, script, keys, args) {
  if (typeof client.call === 'function' && typeof client.defineCommand === 'function') {
    return await client.eval(script, keys.length, ...keys, ...args);
  }
  try {
    return await client.eval(script, { keys, arguments: args });
  } catch (err) {
    if (err instanceof TypeError || String(err).includes('arguments')) {
      return await client.eval(script, keys.length, ...keys, ...args);
    }
    throw err;
  }
}

async function acquireInstanceLock(client, key, value, ttlMs) {
  try {
    if (client.isReady === false) return false;
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    if (typeof client.call === 'function' && typeof client.defineCommand === 'function') {
      const res = await client.set(key, value, 'PX', ttlMs, 'NX');
      return res === 'OK' || res === true;
    }
    const res = await client.set(key, value, {
      NX: true,
      PX: ttlMs,
      EX: ttlSeconds,
    });
    return res === 'OK' || res === true;
  } catch (err) {
    return false;
  }
}

async function getInstanceRecord(client, key) {
  try {
    if (client.isReady === false) return null;
    const val = await client.get(key);
    return val || null;
  } catch (err) {
    return null;
  }
}

async function acquireRedlock(clients, lockKey, lockValue, ttlMs, options = {}) {
  const quorum = Math.floor(clients.length / 2) + 1;
  const retryCount = options.retryCount !== undefined ? options.retryCount : 10;
  const retryDelay = options.retryDelay !== undefined ? options.retryDelay : 30;
  const retryJitter = options.retryJitter !== undefined ? options.retryJitter : 30;
  const clockDriftFactor = 0.01;
  const driftMs = Math.round(clockDriftFactor * ttlMs) + 2;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    const startTime = performance.now();
    let successCount = 0;
    const lockedClients = [];

    const lockPromises = clients.map(async (client) => {
      const ok = await acquireInstanceLock(client, lockKey, lockValue, ttlMs);
      if (ok) {
        successCount++;
        lockedClients.push(client);
      }
    });
    await Promise.all(lockPromises);

    const elapsed = performance.now() - startTime;
    const validityTime = ttlMs - elapsed - driftMs;

    if (successCount >= quorum && validityTime > 0) {
      return { acquired: true, validityTime };
    }

    // Lock failed: release partially acquired instances
    await Promise.all(
      lockedClients.map((client) =>
        evalLua(client, releaseScript, [lockKey], [lockValue]).catch(() => {})
      )
    );

    // If retries remain, check if existing record is completed before backing off
    if (attempt < retryCount) {
      const checkStored = await Promise.all(
        clients.map((c) => getInstanceRecord(c, lockKey))
      );
      const stored = checkStored.find(Boolean);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (parsed.state === 'complete') {
            return { acquired: false, existing: parsed };
          }
        } catch (_) {}
      }

      const jitter = Math.floor(Math.random() * retryJitter);
      const delay = retryDelay + jitter;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Final check for existing record
  const checkStored = await Promise.all(
    clients.map((c) => getInstanceRecord(c, lockKey))
  );
  const stored = checkStored.find(Boolean);
  let existing = null;
  if (stored) {
    try {
      existing = JSON.parse(stored);
    } catch (_) {}
  }

  return { acquired: false, existing };
}

const idempotencyMiddleware = (redisClient, options = {}) => {
  const memoryCache = new Map();
  const clients = extractClients(redisClient, options);
  const usesRedis = clients.length > 0;
  const quorum = usesRedis ? Math.floor(clients.length / 2) + 1 : 1;

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
    const token = crypto.randomUUID();
    const pending = JSON.stringify({ state: 'pending', fingerprint, token });
    let existing;

    try {
      if (usesRedis) {
        // Fail-fast if any single client explicitly indicates unavailable
        const anyReady = clients.some((c) => c.isReady !== false);
        if (!anyReady) throw new Error('Redis is unavailable');

        const ttlMs = PENDING_EXPIRATION_SECONDS * 1000;
        const result = await acquireRedlock(clients, cacheKey, pending, ttlMs, options);

        if (!result.acquired) {
          existing = result.existing;
          if (!existing) {
            throw new Error('Idempotency claim disappeared');
          }
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
        await Promise.all(
          clients.map((c) =>
            evalLua(c, releaseScript, [cacheKey], [pending]).catch((err) => {
              logger.error('Failed to release idempotency key:', err);
              throw err;
            }),
          ),
        );
      } else if (JSON.stringify(memoryCache.get(cacheKey)?.record) === pending) {
        memoryCache.delete(cacheKey);
      }
    };

    const complete = async (status, body, contentType) => {
      const record = { state: 'complete', fingerprint, status, body, contentType };
      if (usesRedis) {
        const results = await Promise.all(
          clients.map((c) =>
            evalLua(c, completeScript, [cacheKey], [
              pending,
              JSON.stringify(record),
              String(CACHE_EXPIRATION_SECONDS),
            ]),
          ),
        );
        const successes = results.filter((saved) => saved === 1 || saved === 'OK').length;
        if (successes < quorum) {
          throw new Error('Idempotency claim expired before completion');
        }
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
