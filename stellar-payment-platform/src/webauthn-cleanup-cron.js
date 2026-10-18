/**
 * WebAuthn Challenge Cleanup Cron
 * Periodically removes expired authentication challenges
 */

const cron = require("node-cron");
const { cleanupExpiredChallenges } = require("./services/webauthnService");
const { logger } = require("./logger");

/**
 * Schedule cleanup job to run every hour
 * Removes expired WebAuthn challenges from database
 */
function scheduleWebAuthnCleanup() {
  // Run every hour at minute 0
  const job = cron.schedule("0 * * * *", async () => {
    try {
      logger.info("Starting WebAuthn challenge cleanup");
      const deletedCount = await cleanupExpiredChallenges();
      logger.info({ deletedCount }, "WebAuthn challenge cleanup completed");
    } catch (error) {
      logger.error({ error }, "WebAuthn challenge cleanup failed");
    }
  });

  logger.info("WebAuthn challenge cleanup cron scheduled (hourly)");
  return job;
}

module.exports = { scheduleWebAuthnCleanup };
