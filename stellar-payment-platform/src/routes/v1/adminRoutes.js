const express = require('express');
const { invalidateFederationCache } = require('../../federationCache');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireRole, ROLES } = require('../../middleware/rbac');
const { ApiError } = require('../../errors');

module.exports = (redisClient) => {
  const router = express.Router();

  const getPrisma = () => {
    return require('../../../prismaClient').prisma;
  };

  // Authenticate + authorize. Support/Viewer cannot mutate.
  const adminRbac = requireRole();

  router.get(
    '/admin/me',
    adminRbac,
    asyncHandler(async (req, res) => {
      return res.status(200).json({
        id: req.admin.id,
        email: req.admin.email,
        role: req.admin.role,
      });
    }),
  );

  router.post(
    '/admin/block',
    adminRbac,
    asyncHandler(async (req, res, next) => {
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
    }),
  );

  router.put(
    '/admin/admins/:id/role',
    requireRole({ roles: [ROLES.SUPER_ADMIN], permission: 'write' }),
    asyncHandler(async (req, res, next) => {
      const prisma = getPrisma();
      const { role } = req.body || {};
      const { normalizeRole } = require('../../middleware/rbac');
      const nextRole = normalizeRole(role);
      if (!nextRole) {
        return next(new ApiError('INVALID_INPUT', 'Invalid role'));
      }
      if (!prisma.admin || typeof prisma.admin.update !== 'function') {
        return next(new ApiError('SERVICE_UNAVAILABLE', 'Admin store is not available'));
      }
      try {
        const updated = await prisma.admin.update({
          where: { id: req.params.id },
          data: { role: nextRole },
        });
        return res.status(200).json({
          id: updated.id,
          email: updated.email,
          role: updated.role,
        });
      } catch (error) {
        if (error.code === 'P2025') {
          return next(new ApiError('NOT_FOUND', 'Admin not found'));
        }
        return next(error);
      }
    }),
  );

  return router;
};
