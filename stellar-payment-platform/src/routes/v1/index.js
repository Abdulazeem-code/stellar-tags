const express = require('express');
const userRoutes = require('./userRoutes');
const federationRoutes = require('./federationRoutes');
const receiptRoutes = require('./receiptRoutes');

const router = express.Router();

router.use('/', userRoutes);
router.use('/', federationRoutes);
router.use('/', receiptRoutes);

module.exports = router;
