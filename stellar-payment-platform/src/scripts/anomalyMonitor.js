'use strict';

/**
 * src/scripts/anomalyMonitor.js
 *
 * Detects unusually large transaction volumes for accounts and dispatches
 * alerts. An account is flagged when its transaction volume in the current
 * sliding window exceeds 1000% (10x) of its historical daily average volume.
 *
 * Alerts are dispatched to Slack and/or Email via configurable webhooks.
 * Optionally, flagged accounts can be auto-paused (soft-blocked) when
 * ANOMALY_AUTO_PAUSE is enabled.
 */

const cron = require('node-cron');
const { logger } = require('../logger');

/** Accounts whose current-window volume exceeds this multiple of their daily
 *  average are considered anomalous. 1000% == 10x. */
const ANOMALY_THRESHOLD_MULTIPLIER = 10;

/** Length of the sliding window used to compare against the daily average. */
const WINDOW_HOURS = 24;

/** Number of days of history used to compute the daily average volume. */
const AVERAGE_LOOKBACK_DAYS = 30;

/** Minimum number of historical days required before an average is meaningful. */
const MIN_HISTORY_DAYS = 3;

/**
 * Computes the daily average volume (sum of amounts) for a given account
 * address over the lookback period, excluding the current window.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} address - Account address (from or to).
 * @param {Date} windowStart - Start of the current sliding window.
 * @returns {Promise<number>} Average daily volume in the lookback period.
 */
async function getDailyAverageVolume(prisma, address, windowStart) {
  const lookbackStart = new Date(windowStart);
  lookbackStart.setDate(lookbackStart.getDate() - AVERAGE_LOOKBACK_DAYS);

  const rows = await prisma.paymentIntent.findMany({
    where: {
      OR: [{ from: address }, { to: address }],
      createdAt: { gte: lookbackStart, lt: windowStart },
    },
    select: { amount: true, createdAt: true },
  });

  if (rows.length === 0) return 0;

  // Group by calendar day to compute per-day totals.
  const dayTotals = new Map();
  for (const row of rows) {
    const day = row.createdAt.toISOString().slice(0, 10);
    const amount = Number(row.amount) || 0;
    dayTotals.set(day, (dayTotals.get(day) || 0) + amount);
  }

  const activeDays = dayTotals.size;
  if (activeDays < MIN_HISTORY_DAYS) return 0;

  const total = [...dayTotals.values()].reduce((sum, v) => sum + v, 0);
  return total / activeDays;
}

/**
 * Computes the transaction volume for an account within the current sliding
 * window.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} address - Account address (from or to).
 * @param {Date} windowStart - Start of the current sliding window.
 * @returns {Promise<number>} Total volume in the window.
 */
async function getWindowVolume(prisma, address, windowStart) {
  const rows = await prisma.paymentIntent.findMany({
    where: {
      OR: [{ from: address }, { to: address }],
      createdAt: { gte: windowStart },
    },
    select: { amount: true },
  });

  return rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
}

/**
 * Dispatches an anomaly alert to configured Slack and/or Email webhooks.
 * No-op when no webhook URLs are configured.
 *
 * @param {object} anomaly - { address, windowVolume, dailyAverage, ratio }
 */
async function dispatchAlert(anomaly) {
  const { address, windowVolume, dailyAverage, ratio } = anomaly;
  const message = {
    text: `[Anomaly Monitor] Unusually large transaction volume detected for account ${address}. ` +
      `Window volume: ${windowVolume}, daily average: ${dailyAverage}, ratio: ${ratio.toFixed(2)}x.`,
  };

  const slackUrl = process.env.ANOMALY_SLACK_WEBHOOK_URL;
  if (slackUrl) {
    try {
      const res = await fetch(slackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (!res.ok) {
        logger.error(`[anomaly-monitor] Slack alert failed with status ${res.status}`);
      }
    } catch (err) {
      logger.error('[anomaly-monitor] Slack alert dispatch error:', err.message);
    }
  }

  const emailUrl = process.env.ANOMALY_EMAIL_WEBHOOK_URL;
  if (emailUrl) {
    try {
      const res = await fetch(emailUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: `[Anomaly Monitor] Unusual volume for ${address}`,
          body: message.text,
        }),
      });
      if (!res.ok) {
        logger.error(`[anomaly-monitor] Email alert failed with status ${res.status}`);
      }
    } catch (err) {
      logger.error('[anomaly-monitor] Email alert dispatch error:', err.message);
    }
  }

  if (!slackUrl && !emailUrl) {
    logger.warn(
      `[anomaly-monitor] Anomaly detected for ${address} but no alert channel configured ` +
        '(set ANOMALY_SLACK_WEBHOOK_URL or ANOMALY_EMAIL_WEBHOOK_URL).',
    );
  }
}

/**
 * Optionally auto-pauses (soft-blocks) a flagged account by setting its
 * flaggedAt timestamp, mirroring the admin block endpoint behaviour.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} address - Account address to pause.
 */
async function autoPauseAccount(prisma, address) {
  try {
    await prisma.user.updateMany({
      where: { address, flaggedAt: null },
      data: { flaggedAt: new Date() },
    });
    logger.warn(`[anomaly-monitor] Auto-paused account ${address}`);
  } catch (err) {
    logger.error(`[anomaly-monitor] Failed to auto-pause account ${address}:`, err.message);
  }
}

/**
 * Runs the anomaly detection heuristic against the provided Prisma client.
 * Exported separately so it can be unit-tested without a live cron scheduler.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<Array<object>>} List of detected anomalies.
 */
async function runAnomalyMonitor(prisma) {
  const windowStart = new Date();
  windowStart.setHours(windowStart.getHours() - WINDOW_HOURS);

  // Collect all distinct account addresses involved in transactions within the
  // current window.
  const windowRows = await prisma.paymentIntent.findMany({
    where: { createdAt: { gte: windowStart } },
    select: { from: true, to: true },
  });

  const addresses = new Set();
  for (const row of windowRows) {
    addresses.add(row.from);
    addresses.add(row.to);
  }

  const anomalies = [];

  for (const address of addresses) {
    const [windowVolume, dailyAverage] = await Promise.all([
      getWindowVolume(prisma, address, windowStart),
      getDailyAverageVolume(prisma, address, windowStart),
    ]);

    if (dailyAverage <= 0) continue;

    const ratio = windowVolume / dailyAverage;
    if (ratio >= ANOMALY_THRESHOLD_MULTIPLIER) {
      const anomaly = { address, windowVolume, dailyAverage, ratio };
      anomalies.push(anomaly);
      await dispatchAlert(anomaly);

      if (process.env.ANOMALY_AUTO_PAUSE === 'true') {
        await autoPauseAccount(prisma, address);
      }
    }
  }

  return anomalies;
}

/**
 * Registers a cron job that runs the anomaly monitor on a configurable
 * interval (default: every 15 minutes).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 */
function scheduleAnomalyMonitor(prisma) {
  const expression = process.env.ANOMALY_CRON || '*/15 * * * *';
  cron.schedule(expression, async () => {
    logger.info('[anomaly-monitor] Starting anomaly detection sweep…');
    try {
      const anomalies = await runAnomalyMonitor(prisma);
      if (anomalies.length > 0) {
        logger.warn(
          `[anomaly-monitor] Detected ${anomalies.length} anomalous account(s):`,
          anomalies.map((a) => a.address),
        );
      } else {
        logger.info('[anomaly-monitor] No anomalies detected.');
      }
    } catch (err) {
      logger.error('[anomaly-monitor] Anomaly detection sweep failed:', err.message);
    }
  });

  logger.info(`[anomaly-monitor] Anomaly detection job scheduled (${expression}).`);
}

module.exports = {
  scheduleAnomalyMonitor,
  runAnomalyMonitor,
  getDailyAverageVolume,
  getWindowVolume,
  dispatchAlert,
  autoPauseAccount,
  ANOMALY_THRESHOLD_MULTIPLIER,
  WINDOW_HOURS,
  AVERAGE_LOOKBACK_DAYS,
  MIN_HISTORY_DAYS,
};
