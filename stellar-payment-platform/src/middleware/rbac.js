'use strict';

const { ApiError } = require('../errors');

const ROLES = Object.freeze({
  SUPER_ADMIN: 'SuperAdmin',
  VIEWER: 'Viewer',
  SUPPORT: 'Support',
});

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Permissions granted to each role.
 * - SuperAdmin: full access (read + mutate)
 * - Viewer: read-only
 * - Support: read-only (cannot perform mutating actions)
 */
const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.SUPER_ADMIN]: Object.freeze({ read: true, write: true }),
  [ROLES.VIEWER]: Object.freeze({ read: true, write: false }),
  [ROLES.SUPPORT]: Object.freeze({ read: true, write: false }),
});

function normalizeRole(role) {
  if (!role || typeof role !== 'string') return null;
  const trimmed = role.trim();
  const match = Object.values(ROLES).find((r) => r.toLowerCase() === trimmed.toLowerCase());
  return match || null;
}

function canWrite(role) {
  const normalized = normalizeRole(role);
  return Boolean(normalized && ROLE_PERMISSIONS[normalized]?.write);
}

function canRead(role) {
  const normalized = normalizeRole(role);
  return Boolean(normalized && ROLE_PERMISSIONS[normalized]?.read);
}

/**
 * Resolves the acting admin from the request.
 * Prefers an already-attached `req.admin`. Falls back to looking up
 * `x-api-key` / `api_key` against the Admin table, then to the legacy
 * ADMIN_API_KEY env var (treated as SuperAdmin for backwards compatibility).
 */
async function resolveAdmin(req) {
  if (req.admin && req.admin.role) {
    return req.admin;
  }

  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey || typeof apiKey !== 'string') {
    return null;
  }

  try {
    const { prisma } = require('../../prismaClient');
    if (prisma.admin && typeof prisma.admin.findUnique === 'function') {
      const admin = await prisma.admin.findUnique({ where: { apiKey } });
      if (admin) return admin;
    }
  } catch {
    // Prisma may be unavailable in some test setups; fall through to env key.
  }

  if (process.env.ADMIN_API_KEY && apiKey === process.env.ADMIN_API_KEY) {
    return {
      id: 'env-admin',
      email: 'admin@local',
      apiKey,
      role: ROLES.SUPER_ADMIN,
    };
  }

  return null;
}

/**
 * Express middleware factory. Checks the admin's role against the required
 * permission for the current route.
 *
 * @param {{ permission?: 'read'|'write', roles?: string[] }} [options]
 */
function requireRole(options = {}) {
  const requiredPermission = options.permission;
  const allowedRoles = Array.isArray(options.roles)
    ? options.roles.map(normalizeRole).filter(Boolean)
    : null;

  return async function rbacMiddleware(req, res, next) {
    try {
      const admin = await resolveAdmin(req);
      if (!admin) {
        return next(new ApiError('UNAUTHENTICATED', 'Unauthorized: Invalid or missing API key'));
      }

      const role = normalizeRole(admin.role);
      if (!role) {
        return next(new ApiError('FORBIDDEN', 'Admin role is not recognized'));
      }

      req.admin = { ...admin, role };

      if (allowedRoles && !allowedRoles.includes(role)) {
        return next(new ApiError('FORBIDDEN', `Role ${role} is not permitted for this resource`));
      }

      const method = (req.method || 'GET').toUpperCase();
      const needsWrite = requiredPermission === 'write' || (!requiredPermission && MUTATING_METHODS.has(method));

      if (needsWrite && !canWrite(role)) {
        return next(
          new ApiError('FORBIDDEN', `Role ${role} cannot perform mutating actions`),
        );
      }

      if (requiredPermission === 'read' && !canRead(role)) {
        return next(new ApiError('FORBIDDEN', `Role ${role} cannot access this resource`));
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Convenience middleware: Support (and Viewer) cannot POST/PUT/PATCH/DELETE.
 * SuperAdmin is allowed. Apply after authentication so `req.admin` is set,
 * or use alone — it will resolve the admin itself.
 */
const denySupportMutations = requireRole();

module.exports = {
  ROLES,
  ROLE_PERMISSIONS,
  MUTATING_METHODS,
  normalizeRole,
  canWrite,
  canRead,
  resolveAdmin,
  requireRole,
  denySupportMutations,
};
