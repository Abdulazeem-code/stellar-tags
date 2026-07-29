const express = require('express');
const { invalidateFederationCache } = require('../../federationCache');

module.exports = (redisClient) => {
  const router = express.Router();

  const getPrisma = () => {
    return require('../../../prismaClient').prisma;
  };

  const adminAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
    }
    next();
  };

  router.post('/admin/block', adminAuth, async (req, res, next) => {
    const prisma = getPrisma();
    const { address } = req.body;

    if (!address || typeof address !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid address' });
    }

    try {
      const updatedUser = await prisma.user.update({
        where: { address },
        data: { flaggedAt: new Date() },
      });

      await invalidateFederationCache(redisClient, updatedUser.address, updatedUser.username);

      return res.status(200).json({
        message: 'Address successfully blocked',
        username: updatedUser.username,
        address: updatedUser.address,
        flaggedAt: updatedUser.flaggedAt,
      });
    } catch (error) {
      if (error.code === 'P2025') {
        return res.status(404).json({ error: 'Address not found' });
      }
      return next(error);
    }
  });

  return router;
};
