// ---------------------------------------------------------------------------
// WebSocket Manager — Socket.io integration for real-time payment status updates
// ---------------------------------------------------------------------------
// Clients connect and subscribe to a specific payment intent ID by emitting
// the "subscribe:payment" event. When the Horizon listener detects a matching
// on-chain payment, it publishes a message to the Redis channel
// "stellar:payment:update". This module subscribes to that channel and
// broadcasts "payment:update" events to every connected socket that joined
// the corresponding room.
//
// Room naming: `payment:<paymentIntentId>`
//
// Client event flow:
//   1. Client connects via Socket.io.
//   2. Client emits  "subscribe:payment"   { paymentIntentId }
//   3. Server joins  client to room        `payment:<id>`
//   4. Horizon listener detects payment →  publishes to Redis
//   5. Server emits  "payment:update"      { paymentIntentId, status, ... }
//      to all sockets in the room.
//
// Usage in server.js:
//   const { initWebSocket } = require('./src/websocket');
//   initWebSocket(httpServer, allowedOrigins);
//
// Usage in horizonListener.js (or any other process):
//   const { emitPaymentUpdate } = require('./src/websocket');
//   emitPaymentUpdate(paymentIntentId, { status, transactionHash, ... });
//   — or —
//   publishPaymentUpdate(redisClient, paymentIntentId, { ... });
// ---------------------------------------------------------------------------

'use strict';

const { Server } = require('socket.io');
const { createRedisConnection } = require('../config/redis');
const { logger } = require('../logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Redis channel that carries cross-process payment update messages. */
const REDIS_CHANNEL = 'stellar:payment:update';

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

/** @type {import('socket.io').Server | null} */
let _io = null;

/** @type {import('ioredis').Redis | null} — subscriber connection */
let _redisSub = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a deterministic Socket.io room name from a payment intent ID.
 *
 * @param {string} paymentIntentId
 * @returns {string}
 */
const _roomName = (paymentIntentId) => `payment:${paymentIntentId}`;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Attach a Socket.io server to the existing Node.js HTTP server and configure
 * CORS to match the same origin allow-list that the Express app uses.
 *
 * Also subscribes to the Redis pub/sub channel so cross-process payment
 * events published by the Horizon listener are forwarded to connected clients.
 *
 * @param {import('http').Server} httpServer - The HTTP server returned by app.listen().
 * @param {string[]} allowedOrigins         - Origins already permitted by the Express CORS config.
 * @returns {import('socket.io').Server}
 */
const initWebSocket = (httpServer, allowedOrigins = []) => {
  if (_io) {
    logger.warn('[ws] Socket.io already initialized; returning existing instance.');
    return _io;
  }

  // ---------------------------------------------------------------------------
  // Socket.io server
  // ---------------------------------------------------------------------------
  _io = new Server(httpServer, {
    // Mirror the Express CORS policy so WebSocket handshakes are subject to
    // the same origin restrictions as regular HTTP requests.
    cors: {
      origin: (origin, callback) => {
        // Allow server-to-server connections (no Origin header) and any
        // origin that is already on the Express allow-list.
        if (!origin || allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        logger.warn({ origin }, '[ws] CORS rejected WebSocket handshake from origin');
        return callback(new Error('WebSocket origin not allowed'));
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },

    // Transport: prefer WebSocket, fall back to long-polling so clients
    // behind restrictive proxies still connect.
    transports: ['websocket', 'polling'],

    // Ping every 25 s; disconnect if no pong within 20 s. Keeps idle
    // connections from accumulating silently.
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  // ---------------------------------------------------------------------------
  // Socket.io connection handler
  // ---------------------------------------------------------------------------
  _io.on('connection', (socket) => {
    const clientIp =
      socket.handshake.headers['x-forwarded-for'] ||
      socket.handshake.address ||
      'unknown';

    logger.info({ socketId: socket.id, ip: clientIp }, '[ws] Client connected');

    // -------------------------------------------------------------------------
    // subscribe:payment
    //   Payload: { paymentIntentId: string }
    //   Joins the socket to the room for that payment so it receives
    //   "payment:update" events targeted at that intent.
    // -------------------------------------------------------------------------
    socket.on('subscribe:payment', ({ paymentIntentId } = {}) => {
      if (!paymentIntentId || typeof paymentIntentId !== 'string') {
        socket.emit('error', {
          code: 'INVALID_PAYLOAD',
          message: 'subscribe:payment requires a non-empty paymentIntentId string.',
        });
        return;
      }

      const room = _roomName(paymentIntentId);
      socket.join(room);

      logger.info(
        { socketId: socket.id, paymentIntentId },
        '[ws] Socket subscribed to payment room',
      );

      socket.emit('subscribed', { paymentIntentId });
    });

    // -------------------------------------------------------------------------
    // unsubscribe:payment
    //   Payload: { paymentIntentId: string }
    //   Leaves the room. Clients should call this when navigating away.
    // -------------------------------------------------------------------------
    socket.on('unsubscribe:payment', ({ paymentIntentId } = {}) => {
      if (!paymentIntentId || typeof paymentIntentId !== 'string') return;

      const room = _roomName(paymentIntentId);
      socket.leave(room);

      logger.info(
        { socketId: socket.id, paymentIntentId },
        '[ws] Socket unsubscribed from payment room',
      );
    });

    // -------------------------------------------------------------------------
    // disconnect
    // -------------------------------------------------------------------------
    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, '[ws] Client disconnected');
    });
  });

  // ---------------------------------------------------------------------------
  // Redis subscriber for cross-process events
  // ---------------------------------------------------------------------------
  // The Horizon listener runs in a separate OS process. It publishes payment
  // events to the Redis channel `stellar:payment:update`. We subscribe here
  // and forward those events to the Socket.io room so the HTTP server process
  // can notify connected browser clients in real time.
  _redisSub = createRedisConnection();

  _redisSub.subscribe(REDIS_CHANNEL, (err) => {
    if (err) {
      logger.error({ err }, '[ws] Failed to subscribe to Redis payment channel');
      return;
    }
    logger.info({ channel: REDIS_CHANNEL }, '[ws] Subscribed to Redis payment channel');
  });

  _redisSub.on('message', (channel, message) => {
    if (channel !== REDIS_CHANNEL) return;

    let data;
    try {
      data = JSON.parse(message);
    } catch (parseErr) {
      logger.warn({ message, parseErr }, '[ws] Received malformed message on Redis channel; skipping');
      return;
    }

    const { paymentIntentId, ...payload } = data;
    if (!paymentIntentId) {
      logger.warn({ data }, '[ws] Redis message missing paymentIntentId; skipping');
      return;
    }

    const room = _roomName(paymentIntentId);
    _io.to(room).emit('payment:update', { paymentIntentId, ...payload });

    logger.info(
      { paymentIntentId, payload },
      '[ws] Forwarded Redis payment event → Socket.io room',
    );
  });

  _redisSub.on('error', (err) => {
    logger.error({ err }, '[ws] Redis subscriber error');
  });

  logger.info('[ws] Socket.io server initialized');
  return _io;
};

// ---------------------------------------------------------------------------
// Emit helpers
// ---------------------------------------------------------------------------

/**
 * Emit a payment update directly via the in-process Socket.io instance.
 * Use this when both the caller and the WebSocket server share the same
 * Node.js process (e.g., in tests or a monolithic deployment).
 *
 * For cross-process delivery (e.g., horizonListener.js → server.js) use
 * `publishPaymentUpdate()` instead.
 *
 * Safe to call before initWebSocket() — logs a warning and no-ops.
 *
 * @param {string} paymentIntentId  - The payment intent ID clients subscribed to.
 * @param {object} payload          - Arbitrary update data (status, txHash, etc.).
 */
const emitPaymentUpdate = (paymentIntentId, payload) => {
  if (!_io) {
    logger.warn(
      { paymentIntentId },
      '[ws] emitPaymentUpdate called before Socket.io was initialized; skipping.',
    );
    return;
  }

  if (!paymentIntentId || typeof paymentIntentId !== 'string') {
    logger.warn('[ws] emitPaymentUpdate called with invalid paymentIntentId; skipping.');
    return;
  }

  const room = _roomName(paymentIntentId);
  _io.to(room).emit('payment:update', { paymentIntentId, ...payload });

  logger.info({ paymentIntentId, payload }, '[ws] Emitted payment:update to room');
};

/**
 * Publish a payment status update to the Redis channel so any server process
 * subscribed via initWebSocket() can forward it to connected clients.
 *
 * This is the primary integration point for horizonListener.js: it creates a
 * short-lived Redis publisher, sends the message, and lets the server process
 * handle delivery to Socket.io rooms. The caller is responsible for providing
 * a live `redisPublisher` (an ioredis client that is NOT in subscriber mode).
 *
 * @param {import('ioredis').Redis} redisPublisher - An ioredis client in normal (publish) mode.
 * @param {string} paymentIntentId                - The payment intent ID.
 * @param {object} payload                        - Update data (status, txHash, amount, etc.).
 * @returns {Promise<void>}
 */
const publishPaymentUpdate = async (redisPublisher, paymentIntentId, payload) => {
  if (!redisPublisher) {
    logger.warn({ paymentIntentId }, '[ws] publishPaymentUpdate: no Redis publisher provided; skipping.');
    return;
  }

  if (!paymentIntentId || typeof paymentIntentId !== 'string') {
    logger.warn('[ws] publishPaymentUpdate called with invalid paymentIntentId; skipping.');
    return;
  }

  const message = JSON.stringify({ paymentIntentId, ...payload });
  await redisPublisher.publish(REDIS_CHANNEL, message);

  logger.info(
    { channel: REDIS_CHANNEL, paymentIntentId, payload },
    '[ws] Published payment update to Redis channel',
  );
};

/**
 * Return the active Socket.io server instance, or null if not yet initialized.
 *
 * @returns {import('socket.io').Server | null}
 */
const getIO = () => _io;

/**
 * Gracefully close the Socket.io server and Redis subscriber connection.
 * Called during server shutdown to drain active connections cleanly.
 *
 * @returns {Promise<void>}
 */
const closeWebSocket = () =>
  new Promise((resolve) => {
    const cleanup = () => {
      if (_redisSub) {
        _redisSub.quit().catch((err) =>
          logger.error({ err }, '[ws] Error closing Redis subscriber'),
        );
        _redisSub = null;
      }
      logger.info('[ws] Socket.io server closed');
      _io = null;
      resolve();
    };

    if (!_io) {
      cleanup();
      return;
    }

    _io.close(cleanup);
  });

module.exports = {
  initWebSocket,
  emitPaymentUpdate,
  publishPaymentUpdate,
  getIO,
  closeWebSocket,
  REDIS_CHANNEL,
};
