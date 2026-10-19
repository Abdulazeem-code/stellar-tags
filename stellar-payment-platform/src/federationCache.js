const { logger } = require('./logger');

const FEDERATION_CACHE_TTL = 300;
const FEDERATION_CACHE_PREFIX = 'federation';

function buildFederationCacheKey(type, value) {
  return `${FEDERATION_CACHE_PREFIX}:${type}:${value.toLowerCase()}`;
}

async function getCachedFederationResult(redisClient, cacheKey, fetchFn) {
  if (redisClient && redisClient.isReady) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      logger.error('Error reading federation cache from Redis:', err);
    }
  }

  const result = await fetchFn();

  if (result !== null && redisClient && redisClient.isReady) {
    redisClient.setEx(cacheKey, FEDERATION_CACHE_TTL, JSON.stringify(result))
      .catch((err) => logger.error('Error saving federation cache to Redis:', err));
  }

  return result;
}

async function invalidateFederationCache(redisClient, address, username) {
  if (!redisClient || !redisClient.isReady) return;

  const keys = [];
  if (address) keys.push(buildFederationCacheKey('id', address));
  if (username) keys.push(buildFederationCacheKey('name', username));

  if (keys.length > 0) {
    try {
      await redisClient.del(keys);
    } catch (err) {
      logger.error('Error invalidating federation cache:', err);
    }
  }
}

module.exports = {
  FEDERATION_CACHE_TTL,
  FEDERATION_CACHE_PREFIX,
  buildFederationCacheKey,
  getCachedFederationResult,
  invalidateFederationCache,
};
