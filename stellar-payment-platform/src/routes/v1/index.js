const express = require('express');

const userRoutes = require('./userRoutes');
const receiptRoutes = require('./receiptRoutes');
const contractRoutes = require('./contractRoutes');
const webhookRoutes = require('./webhookRoutes');
const statsRoutes = require('./statsRoutes');
const historyRoutes = require('./historyRoutes');
const exportRoutes = require('./exportRoutes');

module.exports = (redisClient) => {
  const router = express.Router();

  const federationRoutes = require('./federationRoutes')(redisClient);
  const adminRoutes = require('./adminRoutes')(redisClient);

  router.use('/', userRoutes);
  router.use('/', federationRoutes);
  router.use('/', receiptRoutes);
  router.use('/', contractRoutes);
  router.use('/', webhookRoutes);
  router.use('/', historyRoutes);
  router.use('/', exportRoutes);
  router.use('/', webhookRoutes);
  router.use('/', statsRoutes(redisClient));
  router.use('/', adminRoutes);

  return router;
};
