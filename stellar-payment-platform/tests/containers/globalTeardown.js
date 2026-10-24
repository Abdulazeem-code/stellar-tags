'use strict';

/**
 * #686 — integration test teardown.
 *
 * Stops the PostgreSQL and Redis containers started by `globalSetup`. The
 * containers hold the only copy of the test data, so nothing else has to be
 * cleaned up.
 */

const { stopAll } = require('./support/containerState');

module.exports = async function globalTeardown() {
  // eslint-disable-next-line no-console
  console.log('[containers] stopping PostgreSQL and Redis…');
  await stopAll();
};
