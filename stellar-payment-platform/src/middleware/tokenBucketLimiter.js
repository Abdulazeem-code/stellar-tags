const { ApiError, errorBody } = require('../errors');

const TOKEN_BUCKET_LUA = `
  local key = KEYS[1]
  local capacity = tonumber(ARGV[1])
  local refillRate = tonumber(ARGV[2])
  local now = tonumber(ARGV[3])
  local requested = tonumber(ARGV[4])
  
  local bucket = redis.call('HMGET', key, 'tokens', 'lastRefill')
  local tokens = tonumber(bucket[1])
  local lastRefill = tonumber(bucket[2])
  
  if not tokens or not lastRefill then
    tokens = capacity
    lastRefill = now
  end
  
  local timePassed = math.max(0, now - lastRefill)
  local refillAmount = math.floor(timePassed * refillRate)
  
  if refillAmount > 0 then
    tokens = math.min(capacity, tokens + refillAmount)
    lastRefill = now
  end
  
  local allowed = 0
  if tokens >= requested then
    tokens = tokens - requested
    allowed = 1
  end
  
  redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', lastRefill)
  local ttl = math.ceil(capacity / refillRate) + 10
  redis.call('EXPIRE', key, ttl)
  
  return {allowed, tokens, capacity, lastRefill}
`;

/**
 * In-memory fallback for token bucket rate limiting when Redis is not configured
 * or temporarily unreachable.
 */
class MemoryTokenBucketStore {
  constructor(maxKeys = 10000) {
    this.buckets = new Map();
    this.maxKeys = maxKeys;
  }

  consume(key, capacity, refillRate, now, requested = 1) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now };
    } else {
      const timePassed = Math.max(0, now - bucket.lastRefill);
      const refillAmount = timePassed * refillRate;
      if (refillAmount > 0) {
        bucket.tokens = Math.min(capacity, bucket.tokens + refillAmount);
        bucket.lastRefill = now;
      }
    }

    let allowed = 0;
    if (bucket.tokens >= requested) {
      bucket.tokens -= requested;
      allowed = 1;
    }

    if (this.buckets.size >= this.maxKeys && !this.buckets.has(key)) {
      const oldestKey = this.buckets.keys().next().value;
      this.buckets.delete(oldestKey);
    }
    this.buckets.set(key, bucket);

    return [allowed, Math.floor(bucket.tokens), capacity, bucket.lastRefill];
  }
}

/**
 * Creates a Token Bucket rate limiter middleware backed by Redis with in-memory fallback.
 * @param {Object} redisClient - IORedis or Redis client instance.
 * @param {Object} options - Configuration options.
 * @param {number} options.capacity - Maximum tokens in the bucket (e.g. max requests).
 * @param {number} options.refillRate - Tokens refilled per second.
 * @param {function} options.keyGenerator - Function(req) that returns the key (IP or user ID).
 * @param {string} options.prefix - Redis key prefix.
 * @param {function} options.skip - Function(req) that returns true if the request should be skipped.
 * @param {boolean} options.failClosedOnRedisError - Whether to reject requests if configured Redis fails.
 * @param {MemoryTokenBucketStore} [options.memoryStore] - In-memory store fallback.
 */
const createTokenBucketLimiter = (redisClient, options = {}) => {
  const {
    capacity = 100,
    refillRate = 1, // 1 request per second refill
    prefix = 'tb-rl:',
    keyGenerator = (req) => req.ip || req.connection?.remoteAddress || '',
    skip = () => false,
    failClosedOnRedisError = false,
    memoryStore = new MemoryTokenBucketStore(),
    message,
  } = options;

  return async (req, res, next) => {
    if (skip(req)) {
      return next();
    }

    const id = keyGenerator(req);
    if (!id) return next();

    const key = `${prefix}${id}`;
    const now = Math.floor(Date.now() / 1000); // Current time in seconds
    const requested = 1;

    let result;
    if (redisClient) {
      try {
        if (typeof redisClient.eval === 'function') {
          result = await redisClient.eval(TOKEN_BUCKET_LUA, 1, key, capacity, refillRate, now, requested);
        } else if (typeof redisClient.sendCommand === 'function') {
          result = await redisClient.sendCommand(['EVAL', TOKEN_BUCKET_LUA, '1', key, String(capacity), String(refillRate), String(now), String(requested)]);
        }
      } catch (err) {
        req.log?.error(err, 'Token bucket rate limiter failed');
        if (failClosedOnRedisError) {
          return next(new ApiError('SERVICE_UNAVAILABLE', 'Rate limiting is unavailable', { cause: err }));
        }
        result = memoryStore.consume(key, capacity, refillRate, now, requested);
      }
    } else {
      result = memoryStore.consume(key, capacity, refillRate, now, requested);
    }

    if (!result) return next();

    const [allowed, remainingTokens, maxCapacity] = result;
    const resetTime = Math.ceil((maxCapacity - remainingTokens) / refillRate) + now;

    res.setHeader('X-RateLimit-Limit', maxCapacity);
    res.setHeader('X-RateLimit-Remaining', remainingTokens);
    res.setHeader('X-RateLimit-Reset', resetTime);

    if (allowed === 1) {
      return next();
    } else {
      res.setHeader('Retry-After', Math.ceil(1 / refillRate));
      const payload = message || errorBody('RATE_LIMITED', 'Too many requests, please try again later.', { correlationId: req.correlationId });
      return res.status(429).json(payload);
    }
  };
};

module.exports = { createTokenBucketLimiter, MemoryTokenBucketStore };

