const { resolveTag } = require('../services/api');
const { submitPayment } = require('../services/payment');
const { EXIT_CODES } = require('../constants');

function registerPayCommand(program, deps = {}) {
  program
    .command('pay <tag>')
    .description('Build and submit a payment to a Stellar tag using a secret key from an environment variable')
    .requiredOption('--amount <amount>', 'Amount to pay (e.g. 10 or 1.5, max 7 decimals)')
    .option('--asset <asset>', 'Asset identifier (e.g. XLM or USDC:G...)', 'XLM')
    .option('--memo <memo>', 'Optional transaction memo')
    .option('--memo-type <type>', 'Optional memo type (text, id, hash, return)', 'text')
    .requiredOption(
      '--secret-env <varName>',
      'Name of the environment variable holding your Stellar secret key (never passed as a plain argument)',
    )
    .option(
      '--yes',
      'Confirmation flag required when submitting transactions to the public network (--network public)',
    )
    .action(async (tag, options) => {
      const globalOpts = program.opts();
      const resolveFn = deps.resolveTag || resolveTag;
      const submitFn = deps.submitPayment || submitPayment;

      try {
        const envVarName = options.secretEnv;
        if (!envVarName) {
          const error = new Error('--secret-env <VAR> must specify an environment variable name.');
          error.exitCode = EXIT_CODES.USER_ERROR;
          throw error;
        }

        // Retrieve secret key only from process.env
        const secretKey = process.env[envVarName];
        if (!secretKey) {
          const error = new Error(
            `Environment variable "${envVarName}" is not set or empty. Please set it with your secret key.`,
          );
          error.exitCode = EXIT_CODES.USER_ERROR;
          throw error;
        }

        const network = (globalOpts.network || 'testnet').toLowerCase();

        // Safety gate for public network
        if (network === 'public' && !options.yes) {
          const error = new Error(
            'Submitting a payment to the PUBLIC network requires explicit --yes confirmation.',
          );
          error.exitCode = EXIT_CODES.USER_ERROR;
          throw error;
        }

        // 1. Resolve Tag
        const resolved = await resolveFn(tag, globalOpts);

        // 2. Submit payment
        const result = await submitFn(
          {
            secretKey,
            destination: resolved.accountId,
            amount: options.amount,
            asset: options.asset,
            memo: options.memo || resolved.memo,
            memoType: options.memo ? options.memoType : (resolved.memoType || 'text'),
            network,
          },
          deps,
        );

        if (globalOpts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log('Payment Successful! 🚀');
          console.log(`Transaction Hash: ${result.hash}`);
          console.log(`Network:          ${result.network}`);
          console.log(`To (${tag}):      ${result.to}`);
          console.log(`Amount:           ${result.amount} ${result.asset}`);
          if (result.ledger) {
            console.log(`Ledger:           ${result.ledger}`);
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
        if (deps.isTesting) {
          throw err;
        }
        process.exitCode = exitCode;
        process.exit(exitCode);
      }
    });
}

module.exports = {
  registerPayCommand,
};
