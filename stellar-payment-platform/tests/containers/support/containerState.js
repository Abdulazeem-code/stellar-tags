'use strict';

/**
 * Hand-off registry between Jest's `globalSetup` and `globalTeardown`.
 *
 * Jest runs both hooks in the same (main) process, so a module-level array is
 * all that is needed to carry the started containers from one to the other.
 *
 * If the run crashes before `globalTeardown` gets a chance to run, cleanup is
 * not lost: Testcontainers' Ryuk reaper deletes everything still carrying this
 * run's session label, so no container is left behind.
 */

const started = [];

/** Register a started container (or any `{ stop() }` resource) for teardown. */
function remember(resource) {
  started.push(resource);
  return resource;
}

/** A no-op stand-in used when an externally managed service is used instead. */
function noopResource(name) {
  return {
    name,
    async stop() {},
  };
}

/**
 * Stop everything registered, in reverse start order, and surface failures
 * without aborting the remaining stops.
 */
async function stopAll() {
  const resources = started.splice(0, started.length).reverse();
  const outcomes = await Promise.allSettled(resources.map((r) => r.stop()));

  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      const name = resources[index]?.name || `resource #${index}`;
      // eslint-disable-next-line no-console
      console.error(`[containers] Failed to stop ${name}:`, outcome.reason);
    }
  });
}

module.exports = { remember, noopResource, stopAll };
