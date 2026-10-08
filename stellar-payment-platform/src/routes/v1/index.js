const express = require('express');

const userRoutes = require('./userRoutes');
const receiptRoutes = require('./receiptRoutes');
const webhookRoutes = require('./webhookRoutes');
const statsRoutes = require('./statsRoutes');
const historyRoutes = require('./historyRoutes');
const exportRoutes = require('./exportRoutes');
const paymentRoutes = require('./paymentRoutes');
const sseRoutes = require('./sseRoutes');
const contractRoutes = require('./contractRoutes');
const federationRoutes = require('./federationRoutes');

module.exports = (redisClient) => {
  const router = express.Router();

  const adminRoutes = require('./adminRoutes')(redisClient);
  const routingRuleRoutes = require('./routingRuleRoutes')();
  const settlementRoutes = require('./settlementRoutes')(redisClient);

  router.use('/', userRoutes);
  router.use('/', receiptRoutes);
  router.use('/', contractRoutes);
  router.use('/', historyRoutes);
  router.use('/', exportRoutes);
  router.use('/', routingRuleRoutes);
  router.use('/settlement', settlementRoutes);

  router.use('/', webhookRoutes(redisClient));
  // SSE status streams mount before paymentRoutes so the long-lived stream
  // never passes through the payment router's idempotency middleware.
  router.use('/', sseRoutes(redisClient));
  router.use('/', paymentRoutes(redisClient));
  router.use('/', statsRoutes(redisClient));
  router.use('/', federationRoutes(redisClient));

  router.use('/', adminRoutes);

  return router;
};
