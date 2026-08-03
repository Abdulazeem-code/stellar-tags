jest.setTimeout(20000);
jest.mock('../src/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const http = require('http');
const ioClient = require('socket.io-client');
const { initSocketServer } = require('../src/socketManager');

let server;
let clientSocket;
let publisherSocket;
let port;

function startSocketServer(done) {
  // Create a minimal express app for the socket server so we don't pull in
  // heavyweight dependencies (like @stellar/stellar-sdk) during tests.
  const express = require('express');
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));

  const httpServer = http.createServer(app);
  initSocketServer(httpServer);
  httpServer.listen(0, '127.0.0.1', () => {
    port = httpServer.address().port;
    server = httpServer;
    done();
  });
}

function closeSocketServer() {
  if (server && server.listening) server.close();
}

describe('Socket.IO real-time notification system', () => {
  beforeAll((done) => {
    startSocketServer(() => {
      clientSocket = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
      clientSocket.on('connect', () => done());
    });
  });

  afterAll((done) => {
    // Ensure client sockets are disconnected before closing the server so
    // server.close's callback fires promptly.
    try {
      if (clientSocket && clientSocket.connected) clientSocket.disconnect();
      if (publisherSocket && publisherSocket.connected) publisherSocket.disconnect();
    } catch (e) { /* ignore */ }

    if (server && server.listening) {
      server.close(() => done());
      return;
    }
    done();
  });

  afterEach(() => {
    if (publisherSocket && publisherSocket.connected) publisherSocket.disconnect();
    publisherSocket = null;
  });

  test('should authenticate and join the address room and receive payment events', (done) => {
    const testAddress = 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ';

    clientSocket.on('payment', (paymentData) => {
      try {
        expect(paymentData).toEqual({ amount: '100', asset: 'XLM' });
        done();
      } catch (err) {
        done(err);
      }
    });

    // The ack fires after the server has joined the room, so the publish below
    // cannot outrun the subscription.
    clientSocket.emit('authenticate', { address: testAddress }, () => {
      publisherSocket = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
      publisherSocket.on('connect', () => {
        publisherSocket.emit('payment', {
          address: testAddress,
          payment: { amount: '100', asset: 'XLM' },
        });
        // Disconnecting here would close the transport before the packet is
        // flushed and drop the event; afterEach tears the socket down instead.
      });
    });
  });

  test('does not deliver payments for an address the client did not subscribe to', (done) => {
    const subscribed = 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ';
    const other = 'GBDQD3WTQ6W2VQ2W4V74UZ5WYF6B72GZ6EHD7I3L3WYH357Y4K5H3E4W';

    clientSocket.on('payment', () => {
      done(new Error('received a payment addressed to another account'));
    });

    clientSocket.emit('authenticate', { address: subscribed }, () => {
      publisherSocket = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
      publisherSocket.on('connect', () => {
        publisherSocket.emit('payment', {
          address: other,
          payment: { amount: '100', asset: 'XLM' },
        });
        // Round-trip through the same socket: once this ack returns the server
        // has already handled the payment above, so nothing is still in flight.
        publisherSocket.emit('authenticate', { address: other }, () => done());
      });
    });
  });
});
