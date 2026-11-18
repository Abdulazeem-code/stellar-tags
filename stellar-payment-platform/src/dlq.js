'use strict';

/**
 * src/dlq.js
 *
 * Dead letter queue for payment retry jobs.
 *
 * A job that exhausts its attempts is moved here instead of being dropped, so
 * the original payload, the id it had on the main queue, how many attempts were
 * made, and why it failed all survive the failure. Operators can then list,
 * inspect, replay or discard those messages through the admin routes.
 *
 * Redis is optional in this service, so every entry point degrades to a logged
 * warning and a `null` queue when neither REDIS_URL nor REDIS_CLUSTER_NODES is
 * set. Nothing here connects at require time, so startup and /health are
 * unaffected either way.
 */

const crypto = require('crypto');
const { Queue } = require('bullmq');
const { createRedisConnection } = require('./config/redis');
const { logger } = require('./logger');
const { dlqMessagesTotal } = require('./metrics');
const { ApiError } = require('./errors');
const { redactSensitiveData } = require('./middleware/auditLog');

const DLQ_QUEUE_NAME = 'payment-retries-dlq';

// Sane defaults; every one of these is overridable per environment so an
// operator can widen the retry window without a code change.
const parseEnvInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
};

const MAX_RETRY_ATTEMPTS = parseEnvInt(process.env.MAX_RETRY_ATTEMPTS, 5);
const RETRY_BACKOFF_MS = parseEnvInt(process.env.RETRY_BACKOFF_MS, 1_000);
const DLQ_ALERT_THRESHOLD = parseEnvInt(process.env.DLQ_ALERT_THRESHOLD, 10);
const DLQ_ALERT_COOLDOWN_MS = parseEnvInt(process.env.DLQ_ALERT_COOLDOWN_MS, 300_000);

// A stack is diagnostic context, not a payload, and a long one is mostly
// framework frames. Keeping a bounded prefix stops one pathological error from
// dominating the Redis memory the DLQ costs.
const MAX_STACK_LENGTH = 2_000;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_REPLAY_BATCH_SIZE = parseEnvInt(process.env.DLQ_REPLAY_BATCH_LIMIT, 100);

let dlqConnection;
let dlqQueue;
/** name -> Queue, so replaying back onto a main queue reuses one connection. */
const mainQueues = new Map();

let lastAlertAt = 0;
let alertArmed = true;

// The clock is injectable so the rate limiter can be tested without waiting out
// a five minute cooldown.
let now = () => Date.now();

/** Redis is optional, so "configured" has to be asked of the environment. */
const isRedisConfigured = () =>
  Boolean(process.env.REDIS_URL || process.env.REDIS_CLUSTER_NODES);

const isDlqAvailable = () => isRedisConfigured();

const truncateStack = (stack) => {
  if (typeof stack !== 'string' || stack.length === 0) return null;
  return stack.length > MAX_STACK_LENGTH
    ? `${stack.slice(0, MAX_STACK_LENGTH)}...[truncated]`
    : stack;
};

const getConnection = () => {
  if (!dlqConnection) dlqConnection = createRedisConnection();
  return dlqConnection;
};

const getMainQueue = (name) => {
  if (!mainQueues.has(name)) {
    const queue = new Queue(name, { connection: getConnection() });
    queue.on('error', (error) => {
      logger.error(`[dlq] Redis error on queue ${name}: ${error.message}`);
    });
    mainQueues.set(name, queue);
  }
  return mainQueues.get(name);
};

/**
 * The DLQ queue, or `null` when Redis is not configured. Callers must handle
 * the null case; that is what keeps a Redis-less deployment serving traffic.
 */
const getDlqQueue = () => {
  if (!isRedisConfigured()) return null;
  if (!dlqQueue) {
    dlqQueue = new Queue(DLQ_QUEUE_NAME, { connection: getConnection() });
    dlqQueue.on('error', (error) => {
      logger.error(`[dlq] Redis error: ${error.message}`);
    });
  }
  return dlqQueue;
};

/**
 * Log an error when the DLQ has grown past the threshold. The alert re-arms
 * once the depth falls back below it, and a cooldown keeps a queue that stays
 * over the line from writing one log line per failed job.
 *
 * @returns {boolean} whether an alert was emitted
 */
const maybeAlertOnDepth = (depth) => {
  if (depth < DLQ_ALERT_THRESHOLD) {
    alertArmed = true;
    return false;
  }

  const at = now();
  if (!alertArmed && at - lastAlertAt < DLQ_ALERT_COOLDOWN_MS) return false;

  lastAlertAt = at;
  alertArmed = false;
  logger.error(
    `[dlq] Depth ${depth} is at or above DLQ_ALERT_THRESHOLD ${DLQ_ALERT_THRESHOLD}; ` +
      'inspect with GET /admin/dlq and replay with POST /admin/dlq/replay',
  );
  return true;
};

/** Current DLQ depth. Reports 0 when Redis is not configured. */
const getDlqDepth = async () => {
  const queue = getDlqQueue();
  if (!queue) return 0;

  try {
    const depth = await queue.getWaitingCount();
    maybeAlertOnDepth(depth);
    return depth;
  } catch (error) {
    // A scrape must never fail because the DLQ is unreachable.
    logger.error(`[dlq] Failed to read DLQ depth: ${error.message}`);
    return 0;
  }
};

/**
 * Move an exhausted job into the dead letter queue.
 *
 * Returns `null` when Redis is not configured so the caller can fall back to
 * its previous behaviour instead of dropping the job on the floor.
 *
 * @param {object} job BullMQ job from the main queue
 * @param {Error} error the failure that exhausted the attempts
 */
const routeToDlq = async (job, error) => {
  const queue = getDlqQueue();
  if (!queue) return null;

  const attemptsMade = job?.attemptsMade || 0;
  const maxAttempts = job?.opts?.attempts || MAX_RETRY_ATTEMPTS;

  const message = {
    originalJobId: job?.id ? String(job.id) : null,
    queue: job?.queueName || null,
    jobName: job?.name || null,
    payload: job?.data ?? null,
    attemptsMade,
    maxAttempts,
    failureReason: error?.message ? String(error.message) : 'Unknown error',
    stack: truncateStack(error?.stack),
    failedAt: new Date().toISOString(),
  };

  const dlqJob = await queue.add(
    'dead-letter',
    message,
    // A DLQ entry is parked, never retried, and must outlive any retention
    // window an operator might set elsewhere.
    { jobId: `dlq-${crypto.randomUUID()}`, attempts: 1, removeOnComplete: false, removeOnFail: false },
  );

  dlqMessagesTotal.inc();
  logger.error(
    `[dlq] Moved job=${message.originalJobId} queue=${message.queue} to DLQ after ` +
      `${attemptsMade}/${maxAttempts} attempts: ${message.failureReason}`,
  );
  await getDlqDepth();

  return { id: dlqJob.id, ...message };
};

/** Shape a stored DLQ job into the message the API speaks in. */
const toMessage = (job) => ({
  id: job.id,
  originalJobId: job.data?.originalJobId ?? null,
  queue: job.data?.queue ?? null,
  jobName: job.data?.jobName ?? null,
  payload: redactSensitiveData(job.data?.payload ?? null),
  attemptsMade: job.data?.attemptsMade ?? 0,
  maxAttempts: job.data?.maxAttempts ?? null,
  failureReason: job.data?.failureReason ?? null,
  stack: job.data?.stack ?? null,
  failedAt: job.data?.failedAt ?? null,
});

const requireQueue = () => {
  const queue = getDlqQueue();
  if (!queue) {
    throw new ApiError(
      'SERVICE_UNAVAILABLE',
      'The dead letter queue requires Redis; set REDIS_URL or REDIS_CLUSTER_NODES',
    );
  }
  return queue;
};

/** Whether a stored message belongs to a given merchant. */
const messageBelongsTo = (job, username) => {
  if (!username) return true;
  const owner =
    job.data?.payload?.webhook?.username ??
    job.data?.payload?.username ??
    job.data?.username;
  return typeof owner === 'string' && owner.toLowerCase() === username.toLowerCase();
};

/**
 * One page of DLQ messages, newest first. An empty page is returned (rather
 * than an error) when Redis is not configured, so the admin view still renders.
 *
 * `total` always describes the same set as `messages`. That is free for the
 * unfiltered case, where BullMQ counts the queue directly, but a username
 * filter has no index to count against, so the queue is walked in full and the
 * page is cut from the matches. A DLQ is an operator-drained queue, so that
 * cost is paid on an explicit filtered request rather than on every scrape.
 *
 * @param {{ limit?: number, page?: number, username?: string }} options
 */
const listDlqMessages = async ({ limit = DEFAULT_PAGE_SIZE, page = 1, username } = {}) => {
  const queue = getDlqQueue();
  if (!queue) {
    return { available: false, messages: [], total: 0, page, limit };
  }

  const take = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
  const current = Math.max(page, 1);

  if (!username) {
    const start = (current - 1) * take;
    const [jobs, total] = await Promise.all([
      queue.getJobs(['waiting'], start, start + take - 1, false),
      queue.getWaitingCount(),
    ]);
    return { available: true, messages: jobs.map(toMessage), total, page: current, limit: take };
  }

  const all = await queue.getJobs(['waiting'], 0, -1, false);
  const matched = all.filter((job) => messageBelongsTo(job, username));
  const start = (current - 1) * take;

  return {
    available: true,
    messages: matched.slice(start, start + take).map(toMessage),
    total: matched.length,
    page: current,
    limit: take,
  };
};

const getDlqMessage = async (id) => {
  const queue = requireQueue();
  const job = await queue.getJob(id);
  if (!job) throw new ApiError('NOT_FOUND', `DLQ message ${id} not found`);
  return toMessage(job);
};

/** Job options for a replayed job: a full, reset attempt budget. */
const replayJobOptions = (originalJobId) => ({
  attempts: MAX_RETRY_ATTEMPTS,
  backoff: { type: 'exponential', delay: RETRY_BACKOFF_MS },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
  // BullMQ rejects `:` in custom ids, and the original id may still be sitting
  // in the main queue's failed set, so a replay gets its own id.
  jobId: `${originalJobId || 'replay'}-replay-${Date.now()}`,
});

/**
 * Re-enqueue one DLQ message onto the main queue it came from and drop it from
 * the DLQ. The replayed job starts with a full attempt budget.
 */
const replayDlqMessage = async (id) => {
  const queue = requireQueue();
  const job = await queue.getJob(id);
  if (!job) throw new ApiError('NOT_FOUND', `DLQ message ${id} not found`);

  const message = job.data || {};
  const targetName = message.queue || job.queueName;
  if (!targetName) {
    throw new ApiError('CONFLICT', `DLQ message ${id} does not record a source queue`);
  }

  const mainQueue = getMainQueue(targetName);
  const replayed = await mainQueue.add(
    message.jobName || 'deliver',
    message.payload,
    replayJobOptions(message.originalJobId),
  );

  await job.remove();
  logger.info(`[dlq] Replayed message=${id} job=${replayed.id} onto queue=${targetName}`);

  return { id, replayedJobId: replayed.id, queue: targetName };
};

/**
 * Replay a batch of DLQ messages, optionally narrowed to one merchant.
 * The batch is capped so a single request cannot flood the main queue.
 *
 * @returns {{ replayed: string[], failed: Array<{id: string, error: string}>, capped: boolean }}
 */
const replayDlqMessages = async ({ limit = MAX_REPLAY_BATCH_SIZE, username } = {}) => {
  const queue = requireQueue();
  const take = Math.min(Math.max(limit, 1), MAX_REPLAY_BATCH_SIZE);

  const jobs = await queue.getJobs(['waiting'], 0, take - 1, false);
  const candidates = jobs.filter((job) => messageBelongsTo(job, username));

  const replayed = [];
  const failed = [];

  for (const job of candidates) {
    try {
      const result = await replayDlqMessage(job.id);
      replayed.push(result.replayedJobId);
    } catch (error) {
      failed.push({ id: job.id, error: error.message });
    }
  }

  logger.info(`[dlq] Bulk replay requested: replayed=${replayed.length} failed=${failed.length}`);

  return { replayed, failed, capped: jobs.length >= take };
};

/** Permanently drop one DLQ message. */
const discardDlqMessage = async (id) => {
  const queue = requireQueue();
  const job = await queue.getJob(id);
  if (!job) throw new ApiError('NOT_FOUND', `DLQ message ${id} not found`);

  await job.remove();
  logger.info(`[dlq] Discarded message=${id}`);

  return { id, discarded: true };
};

/**
 * Whether any DLQ connection is currently open. Lets a caller skip the await
 * on close entirely when the DLQ was never used, so shutdown does not pay for
 * an async hop it does not need.
 */
const hasOpenDlqQueues = () => Boolean(dlqQueue || dlqConnection || mainQueues.size);

/** Release the DLQ connection and every queue built on it. */
const closeDlqQueue = async () => {
  const queues = [dlqQueue, ...mainQueues.values()].filter(Boolean);
  await Promise.all(queues.map((queue) => queue.close()));

  if (dlqConnection) await dlqConnection.quit();

  mainQueues.clear();
  dlqQueue = undefined;
  dlqConnection = undefined;
};

// The depth source is registered by server.js, the composition root, so that
// requiring this module has no side effect. Doing it here instead would break
// any caller that supplies its own metrics module.
module.exports = {
  DLQ_QUEUE_NAME,
  MAX_RETRY_ATTEMPTS,
  RETRY_BACKOFF_MS,
  DLQ_ALERT_THRESHOLD,
  DLQ_ALERT_COOLDOWN_MS,
  MAX_STACK_LENGTH,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_REPLAY_BATCH_SIZE,
  isRedisConfigured,
  isDlqAvailable,
  getDlqQueue,
  getDlqDepth,
  hasOpenDlqQueues,
  maybeAlertOnDepth,
  routeToDlq,
  listDlqMessages,
  getDlqMessage,
  replayDlqMessage,
  replayDlqMessages,
  discardDlqMessage,
  closeDlqQueue,
  truncateStack,
  toMessage,
  replayJobOptions,
  // Test seams.
  _setNow: (fn) => { now = fn; },
  _resetAlertState: () => { lastAlertAt = 0; alertArmed = true; },
};
