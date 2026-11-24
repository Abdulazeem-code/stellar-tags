const { Command } = require('commander');
const { resolveTag } = require('../services/api');
const { EXIT_CODES } = require('../constants');

function registerResolveCommand(program, deps = {}) {
  program
    .command('resolve <tag>')
    .description('Resolve a Stellar tag to its Stellar address and memo via public federation')
    .action(async (tag, cmdObj) => {
      const globalOpts = program.opts();
      const resolveFn = deps.resolveTag || resolveTag;

      try {
        const result = await resolveFn(tag, globalOpts);

        if (globalOpts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Tag:        ${result.tag}`);
          console.log(`Address:    ${result.stellarAddress}`);
          if (result.memo) {
            console.log(`Memo:       ${result.memo} (${result.memoType || 'text'})`);
          } else {
            console.log(`Memo:       None`);
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
  registerResolveCommand,
};
