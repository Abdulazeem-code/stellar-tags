/**
 * Payment Command Service
 * Handles write operations (commands) for payments using Event Sourcing
 * Implements CQRS pattern - write side
 */

const { v4: uuidv4 } = require("uuid");
const { logger } = require("../logger");
const { appendEvent, PaymentEventTypes, getEventsByAggregate } = require("./eventStore");
const { prisma } = require("../../prismaClient");

/**
 * Create a new payment (command)
 * @param {Object} paymentData
 * @param {string} paymentData.fromAddress
 * @param {string} paymentData.toAddress
 * @param {number} paymentData.amount
 * @param {number} paymentData.fee
 * @param {string} paymentData.assetCode
 * @param {string} paymentData.userId
 * @param {Object} paymentData.metadata
 * @returns {Promise<Object>} Payment aggregate ID
 */
async function createPayment({
  fromAddress,
  toAddress,
  amount,
  fee = 0,
  assetCode = "XLM",
  userId = null,
  riskScore = 0,
  metadata = {},
}) {
  const paymentId = uuidv4();

  try {
    // Validate payment data
    if (!fromAddress || !toAddress) {
      throw new Error("fromAddress and toAddress are required");
    }
    if (amount <= 0) {
      throw new Error("amount must be greater than 0");
    }

    // Create PAYMENT_CREATED event
    const event = await appendEvent({
      paymentId,
      eventType: PaymentEventTypes.PAYMENT_CREATED,
      data: {
        fromAddress,
        toAddress,
        amount,
        fee,
        assetCode,
        riskScore,
      },
      metadata: {
        ...metadata,
        correlationId: metadata.correlationId || uuidv4(),
      },
      userId,
    });

    logger.info(
      { paymentId, fromAddress, toAddress, amount },
      "Payment created via event sourcing"
    );

    return {
      paymentId,
      eventId: event.id,
      status: "created",
    };
  } catch (error) {
    logger.error({ error, paymentId }, "Failed to create payment");
    throw error;
  }
}

/**
 * Route a payment (command)
 * @param {string} paymentId
 * @param {string} transactionHash
 * @param {string} userId
 * @param {Object} metadata
 * @returns {Promise<Object>}
 */
async function routePayment(paymentId, transactionHash, userId = null, metadata = {}) {
  try {
    // Verify payment exists (by checking for events)
    const events = await getEventsByAggregate(paymentId);
    if (events.length === 0) {
      throw new Error(`Payment ${paymentId} not found`);
    }

    // Check current state
    const createdEvent = events.find((e) => e.eventType === PaymentEventTypes.PAYMENT_CREATED);
    const alreadyRouted = events.find((e) => e.eventType === PaymentEventTypes.PAYMENT_ROUTED);

    if (!createdEvent) {
      throw new Error("Payment not properly created");
    }

    if (alreadyRouted) {
      logger.warn({ paymentId }, "Payment already routed");
      return { paymentId, status: "already_routed" };
    }

    // Create PAYMENT_ROUTED event
    const event = await appendEvent({
      paymentId,
      eventType: PaymentEventTypes.PAYMENT_ROUTED,
      data: {
        transactionHash,
      },
      metadata,
      userId,
    });

    logger.info({ paymentId, transactionHash }, "Payment routed");

    return {
      paymentId,
      eventId: event.id,
      status: "routed",
      transactionHash,
    };
  } catch (error) {
    logger.error({ error, paymentId }, "Failed to route payment");
    throw error;
  }
}

/**
 * Complete a payment (command)
 * @param {string} paymentId
 * @param {string} userId
 * @param {Object} metadata
 * @returns {Promise<Object>}
 */
async function completePayment(paymentId, userId = null, metadata = {}) {
  try {
    const events = await getEventsByAggregate(paymentId);
    if (events.length === 0) {
      throw new Error(`Payment ${paymentId} not found`);
    }

    const alreadyCompleted = events.find(
      (e) => e.eventType === PaymentEventTypes.PAYMENT_COMPLETED
    );
    if (alreadyCompleted) {
      logger.warn({ paymentId }, "Payment already completed");
      return { paymentId, status: "already_completed" };
    }

    // Create PAYMENT_COMPLETED event
    const event = await appendEvent({
      paymentId,
      eventType: PaymentEventTypes.PAYMENT_COMPLETED,
      data: {},
      metadata,
      userId,
    });

    logger.info({ paymentId }, "Payment completed");

    return {
      paymentId,
      eventId: event.id,
      status: "completed",
    };
  } catch (error) {
    logger.error({ error, paymentId }, "Failed to complete payment");
    throw error;
  }
}

/**
 * Fail a payment (command)
 * @param {string} paymentId
 * @param {string} reason
 * @param {string} userId
 * @param {Object} metadata
 * @returns {Promise<Object>}
 */
async function failPayment(paymentId, reason, userId = null, metadata = {}) {
  try {
    const events = await getEventsByAggregate(paymentId);
    if (events.length === 0) {
      throw new Error(`Payment ${paymentId} not found`);
    }

    // Create PAYMENT_FAILED event
    const event = await appendEvent({
      paymentId,
      eventType: PaymentEventTypes.PAYMENT_FAILED,
      data: {
        reason,
      },
      metadata,
      userId,
    });

    logger.info({ paymentId, reason }, "Payment failed");

    return {
      paymentId,
      eventId: event.id,
      status: "failed",
      reason,
    };
  } catch (error) {
    logger.error({ error, paymentId }, "Failed to mark payment as failed");
    throw error;
  }
}

/**
 * Flag payment for fraud (command)
 * @param {string} paymentId
 * @param {number} riskScore
 * @param {string} userId
 * @param {Object} metadata
 * @returns {Promise<Object>}
 */
async function flagPaymentFraud(paymentId, riskScore, userId = null, metadata = {}) {
  try {
    const events = await getEventsByAggregate(paymentId);
    if (events.length === 0) {
      throw new Error(`Payment ${paymentId} not found`);
    }

    // Create PAYMENT_FLAGGED_FRAUD event
    const event = await appendEvent({
      paymentId,
      eventType: PaymentEventTypes.PAYMENT_FLAGGED_FRAUD,
      data: {
        riskScore,
      },
      metadata,
      userId,
    });

    logger.warn({ paymentId, riskScore }, "Payment flagged for fraud");

    return {
      paymentId,
      eventId: event.id,
      fraudStatus: "flagged",
      riskScore,
    };
  } catch (error) {
    logger.error({ error, paymentId }, "Failed to flag payment for fraud");
    throw error;
  }
}

/**
 * Clear fraud flag from payment (command)
 * @param {string} paymentId
 * @param {string} userId
 * @param {Object} metadata
 * @returns {Promise<Object>}
 */
async function clearPaymentFraud(paymentId, userId = null, metadata = {}) {
  try {
    const events = await getEventsByAggregate(paymentId);
    if (events.length === 0) {
      throw new Error(`Payment ${paymentId} not found`);
    }

    // Create PAYMENT_CLEARED_FRAUD event
    const event = await appendEvent({
      paymentId,
      eventType: PaymentEventTypes.PAYMENT_CLEARED_FRAUD,
      data: {},
      metadata,
      userId,
    });

    logger.info({ paymentId }, "Payment fraud flag cleared");

    return {
      paymentId,
      eventId: event.id,
      fraudStatus: "cleared",
    };
  } catch (error) {
    logger.error({ error, paymentId }, "Failed to clear fraud flag");
    throw error;
  }
}

module.exports = {
  createPayment,
  routePayment,
  completePayment,
  failPayment,
  flagPaymentFraud,
  clearPaymentFraud,
};
