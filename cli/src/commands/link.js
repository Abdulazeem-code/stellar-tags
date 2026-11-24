const { resolveTag } = require('../services/api');
const { buildSep7Uri } = require('../services/sep7');
const { renderTerminalQr } = require('../services/qr');
const { EXIT_CODES } = require('../constants');

function registerLinkCommand(program, deps = {}) {
  program
    .command('link <tag>')
    .description('Generate a SEP-0007 payment URI and optional terminal QR code for a tag')
    .requiredOption('--amount <amount>', 'Amount to pay (e.g. 10 or 1.5, max 7 decimals)')
    .option('--asset <asset>', 'Asset identifier (e.g. XLM or USDC:G...)', 'XLM')
    .option('--memo <memo>', 'Optional transaction memo text')
    .option('--memo-type <type>', 'Optional memo type (text, id, hash, return)', 'text')
    .option('--qr', 'Print a QR code in the terminal')
    .action(async (tag, options) => {
      const globalOpts = program.opts();
      const resolveFn = deps.resolveTag || resolveTag;
      const qrFn = deps.renderTerminalQr || renderTerminalQr;

      try {
        const resolved = await resolveFn(tag, globalOpts);

        const uri = buildSep7Uri({
          destination: resolved.accountId,
          amount: options.amount,
          asset: options.asset,
          memo: options.memo || resolved.memo,
          memoType: options.memo ? options.memoType : (resolved.memoType || 'text'),
          network: globalOpts.network,
        });

        let qrString = null;
        if (options.qr) {
          qrString = await qrFn(uri);
        }

        if (globalOpts.json) {
          console.log(
            JSON.stringify(
              {
                tag: resolved.tag,
                destination: resolved.accountId,
                amount: options.amount,
                asset: options.asset,
                uri,
                ...(qrString ? { qr: qrString } : {}),
              },
              null,
              2,
            ),
          );
        } else {
          console.log(`URI: ${uri}`);
          if (qrString) {
            console.log('\nScan with your Stellar wallet:');
            console.log(qrString);
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
  registerLinkCommand,
};
