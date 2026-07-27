const express = require('express');
const userRoutes = require('./userRoutes');
const federationRoutes = require('./federationRoutes');
const receiptRoutes = require('./receiptRoutes');
const adminRoutes = require('./adminRoutes');

const router = express.Router();

router.use('/', userRoutes);
router.use('/', federationRoutes);
router.use('/', receiptRoutes);
router.use('/', adminRoutes);

module.exports = router;
