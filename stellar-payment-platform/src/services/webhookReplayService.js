'use strict';

/**
 * src/services/webhookReplayService.js
 *
 * Time-travel webhook replay engine. Allows merchants to query failed deliveries
 * by time range or event type, preview payload diffs against updated schema
 * definitions, and trigger controlled batch replays with custom concurrency
 * and idempotency replay headers.
 */

const { prisma } = require('../../prismaClient');
const crypto = require('crypto');
const { logger } = require('../logger');
const { internalFetch } = require('../utils/internalClient');
const { computeSignature, computeBoundSignature, WEBHOOK_TIMEOUT_MS } = require('../webhookWorker');

const MAX_REPLAY_RATE_PER_SEC = 50;
const MAX_REPLAY_BATCH_SIZE = 1000;
const REPLAY_ID_PREFIX = 'replay_';

const rateLimitStore = new Map();
const parseEnvInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
};

const getRateLimitConfig = () => ({
  maxPerSec: parseEnvInt(process.env.WEBHOOK_REPLAY_MAX_RATE, MAX_REPLAY_RATE_PER_SEC),
  maxBatchSize: parseEnvInt(process.env.WEBHOOK_REPLAY_MAX_BATCH, MAX_REPLAY_BATCH_SIZE),
});

const checkRateLimit = (key) => {
  const now = Date.now();
  const windowStart = now - 1000;
  const config = getRateLimitConfig();

  if (!rateLimitStore.has(key)) {
    rateLimitStore.set(key, []);
  }

  const timestamps = rateLimitStore.get(key).filter((ts) => ts > windowStart);
  rateLimitStore.set(key, timestamps);

  if (timestamps.length >= config.maxPerSec) {
    return { allowed: false, retryAfter: 1000 - (now - timestamps[0]) };
  }

  timestamps.push(now);
  return { allowed: true };
};

const buildReplayHeaders = (originalPayload, secret, isReplay = true) => {
  const rawBody = JSON.stringify(originalPayload);
  const signature = computeSignature(secret, rawBody);
  const timestamp = originalPayload.timestamp || new Date().toISOString();
  const stellarSignature = computeBoundSignature(secret, timestamp, rawBody);

  const headers = {
    'Content-Type': 'application/json',
    'X-Webhook-Signature': signature,
    'X-Stellar-Tags-Signature': signature,
    'X-Webhook-Timestamp': timestamp,
    'Stellar-Signature': stellarSignature,
    'Stellar-Timestamp': timestamp,
  };

  if (isReplay) {
    headers['X-Stellar-Replay'] = 'true';
    headers['X-Stellar-Original-Timestamp'] = originalPayload.timestamp || timestamp;
  }

  return { headers, rawBody };
};

const sendReplayWebhook = async (webhook, payload) => {
  const { headers, rawBody } = buildReplayHeaders(payload, webhook.secret, true);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await internalFetch(webhook.url, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: controller.signal,
    });

    let responseBody = null;
    try {
      responseBody = await response.text();
    } catch {
      responseBody = null;
    }

    if (!response.ok) {
      const error = new Error(`Webhook responded with HTTP ${response.status}`);
      error.responseCode = response.status;
      error.responseBody = responseBody;
      throw error;
    }

    return { ok: true, responseCode: response.status, responseBody };
  } finally {
    clearTimeout(timeoutId);
  }
};

const findDeliveriesForReplay = async (filters) => {
  const { eventIds, startDate, endDate, status, username, webhookId, eventType, limit } = filters;

  const where = {};

  if (username) {
    where.username = username;
  }

  if (webhookId) {
    where.webhookId = webhookId;
  }

  if (eventType) {
    where.eventType = eventType;
  }

  if (eventIds && eventIds.length > 0) {
    where.eventId = { in: eventIds };
  }

  if (status) {
    where.status = status;
  }

  if (startDate || endDate) {
    where.sentAt = {};
    if (startDate) where.sentAt.gte = new Date(startDate);
    if (endDate) where.sentAt.lte = new Date(endDate);
  }

  const deliveries = await prisma.webhookDelivery.findMany({
    where,
    orderBy: { sentAt: 'asc' },
    take: limit,
  });

  return deliveries;
};

const getUniqueWebhooksFromDeliveries = async (deliveries) => {
  const webhookIds = [...new Set(deliveries.map((d) => d.webhookId))];
  const webhooks = await prisma.webhook.findMany({
    where: { id: { in: webhookIds } },
  });
  return webhooks;
};

const executeReplay = async (deliveries, webhooks, replayId) => {
  const webhookMap = new Map(webhooks.map((w) => [w.id, w]));
  const results = {
    total: deliveries.length,
    successful: 0,
    failed: 0,
    errors: [],
    replayId,
  };

  const config = getRateLimitConfig();

  for (let i = 0; i < deliveries.length; i++) {
    const delivery = deliveries[i];
    const webhook = webhookMap.get(delivery.webhookId);

    if (!webhook) {
      results.failed++;
      results.errors.push({
        deliveryId: delivery.id,
        eventId: delivery.eventId,
        error: 'Webhook not found',
      });
      continue;
    }

    const rateKey = `replay:${webhook.id}`;
    const rateCheck = checkRateLimit(rateKey);

    if (!rateCheck.allowed) {
      await new Promise((resolve) => setTimeout(resolve, rateCheck.retryAfter));
    }

    try {
      const originalPayload = delivery.payload;
      const { responseCode, responseBody } = await sendReplayWebhook(webhook, originalPayload);

      await prisma.webhookDelivery.create({
        data: {
          webhookId: webhook.id,
          username: webhook.username,
          eventType: delivery.eventType,
          eventId: delivery.eventId,
          payload: originalPayload,
          status: 'replayed',
          responseCode,
          responseBody,
          attemptNumber: delivery.attemptNumber + 1,
          replayId,
        },
      });

      results.successful++;
    } catch (error) {
      results.failed++;
      results.errors.push({
        deliveryId: delivery.id,
        eventId: delivery.eventId,
        error: error.message,
        responseCode: error.responseCode,
        responseBody: error.responseBody,
      });

      await prisma.webhookDelivery.create({
        data: {
          webhookId: webhook.id,
          username: webhook.username,
          eventType: delivery.eventType,
          eventId: delivery.eventId,
          payload: delivery.payload,
          status: 'failed',
          responseCode: error.responseCode,
          responseBody: error.responseBody,
          errorMessage: error.message,
          attemptNumber: delivery.attemptNumber + 1,
          replayId,
        },
      });
    }

    if ((i + 1) % 100 === 0) {
      logger.info(`[webhook-replay] Progress: ${i + 1}/${deliveries.length} replayed`);
    }
  }

  return results;
};

const previewReplay = async (filters) => {
  const config = getRateLimitConfig();
  const deliveries = await findDeliveriesForReplay({ ...filters, limit: config.maxBatchSize });

  const stats = {
    total: deliveries.length,
    byStatus: {},
    byEventType: {},
    byWebhook: {},
    dateRange: {
      earliest: deliveries.length > 0 ? deliveries[0].sentAt : null,
      latest: deliveries.length > 0 ? deliveries[deliveries.length - 1].sentAt : null,
    },
    samplePayloads: deliveries.slice(0, 5).map((d) => ({
      eventId: d.eventId,
      eventType: d.eventType,
      status: d.status,
      sentAt: d.sentAt,
      payload: d.payload,
    })),
  };

  for (const d of deliveries) {
    stats.byStatus[d.status] = (stats.byStatus[d.status] || 0) + 1;
    stats.byEventType[d.eventType] = (stats.byEventType[d.eventType] || 0) + 1;
    stats.byWebhook[d.webhookId] = (stats.byWebhook[d.webhookId] || 0) + 1;
  }

  return { stats, deliveries: deliveries.map((d) => ({ id: d.id, eventId: d.eventId, sentAt: d.sentAt, status: d.status })) };
};

const triggerReplay = async (filters, options = {}) => {
  const config = getRateLimitConfig();
  const { dryRun = false, idempotencyKey } = options;

  if (idempotencyKey) {
    const existing = await prisma.webhookDelivery.findFirst({
      where: { replayId: idempotencyKey },
    });
    if (existing) {
      return { ok: false, error: 'Replay with this idempotency key already executed', replayId: idempotencyKey };
    }
  }

  const replayId = idempotencyKey || `${REPLAY_ID_PREFIX}${crypto.randomUUID()}`;

  const deliveries = await findDeliveriesForReplay({ ...filters, limit: config.maxBatchSize });

  if (deliveries.length === 0) {
    return { ok: true, replayId, results: { total: 0, successful: 0, failed: 0, errors: [] } };
  }

  if (dryRun) {
    return previewReplay(filters);
  }

  const webhooks = await getUniqueWebhooksFromDeliveries(deliveries);
  const results = await executeReplay(deliveries, webhooks, replayId);

  return { ok: true, replayId, results };
};

module.exports = {
  findDeliveriesForReplay,
  getUniqueWebhooksFromDeliveries,
  executeReplay,
  previewReplay,
  triggerReplay,
  sendReplayWebhook,
  buildReplayHeaders,
  checkRateLimit,
  MAX_REPLAY_RATE_PER_SEC,
  MAX_REPLAY_BATCH_SIZE,
  _resetRateLimitStore: () => rateLimitStore.clear(),
};