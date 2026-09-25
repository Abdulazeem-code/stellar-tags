'use strict';

const { shouldFallbackToLocalRegistry } = require('../utils');

const SERVER_START_TIME = Date.now();

/**
 * Fetches admin statistics using Prisma exclusively.
 * Both the total user count and active (non-flagged) count are fetched in a
 * single atomic transaction to avoid race conditions.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<{ total_registered_users: number, active_tokens: number, platform_uptime_seconds: number, platform_uptime_started_at: string }>}
 */
async function fetchAdminStats(prisma) {
  const [totalRegisteredUsers, activeTokens] = await prisma.$transaction([
    prisma.user.count(),
    prisma.user.count({ where: { flaggedAt: null } }),
  ]);

  return {
    total_registered_users: totalRegisteredUsers,
    active_tokens: activeTokens,
    platform_uptime_seconds: Math.floor(process.uptime()),
    platform_uptime_started_at: new Date(SERVER_START_TIME).toISOString(),
  };
}

module.exports = { fetchAdminStats, SERVER_START_TIME };
