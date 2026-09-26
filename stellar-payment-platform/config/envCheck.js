'use strict';

const { logger } = require('../src/logger');

const REQUIRED_ENV_VARS = ['PORT'];

for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    if (process.env.NODE_ENV !== 'test') {
      logger.error(`[env] Missing required environment variable: ${key}`);
      process.exit(1);
    }
  }
}
