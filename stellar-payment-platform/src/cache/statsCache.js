'use strict';

const { logger } = require('../logger');

const STATS_CACHE_KEY = 'stats:admin:overview';
const STATS_CACHE_TTL = 300; // 5 minutes

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

module.exports = { getCachedStats, invalidateStatsCache, STATS_CACHE_KEY, STATS_CACHE_TTL };
