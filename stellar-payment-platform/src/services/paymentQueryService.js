/**
 * Payment Query Service
 * Handles read operations (queries) for payments
 * Implements CQRS pattern - read side (queries from read models)
 */

const { prisma } = require("../../prismaClient");
const { logger } = require("../logger");
const { getEventsByAggregate, rebuildStateFromEvents } = require("./eventStore");

/**
 * Get payment by ID from read model
 * @param {string} paymentId
 * @returns {Promise<Object|null>}
 */
async function getPaymentById(paymentId) {
  try {
    const payment = await prisma.paymentReadModel.findUnique({
      where: { id: paymentId },
    });

    return payment;
  } catch (error) {
    logger.error({ error, paymentId }, "Failed to get payment");
    throw error;
  }
}

/**
 * Get payment with full event history
 * @param {string} paymentId
 * @returns {Promise<Object|null>}
 */
async function getPaymentWithHistory(paymentId) {
  try {
    const payment = await getPaymentById(paymentId);
    const events = await getEventsByAggregate(paymentId);

    return {
      payment,
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        sequence: e.sequence,
        timestamp: e.timestamp,
        data: e.eventData,
        metadata: e.metadata,
      })),
      eventCount: events.length,
    };
  } catch (error) {
    logger.error({ error, paymentId }, "Failed to get payment with history");
    throw error;
  }
}

/**
 * List payments with pagination
 * @param {Object} filters
 * @param {string} filters.fromAddress
 * @param {string} filters.toAddress
 * @param {string} filters.status
 * @param {number} filters.skip
 * @param {number} filters.take
 * @returns {Promise<Object>}
 */
async function listPayments({
  fromAddress,
  toAddress,
  status,
  skip = 0,
  take = 50,
} = {}) {
  try {
    const where = {};

    if (fromAddress) {
      where.fromAddress = fromAddress;
    }
    if (toAddress) {
      where.toAddress = toAddress;
    }
    if (status) {
      where.currentState = status;
    }

    const [payments, total] = await Promise.all([
      prisma.paymentReadModel.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.paymentReadModel.count({ where }),
    ]);

    return {
      data: payments,
      pagination: {
        total,
        skip,
        take,
        hasMore: skip + take < total,
      },
    };
  } catch (error) {
    logger.error({ error }, "Failed to list payments");
    throw error;
  }
}

/**
 * Get payment statistics
 * @param {Object} filters
 * @param {Date} filters.startDate
 * @param {Date} filters.endDate
 * @returns {Promise<Object>}
 */
async function getPaymentStats({ startDate, endDate } = {}) {
  try {
    const where = {};

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    const [totalCount, statusGroups, fraudGroups, totalVolume] = await Promise.all([
      prisma.paymentReadModel.count({ where }),
      prisma.paymentReadModel.groupBy({
        by: ["currentState"],
        where,
        _count: true,
      }),
      prisma.paymentReadModel.groupBy({
        by: ["fraudStatus"],
        where,
        _count: true,
      }),
      prisma.paymentReadModel.aggregate({
        where,
        _sum: {
          amount: true,
          fee: true,
        },
      }),
    ]);

    const statusCounts = statusGroups.reduce((acc, group) => {
      acc[group.currentState] = group._count;
      return acc;
    }, {});

    const fraudCounts = fraudGroups.reduce((acc, group) => {
      acc[group.fraudStatus] = group._count;
      return acc;
    }, {});

    return {
      totalPayments: totalCount,
      byStatus: statusCounts,
      byFraudStatus: fraudCounts,
      totalVolume: totalVolume._sum.amount || 0,
      totalFees: totalVolume._sum.fee || 0,
    };
  } catch (error) {
    logger.error({ error }, "Failed to get payment stats");
    throw error;
  }
}

/**
 * Get payments by fraud status
 * @param {string} fraudStatus - 'flagged', 'cleared', 'clear'
 * @param {number} skip
 * @param {number} take
 * @returns {Promise<Object>}
 */
async function getPaymentsByFraudStatus(fraudStatus, skip = 0, take = 50) {
  try {
    const [payments, total] = await Promise.all([
      prisma.paymentReadModel.findMany({
        where: { fraudStatus },
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.paymentReadModel.count({ where: { fraudStatus } }),
    ]);

    return {
      data: payments,
      pagination: {
        total,
        skip,
        take,
        hasMore: skip + take < total,
      },
    };
  } catch (error) {
    logger.error({ error, fraudStatus }, "Failed to get payments by fraud status");
    throw error;
  }
}

/**
 * Rebuild payment state from events (for verification or recovery)
 * @param {string} paymentId
 * @returns {Promise<Object>}
 */
async function rebuildPaymentState(paymentId) {
  try {
    const rebuiltState = await rebuildStateFromEvents(paymentId);
    const currentReadModel = await getPaymentById(paymentId);

    return {
      rebuiltState,
      currentReadModel,
      isConsistent: rebuiltState && currentReadModel
        ? rebuiltState.status === currentReadModel.currentState
        : false,
    };
  } catch (error) {
    logger.error({ error, paymentId }, "Failed to rebuild payment state");
    throw error;
  }
}

module.exports = {
  getPaymentById,
  getPaymentWithHistory,
  listPayments,
  getPaymentStats,
  getPaymentsByFraudStatus,
  rebuildPaymentState,
};
