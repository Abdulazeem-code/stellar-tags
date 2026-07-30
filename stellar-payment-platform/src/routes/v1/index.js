const express = require('express');
const userRoutes = require('./userRoutes');
const receiptRoutes = require('./receiptRoutes');
const statsRoutes = require('./statsRoutes');
const historyRoutes = require('./historyRoutes');
const exportRoutes = require('./exportRoutes');

module.exports = (redisClient) => {
  const router = express.Router();
  const federationRoutes = require('./federationRoutes')(redisClient);

  router.use('/', userRoutes);
  router.use('/', federationRoutes);
  router.use('/', receiptRoutes);
  router.use('/', historyRoutes);
  router.use('/', exportRoutes);
  router.use('/', statsRoutes);

  return router;
};
