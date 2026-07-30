'use strict';

const http = require('http');
const ioClient = require('socket.io-client');
const { initSocketServer, closeSocketServer } = require('../src/socketManager');

// Set a larger timeout for the socket tests to avoid intermittent timeouts under heavy test run loads
jest.setTimeout(30000);

// Mock logger to avoid spamming output
jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('Socket.IO real-time notification system', () => {
  let server;
  let clientSocket;
  let port;

  beforeAll((done) => {
    server = http.createServer();
    initSocketServer(server);
    server.listen(() => {
      port = server.address().port;
      done();
    });
  });

  afterAll((done) => {
    if (clientSocket && clientSocket.connected) {
      clientSocket.disconnect();
    }
    closeSocketServer();
    server.close(done);
  });

  beforeEach((done) => {
    clientSocket = ioClient(`http://localhost:${port}`);
    clientSocket.on('connect', done);
  });

  afterEach(() => {
    clientSocket.disconnect();
  });

  test('should authenticate and join the address room and receive payment events', (done) => {
    const testAddress = 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ';
    clientSocket.emit('authenticate', { address: testAddress });

    setTimeout(() => {
      clientSocket.on('payment', (paymentData) => {
        expect(paymentData).toEqual({ amount: '100', asset: 'XLM' });
        done();
      });

      const publisherSocket = ioClient(`http://localhost:${port}`);
      publisherSocket.on('connect', () => {
        publisherSocket.emit('payment', {
          address: testAddress,
          payment: { amount: '100', asset: 'XLM' },
        });
        publisherSocket.disconnect();
      });
    }, 200);
  });
});
