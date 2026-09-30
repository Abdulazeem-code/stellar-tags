/**
 * Event-Sourced Payment Routes
 * RESTful API for event-sourced payment operations
 */

const express = require("express");
const { asyncHandler } = require("../../middleware/asyncHandler");
const { ApiError } = require("../../errors");
const {
  createPayment,
  routePayment,
  completePayment,
  failPayment,
  flagPaymentFraud,
  clearPaymentFraud,
} = require("../../services/paymentCommandService");
const {
  getPaymentById,
  getPaymentWithHistory,
  listPayments,
  getPaymentStats,
  getPaymentsByFraudStatus,
  rebuildPaymentState,
} = require("../../services/paymentQueryService");
const {
  processNewEvents,
  rebuildAllReadModels,
} = require("../../services/readModelUpdater");

const router = express.Router();

/**
 * @swagger
 * /api/v1/event-sourced-payments:
 *   post:
 *     summary: Create a new payment using event sourcing
 *     tags: [Event-Sourced Payments]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fromAddress
 *               - toAddress
 *               - amount
 *             properties:
 *               fromAddress:
 *                 type: string
 *               toAddress:
 *                 type: string
 *               amount:
 *                 type: number
 *               fee:
 *                 type: number
 *               assetCode:
 *                 type: string
 *     responses:
 *       201:
 *         description: Payment created
 */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { fromAddress, toAddress, amount, fee, assetCode, riskScore } = req.body;

    if (!fromAddress || !toAddress || !amount) {
      throw new ApiError(400, "fromAddress, toAddress, and amount are required");
    }

    const result = await createPayment({
      fromAddress,
      toAddress,
      amount: parseFloat(amount),
      fee: fee ? parseFloat(fee) : 0,
      assetCode: assetCode || "XLM",
      riskScore: riskScore || 0,
      userId: req.user?.id,
      metadata: {
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        correlationId: req.correlationId,
      },
    });

    res.status(201).json({
      success: true,
      data: result,
    });
  })
);

/**
 * @swagger
 * /api/v1/event-sourced-payments/{id}:
 *   get:
 *     summary: Get payment by ID
 *     tags: [Event-Sourced Payments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Payment details
 */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const payment = await getPaymentById(id);

    if (!payment) {
      throw new ApiError(404, "Payment not found");
    }

    res.json({
      success: true,
      data: payment,
    });
  })
);

/**
 * @swagger
 * /api/v1/event-sourced-payments/{id}/history:
 *   get:
 *     summary: Get payment with full event history
 *     tags: [Event-Sourced Payments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Payment with event history
 */
router.get(
  "/:id/history",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await getPaymentWithHistory(id);

    if (!result.payment) {
      throw new ApiError(404, "Payment not found");
    }

    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * @swagger
 * /api/v1/event-sourced-payments:
 *   get:
 *     summary: List payments with filters
 *     tags: [Event-Sourced Payments]
 *     parameters:
 *       - in: query
 *         name: fromAddress
 *         schema:
 *           type: string
 *       - in: query
 *         name: toAddress
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: skip
 *         schema:
 *           type: integer
 *       - in: query
 *         name: take
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of payments
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { fromAddress, toAddress, status, skip, take } = req.query;

    const result = await listPayments({
      fromAddress,
      toAddress,
      status,
      skip: skip ? parseInt(skip) : 0,
      take: take ? parseInt(take) : 50,
    });

    res.json({
      success: true,
      ...result,
    });
  })
);

/**
 * @swagger
 * /api/v1/event-sourced-payments/{id}/route:
 *   post:
 *     summary: Route a payment
 *     tags: [Event-Sourced Payments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - transactionHash
 *             properties:
 *               transactionHash:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment routed
 */
router.post(
  "/:id/route",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { transactionHash } = req.body;

    if (!transactionHash) {
      throw new ApiError(400, "transactionHash is required");
    }

    const result = await routePayment(id, transactionHash, req.user?.id, {
      ipAddress: req.ip,
      correlationId: req.correlationId,
    });

    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * @swagger
 * /api/v1/event-sourced-payments/{id}/complete:
 *   post:
 *     summary: Complete a payment
 *     tags: [Event-Sourced Payments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Payment completed
 */
router.post(
  "/:id/complete",
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await completePayment(id, req.user?.id, {
      ipAddress: req.ip,
      correlationId: req.correlationId,
    });

    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * @swagger
 * /api/v1/event-sourced-payments/{id}/fail:
 *   post:
 *     summary: Mark payment as failed
 *     tags: [Event-Sourced Payments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reason
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Payment marked as failed
 */
router.post(
  "/:id/fail",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      throw new ApiError(400, "reason is required");
    }

    const result = await failPayment(id, reason, req.user?.id, {
      ipAddress: req.ip,
      correlationId: req.correlationId,
    });

    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * @swagger
 * /api/v1/event-sourced-payments/{id}/flag-fraud:
 *   post:
 *     summary: Flag payment for fraud
 *     tags: [Event-Sourced Payments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - riskScore
 *             properties:
 *               riskScore:
 *                 type: number
 *     responses:
 *       200:
 *         description: Payment flagged for fraud
 */
router.post(
  "/:id/flag-fraud",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { riskScore } = req.body;

    if (riskScore === undefined) {
      throw new ApiError(400, "riskScore is required");
    }

    const result = await flagPaymentFraud(id, parseFloat(riskScore), req.user?.id, {
      ipAddress: req.ip,
      correlationId: req.correlationId,
    });

    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * @swagger
 * /api/v1/event-sourced-payments/{id}/clear-fraud:
 *   post:
 *     summary: Clear fraud flag from payment
 *     tags: [Event-Sourced Payments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Fraud flag cleared
 */
router.post(
  "/:id/clear-fraud",
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await clearPaymentFraud(id, req.user?.id, {
      ipAddress: req.ip,
      correlationId: req.correlationId,
    });

    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * @swagger
 * /api/v1/event-sourced-payments/stats:
 *   get:
 *     summary: Get payment statistics
 *     tags: [Event-Sourced Payments]
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: Payment statistics
 */
router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;

    const stats = await getPaymentStats({
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    });

    res.json({
      success: true,
      data: stats,
    });
  })
);

/**
 * Admin endpoint: Process pending events (trigger read model update)
 */
router.post(
  "/admin/process-events",
  asyncHandler(async (req, res) => {
    const processedCount = await processNewEvents();

    res.json({
      success: true,
      data: {
        processedCount,
        message: `Processed ${processedCount} events`,
      },
    });
  })
);

/**
 * Admin endpoint: Rebuild all read models from event stream
 */
router.post(
  "/admin/rebuild-read-models",
  asyncHandler(async (req, res) => {
    const rebuiltCount = await rebuildAllReadModels();

    res.json({
      success: true,
      data: {
        rebuiltCount,
        message: `Rebuilt ${rebuiltCount} read models`,
      },
    });
  })
);

/**
 * Admin endpoint: Verify payment consistency
 */
router.get(
  "/:id/verify",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const verification = await rebuildPaymentState(id);

    res.json({
      success: true,
      data: verification,
    });
  })
);

module.exports = router;
