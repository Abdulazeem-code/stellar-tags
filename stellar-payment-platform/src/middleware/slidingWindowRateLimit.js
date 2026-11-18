const crypto = require("crypto");
const { ApiError } = require("../errors");

// One atomic operation removes expired requests, checks the current window,
// conditionally adds this request, and returns the oldest surviving timestamp.
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local maximum = tonumber(ARGV[3])
local member = ARGV[4]
local cutoff = now - window

redis.call("ZREMRANGEBYSCORE", key, 0, cutoff)
local count = redis.call("ZCARD", key)
local allowed = 0

if count < maximum then
  redis.call("ZADD", key, now, member)
  count = count + 1
  allowed = 1
end

local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
redis.call("PEXPIRE", key, window)

local oldest_timestamp = now
if oldest[2] then
  oldest_timestamp = tonumber(oldest[2])
end

return { allowed, count, oldest_timestamp }
`;

class MemorySlidingWindowStore {
  constructor({ maxKeys = 10_000 } = {}) {
    if (!Number.isInteger(maxKeys) || maxKeys <= 0) {
      throw new TypeError("maxKeys must be a positive integer");
    }
    this.maxKeys = maxKeys;
    this.requests = new Map();
  }

  async hit(key, now, windowMs, maximum) {
    const cutoff = now - windowMs;
    for (const [oldestKey, entry] of this.requests) {
      if (entry.expiresAt > now) break;
      this.requests.delete(oldestKey);
    }

    const previous = this.requests.get(key);
    const active = (previous?.timestamps || []).filter(
      (timestamp) => timestamp > cutoff,
    );
    const allowed = active.length < maximum;
    if (allowed && !previous && this.requests.size >= this.maxKeys) {
      return {
        allowed: false,
        count: maximum,
        resetAt: this.requests.values().next().value.expiresAt,
      };
    }

    if (allowed) {
      active.push(now);
      this.requests.delete(key);
      this.requests.set(key, { timestamps: active, expiresAt: now + windowMs });
    } else {
      this.requests.set(key, { timestamps: active, expiresAt: previous.expiresAt });
    }

    return {
      allowed,
      count: active.length,
      resetAt: active[0] + windowMs,
    };
  }
}

class RedisSlidingWindowStore {
  constructor(redisClient, prefix) {
    this.redisClient = redisClient;
    this.prefix = prefix;
  }

  async hit(key, now, windowMs, maximum) {
    const member = `${now}:${process.pid}:${crypto.randomUUID()}`;
    const result = await this.redisClient.eval(SLIDING_WINDOW_LUA, {
      keys: [`${this.prefix}${key}`],
      arguments: [
        String(now),
        String(windowMs),
        String(maximum),
        member,
      ],
    });
    const [allowed, count, oldestTimestamp] = result.map(Number);
    return {
      allowed: allowed === 1,
      count,
      resetAt: oldestTimestamp + windowMs,
    };
  }
}

const createSlidingWindowRateLimiter = ({
  redisClient = null,
  windowMs,
  max,
  prefix = "rl:",
  keyGenerator = (req) => req.ip || req.socket?.remoteAddress || "unknown",
  skip = () => false,
  message,
  now = () => Date.now(),
  memoryStore = new MemorySlidingWindowStore(),
  failClosedOnRedisError = false,
}) => {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError("windowMs must be a positive number");
  }
  if (!Number.isInteger(max) || max <= 0) {
    throw new TypeError("max must be a positive integer");
  }

  const redisStore = redisClient
    ? new RedisSlidingWindowStore(redisClient, prefix)
    : null;

  return async (req, res, next) => {
    try {
      if (await skip(req)) return next();

      const timestamp = now();
      const key = String(await keyGenerator(req));
      let result;
      if (redisStore) {
        try {
          result = await redisStore.hit(key, timestamp, windowMs, max);
        } catch (error) {
          if (failClosedOnRedisError) {
            throw new ApiError("SERVICE_UNAVAILABLE", "Rate limiting is unavailable", { cause: error });
          }
          result = await memoryStore.hit(key, timestamp, windowMs, max);
        }
      } else {
        result = await memoryStore.hit(key, timestamp, windowMs, max);
      }

      const remaining = Math.max(0, max - result.count);
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((result.resetAt - timestamp) / 1000),
      );
      res.setHeader("RateLimit-Limit", String(max));
      res.setHeader("RateLimit-Remaining", String(remaining));
      res.setHeader("RateLimit-Reset", String(retryAfterSeconds));

      if (!result.allowed) {
        res.setHeader("Retry-After", String(retryAfterSeconds));
        return res.status(429).json(message);
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
};

module.exports = {
  MemorySlidingWindowStore,
  RedisSlidingWindowStore,
  SLIDING_WINDOW_LUA,
  createSlidingWindowRateLimiter,
};
