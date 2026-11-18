'use strict';

const { logger } = require('../logger');

const STATS_CACHE_KEY = 'stats:admin:overview';
const STATS_CACHE_TTL = 300; // 5 minutes

const RATE_CACHE_TTL = 60; // 1 minute
const RATE_CACHE_PREFIX = 'rates:';

/**
 * Attempt to return a cached stats result from Redis.
 * On a cache miss, calls fetchFn(), stores the result in Redis (fire-and-forget),
 * and returns it. If Redis is unavailable or errors, falls through to fetchFn().
 *
 * @param {object|null} redisClient - Redis v4 client, or null if not configured.
 * @param {Function} fetchFn - Async function that returns fresh stats data.
 * @returns {Promise<object>} Stats payload.
 */
async function getCachedStats(redisClient, fetchFn) {
  if (redisClient?.isReady) {
    try {
      const cached = await redisClient.get(STATS_CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      logger.warn({ err }, 'Stats cache read failed, falling back to live query');
    }
  }

  const result = await fetchFn();

  if (redisClient?.isReady) {
    redisClient
      .setEx(STATS_CACHE_KEY, STATS_CACHE_TTL, JSON.stringify(result))
      .catch((err) => logger.warn({ err }, 'Stats cache write failed'));
  }

  return result;
}

/**
 * Delete the stats cache entry from Redis.
 * Logs and swallows any errors so callers are never disrupted.
 *
 * @param {object|null} redisClient - Redis v4 client, or null if not configured.
 */
async function invalidateStatsCache(redisClient) {
  if (!redisClient?.isReady) return;
  try {
    await redisClient.del([STATS_CACHE_KEY]);
  } catch (err) {
    logger.warn({ err }, 'Stats cache invalidation failed');
  }
}

/**
 * Builds the Redis key for an asset pair.
 *
 * @param {string} assetPair - Pair label such as `XLM:USD`.
 * @returns {string} Cache key under `rates:<asset_pair>`.
 */
function rateCacheKey(assetPair) {
  return `${RATE_CACHE_PREFIX}${String(assetPair).trim().toUpperCase()}`;
}

/**
 * Return a cached exchange rate, fetching it on a miss.
 *
 * The primary feed is tried first; a failure falls back to the secondary feed.
 * Redis is updated asynchronously so callers never wait on the cache write.
 * Redis errors are logged and the live feed result is returned.
 *
 * @param {object|null} redisClient - Redis v4 client, or null if not configured.
 * @param {string} assetPair - Pair label such as `XLM:USD`.
 * @param {object} feeds
 * @param {Function} feeds.primary - Async primary rate lookup.
 * @param {Function} feeds.secondary - Async fallback rate lookup.
 * @param {number} [feeds.ttl=RATE_CACHE_TTL] - Cache TTL in seconds.
 * @returns {Promise<*>} Cached or freshly fetched rate payload.
 */
async function getCachedExchangeRate(redisClient, assetPair, feeds = {}) {
  if (typeof feeds.primary !== 'function') {
    throw new TypeError('primary rate feed is required');
  }

  const key = rateCacheKey(assetPair);
  if (redisClient?.isReady) {
    try {
      const cached = await redisClient.get(key);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      logger.warn({ err, key }, 'Rate cache read failed, falling back to live feed');
    }
  }

  let rate;
  try {
    rate = await feeds.primary(assetPair);
  } catch (primaryError) {
    if (typeof feeds.secondary !== 'function') throw primaryError;
    logger.warn({ err: primaryError, assetPair }, 'Primary rate feed failed, trying fallback');
    rate = await feeds.secondary(assetPair);
  }

  if (redisClient?.isReady) {
    const ttl = Number(feeds.ttl) > 0 ? Number(feeds.ttl) : RATE_CACHE_TTL;
    redisClient
      .setEx(key, ttl, JSON.stringify(rate))
      .catch((err) => logger.warn({ err, key }, 'Rate cache write failed'));
  }

  return rate;
}

module.exports = {
  getCachedStats,
  invalidateStatsCache,
  getCachedExchangeRate,
  rateCacheKey,
  STATS_CACHE_KEY,
  STATS_CACHE_TTL,
  RATE_CACHE_TTL,
  RATE_CACHE_PREFIX,
};
