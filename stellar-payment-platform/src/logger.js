const pino = require('pino');

const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
const IS_TEST = process.env.NODE_ENV === 'test';

const logger = pino({
  level: IS_TEST ? 'silent' : LOG_LEVEL,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
});

module.exports = { logger };
