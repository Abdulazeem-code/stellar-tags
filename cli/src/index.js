require('dotenv').config();
const { Command } = require('commander');
const { registerResolveCommand } = require('./commands/resolve');
const { registerLookupCommand } = require('./commands/lookup');
const { registerLinkCommand } = require('./commands/link');
const { registerPayCommand } = require('./commands/pay');

/**
 * Creates and configures the Commander program.
 * @param {object} [deps] - Optional dependency overrides for testing
 * @returns {Command}
 */
function createCli(deps = {}) {
  const program = new Command();

  program
    .name('stellar-tags')
    .description('CLI tool to resolve Stellar tags, look up addresses, build SEP-7 links, and submit payments')
    .version('1.0.0');

  // Global options
  program
    .option('--api <url>', 'Stellar Tags API base URL', process.env.STELLAR_TAGS_API_BASE || 'http://localhost:3000')
    .option('--domain <domain>', 'Default domain for Stellar Tags federation', process.env.STELLAR_TAGS_DOMAIN || 'stellar-tags.org')
    .option('--network <network>', 'Stellar network: testnet or public', process.env.NETWORK || 'testnet')
    .option('--json', 'Output machine-readable JSON', false);

  // Register commands
  registerResolveCommand(program, deps);
  registerLookupCommand(program, deps);
  registerLinkCommand(program, deps);
  registerPayCommand(program, deps);

  return program;
}

module.exports = {
  createCli,
};
