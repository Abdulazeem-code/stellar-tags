const express = require('express');
const userRoutes = require('./userRoutes');
const receiptRoutes = require('./receiptRoutes');
const webhookRoutes = require('./webhookRoutes');
const statsRoutes = require('./statsRoutes');
const historyRoutes = require('./historyRoutes');
const exportRoutes = require('./exportRoutes');
const adminRoutesFn = require('./adminRoutes');

module.exports = (redisClient) => {
  const router = express.Router();
  const federationRoutes = require('./federationRoutes')(redisClient);
  const adminRoutes = adminRoutesFn(redisClient);

  router.use('/', userRoutes);
  router.use('/', federationRoutes);
  router.use('/', receiptRoutes);
  router.use('/', historyRoutes);
  router.use('/', exportRoutes);
  router.use('/', statsRoutes);
  router.use('/', adminRoutes);

  return router;
};
