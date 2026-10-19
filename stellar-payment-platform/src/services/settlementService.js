'use strict';

const { OutboxEngine } = require('../settlement/outboxEngine');
const { logger } = require('../logger');

/**
 * Feature 27: Settlement Service
 *
 * Provides a managed singleton instance of the OutboxEngine with configurable
 * Redis cluster support and Prisma persistence integration.
 */

let engineInstance = null;

/**
 * Initializes or returns the OutboxEngine singleton.
 * @param {object} [redisClient]
 * @param {object} [options]
 * @returns {OutboxEngine}
 */
function getSettlementEngine(redisClient = null, options = {}) {
  if (!engineInstance) {
    const numShards = parseInt(process.env.SETTLEMENT_SHARDS || '8', 10);
    const batchSize = parseInt(process.env.SETTLEMENT_BATCH_SIZE || '50', 10);
    const maxRetries = parseInt(process.env.SETTLEMENT_MAX_RETRIES || '5', 10);

    engineInstance = new OutboxEngine({
      numShards,
      batchSize,
      maxRetries,
      redisClient,
      logger,
      ...options,
    });
  }
  return engineInstance;
}

/**
 * Resets the engine instance (primarily for testing).
 */
function resetSettlementEngine() {
  if (engineInstance) {
    engineInstance.reset();
  }
  engineInstance = null;
}

module.exports = {
  getSettlementEngine,
  resetSettlementEngine,
};
