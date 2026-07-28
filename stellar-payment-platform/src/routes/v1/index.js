const express = require('express');
const userRoutes = require('./userRoutes');
const federationRoutes = require('./federationRoutes');
const receiptRoutes = require('./receiptRoutes');
const webhookRoutes = require('./webhookRoutes');
const statsRoutes = require('./statsRoutes');

const router = express.Router();

router.use('/', userRoutes);
router.use('/', federationRoutes);
router.use('/', receiptRoutes);
router.use('/', webhookRoutes);
router.use('/', statsRoutes);

module.exports = router;
