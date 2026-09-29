const pino = require('pino');
const pinoHttp = require('pino-http');

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

const redactSensitive = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactSensitive);
  const clone = { ...obj };
  const sensitiveFields = ['signature', 'secret', 'x-api-key', 'authorization'];
  
  for (const key of Object.keys(clone)) {
    if (sensitiveFields.includes(key.toLowerCase())) {
      clone[key] = '[REDACTED]';
    } else if (typeof clone[key] === 'object' && clone[key] !== null) {
      clone[key] = redactSensitive(clone[key]);
    }
  }
  return clone;
};

const httpLogger = pinoHttp({
  logger,
  autoLogging: true,
  serializers: {
    req: (req) => {
      const serialized = {
        method: req.method,
        path: req.url,
      };
      
      if (req.raw && req.raw.headers) {
        serialized.headers = redactSensitive(req.raw.headers);
      } else if (req.headers) {
        serialized.headers = redactSensitive(req.headers);
      }

      if (req.raw && req.raw.body) {
        serialized.body = redactSensitive(req.raw.body);
      }
      
      return serialized;
    },
    res: (res) => ({
      status: res.statusCode,
    })
  }
});

module.exports = { logger, httpLogger };
