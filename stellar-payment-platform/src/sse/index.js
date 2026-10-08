// ---------------------------------------------------------------------------
// SSE Manager — Server-Sent Events for real-time payment status updates (#730)
// ---------------------------------------------------------------------------
// Replaces the former Socket.io WebSocket implementation. Status updates are
// strictly one-way (server → client), so plain HTTP responses keep the
// per-client cost at a single socket plus one map entry: no upgrade handshake,
// no frame protocol, no server-side ping bookkeeping. Reconnection is delegated
// to the browser's EventSource API, which retries natively (honouring the
// `retry:` hint below) and re-sends `Last-Event-ID` for free.
//
// Stream key: `payment:<paymentId>` — an opaque identifier that may be a
// Payment id or a PaymentIntent id; publishers decide which key they publish
// under and clients subscribe to the same key.
//
// Client event flow:
//   1. Client opens  GET /payments/<paymentId>/events   (EventSource).
//   2. Server registers the response under topic `payment:<paymentId>` and
//      emits `connected`, followed by a `snapshot` of the last known status so
//      a client that just (re)connected converges immediately.
//   3. A status change is published to the Redis channel
//      "stellar:payment:update" by whichever process detected it (e.g. the
//      Horizon listener) — or emitted directly when publisher and server share
//      a process.
//   4. Every response subscribed to that topic receives `payment-update`.
//
// Usage in server.js:
//   const { initSse, closeSse } = require('./src/sse');
//   initSse();          // subscribe to Redis (skipped when Redis is unconfigured)
//   closeSse();         // drain open streams during graceful shutdown
//
// Usage in horizonListener.js (or any other process):
//   const { publishPaymentUpdate } = require('./src/sse');
//   await publishPaymentUpdate(redisPublisher, paymentId, { status, ... });
// ---------------------------------------------------------------------------

'use strict';

const { createRedisConnection, isClusterMode } = require('../config/redis');
const { logger } = require('../logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Redis channel that carries cross-process payment update messages. */
const REDIS_CHANNEL = 'stellar:payment:update';

/** How often a `: keep-alive` comment is written to idle streams. */
const HEARTBEAT_INTERVAL_MS =
  Number.parseInt(process.env.SSE_HEARTBEAT_MS, 10) > 0
    ? Number.parseInt(process.env.SSE_HEARTBEAT_MS, 10)
    : 25_000;

/** Reconnection delay advertised to EventSource clients via `retry:`. */
const RETRY_MS = 3_000;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** @type {Map<string, Set<{req: import('http').IncomingMessage, res: import('http').ServerResponse, paymentId: string, topic: string}>>} */
const _clients = new Map();

/** @type {NodeJS.Timeout | null} */
let _heartbeatTimer = null;

/** @type {import('ioredis').Redis | null} — subscriber connection */
let _redisSub = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const _topicName = (paymentId) => `payment:${paymentId}`;

const _stopHeartbeat = () => {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
};

const _startHeartbeat = () => {
  if (_heartbeatTimer) return;
  _heartbeatTimer = setInterval(() => {
    for (const topic of [..._clients.values()]) {
      for (const client of [...topic]) {
        _write(client, ': keep-alive\n\n');
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Never hold the process open just for heartbeats.
  if (typeof _heartbeatTimer.unref === 'function') _heartbeatTimer.unref();
};

const _removeClient = (client) => {
  const topic = _clients.get(client.topic);
  if (!topic || !topic.delete(client)) return;
  if (topic.size === 0) _clients.delete(client.topic);
  if (_clients.size === 0) _stopHeartbeat();
};

/**
 * Write a chunk to one client, dropping the stream when the socket is already
 * gone so a dead connection can never wedge a broadcast.
 *
 * @returns {boolean} whether the chunk was written.
 */
const _write = (client, chunk) => {
  if (client.res.writableEnded || client.res.destroyed) {
    _removeClient(client);
    return false;
  }
  try {
    return client.res.write(chunk);
  } catch (err) {
    logger.warn(
      { err, paymentId: client.paymentId },
      '[sse] Failed to write to client; dropping stream',
    );
    _removeClient(client);
    return false;
  }
};

// ---------------------------------------------------------------------------
// Client registry
// ---------------------------------------------------------------------------

/**
 * Turn a plain HTTP response into an SSE stream and register it under the
 * payment's topic.
 *
 * Headers are flushed synchronously — before any async work — so the
 * `connect-timeout` middleware (which arms a 10s timer cleared by on-headers)
 * cannot abort a healthy stream and compression backs off via `no-transform`.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} paymentId
 * @returns {{req: import('http').IncomingMessage, res: import('http').ServerResponse, paymentId: string, topic: string}}
 */
const addClient = (req, res, paymentId) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tell reverse proxies (nginx) not to buffer the stream.
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (req.socket && typeof req.socket.setNoDelay === 'function') {
    req.socket.setNoDelay(true);
  }

  const client = { req, res, paymentId, topic: _topicName(paymentId) };

  let topic = _clients.get(client.topic);
  if (!topic) {
    topic = new Set();
    _clients.set(client.topic, topic);
  }
  topic.add(client);
  _startHeartbeat();

  const cleanup = () => _removeClient(client);
  res.on('close', cleanup);
  req.on('close', cleanup);

  // `retry:` tells EventSource how quickly to reconnect after a drop.
  res.write(`retry: ${RETRY_MS}\n\n`);
  res.write(`event: connected\ndata: ${JSON.stringify({ paymentId })}\n\n`);

  logger.info(
    { paymentId, clients: getSseClientCount() },
    '[sse] Client connected',
  );
  return client;
};

/**
 * Send a named SSE event to a single registered client.
 *
 * @param {{res: import('http').ServerResponse} | null} client
 * @param {string} event - SSE `event:` name (e.g. "snapshot", "payment-update").
 * @param {object} data  - JSON-serialised payload.
 * @returns {boolean} whether the event was written.
 */
const sendClientEvent = (client, event, data) => {
  if (!client) return false;
  return _write(client, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

/** @returns {number} total number of open SSE streams across all topics. */
const getSseClientCount = () => {
  let total = 0;
  for (const topic of _clients.values()) total += topic.size;
  return total;
};

/**
 * True for SSE stream paths, used to exempt them from the global token-bucket
 * limiter so an EventSource reconnect loop cannot consume a caller's REST
 * quota. Streams are bounded separately by a per-IP limiter in sseRoutes.
 *
 * @param {string} path
 * @returns {boolean}
 */
const isSseStreamPath = (path) =>
  /\/payments\/[^/]+\/events\/?$/.test(path || '');

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

/**
 * Emit a payment update to every stream subscribed to this payment, in-process.
 * Safe to call before initSse() — with no subscribers it simply delivers to
 * nobody.
 *
 * @param {string} paymentId - The payment id clients subscribed to.
 * @param {object} payload   - Update data (status, transactionHash, etc.).
 * @returns {number} number of clients the update was written to.
 */
const emitPaymentUpdate = (paymentId, payload = {}) => {
  if (!paymentId || typeof paymentId !== 'string') {
    logger.warn('[sse] emitPaymentUpdate called with invalid paymentId; skipping.');
    return 0;
  }

  const topic = _clients.get(_topicName(paymentId));
  if (!topic || topic.size === 0) return 0;

  const chunk = `event: payment-update\ndata: ${JSON.stringify({
    paymentId,
    ...payload,
  })}\n\n`;

  let delivered = 0;
  for (const client of [...topic]) {
    if (_write(client, chunk)) {
      // Lets the route skip a snapshot that would arrive after — and be older
      // than — a live update the client already received.
      client.receivedUpdate = true;
      delivered += 1;
    }
  }
  return delivered;
};

/**
 * Publish a payment status update to the Redis channel so every server process
 * subscribed via initSse() can forward it to its connected clients.
 *
 * Primary integration point for horizonListener.js: it holds a Redis
 * publisher, sends the message, and the API server handles delivery to SSE
 * streams. The caller is responsible for providing a live `redisPublisher`
 * (an ioredis client that is NOT in subscriber mode).
 *
 * @param {import('ioredis').Redis} redisPublisher - ioredis client in normal (publish) mode.
 * @param {string} paymentId                       - Payment or PaymentIntent id.
 * @param {object} payload                         - Update data (status, txHash, amount, etc.).
 * @returns {Promise<void>}
 */
const publishPaymentUpdate = async (redisPublisher, paymentId, payload = {}) => {
  if (!redisPublisher) {
    logger.warn({ paymentId }, '[sse] publishPaymentUpdate: no Redis publisher provided; skipping.');
    return;
  }

  if (!paymentId || typeof paymentId !== 'string') {
    logger.warn('[sse] publishPaymentUpdate called with invalid paymentId; skipping.');
    return;
  }

  const message = JSON.stringify({ paymentId, ...payload });
  await redisPublisher.publish(REDIS_CHANNEL, message);

  logger.info(
    { channel: REDIS_CHANNEL, paymentId, payload },
    '[sse] Published payment update to Redis channel',
  );
};

// ---------------------------------------------------------------------------
// Init / close
// ---------------------------------------------------------------------------

/**
 * Subscribe to the Redis payment channel so cross-process events published by
 * the Horizon listener are forwarded to connected SSE clients.
 *
 * In-process callers can use emitPaymentUpdate() without ever calling this.
 *
 * @returns {boolean} true when a subscriber was created.
 */
const initSse = () => {
  if (_redisSub) {
    logger.warn('[sse] Already initialized; returning existing subscriber.');
    return false;
  }

  if (!process.env.REDIS_URL && !isClusterMode()) {
    logger.warn(
      '[sse] Redis not configured — cross-process payment updates are disabled; only in-process updates will stream.',
    );
    return false;
  }

  _redisSub = createRedisConnection();

  _redisSub.subscribe(REDIS_CHANNEL, (err) => {
    if (err) {
      logger.error({ err }, '[sse] Failed to subscribe to Redis payment channel');
      return;
    }
    logger.info({ channel: REDIS_CHANNEL }, '[sse] Subscribed to Redis payment channel');
  });

  _redisSub.on('message', (channel, message) => {
    if (channel !== REDIS_CHANNEL) return;

    let data;
    try {
      data = JSON.parse(message);
    } catch (parseErr) {
      logger.warn({ message, parseErr }, '[sse] Received malformed message on Redis channel; skipping');
      return;
    }

    // `paymentIntentId` is the legacy field name; accept it so publishers
    // written against the old WebSocket protocol keep working unchanged.
    const { paymentId, paymentIntentId, ...rest } = data;
    const streamKey = paymentId || paymentIntentId;
    if (!streamKey) {
      logger.warn({ data }, '[sse] Redis message missing paymentId; skipping');
      return;
    }

    const delivered = emitPaymentUpdate(streamKey, rest);
    logger.info(
      { paymentId: streamKey, delivered, payload: rest },
      '[sse] Forwarded Redis payment event to SSE streams',
    );
  });

  _redisSub.on('error', (err) => {
    logger.error({ err }, '[sse] Redis subscriber error');
  });

  logger.info('[sse] SSE payment stream initialized');
  return true;
};

/**
 * End every open stream and close the Redis subscriber. Called during server
 * shutdown: Node keeps sockets alive while a response is open, so streams
 * must be closed before server.close() can finish.
 *
 * @returns {Promise<void>}
 */
const closeSse = () =>
  new Promise((resolve) => {
    _stopHeartbeat();

    for (const topic of [..._clients.values()]) {
      for (const client of [...topic]) {
        try {
          client.res.end();
        } catch {
          // Socket already gone — nothing to drain.
        }
      }
    }
    _clients.clear();

    const sub = _redisSub;
    _redisSub = null;
    if (!sub) {
      resolve();
      return;
    }

    sub
      .quit()
      .catch((err) => logger.error({ err }, '[sse] Error closing Redis subscriber'))
      .finally(() => {
        logger.info('[sse] SSE payment stream closed');
        resolve();
      });
  });

module.exports = {
  initSse,
  closeSse,
  addClient,
  sendClientEvent,
  emitPaymentUpdate,
  publishPaymentUpdate,
  getSseClientCount,
  isSseStreamPath,
  REDIS_CHANNEL,
};
