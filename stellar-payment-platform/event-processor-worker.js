/**
 * Event Processor Worker
 * Background process for updating read models from event stream
 * Run this as a separate process: node event-processor-worker.js
 */

require("dotenv").config();
require("./src/utils/tracing");

const { logger } = require("./src/logger");
const { startEventProcessor } = require("./src/services/readModelUpdater");

logger.info("Starting Event Processor Worker");

// Start the event processor with 5 second polling interval
const POLLING_INTERVAL = process.env.EVENT_PROCESSOR_INTERVAL || 5000;

startEventProcessor(parseInt(POLLING_INTERVAL));

logger.info(
  { interval: POLLING_INTERVAL },
  "Event processor worker started successfully"
);

// Keep the process alive
process.on("SIGTERM", () => {
  logger.info("Received SIGTERM, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("Received SIGINT, shutting down gracefully");
  process.exit(0);
});
