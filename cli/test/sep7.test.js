const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSep7Uri, validateAmount, parseAsset } = require('../src/services/sep7');
const { EXIT_CODES } = require('../src/constants');

const TEST_DESTINATION = 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G';
const TEST_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

test('validateAmount parses valid and throws on invalid amount', () => {
  assert.equal(validateAmount('10.5'), '10.5');
  assert.throws(
    () => validateAmount('-1'),
    (err) => err.exitCode === EXIT_CODES.USER_ERROR,
  );
  assert.throws(
    () => validateAmount('1.12345678'),
    (err) => err.exitCode === EXIT_CODES.USER_ERROR,
  );
});

test('parseAsset validates codes and issuers correctly', () => {
  assert.deepEqual(parseAsset('XLM'), { isNative: true, assetCode: 'XLM' });
  assert.deepEqual(parseAsset(`USDC:${TEST_ISSUER}`), {
    isNative: false,
    assetCode: 'USDC',
    assetIssuer: TEST_ISSUER,
  });
  assert.throws(
    () => parseAsset('TOOLONGLONGASSETNAME'),
    (err) => err.exitCode === EXIT_CODES.USER_ERROR,
  );
});

test('buildSep7Uri builds valid URI with URL encoding', () => {
  const uri = buildSep7Uri({
    destination: TEST_DESTINATION,
    amount: '50.25',
    asset: `USDC:${TEST_ISSUER}`,
    memo: 'Order #1234',
    memoType: 'text',
    network: 'testnet',
  });

  assert.ok(uri.startsWith('web+stellar:pay?'));
  const parsed = new URL(uri);
  assert.equal(parsed.searchParams.get('destination'), TEST_DESTINATION);
  assert.equal(parsed.searchParams.get('amount'), '50.25');
  assert.equal(parsed.searchParams.get('asset_code'), 'USDC');
  assert.equal(parsed.searchParams.get('asset_issuer'), TEST_ISSUER);
  assert.equal(parsed.searchParams.get('memo'), 'Order #1234');
});
