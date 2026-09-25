const { errorBody } = require('../errors');

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
 * Creates a Token Bucket rate limiter middleware backed by Redis.
 * @param {Object} redisClient - IORedis or Redis client instance.
 * @param {Object} options - Configuration options.
 * @param {number} options.capacity - Maximum tokens in the bucket (e.g. max requests).
 * @param {number} options.refillRate - Tokens refilled per second.
 * @param {function} options.keyGenerator - Function(req) that returns the key (IP or user ID).
 * @param {string} options.prefix - Redis key prefix.
 * @param {function} options.skip - Function(req) that returns true if the request should be skipped.
 */
const createTokenBucketLimiter = (redisClient, options = {}) => {
  const {
    capacity = 100,
    refillRate = 1, // 1 request per second refill
    prefix = 'tb-rl:',
    keyGenerator = (req) => req.ip || req.connection?.remoteAddress || '',
    skip = () => false,
  } = options;

  return async (req, res, next) => {
    if (skip(req)) {
      return next();
    }

    if (!redisClient) {
      // Fallback if redis is not available
      return next();
    }

    try {
      const id = keyGenerator(req);
      if (!id) return next();

      const key = \`\${prefix}\${id}\`;
      const now = Math.floor(Date.now() / 1000); // Current time in seconds
      const requested = 1;

      // Evaluate Lua script
      let result;
      if (typeof redisClient.eval === 'function') {
        result = await redisClient.eval(TOKEN_BUCKET_LUA, 1, key, capacity, refillRate, now, requested);
      } else if (typeof redisClient.sendCommand === 'function') {
        // Fallback for redis v4 if it doesn't support eval directly the same way
        result = await redisClient.sendCommand(['EVAL', TOKEN_BUCKET_LUA, '1', key, String(capacity), String(refillRate), String(now), String(requested)]);
      }
      
      if (!result) return next();

      const [allowed, remainingTokens, maxCapacity, lastRefill] = result;
      const resetTime = Math.ceil((maxCapacity - remainingTokens) / refillRate) + now;

      res.setHeader('X-RateLimit-Limit', maxCapacity);
      res.setHeader('X-RateLimit-Remaining', remainingTokens);
      res.setHeader('X-RateLimit-Reset', resetTime);

      if (allowed === 1) {
        return next();
      } else {
        res.setHeader('Retry-After', Math.ceil(1 / refillRate));
        return res.status(429).json(
          errorBody('RATE_LIMITED', 'Too many requests, please try again later.', { correlationId: req.correlationId })
        );
      }
    } catch (err) {
      // On error, let the request pass through to avoid blocking legitimate traffic
      req.log?.error(err, 'Token bucket rate limiter failed');
      return next();
    }
  };
};

module.exports = { createTokenBucketLimiter };
