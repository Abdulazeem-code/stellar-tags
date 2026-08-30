'use strict';

const { shouldFallbackToLocalRegistry } = require('../utils');

const SERVER_START_TIME = Date.now();

async function fetchAdminStats(prisma, poolGet) {
  let totalRegisteredUsers;
  let activeTokens;

  try {
    [totalRegisteredUsers, activeTokens] = await prisma.$transaction([
      prisma.user.count(),
      prisma.user.count({ where: { flaggedAt: null } }),
    ]);
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;

    const totalCountRow = await poolGet(
      'SELECT COUNT(*) AS totalCount FROM username_registry',
    );
    const activeCountRow = await poolGet(
      'SELECT COUNT(*) AS activeCount FROM username_registry WHERE flagged_at IS NULL',
    );
    totalRegisteredUsers = Number(totalCountRow?.totalCount || 0);
    activeTokens = Number(activeCountRow?.activeCount || 0);
  }

  return {
    total_registered_users: totalRegisteredUsers,
    active_tokens: activeTokens,
    platform_uptime_seconds: Math.floor(process.uptime()),
    platform_uptime_started_at: new Date(SERVER_START_TIME).toISOString(),
  };
}

module.exports = { fetchAdminStats, SERVER_START_TIME };
