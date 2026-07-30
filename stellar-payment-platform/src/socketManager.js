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

    socket.on('authenticate', (payload) => {
      try {
        const address = payload && typeof payload.address === 'string' ? payload.address : null;
        if (address) {
          socket.join(address);
          socket.address = address;
          logger.info(`Socket ${socket.id} joined room for ${address}`);
        }
      } catch (err) {
        logger.error('Socket authenticate error', err);
      }
    });

    socket.on('payment', (payload) => {
      try {
        const { address, payment } = payload || {};
        if (address && payment) {
          emitToAddress(address, 'payment', payment);
          logger.info(`Forwarded payment event to room for address ${address}`);
        }
      } catch (err) {
        logger.error('Socket payment forwarding error', err);
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
