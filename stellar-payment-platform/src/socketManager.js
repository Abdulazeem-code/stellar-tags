const { Server } = require('socket.io');
const { logger } = require('./logger');

let io = null;

/**
 * Initialize Socket.IO on the passed http.Server instance.
 * Maintains a simple room-per-address mapping: clients call `authenticate` with
 * { address } and are added to a room named by that address. Emitted payments
 * are broadcast to that room.
 */
function initSocketServer(httpServer, corsOptions = {}) {
  if (io) return io;
  io = new Server(httpServer, {
    cors: Object.assign({ origin: true, methods: ['GET', 'POST'] }, corsOptions),
  });

  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id}`);

    // The optional ack lets a client wait until it is actually subscribed.
    // Without it a client that emits `authenticate` and immediately expects
    // events can miss any payment that arrives before the room join lands.
    socket.on('authenticate', async (payload, ack) => {
      let subscribed = false;
      try {
        const address = payload && typeof payload.address === 'string' ? payload.address : null;
        if (address) {
          // socket.join can be async in some adapters; await to be safe.
          await socket.join(address);
          socket.address = address;
          subscribed = true;
          logger.info(`Socket ${socket.id} joined room for ${address}`);
        }
      } catch (err) {
        logger.error('Socket authenticate error', err);
      }
      if (typeof ack === 'function') {
        try { ack({ subscribed }); } catch (e) { /* ignore ack errors */ }
      }
    });

    socket.on('payment', (payload) => {
      try {
        const addr = payload && typeof payload.address === 'string' ? payload.address : null;
        const payment = payload && payload.payment ? payload.payment : payload;
        if (addr) {
          io.to(addr).emit('payment', payment);
        }
      } catch (err) {
        logger.error('Error handling payment emit', err);
      }
    });

    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: ${socket.id}`);
    });
  });

  return io;
}

function emitToAddress(address, event, data) {
  if (!io) return;
  io.to(address).emit(event, data);
}

function closeSocketServer() {
  if (io) {
    io.close();
    io = null;
  }
}

module.exports = { initSocketServer, emitToAddress, closeSocketServer };
