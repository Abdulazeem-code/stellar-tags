const IORedis = require('ioredis');

const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';

const createRedisConnection = () => {
  return new IORedis(process.env.REDIS_URL || DEFAULT_REDIS_URL, {
    // BullMQ workers require blocking Redis commands to wait indefinitely.
    maxRetriesPerRequest: null,
  });
};

module.exports = {
  createRedisConnection,
  DEFAULT_REDIS_URL,
};
