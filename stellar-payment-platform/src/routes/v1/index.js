const express = require('express');
const userRoutes = require('./userRoutes');
const federationRoutes = require('./federationRoutes');
const receiptRoutes = require('./receiptRoutes');
const statsRoutes = require('./statsRoutes');
const historyRoutes = require('./historyRoutes');

const router = express.Router();

router.use('/', userRoutes);
router.use('/', federationRoutes);
router.use('/', receiptRoutes);
router.use('/', historyRoutes);
router.use('/', statsRoutes);

module.exports = router;
