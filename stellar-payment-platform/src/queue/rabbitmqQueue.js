'use strict';

/**
 * RabbitMQ-backed job queue for the webhook delivery pipeline.
 *
 * This module replaces the previous Redis/BullMQ transport. It exposes a small
 * BullMQ-compatible surface (`Queue` / `Worker` with `add` / `on` / `close`)
 * so the worker code could migrate without rewriting its delivery, retry and
 * dead-letter semantics.
 *
 * Durability / no-loss guarantees:
 *   - a `topic` exchange (`stellar.webhooks`) provides routing keys per event,
 *   - persistent messages on durable queues survive a broker restart,
 *   - publishers use a confirm channel and await `waitForConfirms()` before the
 *     enqueue is considered successful,
 *   - a dedicated retry queue re-delivers with bounded exponential backoff via
 *     per-message TTL, and
 *   - messages that exhaust their attempts are dead-lettered to a durable DLQ.
 */

const amqp = require('amqplib');
const { logger } = require('../logger');

const DEFAULT_RABBITMQ_URL = 'amqp://127.0.0.1:5672';

const DELIVERIES_EXCHANGE = 'stellar.webhooks';
const DELIVERIES_EXCHANGE_TYPE = 'topic';
const DLX_EXCHANGE = 'stellar.webhooks.dlx';

const WORK_QUEUE = 'webhook-deliveries';
const RETRY_QUEUE = 'webhook-deliveries.retry';
const DEAD_LETTER_QUEUE = 'webhook-deliveries.dlq';

/** Every webhook event routes under this prefix, e.g. `webhook.payment.received`. */
const ROUTING_PREFIX = 'webhook.';

/** Header that carries the number of delivery attempts already made. */
const ATTEMPTS_HEADER = 'x-attempts';

/** Upper bound for the exponential retry delay. */
const MAX_RETRY_DELAY_MS = 60_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rabbitmqUrl = () => process.env.RABBITMQ_URL || DEFAULT_RABBITMQ_URL;

/** Routing key for a webhook event name (`payment.received` -> `webhook.payment.received`). */
const routingKeyForEvent = (eventName) => {
  const normalized =
    typeof eventName === 'string' && eventName.trim() ? eventName.trim().toLowerCase() : 'deliver';
  return `${ROUTING_PREFIX}${normalized}`;
};

// ── connection management ─────────────────────────────────────────────────

let connection = null;
let connectionPromise = null;

/**
 * Open (or reuse) the shared AMQP connection. Transient connect failures are
 * retried with a bounded backoff so a slow broker start does not crash the
 * process; once the connection closes, the cached handle is cleared so the
 * next operation reconnects instead of reusing a dead socket.
 */
const connect = async () => {
  if (connection) return connection;
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    let attempt = 0;
    for (;;) {
      try {
        const conn = await amqp.connect(rabbitmqUrl(), { heartbeat: 30 });
        conn.on('error', (error) => logger.error(`[rabbitmq] connection error: ${error.message}`));
        conn.on('close', () => {
          if (connection === conn) connection = null;
          connectionPromise = null;
        });
        connection = conn;
        return conn;
      } catch (error) {
        attempt += 1;
        if (attempt >= 5) {
          connectionPromise = null;
          throw error;
        }
        logger.warn(`[rabbitmq] connect failed (${error.message}); retry ${attempt}/5`);
        await defaultSleep(Math.min(500 * 2 ** attempt, 5_000));
      }
    }
  })();

  return connectionPromise;
};

const createChannel = async ({ confirm = false } = {}) => {
  const conn = await connect();
  const channel = confirm ? await conn.createConfirmChannel() : await conn.createChannel();
  channel.on('error', (error) => logger.error(`[rabbitmq] channel error: ${error.message}`));
  return channel;
};

/**
 * Declare the durable topology. Declarations are idempotent, so every channel
 * can call this before use and a broker restart (which drops non-durable state)
 * is repaired automatically.
 */
const assertTopology = async (channel) => {
  await channel.assertExchange(DELIVERIES_EXCHANGE, DELIVERIES_EXCHANGE_TYPE, { durable: true });
  await channel.assertExchange(DLX_EXCHANGE, 'fanout', { durable: true });

  // Retry queue: messages carry a per-message TTL and, once expired, are
  // dead-lettered back onto the main exchange to be redelivered.
  await channel.assertQueue(RETRY_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': DELIVERIES_EXCHANGE,
      'x-dead-letter-routing-key': `${ROUTING_PREFIX}deliver`,
    },
  });

  // Terminal dead-letter queue for messages that exhausted their attempts.
  await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
  await channel.bindQueue(DEAD_LETTER_QUEUE, DLX_EXCHANGE, '');

  await channel.assertQueue(WORK_QUEUE, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': DLX_EXCHANGE },
  });
  await channel.bindQueue(WORK_QUEUE, DELIVERIES_EXCHANGE, `${ROUTING_PREFIX}#`);

  return channel;
};

/** Close the shared connection (used on graceful shutdown / tests). */
const closeRabbitMQ = async () => {
  const conn = connection;
  connection = null;
  connectionPromise = null;
  if (conn) await conn.close().catch(() => {});
};

// ── publisher ────────────────────────────────────────────────────────────

/**
 * BullMQ-shaped producer. `add(jobName, data, opts)` publishes one persistent
 * message and resolves only after the broker confirms it.
 */
class Queue {
  constructor(name = WORK_QUEUE, options = {}) {
    this.name = name;
    this.options = options;
    this._handlers = {};
    this._channelPromise = null;
  }

  on(event, handler) {
    (this._handlers[event] = this._handlers[event] || []).push(handler);
    return this;
  }

  _emit(event, ...args) {
    for (const handler of this._handlers[event] || []) {
      try {
        handler(...args);
      } catch (error) {
        logger.error(`[rabbitmq] queue '${event}' handler failed: ${error.message}`);
      }
    }
  }

  async _channel() {
    if (!this._channelPromise) {
      this._channelPromise = (async () => {
        const channel = await createChannel({ confirm: true });
        await assertTopology(channel);
        return channel;
      })().catch((error) => {
        this._channelPromise = null;
        throw error;
      });
    }
    return this._channelPromise;
  }

  async add(jobName, data, opts = {}) {
    const channel = await this._channel();
    const message = {
      name: jobName || 'deliver',
      data,
      opts,
      attemptsMade: 0,
      enqueuedAt: new Date().toISOString(),
    };
    const routingKey =
      opts.routingKey || routingKeyForEvent((data && data.payload && data.payload.event) || jobName);
    const published = channel.publish(
      DELIVERIES_EXCHANGE,
      routingKey,
      Buffer.from(JSON.stringify(message)),
      {
        persistent: true,
        contentType: 'application/json',
        contentEncoding: 'utf-8',
        messageId: opts.jobId || undefined,
        timestamp: Date.now(),
        headers: { [ATTEMPTS_HEADER]: 0 },
      },
    );
    if (!published) {
      await new Promise((resolve) => channel.once('drain', resolve));
    }
    // Await the broker ack so a caller never observes success for a message
    // that was not durably accepted (this is the "no jobs lost" guarantee).
    await channel.waitForConfirms();
    return { id: opts.jobId || null };
  }

  async close() {
    if (!this._channelPromise) return;
    const channel = await this._channelPromise.catch(() => null);
    this._channelPromise = null;
    if (channel) await channel.close().catch(() => {});
  }
}

// ── consumer ─────────────────────────────────────────────────────────────

/**
 * BullMQ-shaped consumer. Runs the processor with a fixed concurrency,
 * acknowledges successful jobs, republishes transient failures onto the retry
 * queue with exponential backoff, and dead-letters jobs that exhausted their
 * attempts.
 */
class Worker {
  constructor(name = WORK_QUEUE, processor, options = {}) {
    if (typeof processor !== 'function') {
      throw new TypeError('Worker requires a processor function');
    }
    this.name = name;
    this.processor = processor;
    this.options = options || {};
    this.concurrency = Math.max(1, this.options.concurrency || 1);
    this._handlers = {};
    this.channel = null;
    this.consumerTag = null;
    this._ready = this._start();
    this._ready.catch((error) => this._emit('error', error));
  }

  on(event, handler) {
    (this._handlers[event] = this._handlers[event] || []).push(handler);
    return this;
  }

  _emit(event, ...args) {
    for (const handler of this._handlers[event] || []) {
      try {
        handler(...args);
      } catch (error) {
        logger.error(`[rabbitmq] worker '${event}' handler failed: ${error.message}`);
      }
    }
  }

  async _start() {
    const channel = await createChannel();
    await assertTopology(channel);
    await channel.prefetch(this.concurrency);
    this.channel = channel;
    const { consumerTag } = await channel.consume(
      WORK_QUEUE,
      (message) => {
        if (message) this._handle(message);
      },
      { noAck: false },
    );
    this.consumerTag = consumerTag;
    return this;
  }

  /** Exposed so callers can await readiness before publishing traffic. */
  async ready() {
    await this._ready;
    return this;
  }

  _handle(message) {
    let parsed;
    try {
      parsed = JSON.parse(message.content.toString('utf8'));
    } catch (error) {
      logger.error(`[rabbitmq] dropping unparseable message: ${error.message}`);
      this.channel.nack(message, false, false);
      return;
    }

    const jobOpts = parsed.opts || {};
    const maxAttempts = Number(jobOpts.attempts) || 1;
    const attemptsMade = Number((message.properties.headers || {})[ATTEMPTS_HEADER] || 0) + 1;
    const job = {
      id: message.properties.messageId || null,
      name: parsed.name,
      data: parsed.data,
      opts: jobOpts,
      attemptsMade,
    };

    Promise.resolve()
      .then(() => this.processor(job))
      .then(() => {
        this.channel.ack(message);
        this._emit('completed', job);
      })
      .catch((error) => this._onFailure(parsed, message, job, maxAttempts, error));
  }

  _onFailure(parsed, message, job, maxAttempts, error) {
    this._emit('failed', job, error);

    if (job.attemptsMade >= maxAttempts) {
      logger.error(
        `[rabbitmq] job ${job.id || job.name} exhausted retries (${job.attemptsMade}/${maxAttempts}); routing to DLQ`,
      );
      // requeue=false -> dead-letter exchange -> durable DLQ.
      this.channel.nack(message, false, false);
      return;
    }

    const jobOpts = parsed.opts || {};
    const baseDelayMs = Number(jobOpts.backoff && jobOpts.backoff.delay) || 1_000;
    const delayMs = Math.min(baseDelayMs * 2 ** (job.attemptsMade - 1), MAX_RETRY_DELAY_MS);
    const retryPayload = Buffer.from(JSON.stringify({ ...parsed, attemptsMade: job.attemptsMade }));

    try {
      this.channel.publish('', RETRY_QUEUE, retryPayload, {
        persistent: true,
        contentType: 'application/json',
        messageId: message.properties.messageId,
        expiration: String(delayMs),
        headers: { [ATTEMPTS_HEADER]: job.attemptsMade },
      });
      // Ack the original only after the retry copy is on the wire; if the
      // publish throws, the original is requeued instead of being dropped.
      this.channel.ack(message);
    } catch (publishError) {
      logger.error(`[rabbitmq] failed to schedule retry: ${publishError.message}; requeueing`);
      this.channel.nack(message, false, true);
    }
  }

  async close() {
    await this._ready.catch(() => {});
    if (this.channel) {
      if (this.consumerTag) await this.channel.cancel(this.consumerTag).catch(() => {});
      await this.channel.close().catch(() => {});
      this.channel = null;
    }
  }
}

// ── generic transient retry (replaces the Redis-specific helper) ─────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for socket/broker errors where a retry can plausibly succeed. */
const isTransientQueueError = (error) => {
  if (!error) return false;
  const code = String(error.code || '');
  if (
    ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'CONNECTION_BROKEN'].includes(
      code,
    )
  ) {
    return true;
  }
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|Connection closed|channel closed/i.test(
    String(error.message || ''),
  );
};

/**
 * Run a queue-backed operation with bounded exponential backoff, retrying only
 * transient/connection errors. During a broker restart an enqueue that lands on
 * a dropped connection is retried against a fresh channel instead of failing.
 */
const withQueueRetry = async (
  operation,
  { attempts = 5, baseDelayMs = 50, sleep: sleepFn = sleep, onRetry } = {},
) => {
  if (typeof operation !== 'function') {
    throw new TypeError('withQueueRetry requires an operation function');
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientQueueError(error)) throw error;
      if (typeof onRetry === 'function') onRetry(error, attempt);
      await sleepFn(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
};

module.exports = {
  Queue,
  Worker,
  connect,
  createChannel,
  assertTopology,
  closeRabbitMQ,
  withQueueRetry,
  isTransientQueueError,
  routingKeyForEvent,
  rabbitmqUrl,
  DEFAULT_RABBITMQ_URL,
  DELIVERIES_EXCHANGE,
  DELIVERIES_EXCHANGE_TYPE,
  DLX_EXCHANGE,
  WORK_QUEUE,
  RETRY_QUEUE,
  DEAD_LETTER_QUEUE,
  ROUTING_PREFIX,
  ATTEMPTS_HEADER,
  MAX_RETRY_DELAY_MS,
};
