const { logger } = require('./logger');

const APPROVED_ORIGINS_CACHE_TTL = 300;
const APPROVED_ORIGINS_CACHE_KEY = 'cors:approved-origins';

async function getCachedApprovedOrigins(redisClient, fetchFn) {
  if (redisClient && redisClient.isReady) {
    try {
      const cached = await redisClient.get(APPROVED_ORIGINS_CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      logger.error('Error reading approved origins cache from Redis:', err);
    }
  }

  const result = await fetchFn();

  if (result !== null && redisClient && redisClient.isReady) {
    redisClient.setEx(APPROVED_ORIGINS_CACHE_KEY, APPROVED_ORIGINS_CACHE_TTL, JSON.stringify(result))
      .catch((err) => logger.error('Error saving approved origins cache to Redis:', err));
  }

  return result;
}

module.exports = {
  APPROVED_ORIGINS_CACHE_TTL,
  APPROVED_ORIGINS_CACHE_KEY,
  getCachedApprovedOrigins,
};
