'use strict';

// ---------------------------------------------------------------------------
// Optional in-process Horizon listener
// ---------------------------------------------------------------------------
// The Horizon listener (horizonListener.js) matches on-chain payments to
// payment requests, records payments and delivers webhooks. It normally runs
// as its own process (`npm run listener`). On a single-instance deployment
// with no separate worker, set RUN_HORIZON_LISTENER=true and the API starts
// it inside its own process instead, so payment requests still turn to
// "paid" without anything else running.
//
// Run it in exactly one place: either one API instance with this flag, or a
// separate `npm run listener` process, never both. Payment matching is safe
// to run twice, but webhook deliveries would be duplicated.
// ---------------------------------------------------------------------------

const { logger } = require('./logger');

let listener = null;

const isInProcessListenerEnabled = (env = process.env) =>
  String(env.RUN_HORIZON_LISTENER || '').trim().toLowerCase() === 'true';

/**
 * Starts the Horizon listener in this process when RUN_HORIZON_LISTENER=true.
 * A failure is logged and never thrown, so the API keeps serving requests.
 *
 * @param {object} [options]
 * @param {object} [options.env] - Environment to read the flag from.
 * @param {() => { main: Function, stop: Function }} [options.load] - Loads the listener module.
 * @returns {Promise<boolean>} true when the listener is running in this process.
 */
async function startInProcessListener({
  env = process.env,
  load = () => require('../horizonListener'),
} = {}) {
  if (!isInProcessListenerEnabled(env)) return false;
  if (listener) return true;

  try {
    const loaded = load();
    await loaded.main();
    listener = loaded;
    logger.info('[listener] Horizon listener running inside the API process (RUN_HORIZON_LISTENER=true).');
    return true;
  } catch (err) {
    logger.error({ err }, '[listener] Failed to start the in-process Horizon listener; the API keeps running without it.');
    return false;
  }
}

/** True while a listener started by startInProcessListener() is running. */
const isInProcessListenerRunning = () => listener !== null;

/** Stops the in-process listener, if one was started. Never throws. */
async function stopInProcessListener() {
  if (!listener) return;
  const running = listener;
  listener = null;
  try {
    await running.stop();
  } catch (err) {
    logger.error({ err }, '[listener] Error stopping the in-process Horizon listener.');
  }
}

module.exports = {
  isInProcessListenerEnabled,
  isInProcessListenerRunning,
  startInProcessListener,
  stopInProcessListener,
};
