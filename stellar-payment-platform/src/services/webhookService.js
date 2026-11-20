'use strict';

/**
 * Host-level Circuit Breaker and Token Bucket Rate Limiter for Webhook Deliveries.
 *
 * Prevents cascading retry storms when merchant webhook endpoints degrade or fail.
 * - Tracks failure rates and response latency per destination domain in Redis.
 * - Trips circuit breaker to OPEN after 5 consecutive failures, halting active queueing.
 * - Enforces token-bucket rate limiting with exponential backpressure per host.
 * - Sends single probe requests every 60 seconds when OPEN/HALF_OPEN.
 * - Resets to CLOSED after 3 consecutive 200 OK probe successes.
 * - Alerts merchant via dashboard notification when circuit breaker enters OPEN state.
 */

const { logger } = require('../logger');
const { recordActivity, ACTIVITY_ACTIONS } = require('./activityService');

// ---------------------------------------------------------------------------
// Constants & Defaults
// ---------------------------------------------------------------------------
const CB_STATES = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

const CONSECUTIVE_FAILURE_THRESHOLD = parseInt(process.env.WEBHOOK_CB_FAILURE_THRESHOLD, 10) || 5;
const CONSECUTIVE_SUCCESS_THRESHOLD = parseInt(process.env.WEBHOOK_CB_SUCCESS_THRESHOLD, 10) || 3;
const PROBE_INTERVAL_MS = parseInt(process.env.WEBHOOK_CB_PROBE_INTERVAL_MS, 10) || 60_000; // 60s
const RATE_LIMIT_CAPACITY = parseInt(process.env.WEBHOOK_RATE_LIMIT_CAPACITY, 10) || 10;
const RATE_LIMIT_REFILL_PER_SEC = parseInt(process.env.WEBHOOK_RATE_LIMIT_REFILL_RATE, 10) || 5;
const BASE_BACKOFF_MS = parseInt(process.env.WEBHOOK_BACKOFF_MS, 10) || 1_000;
const MAX_BACKOFF_MS = 60_000;

const DASHBOARD_NOTIFICATION_CHANNEL = 'stellar:dashboard:notifications';

// In-memory fallback if Redis is unavailable or unconfigured
const memoryState = new Map();
const memoryMetrics = new Map();
const memoryRateLimiter = new Map();

/**
 * Extracts host / destination domain from a URL safely.
 * @param {string} url
 * @returns {string} destination domain or 'unknown'
 */
const getDestinationDomain = (url) => {
  if (typeof url !== 'string') return 'unknown';
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.host || 'unknown';
  } catch {
    return 'unknown';
  }
};

// ---------------------------------------------------------------------------
// Redis Key Helpers
// ---------------------------------------------------------------------------
const cbKey = (domain, field) => `webhook:cb:${domain}:${field}`;
const metricsKey = (domain) => `webhook:metrics:${domain}`;

/**
 * Get internal state for a domain (fallback to memory if Redis is null or fails)
 */
const getBreakerRecord = async (redis, domain) => {
  if (!redis) {
    if (!memoryState.has(domain)) {
      memoryState.set(domain, {
        state: CB_STATES.CLOSED,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastProbeTime: 0,
        openedAt: 0,
        probing: false,
      });
    }
    return memoryState.get(domain);
  }

  try {
    const [state, failures, successes, lastProbeTime, openedAt, probing] = await redis.mget(
      cbKey(domain, 'state'),
      cbKey(domain, 'failures'),
      cbKey(domain, 'successes'),
      cbKey(domain, 'last_probe_time'),
      cbKey(domain, 'opened_at'),
      cbKey(domain, 'probing'),
    );

    return {
      state: state || CB_STATES.CLOSED,
      consecutiveFailures: parseInt(failures, 10) || 0,
      consecutiveSuccesses: parseInt(successes, 10) || 0,
      lastProbeTime: parseInt(lastProbeTime, 10) || 0,
      openedAt: parseInt(openedAt, 10) || 0,
      probing: probing === '1' || probing === 'true',
    };
  } catch (err) {
    logger.warn({ err: err.message, domain }, '[webhook-service] Redis error reading breaker state; using memory fallback');
    if (!memoryState.has(domain)) {
      memoryState.set(domain, {
        state: CB_STATES.CLOSED,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastProbeTime: 0,
        openedAt: 0,
        probing: false,
      });
    }
    return memoryState.get(domain);
  }
};

/**
 * Updates circuit breaker record in Redis (or in-memory)
 */
const setBreakerRecord = async (redis, domain, record) => {
  if (!redis) {
    memoryState.set(domain, { ...record });
    return;
  }

  try {
    const pipeline = redis.pipeline();
    pipeline.set(cbKey(domain, 'state'), record.state);
    pipeline.set(cbKey(domain, 'failures'), record.consecutiveFailures);
    pipeline.set(cbKey(domain, 'successes'), record.consecutiveSuccesses);
    pipeline.set(cbKey(domain, 'last_probe_time'), record.lastProbeTime);
    pipeline.set(cbKey(domain, 'opened_at'), record.openedAt);
    pipeline.set(cbKey(domain, 'probing'), record.probing ? '1' : '0');
    // Set a reasonable TTL (7 days) so stale domains expire naturally
    const ttlSeconds = 7 * 24 * 3600;
    pipeline.expire(cbKey(domain, 'state'), ttlSeconds);
    pipeline.expire(cbKey(domain, 'failures'), ttlSeconds);
    pipeline.expire(cbKey(domain, 'successes'), ttlSeconds);
    pipeline.expire(cbKey(domain, 'last_probe_time'), ttlSeconds);
    pipeline.expire(cbKey(domain, 'opened_at'), ttlSeconds);
    pipeline.expire(cbKey(domain, 'probing'), ttlSeconds);
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err: err.message, domain }, '[webhook-service] Redis error writing breaker state; writing to memory');
    memoryState.set(domain, { ...record });
  }
};

// ---------------------------------------------------------------------------
// Failure Rates & Response Latency Tracking in Redis
// ---------------------------------------------------------------------------
/**
 * Records delivery metrics in Redis: total requests, success/fail counts,
 * failure rates, and rolling response latency.
 */
const recordDeliveryMetrics = async (redis, domain, { success, latencyMs, statusCode }) => {
  const now = new Date().toISOString();
  const latency = Math.max(0, Number(latencyMs) || 0);

  if (!redis) {
    let metrics = memoryMetrics.get(domain);
    if (!metrics) {
      metrics = {
        totalRequests: 0,
        successRequests: 0,
        failedRequests: 0,
        failureRate: 0,
        totalLatencyMs: 0,
        latencyCount: 0,
        avgLatencyMs: 0,
        lastLatencyMs: 0,
        lastStatusCode: null,
        lastUpdatedAt: now,
      };
      memoryMetrics.set(domain, metrics);
    }
    metrics.totalRequests += 1;
    if (success) {
      metrics.successRequests += 1;
    } else {
      metrics.failedRequests += 1;
    }
    metrics.failureRate = metrics.totalRequests > 0 ? (metrics.failedRequests / metrics.totalRequests) : 0;
    metrics.totalLatencyMs += latency;
    metrics.latencyCount += 1;
    metrics.avgLatencyMs = Math.round(metrics.totalLatencyMs / metrics.latencyCount);
    metrics.lastLatencyMs = latency;
    metrics.lastStatusCode = statusCode || (success ? 200 : 500);
    metrics.lastUpdatedAt = now;
    return metrics;
  }

  try {
    const key = metricsKey(domain);
    const pipeline = redis.pipeline();
    pipeline.hincrby(key, 'totalRequests', 1);
    if (success) {
      pipeline.hincrby(key, 'successRequests', 1);
    } else {
      pipeline.hincrby(key, 'failedRequests', 1);
    }
    pipeline.hincrby(key, 'totalLatencyMs', latency);
    pipeline.hincrby(key, 'latencyCount', 1);
    pipeline.hset(key, 'lastLatencyMs', latency);
    pipeline.hset(key, 'lastStatusCode', statusCode || (success ? 200 : 500));
    pipeline.hset(key, 'lastUpdatedAt', now);
    pipeline.expire(key, 7 * 24 * 3600); // 7-day TTL

    const results = await pipeline.exec();
    const totalRequests = results[0]?.[1] || 1;
    const successOrFailed = results[1]?.[1] || (success ? 1 : 0);
    const failedRequests = success ? Math.max(0, totalRequests - successOrFailed) : successOrFailed;
    const totalLatency = results[2]?.[1] || latency;
    const latencyCount = results[3]?.[1] || 1;

    const failureRate = totalRequests > 0 ? failedRequests / totalRequests : 0;
    const avgLatencyMs = latencyCount > 0 ? Math.round(totalLatency / latencyCount) : latency;

    await redis.hset(key, 'failureRate', failureRate.toFixed(4));
    await redis.hset(key, 'avgLatencyMs', avgLatencyMs);

    return {
      domain,
      totalRequests,
      failedRequests,
      failureRate,
      avgLatencyMs,
      lastLatencyMs: latency,
      lastStatusCode: statusCode,
      lastUpdatedAt: now,
    };
  } catch (err) {
    logger.warn({ err: err.message, domain }, '[webhook-service] Failed to record delivery metrics in Redis');
    return null;
  }
};

/**
 * Retrieve failure rates and response latency for a domain.
 */
const getDeliveryMetrics = async (redis, domain) => {
  if (!redis) {
    return memoryMetrics.get(domain) || {
      domain,
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      failureRate: 0,
      avgLatencyMs: 0,
      lastLatencyMs: 0,
      lastStatusCode: null,
      lastUpdatedAt: null,
    };
  }

  try {
    const raw = await redis.hgetall(metricsKey(domain));
    if (!raw || Object.keys(raw).length === 0) {
      return {
        domain,
        totalRequests: 0,
        successRequests: 0,
        failedRequests: 0,
        failureRate: 0,
        avgLatencyMs: 0,
        lastLatencyMs: 0,
        lastStatusCode: null,
        lastUpdatedAt: null,
      };
    }

    return {
      domain,
      totalRequests: parseInt(raw.totalRequests, 10) || 0,
      successRequests: parseInt(raw.successRequests, 10) || 0,
      failedRequests: parseInt(raw.failedRequests, 10) || 0,
      failureRate: parseFloat(raw.failureRate) || 0,
      avgLatencyMs: parseInt(raw.avgLatencyMs, 10) || 0,
      lastLatencyMs: parseInt(raw.lastLatencyMs, 10) || 0,
      lastStatusCode: raw.lastStatusCode ? parseInt(raw.lastStatusCode, 10) : null,
      lastUpdatedAt: raw.lastUpdatedAt || null,
    };
  } catch (err) {
    logger.warn({ err: err.message, domain }, '[webhook-service] Failed to fetch delivery metrics');
    return null;
  }
};

// ---------------------------------------------------------------------------
// Merchant Dashboard Notification Alert
// ---------------------------------------------------------------------------
/**
 * Alerts merchant via dashboard notification when circuit breaker enters OPEN state.
 * Emits real-time event through Redis pub/sub and persists an ActivityLog entry.
 */
const alertMerchantCircuitBreakerOpen = async ({ domain, merchantUsername, prisma, redis, failures = 5 }) => {
  const timestamp = new Date().toISOString();
  const alertPayload = {
    type: 'CIRCUIT_BREAKER_OPEN',
    domain,
    username: merchantUsername || 'all',
    title: 'Webhook Delivery Circuit Breaker Tripped',
    message: `Webhook endpoint for domain '${domain}' failed ${failures} consecutive deliveries. Delivery queueing is halted; probing every 60s.`,
    consecutiveFailures: failures,
    timestamp,
  };

  logger.warn(
    alertPayload,
    `[circuit-breaker] Circuit breaker OPEN for domain=${domain} merchant=${merchantUsername || 'unknown'}`,
  );

  // 1. Record in merchant self-service activity log for the dashboard
  if (prisma && merchantUsername) {
    try {
      await recordActivity(prisma, {
        username: merchantUsername,
        action: ACTIVITY_ACTIONS.WEBHOOK_CIRCUIT_BREAKER_OPEN || 'webhook.circuit_breaker_open',
        metadata: {
          domain,
          reason: `${failures} consecutive delivery failures (5xx or timeouts)`,
          state: CB_STATES.OPEN,
          probeIntervalSeconds: 60,
          timestamp,
        },
      });
    } catch (err) {
      logger.error({ err: err.message, merchantUsername }, '[circuit-breaker] Failed to record activity log alert');
    }
  }

  // 2. Publish to Redis for real-time dashboard notifications
  if (redis) {
    try {
      await redis.publish(DASHBOARD_NOTIFICATION_CHANNEL, JSON.stringify(alertPayload));
      // Also publish to payment update channel so any active SSE connection receives it as well
      await redis.publish('stellar:payment:update', JSON.stringify({
        topic: `merchant:${merchantUsername || domain}:alert`,
        event: 'circuit-breaker-open',
        data: alertPayload,
      }));
    } catch (err) {
      logger.warn({ err: err.message }, '[circuit-breaker] Failed to publish real-time dashboard notification');
    }
  }
};

// ---------------------------------------------------------------------------
// Token Bucket Rate Limiter with Exponential Backpressure
// ---------------------------------------------------------------------------
/**
 * Host-level token bucket rate limiter.
 * Throttles outbound requests with exponential backpressure when tokens are exhausted.
 */
const consumeToken = async (redis, domain, tokens = 1) => {
  const now = Date.now();
  const capacity = RATE_LIMIT_CAPACITY;
  const refillRate = RATE_LIMIT_REFILL_PER_SEC; // tokens/second

  if (!redis) {
    let bucket = memoryRateLimiter.get(domain);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now };
      memoryRateLimiter.set(domain, bucket);
    }
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return { allowed: true, remainingTokens: Math.floor(bucket.tokens) };
    }
    return {
      allowed: false,
      remainingTokens: 0,
      retryAfterMs: Math.ceil(((tokens - bucket.tokens) / refillRate) * 1000),
    };
  }

  const tokenKey = `webhook:rate:${domain}:tokens`;
  const refillKey = `webhook:rate:${domain}:last_refill`;

  try {
    // Atomic token bucket acquisition
    const luaScript = `
      local token_key = KEYS[1]
      local refill_key = KEYS[2]
      local now = tonumber(ARGV[1])
      local capacity = tonumber(ARGV[2])
      local refill_rate = tonumber(ARGV[3])
      local requested = tonumber(ARGV[4])

      local current_tokens = tonumber(redis.call('get', token_key))
      local last_refill = tonumber(redis.call('get', refill_key))

      if not current_tokens then
        current_tokens = capacity
        last_refill = now
      else
        local elapsed = (now - last_refill) / 1000.0
        current_tokens = math.min(capacity, current_tokens + (elapsed * refill_rate))
        last_refill = now
      end

      if current_tokens >= requested then
        current_tokens = current_tokens - requested
        redis.call('set', token_key, current_tokens, 'EX', 3600)
        redis.call('set', refill_key, last_refill, 'EX', 3600)
        return {1, math.floor(current_tokens), 0}
      else
        local missing = requested - current_tokens
        local retry_after = math.ceil((missing / refill_rate) * 1000)
        redis.call('set', token_key, current_tokens, 'EX', 3600)
        redis.call('set', refill_key, last_refill, 'EX', 3600)
        return {0, 0, retry_after}
      end
    `;

    const result = await redis.eval(luaScript, 2, tokenKey, refillKey, now, capacity, refillRate, tokens);
    const allowed = result[0] === 1;
    const remainingTokens = result[1];
    const retryAfterMs = result[2];

    return { allowed, remainingTokens, retryAfterMs };
  } catch (err) {
    logger.warn({ err: err.message, domain }, '[webhook-service] Token bucket Redis error; defaulting to allowed');
    return { allowed: true, remainingTokens: capacity, retryAfterMs: 0 };
  }
};

/**
 * Calculates exponential backpressure delay based on attempt number.
 */
const calculateExponentialBackoff = (attempt, baseDelayMs = BASE_BACKOFF_MS) => {
  const safeAttempt = Math.max(0, Math.min(10, attempt));
  const delay = baseDelayMs * 2 ** safeAttempt;
  return Math.min(delay, MAX_BACKOFF_MS);
};

// ---------------------------------------------------------------------------
// Circuit Breaker Core Logic
// ---------------------------------------------------------------------------
/**
 * Checks whether active delivery queueing is allowed for a destination domain.
 * - CLOSED: Allowed.
 * - OPEN: Halted.
 * - HALF_OPEN: Halted for regular queueing (only probes are allowed).
 */
const canQueueDelivery = async (redis, domain) => {
  const record = await getBreakerRecord(redis, domain);
  const now = Date.now();

  if (record.state === CB_STATES.CLOSED) {
    return { allowed: true, state: CB_STATES.CLOSED };
  }

  // If breaker is OPEN, check if 60 seconds have elapsed since last probe
  if (record.state === CB_STATES.OPEN) {
    const timeSinceProbe = now - record.lastProbeTime;
    if (timeSinceProbe >= PROBE_INTERVAL_MS && !record.probing) {
      // Time to transition to HALF_OPEN for a single probe request
      return {
        allowed: false,
        state: CB_STATES.OPEN,
        canProbe: true,
        reason: 'Circuit breaker is OPEN. Active queueing halted; probe eligible.',
      };
    }

    return {
      allowed: false,
      state: CB_STATES.OPEN,
      canProbe: false,
      reason: `Circuit breaker is OPEN after ${CONSECUTIVE_FAILURE_THRESHOLD} consecutive failures. Active queueing halted.`,
      nextProbeInMs: Math.max(0, PROBE_INTERVAL_MS - timeSinceProbe),
    };
  }

  // In HALF_OPEN state
  return {
    allowed: false,
    state: CB_STATES.HALF_OPEN,
    canProbe: !record.probing,
    reason: 'Circuit breaker is HALF_OPEN (probing in progress). Active queueing halted.',
  };
};

/**
 * Attempts to claim a single probe request slot for a domain (every 60 seconds).
 * Returns true if this caller won the probe slot, false otherwise.
 */
const acquireProbeSlot = async (redis, domain) => {
  const record = await getBreakerRecord(redis, domain);
  const now = Date.now();

  if (record.state === CB_STATES.CLOSED) {
    return false; // Not in probe mode
  }

  const timeSinceLastProbe = now - record.lastProbeTime;
  if (timeSinceLastProbe < PROBE_INTERVAL_MS && record.state === CB_STATES.OPEN) {
    return false; // Probe cooldown not elapsed
  }

  if (record.probing) {
    return false; // Another probe is already in flight
  }

  // Transition to HALF_OPEN and mark probing in-flight
  record.state = CB_STATES.HALF_OPEN;
  record.lastProbeTime = now;
  record.probing = true;
  await setBreakerRecord(redis, domain, record);
  logger.info({ domain }, '[circuit-breaker] Acquired probe slot; switched to HALF_OPEN probing');
  return true;
};

/**
 * Handles a successful delivery (200 OK):
 * - Records latency and success metric in Redis.
 * - In CLOSED state: resets consecutive failures to 0.
 * - In HALF_OPEN state: increments consecutive 200 OKs.
 *   After 3 consecutive 200 OKs, resets circuit breaker to CLOSED.
 */
const handleDeliverySuccess = async (redis, domain, latencyMs, { prisma, merchantUsername } = {}) => {
  // 1. Record metrics
  await recordDeliveryMetrics(redis, domain, { success: true, latencyMs, statusCode: 200 });

  // 2. Update circuit breaker state
  const record = await getBreakerRecord(redis, domain);
  record.probing = false;

  if (record.state === CB_STATES.HALF_OPEN) {
    record.consecutiveSuccesses += 1;
    logger.info(
      { domain, consecutiveSuccesses: record.consecutiveSuccesses, target: CONSECUTIVE_SUCCESS_THRESHOLD },
      `[circuit-breaker] Probe succeeded (${record.consecutiveSuccesses}/${CONSECUTIVE_SUCCESS_THRESHOLD} required 200 OKs)`,
    );

    if (record.consecutiveSuccesses >= CONSECUTIVE_SUCCESS_THRESHOLD) {
      // 3 consecutive 200 OKs -> Reset to CLOSED!
      record.state = CB_STATES.CLOSED;
      record.consecutiveFailures = 0;
      record.consecutiveSuccesses = 0;
      record.openedAt = 0;
      logger.info(
        { domain },
        '[circuit-breaker] Circuit breaker recovered to CLOSED after 3 consecutive 200 OK probes',
      );
    }
  } else if (record.state === CB_STATES.CLOSED) {
    record.consecutiveFailures = 0;
  }

  await setBreakerRecord(redis, domain, record);
  return record;
};

/**
 * Determines whether an error/status indicates a severe destination endpoint outage
 * (e.g., 5xx server error, network timeout, connection reset).
 */
const isOutageFailure = (errorOrStatus) => {
  if (typeof errorOrStatus === 'number') {
    return errorOrStatus >= 500 && errorOrStatus <= 599;
  }
  const msg = String(errorOrStatus?.message || errorOrStatus || '').toLowerCase();
  if (/5\d{2}|timeout|econnrefused|econnreset|etimedout|enotfound|abort/i.test(msg)) {
    return true;
  }
  return true;
};

/**
 * Handles a failed delivery:
 * - Records latency and failure metric in Redis.
 * - If failure is 5xx / timeout:
 *   - In HALF_OPEN state: Probe failed! Trips back to OPEN immediately, resets successes to 0.
 *   - In CLOSED state: Increments consecutive failures.
 *     After 5 consecutive failures, trips circuit breaker to OPEN, halts queueing,
 *     and alerts merchant via dashboard notification.
 */
const handleDeliveryFailure = async (redis, domain, error, latencyMs, { prisma, merchantUsername } = {}) => {
  const isSevere = isOutageFailure(error);
  const statusCode = typeof error === 'number' ? error : (parseInt(error?.message?.match(/\b(\d{3})\b/)?.[1], 10) || 500);

  // 1. Record metrics in Redis
  await recordDeliveryMetrics(redis, domain, { success: false, latencyMs, statusCode });

  if (!isSevere) {
    return await getBreakerRecord(redis, domain);
  }

  // 2. Update circuit breaker state
  const record = await getBreakerRecord(redis, domain);
  record.probing = false;

  if (record.state === CB_STATES.HALF_OPEN) {
    // Probe failed -> Return to OPEN state, reset probe timer
    record.state = CB_STATES.OPEN;
    record.consecutiveSuccesses = 0;
    record.lastProbeTime = Date.now();
    logger.warn({ domain, error: error?.message || error }, '[circuit-breaker] Probe failed! Resetting to OPEN state');
    await setBreakerRecord(redis, domain, record);
    return record;
  }

  if (record.state === CB_STATES.CLOSED) {
    record.consecutiveFailures += 1;
    logger.warn(
      { domain, consecutiveFailures: record.consecutiveFailures, threshold: CONSECUTIVE_FAILURE_THRESHOLD },
      `[circuit-breaker] Delivery failure (${record.consecutiveFailures}/${CONSECUTIVE_FAILURE_THRESHOLD})`,
    );

    if (record.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
      // 5 consecutive failures -> TRIP BREAKER TO OPEN
      record.state = CB_STATES.OPEN;
      record.openedAt = Date.now();
      record.lastProbeTime = Date.now();
      record.consecutiveSuccesses = 0;

      await setBreakerRecord(redis, domain, record);

      // Alert merchant via dashboard notification
      await alertMerchantCircuitBreakerOpen({
        domain,
        merchantUsername,
        prisma,
        redis,
        failures: record.consecutiveFailures,
      });

      return record;
    }
  }

  await setBreakerRecord(redis, domain, record);
  return record;
};

/**
 * Sends a single probe request to a merchant endpoint.
 * Called every 60s when circuit breaker is in OPEN/HALF_OPEN state.
 */
const sendProbeRequest = async (webhook, { redis, prisma, sendWebhookFn } = {}) => {
  const domain = getDestinationDomain(webhook.url);
  const probePayload = {
    event: 'probe.health_check',
    event_id: `probe-${domain}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    network: process.env.HORIZON_NETWORK || 'testnet',
    data: {
      type: 'probe',
      domain,
      probe_time: new Date().toISOString(),
    },
  };

  const sender = sendWebhookFn || require('../webhookWorker').sendWebhook;
  const start = Date.now();
  try {
    const res = await sender(webhook.url, probePayload, webhook.secret);
    const latency = Date.now() - start;
    const record = await handleDeliverySuccess(redis, domain, latency, {
      prisma,
      merchantUsername: webhook.username,
    });
    return { ok: true, latency, state: record.state };
  } catch (err) {
    const latency = Date.now() - start;
    const record = await handleDeliveryFailure(redis, domain, err, latency, {
      prisma,
      merchantUsername: webhook.username,
    });
    return { ok: false, error: err.message, latency, state: record.state };
  }
};

/**
 * Cycles through webhooks whose domain breaker is OPEN or HALF_OPEN and eligible for probing (every 60 seconds).
 */
const runProbeCycle = async ({ prisma, redis, sendWebhookFn } = {}) => {
  if (!prisma) return [];

  try {
    const openWebhooks = await prisma.webhook.findMany({
      where: { failingSince: { not: null } },
      select: { id: true, url: true, secret: true, username: true },
    });

    const probeResults = [];
    const probedDomains = new Set();

    for (const webhook of openWebhooks) {
      const domain = getDestinationDomain(webhook.url);
      if (probedDomains.has(domain)) continue;

      const check = await canQueueDelivery(redis, domain);
      if (check.canProbe) {
        const won = await acquireProbeSlot(redis, domain);
        if (won) {
          probedDomains.add(domain);
          const result = await sendProbeRequest(webhook, { redis, prisma, sendWebhookFn });
          probeResults.push({ domain, webhookId: webhook.id, ...result });
        }
      }
    }

    return probeResults;
  } catch (err) {
    logger.error({ err: err.message }, '[circuit-breaker] Error running probe cycle');
    return [];
  }
};

/**
 * Starts a recurring background probe interval (every 60 seconds by default).
 */
let probeTimer = null;
const startProbeScheduler = ({ prisma, redis, intervalMs = PROBE_INTERVAL_MS, sendWebhookFn } = {}) => {
  if (probeTimer) return probeTimer;
  probeTimer = setInterval(() => {
    runProbeCycle({ prisma, redis, sendWebhookFn }).catch((err) => {
      logger.error({ err: err.message }, '[circuit-breaker] Scheduled probe cycle failed');
    });
  }, intervalMs);
  if (typeof probeTimer.unref === 'function') probeTimer.unref();
  return probeTimer;
};

const stopProbeScheduler = () => {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
};

/**
 * Resets the circuit breaker state to CLOSED (useful for administrative overrides or tests).
 */
const resetCircuitBreaker = async (redis, domain) => {
  const record = {
    state: CB_STATES.CLOSED,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastProbeTime: 0,
    openedAt: 0,
    probing: false,
  };
  await setBreakerRecord(redis, domain, record);
  return record;
};

/**
 * Clear in-memory caches (for testing)
 */
const clearMemoryCache = () => {
  memoryState.clear();
  memoryMetrics.clear();
  memoryRateLimiter.clear();
};

module.exports = {
  CB_STATES,
  CONSECUTIVE_FAILURE_THRESHOLD,
  CONSECUTIVE_SUCCESS_THRESHOLD,
  PROBE_INTERVAL_MS,
  RATE_LIMIT_CAPACITY,
  RATE_LIMIT_REFILL_PER_SEC,
  BASE_BACKOFF_MS,
  DASHBOARD_NOTIFICATION_CHANNEL,
  getDestinationDomain,
  getBreakerRecord,
  canQueueDelivery,
  acquireProbeSlot,
  handleDeliverySuccess,
  handleDeliveryFailure,
  recordDeliveryMetrics,
  getDeliveryMetrics,
  consumeToken,
  calculateExponentialBackoff,
  alertMerchantCircuitBreakerOpen,
  sendProbeRequest,
  runProbeCycle,
  startProbeScheduler,
  stopProbeScheduler,
  resetCircuitBreaker,
  clearMemoryCache,
};
