'use strict';

/**
 * src/dlqWorker.js
 *
 * Automated Dead Letter Queue (DLQ) recovery consumer.
 *
 * Processes messages from the DLQ queue with an exponential backoff schedule:
 * 1st retry: 1 hour delay
 * 2nd retry: 6 hours delay
 * 3rd retry: 24 hours delay
 *
 * After 3 failed retries (24h), the message is moved to permanent archive
 * (discarded from DLQ and logged for manual investigation).
 */

const { Worker, Queue } = require('bullmq');
const { createRedisConnection } = require('./config/redis');
const { logger } = require('./logger');
const {
  DLQ_QUEUE_NAME,
  getConnection,
  getMainQueue,
  getDlqQueue,
  closeDlqQueue,
  isDlqAvailable,
  routeToDlq,
} = require('./dlq');

const DLQ_WORKER_CONCURRENCY = 1;

const BACKOFF_SCHEDULE_MS = [
  1 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];

const MAX_DLQ_RETRIES = BACKOFF_SCHEDULE_MS.length;

let dlqWorker;
let workerConnection;

const getDlqWorkerQueue = () => {
  const queue = getDlqQueue();
  if (!queue) return null;
  return queue;
};

const processDlqJob = async (job) => {
  const data = job.data || {};
  const dlqAttempt = data.dlqAttempt ?? 0;

  if (dlqAttempt >= MAX_DLQ_RETRIES) {
    logger.warn(
      `[dlq-worker] Message ${job.id} exceeded max DLQ retries (${MAX_DLQ_RETRIES}), archiving permanently`,
    );
    await job.remove();
    return { archived: true, jobId: job.id };
  }

  const delayMs = BACKOFF_SCHEDULE_MS[dlqAttempt];
  const targetQueueName = data.queue;
  const targetJobName = data.jobName || 'deliver';

  if (!targetQueueName) {
    logger.error(`[dlq-worker] Message ${job.id} has no source queue, discarding`);
    await job.remove();
    return { discarded: true, jobId: job.id, reason: 'no source queue' };
  }

  const mainQueue = getMainQueue(targetQueueName);
  const originalJobId = data.originalJobId || `dlq-${job.id}`;

  await mainQueue.add(
    targetJobName,
    data.payload,
    {
      attempts: data.maxAttempts || 5,
      backoff: { type: 'exponential', delay: data.backoffDelay || 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
      jobId: `${originalJobId}-dlq-retry-${dlqAttempt + 1}-${Date.now()}`,
    },
  );

  const nextAttempt = dlqAttempt + 1;
  await job.updateData({ ...data, dlqAttempt: nextAttempt });

  logger.info(
    `[dlq-worker] Re-queued message ${job.id} to ${targetQueueName} (DLQ attempt ${nextAttempt}/${MAX_DLQ_RETRIES}, next retry in ${delayMs}ms)`,
  );

  await job.moveToDelayed(Date.now() + delayMs, true);

  return { requeued: true, jobId: job.id, dlqAttempt: nextAttempt };
};

const startDlqWorker = () => {
  if (dlqWorker) return dlqWorker;

  if (!isDlqAvailable()) {
    logger.warn('[dlq-worker] Redis not configured, skipping DLQ worker startup');
    return null;
  }

  workerConnection = createRedisConnection();
  dlqWorker = new Worker(
    DLQ_QUEUE_NAME,
    async (job) => processDlqJob(job),
    {
      connection: workerConnection,
      concurrency: DLQ_WORKER_CONCURNCY,
    },
  );

  dlqWorker.on('completed', (job) => {
    logger.debug(`[dlq-worker] Job ${job.id} completed`);
  });

  dlqWorker.on('failed', (job, error) => {
    logger.error(`[dlq-worker] Job ${job?.id} failed: ${error.message}`);
  });

  dlqWorker.on('error', (error) => {
    logger.error(`[dlq-worker] Redis error: ${error.message}`);
  });

  logger.info(
    `[dlq-worker] Started queue=${DLQ_QUEUE_NAME} concurrency=${DLQ_WORKER_CONCURRENCY} ` +
      `backoffSchedule=[${BACKOFF_SCHEDULE_MS.map((ms) => `${ms / 3600000}h`).join(', ')}]`,
  );

  return dlqWorker;
};

const closeDlqWorker = async () => {
  if (dlqWorker) {
    await dlqWorker.close();
    dlqWorker = undefined;
  }
  if (workerConnection) {
    await workerConnection.quit();
    workerConnection = undefined;
  }
};

const triggerManualReplay = async ({ limit = 100, username } = {}) => {
  const queue = getDlqWorkerQueue();
  if (!queue) {
    throw new Error('DLQ not available (Redis not configured)');
  }

  const take = Math.min(Math.max(limit, 1), 100);
  const jobs = await queue.getJobs(['waiting', 'delayed'], 0, take - 1, false);
  const candidates = jobs.filter((job) => {
    if (!username) return true;
    const owner =
      job.data?.payload?.webhook?.username ??
      job.data?.payload?.username ??
      job.data?.username;
    return typeof owner === 'string' && owner.toLowerCase() === username.toLowerCase();
  });

  const results = { replayed: [], failed: [] };
  let replayCounter = 0;

  for (const job of candidates) {
    try {
      const data = job.data || {};
      const targetQueueName = data.queue;
      const targetJobName = data.jobName || 'deliver';
      const originalJobId = data.originalJobId || `dlq-${job.id}`;

      if (!targetQueueName) {
        results.failed.push({ id: job.id, error: 'No source queue recorded' });
        continue;
      }

      const mainQueue = getMainQueue(targetQueueName);
      replayCounter += 1;
      await mainQueue.add(
        targetJobName,
        data.payload,
        {
          attempts: data.maxAttempts || 5,
          backoff: { type: 'exponential', delay: data.backoffDelay || 1000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
          jobId: `${originalJobId}-manual-replay-${replayCounter}-${Date.now()}`,
        },
      );

      await job.remove();
      results.replayed.push(job.id);
      logger.info(`[dlq-worker] Manual replay: message ${job.id} re-queued to ${targetQueueName}`);
    } catch (error) {
      results.failed.push({ id: job.id, error: error.message });
      logger.error(`[dlq-worker] Manual replay failed for ${job.id}: ${error.message}`);
    }
  }

  return results;
};

module.exports = {
  DLQ_WORKER_CONCURRENCY,
  BACKOFF_SCHEDULE_MS,
  MAX_DLQ_RETRIES,
  startDlqWorker,
  closeDlqWorker,
  triggerManualReplay,
  processDlqJob,
  getDlqWorkerQueue,
};