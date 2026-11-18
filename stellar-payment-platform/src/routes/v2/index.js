'use strict';

const express = require('express');

module.exports = (redisClient) => {
  const router = express.Router();

  router.use((req, res, next) => {
    req.apiVersion = 'v2';
    next();
  });

  router.get('/', (req, res) => {
    res.status(200).json({ apiVersion: 'v2', status: 'ok' });
  });

  // Endpoints not yet implemented in v2 fall through to the v1 router, so
  // /api/v2/... keeps working while handlers are ported one by one.
  router.use('/', require('../v1')(redisClient));

  return router;
};