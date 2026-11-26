#!/usr/bin/env node

const { createCli } = require('../src/index');

const cli = createCli();
cli.parseAsync(process.argv).catch((err) => {
  // Catch any unexpected uncaught errors
  console.error(err.message || err);
  process.exit(err.exitCode !== undefined ? err.exitCode : 1);
});
