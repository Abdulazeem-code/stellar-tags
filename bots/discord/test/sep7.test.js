const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateAmount,
  parseAsset,
  buildSep7PayUri,
} = require('../src/services/sep7');

const TEST_DESTINATION = 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G';
const TEST_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

test('validateAmount handles valid amounts', () => {
  assert.equal(validateAmount('10').valid, true);
  assert.equal(validateAmount('0.1').valid, true);
  assert.equal(validateAmount('12345.6789012').valid, true);
  assert.equal(validateAmount(50).valid, true);
});

test('validateAmount rejects invalid amounts', () => {
  assert.equal(validateAmount('-5').valid, false);
  assert.equal(validateAmount('0').valid, false);
  assert.equal(validateAmount('1.12345678').valid, false);
  assert.equal(validateAmount('abc').valid, false);
  assert.equal(validateAmount('').valid, false);
});

test('parseAsset identifies native asset', () => {
  assert.deepEqual(parseAsset(), { valid: true, isNative: true, assetCode: 'XLM' });
  assert.deepEqual(parseAsset('XLM'), { valid: true, isNative: true, assetCode: 'XLM' });
  assert.deepEqual(parseAsset('native'), { valid: true, isNative: true, assetCode: 'XLM' });
});

test('parseAsset identifies issued asset with code', () => {
  const res = parseAsset('USDC');
  assert.equal(res.valid, true);
  assert.equal(res.isNative, false);
  assert.equal(res.assetCode, 'USDC');
});

test('parseAsset identifies issued asset with code and issuer', () => {
  const res = parseAsset(`USDC:${TEST_ISSUER}`);
  assert.equal(res.valid, true);
  assert.equal(res.isNative, false);
  assert.equal(res.assetCode, 'USDC');
  assert.equal(res.assetIssuer, TEST_ISSUER);
});

test('parseAsset rejects invalid asset code or issuer', () => {
  assert.equal(parseAsset('TOOLONGLONGASSETNAME').valid, false);
  assert.equal(parseAsset('USDC:INVALID_ISSUER').valid, false);
});

test('buildSep7PayUri generates valid native payment URI', () => {
  const uri = buildSep7PayUri({
    destination: TEST_DESTINATION,
    amount: '10.5',
    network: 'testnet',
  });

  assert.ok(uri.startsWith('web+stellar:pay?'));
  const parsed = new URL(uri);
  assert.equal(parsed.searchParams.get('destination'), TEST_DESTINATION);
  assert.equal(parsed.searchParams.get('amount'), '10.5');
  assert.equal(parsed.searchParams.get('network_passphrase'), 'Test SDF Network ; September 2015');
  assert.equal(parsed.searchParams.get('asset_code'), null);
});

test('buildSep7PayUri generates valid non-native asset payment URI with issuer', () => {
  const uri = buildSep7PayUri({
    destination: TEST_DESTINATION,
    amount: '100',
    asset: `USDC:${TEST_ISSUER}`,
    memo: 'Invoice#1234',
    memoType: 'text',
    network: 'public',
  });

  const parsed = new URL(uri);
  assert.equal(parsed.searchParams.get('destination'), TEST_DESTINATION);
  assert.equal(parsed.searchParams.get('amount'), '100');
  assert.equal(parsed.searchParams.get('asset_code'), 'USDC');
  assert.equal(parsed.searchParams.get('asset_issuer'), TEST_ISSUER);
  assert.equal(parsed.searchParams.get('memo'), 'Invoice#1234');
  assert.equal(parsed.searchParams.get('memo_type'), 'text');
  assert.equal(parsed.searchParams.get('network_passphrase'), null);
});

test('buildSep7PayUri throws on invalid input', () => {
  assert.throws(() => {
    buildSep7PayUri({
      destination: TEST_DESTINATION,
      amount: '-10',
    });
  }, /Invalid amount|Amount must be greater than 0/);

  assert.throws(() => {
    buildSep7PayUri({
      destination: TEST_DESTINATION,
      amount: '10.12345678',
    });
  }, /up to 7 decimal places/);
});
