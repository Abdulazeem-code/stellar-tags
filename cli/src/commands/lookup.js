const { lookupAddress } = require('../services/api');
const { EXIT_CODES } = require('../constants');

function registerLookupCommand(program, deps = {}) {
  program
    .command('lookup <address>')
    .description('Look up registered tag and account details for a Stellar G... address')
    .action(async (address) => {
      const globalOpts = program.opts();
      const lookupFn = deps.lookupAddress || lookupAddress;

      try {
        const result = await lookupFn(address, globalOpts);

        if (globalOpts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Address:    ${result.address}`);
          console.log(`Tag:        ${result.username}`);
          if (result.balances) {
            console.log(`Balances:   ${JSON.stringify(result.balances)}`);
          }
        }
        process.exitCode = EXIT_CODES.SUCCESS;
      } catch (err) {
        const exitCode = err.exitCode !== undefined ? err.exitCode : EXIT_CODES.USER_ERROR;
        if (globalOpts.json) {
          console.error(JSON.stringify({ error: err.message, exitCode }, null, 2));
        } else {
          console.error(`Error: ${err.message}`);
        }
        process.exit(exitCode);
      }
    });
}

module.exports = {
  registerLookupCommand,
};
