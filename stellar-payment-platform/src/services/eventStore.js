/**
 * Event Store Service
 * Implements Event Sourcing pattern for payment events
 * Provides append-only event stream with optimistic concurrency control
 */

const { prisma } = require("../../prismaClient");
const { logger } = require("../logger");

/**
 * Payment Event Types
 */
const PaymentEventTypes = {
  PAYMENT_CREATED: "PAYMENT_CREATED",
  PAYMENT_VALIDATED: "PAYMENT_VALIDATED",
  PAYMENT_ROUTED: "PAYMENT_ROUTED",
  PAYMENT_COMPLETED: "PAYMENT_COMPLETED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  PAYMENT_REFUNDED: "PAYMENT_REFUNDED",
  PAYMENT_FLAGGED_FRAUD: "PAYMENT_FLAGGED_FRAUD",
  PAYMENT_CLEARED_FRAUD: "PAYMENT_CLEARED_FRAUD",
};

/**
 * Append an event to the event store
 * @param {Object} eventData
 * @param {string} eventData.paymentId - Payment identifier
 * @param {string} eventData.eventType - Type of event
 * @param {Object} eventData.data - Event payload
 * @param {Object} eventData.metadata - Additional metadata
 * @param {string} eventData.userId - User who triggered the event
 * @returns {Promise<Object>} The created event
 */
async function appendEvent({ paymentId, eventType, data, metadata = {}, userId = null }) {
  try {
    // Get the next sequence number for this aggregate
    const lastEvent = await prisma.paymentEvent.findFirst({
      where: { aggregateId: paymentId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });

    const nextSequence = lastEvent ? lastEvent.sequence + 1 : 1;

    // Append event to the store
    const event = await prisma.paymentEvent.create({
      data: {
        paymentId,
        eventType,
        aggregateId: paymentId,
        sequence: nextSequence,
        eventData: data,
        metadata: {
          ...metadata,
          timestamp: new Date().toISOString(),
        },
        userId,
      },
    });

    logger.info(
      { paymentId, eventType, sequence: nextSequence },
      "Event appended to event store"
    );

    return event;
  } catch (error) {
    // Handle unique constraint violation (concurrent writes)
    if (error.code === "P2002") {
      logger.warn({ paymentId, eventType }, "Concurrent event write detected, retrying");
      // Retry logic could be implemented here
      throw new Error("Concurrent modification detected");
    }
    logger.error({ error, paymentId, eventType }, "Failed to append event");
    throw error;
  }
}

/**
 * Get all events for a payment aggregate
 * @param {string} aggregateId - Payment aggregate ID
 * @returns {Promise<Array>} Ordered list of events
 */
async function getEventsByAggregate(aggregateId) {
  const events = await prisma.paymentEvent.findMany({
    where: { aggregateId },
    orderBy: { sequence: "asc" },
  });

  return events;
}

/**
 * Get events since a specific sequence number (for event streaming/catching up)
 * @param {number} sinceSequence - Sequence to start from
 * @param {number} limit - Maximum events to return
 * @returns {Promise<Array>} Events after the sequence
 */
async function getEventsSince(sinceSequence = 0, limit = 100) {
  const events = await prisma.paymentEvent.findMany({
    where: {
      sequence: {
        gt: sinceSequence,
      },
    },
    orderBy: [{ timestamp: "asc" }, { sequence: "asc" }],
    take: limit,
  });

  return events;
}

/**
 * Get events by type within a time range
 * @param {string} eventType - Event type to filter
 * @param {Date} startTime - Start timestamp
 * @param {Date} endTime - End timestamp
 * @returns {Promise<Array>} Filtered events
 */
async function getEventsByType(eventType, startTime, endTime) {
  const where = { eventType };

  if (startTime || endTime) {
    where.timestamp = {};
    if (startTime) where.timestamp.gte = startTime;
    if (endTime) where.timestamp.lte = endTime;
  }

  const events = await prisma.paymentEvent.findMany({
    where,
    orderBy: { timestamp: "asc" },
  });

  return events;
}

/**
 * Rebuild payment state from event stream (event replay)
 * @param {string} aggregateId - Payment aggregate ID
 * @returns {Promise<Object>} Reconstructed payment state
 */
async function rebuildStateFromEvents(aggregateId) {
  const events = await getEventsByAggregate(aggregateId);

  if (events.length === 0) {
    return null;
  }

  // Apply events in order to rebuild state
  let state = {
    id: aggregateId,
    status: "unknown",
    eventCount: 0,
  };

  for (const event of events) {
    state = applyEvent(state, event);
  }

  return state;
}

/**
 * Apply an event to the current state (state transition function)
 * @param {Object} currentState - Current aggregate state
 * @param {Object} event - Event to apply
 * @returns {Object} New state after applying event
 */
function applyEvent(currentState, event) {
  const newState = { ...currentState, eventCount: currentState.eventCount + 1 };

  switch (event.eventType) {
    case PaymentEventTypes.PAYMENT_CREATED:
      return {
        ...newState,
        ...event.eventData,
        status: "created",
        createdAt: event.timestamp,
      };

    case PaymentEventTypes.PAYMENT_VALIDATED:
      return {
        ...newState,
        status: "validated",
        validatedAt: event.timestamp,
      };

    case PaymentEventTypes.PAYMENT_ROUTED:
      return {
        ...newState,
        status: "routed",
        routedAt: event.timestamp,
        transactionHash: event.eventData.transactionHash,
      };

    case PaymentEventTypes.PAYMENT_COMPLETED:
      return {
        ...newState,
        status: "completed",
        completedAt: event.timestamp,
      };

    case PaymentEventTypes.PAYMENT_FAILED:
      return {
        ...newState,
        status: "failed",
        failedAt: event.timestamp,
        failureReason: event.eventData.reason,
      };

    case PaymentEventTypes.PAYMENT_FLAGGED_FRAUD:
      return {
        ...newState,
        fraudStatus: "flagged",
        riskScore: event.eventData.riskScore,
        fraudFlaggedAt: event.timestamp,
      };

    case PaymentEventTypes.PAYMENT_CLEARED_FRAUD:
      return {
        ...newState,
        fraudStatus: "cleared",
        fraudClearedAt: event.timestamp,
      };

    default:
      logger.warn({ eventType: event.eventType }, "Unknown event type");
      return newState;
  }
}

/**
 * Update checkpoint for an event consumer
 * @param {string} consumerName - Name of the consumer
 * @param {string} lastEventId - Last processed event ID
 * @param {number} lastSequence - Last processed sequence
 * @param {Date} lastTimestamp - Last event timestamp
 */
async function updateCheckpoint(consumerName, lastEventId, lastSequence, lastTimestamp) {
  await prisma.eventCheckpoint.upsert({
    where: { consumerName },
    update: {
      lastEventId,
      lastSequence,
      lastTimestamp,
    },
    create: {
      consumerName,
      lastEventId,
      lastSequence,
      lastTimestamp,
    },
  });
}

/**
 * Get checkpoint for a consumer
 * @param {string} consumerName - Name of the consumer
 * @returns {Promise<Object|null>} Checkpoint data or null
 */
async function getCheckpoint(consumerName) {
  return prisma.eventCheckpoint.findUnique({
    where: { consumerName },
  });
}

module.exports = {
  PaymentEventTypes,
  appendEvent,
  getEventsByAggregate,
  getEventsSince,
  getEventsByType,
  rebuildStateFromEvents,
  applyEvent,
  updateCheckpoint,
  getCheckpoint,
};
