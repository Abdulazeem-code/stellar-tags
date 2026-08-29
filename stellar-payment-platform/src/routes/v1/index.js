const express = require('express');
const userRoutes = require('./userRoutes');
const federationRoutes = require('./federationRoutes');
const receiptRoutes = require('./receiptRoutes');
const contractRoutes = require('./contractRoutes');

const router = express.Router();

router.use('/', userRoutes);
router.use('/', federationRoutes);
router.use('/', receiptRoutes);
router.use('/', contractRoutes);

module.exports = router;
