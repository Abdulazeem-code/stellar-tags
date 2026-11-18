'use strict';

/**
 * #686 — Jest configuration for the container-backed integration phase.
 *
 * Kept separate from the `jest` key in package.json (which drives the fast,
 * mock-based unit suite used by `npm test`) because this phase needs a Docker
 * daemon and therefore must not run implicitly. It is invoked explicitly by
 * `npm run test:integration`.
 *
 * Run it with `npm run test:integration` rather than `jest --config …` so the
 * script stays the single source of truth for how this phase is wired.
 */

const path = require('path');

const BACKEND_ROOT = __dirname;

module.exports = {
  rootDir: BACKEND_ROOT,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/containers/**/*.test.js'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  globalSetup: '<rootDir>/tests/containers/globalSetup.js',
  globalTeardown: '<rootDir>/tests/containers/globalTeardown.js',

  // One PostgreSQL and one Redis instance back the whole phase and every test
  // truncates the schema first, so suites must not run concurrently against
  // each other's fixtures.
  maxWorkers: 1,

  // Booting containers, applying the migration chain and opening the first
  // connections is slower than a unit test's whole body.
  testTimeout: 60000,

  // The app keeps a Prisma engine, a pg pool and a Redis client open by design;
  // the phase tears the containers down in globalTeardown.
  forceExit: true,

  // A failing test in this phase is almost always a real defect in SQL,
  // caching or wiring. Do not let a shared Jest cache hide one.
  cacheDirectory: path.join(BACKEND_ROOT, '.jest-cache-integration'),

  // Surface the suite by name in the output so the phase is obvious in CI logs.
  displayName: 'integration (testcontainers)',
};
