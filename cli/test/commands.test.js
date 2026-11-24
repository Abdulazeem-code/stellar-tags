const test = require('node:test');
const assert = require('node:assert/strict');
const { createCli } = require('../src/index');

const TEST_DESTINATION = 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G';
const TEST_SECRET = 'SBCEMG2Y35547UAKQ34V52SNHZ67AKP3T56AOUC77QJ6C7E2Y35547UA'; // Test dummy secret key

function captureOutput() {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

test('CLI resolve command outputs human readable and json', async () => {
  const mockDeps = {
    resolveTag: async (tag) => ({
      tag,
      federationQuery: `${tag}*stellar-tags.org`,
      accountId: TEST_DESTINATION,
      stellarAddress: TEST_DESTINATION,
      memo: 'Memo123',
      memoType: 'text',
    }),
  };

  const cli = createCli(mockDeps);
  cli.exitOverride();

  const out = captureOutput();
  try {
    await cli.parseAsync(['node', 'stellar-tags', 'resolve', 'alice', '--json']);
    const jsonOutput = JSON.parse(out.logs.join('\n'));
    assert.equal(jsonOutput.tag, 'alice');
    assert.equal(jsonOutput.accountId, TEST_DESTINATION);
  } finally {
    out.restore();
  }
});

test('CLI lookup command outputs account info', async () => {
  const mockDeps = {
    lookupAddress: async (addr) => ({
      address: addr,
      username: 'alice*stellar-tags.org',
      balances: [],
    }),
  };

  const cli = createCli(mockDeps);
  cli.exitOverride();

  const out = captureOutput();
  try {
    await cli.parseAsync(['node', 'stellar-tags', 'lookup', TEST_DESTINATION, '--json']);
    const jsonOutput = JSON.parse(out.logs.join('\n'));
    assert.equal(jsonOutput.username, 'alice*stellar-tags.org');
  } finally {
    out.restore();
  }
});

test('CLI link command generates SEP-7 link and optional QR', async () => {
  const mockDeps = {
    resolveTag: async (tag) => ({
      tag,
      accountId: TEST_DESTINATION,
      stellarAddress: TEST_DESTINATION,
    }),
    renderTerminalQr: async () => 'FAKE_TERMINAL_QR',
  };

  const cli = createCli(mockDeps);
  cli.exitOverride();

  const out = captureOutput();
  try {
    await cli.parseAsync([
      'node',
      'stellar-tags',
      'link',
      'alice',
      '--amount',
      '10',
      '--qr',
      '--json',
    ]);
    const jsonOutput = JSON.parse(out.logs.join('\n'));
    assert.ok(jsonOutput.uri.startsWith('web+stellar:pay?'));
    assert.equal(jsonOutput.qr, 'FAKE_TERMINAL_QR');
  } finally {
    out.restore();
  }
});

test('CLI pay command submits transaction using environment variable and NEVER logs secret', async () => {
  const ENV_VAR = 'MY_TEST_KEY_ENV';
  process.env[ENV_VAR] = TEST_SECRET;

  let passedSecret = null;
  const mockDeps = {
    resolveTag: async (tag) => ({
      tag,
      accountId: TEST_DESTINATION,
      stellarAddress: TEST_DESTINATION,
    }),
    submitPayment: async (params) => {
      passedSecret = params.secretKey;
      return {
        successful: true,
        hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        network: 'testnet',
        amount: '10',
        asset: 'XLM',
        from: 'GSOURCE...',
        to: TEST_DESTINATION,
      };
    },
  };

  const cli = createCli(mockDeps);
  cli.exitOverride();

  const out = captureOutput();
  try {
    await cli.parseAsync([
      'node',
      'stellar-tags',
      'pay',
      'alice',
      '--amount',
      '10',
      '--secret-env',
      ENV_VAR,
      '--json',
    ]);

    assert.equal(passedSecret, TEST_SECRET);

    // SECURITY CHECK: Assert secret key is NEVER printed in logs or errors
    const allLogs = out.logs.join(' ') + ' ' + out.errors.join(' ');
    assert.ok(!allLogs.includes(TEST_SECRET), 'Secret key must never be logged or output!');
  } finally {
    process.exitCode = 0;
    delete process.env[ENV_VAR];
    out.restore();
  }
});

test('CLI pay command requires --yes for public network', async () => {
  const ENV_VAR = 'MY_TEST_KEY_ENV';
  process.env[ENV_VAR] = TEST_SECRET;

  const cli = createCli({
    isTesting: true,
    resolveTag: async () => ({ accountId: TEST_DESTINATION }),
  });
  cli.exitOverride();

  const out = captureOutput();
  try {
    await assert.rejects(
      async () => {
        await cli.parseAsync([
          'node',
          'stellar-tags',
          'pay',
          'alice',
          '--amount',
          '10',
          '--secret-env',
          ENV_VAR,
          '--network',
          'public',
        ]);
      },
      (err) => {
        assert.ok(out.errors.join(' ').includes('--yes') || err.message.includes('--yes'));
        return true;
      },
    );
  } finally {
    process.exitCode = 0;
    delete process.env[ENV_VAR];
    out.restore();
  }
});
