import pino from 'pino';

// Simple pino configuration for the frontend
const logger = pino({
  level: import.meta.env.PROD ? 'info' : 'debug',
  browser: {
    asObject: true
  }
});

export default logger;
