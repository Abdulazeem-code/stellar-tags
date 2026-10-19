/**
 * Read Model Updater Service
 * Asynchronously updates read models from event stream
 * Implements eventual consistency pattern
 */

const { prisma } = require("../../prismaClient");
const { logger } = require("../logger");
const {
  PaymentEventTypes,
  getEventsSince,
  updateCheckpoint,
  getCheckpoint,
  applyEvent,
} = require("./eventStore");

const CONSUMER_NAME = "payment-read-model-updater";
const BATCH_SIZE = 50;

/**
 * Process new events and update read models
 * @returns {Promise<number>} Number of events processed
 */
async function processNewEvents() {
  try {
    // Get last checkpoint
    const checkpoint = await getCheckpoint(CONSUMER_NAME);
    const lastSequence = checkpoint ? checkpoint.lastSequence : 0;

    // Fetch new events since last checkpoint
    const events = await getEventsSince(lastSequence, BATCH_SIZE);

    if (events.length === 0) {
      logger.debug("No new events to process");
      return 0;
    }

    logger.info({ eventCount: events.length }, "Processing new events for read model");

    // Process each event
    for (const event of events) {
      await updateReadModelFromEvent(event);

      // Update checkpoint after each event (at-least-once delivery)
      await updateCheckpoint(
        CONSUMER_NAME,
        event.id,
        event.sequence,
        event.timestamp
      );
    }

    logger.info(
      { processedCount: events.length },
      "Successfully updated read models"
    );

    return events.length;
  } catch (error) {
    logger.error({ error }, "Failed to process events for read model");
    throw error;
  }
}

/**
 * Update or create read model from a single event
 * @param {Object} event - Payment event
 */
async function updateReadModelFromEvent(event) {
  const { aggregateId, eventType, eventData, timestamp } = event;

  try {
    // Get current read model or initialize new one
    let readModel = await prisma.paymentReadModel.findUnique({
      where: { id: aggregateId },
    });

    switch (eventType) {
      case PaymentEventTypes.PAYMENT_CREATED:
        if (!readModel) {
          // Create new read model
          await prisma.paymentReadModel.create({
            data: {
              id: aggregateId,
              currentState: "created",
              fromAddress: eventData.fromAddress,
              toAddress: eventData.toAddress,
              amount: eventData.amount,
              fee: eventData.fee || 0,
              assetCode: eventData.assetCode,
              riskScore: eventData.riskScore,
              fraudStatus: "clear",
              createdAt: timestamp,
              lastEventSeq: event.sequence,
            },
          });
          logger.debug({ aggregateId }, "Created new read model");
        }
        break;

      case PaymentEventTypes.PAYMENT_ROUTED:
        if (readModel) {
          await prisma.paymentReadModel.update({
            where: { id: aggregateId, version: readModel.version },
            data: {
              currentState: "routed",
              transactionHash: eventData.transactionHash,
              lastEventSeq: event.sequence,
              version: { increment: 1 },
            },
          });
          logger.debug({ aggregateId }, "Updated read model: routed");
        }
        break;

      case PaymentEventTypes.PAYMENT_COMPLETED:
        if (readModel) {
          await prisma.paymentReadModel.update({
            where: { id: aggregateId, version: readModel.version },
            data: {
              currentState: "completed",
              lastEventSeq: event.sequence,
              version: { increment: 1 },
            },
          });
          logger.debug({ aggregateId }, "Updated read model: completed");
        }
        break;

      case PaymentEventTypes.PAYMENT_FAILED:
        if (readModel) {
          await prisma.paymentReadModel.update({
            where: { id: aggregateId, version: readModel.version },
            data: {
              currentState: "failed",
              lastEventSeq: event.sequence,
              version: { increment: 1 },
            },
          });
          logger.debug({ aggregateId }, "Updated read model: failed");
        }
        break;

      case PaymentEventTypes.PAYMENT_FLAGGED_FRAUD:
        if (readModel) {
          await prisma.paymentReadModel.update({
            where: { id: aggregateId, version: readModel.version },
            data: {
              fraudStatus: "flagged",
              riskScore: eventData.riskScore,
              lastEventSeq: event.sequence,
              version: { increment: 1 },
            },
          });
          logger.debug({ aggregateId }, "Updated read model: fraud flagged");
        }
        break;

      case PaymentEventTypes.PAYMENT_CLEARED_FRAUD:
        if (readModel) {
          await prisma.paymentReadModel.update({
            where: { id: aggregateId, version: readModel.version },
            data: {
              fraudStatus: "cleared",
              lastEventSeq: event.sequence,
              version: { increment: 1 },
            },
          });
          logger.debug({ aggregateId }, "Updated read model: fraud cleared");
        }
        break;

      default:
        logger.warn({ eventType }, "Unknown event type in read model updater");
    }
  } catch (error) {
    // Handle optimistic locking conflict
    if (error.code === "P2025") {
      logger.warn(
        { aggregateId, eventType },
        "Optimistic locking conflict, event may have been processed"
      );
    } else {
      logger.error(
        { error, aggregateId, eventType },
        "Failed to update read model"
      );
      throw error;
    }
  }
}

/**
 * Rebuild all read models from event stream (for recovery/migration)
 * @returns {Promise<number>} Number of read models rebuilt
 */
async function rebuildAllReadModels() {
  logger.info("Starting full read model rebuild");

  try {
    // Clear existing read models
    await prisma.paymentReadModel.deleteMany({});

    // Get all payment aggregates
    const aggregates = await prisma.paymentEvent.groupBy({
      by: ["aggregateId"],
    });

    logger.info({ count: aggregates.length }, "Rebuilding read models");

    let rebuilt = 0;
    for (const { aggregateId } of aggregates) {
      const events = await prisma.paymentEvent.findMany({
        where: { aggregateId },
        orderBy: { sequence: "asc" },
      });

      // Rebuild state from events
      let state = {
        id: aggregateId,
        currentState: "unknown",
        lastEventSeq: 0,
        version: 1,
      };

      for (const event of events) {
        const appliedState = applyEvent(state, event);
        state = {
          ...state,
          ...appliedState,
          lastEventSeq: event.sequence,
        };
      }

      // Create read model with final state
      if (state.currentState !== "unknown") {
        await prisma.paymentReadModel.create({
          data: {
            id: state.id,
            currentState: state.status || state.currentState,
            fromAddress: state.fromAddress,
            toAddress: state.toAddress,
            amount: state.amount || 0,
            fee: state.fee || 0,
            assetCode: state.assetCode,
            transactionHash: state.transactionHash,
            riskScore: state.riskScore,
            fraudStatus: state.fraudStatus || "clear",
            createdAt: state.createdAt || new Date(),
            lastEventSeq: state.lastEventSeq,
            version: 1,
          },
        });
        rebuilt++;
      }
    }

    logger.info({ rebuilt }, "Read model rebuild complete");
    return rebuilt;
  } catch (error) {
    logger.error({ error }, "Failed to rebuild read models");
    throw error;
  }
}

/**
 * Start continuous event processing (can be run as a background worker)
 * @param {number} intervalMs - Polling interval in milliseconds
 */
function startEventProcessor(intervalMs = 5000) {
  logger.info({ intervalMs }, "Starting read model event processor");

  const processInterval = setInterval(async () => {
    try {
      await processNewEvents();
    } catch (error) {
      logger.error({ error }, "Event processor error");
    }
  }, intervalMs);

  // Cleanup handler
  process.on("SIGINT", () => {
    logger.info("Stopping event processor");
    clearInterval(processInterval);
    process.exit(0);
  });

  return processInterval;
}

module.exports = {
  processNewEvents,
  updateReadModelFromEvent,
  rebuildAllReadModels,
  startEventProcessor,
};
