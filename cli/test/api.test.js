const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTag, lookupAddress, normalizeTag } = require('../src/services/api');
const { EXIT_CODES } = require('../src/constants');

test('normalizeTag formats tag query correctly', () => {
  assert.equal(normalizeTag('alice', 'stellar-tags.org'), 'alice*stellar-tags.org');
  assert.equal(normalizeTag('ALICE', 'stellar-tags.org'), 'alice*stellar-tags.org');
  assert.equal(normalizeTag('bob*custom.org', 'stellar-tags.org'), 'bob*custom.org');
});

test('resolveTag success with mocked federation API', async () => {
  const mockOptions = {
    api: 'http://mock-api',
    domain: 'stellar-tags.org',
  };

  const mockFetch = async (url) => {
    assert.match(url, /q=alice(\*|%2A)stellar-tags\.org&type=name/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        account_id: 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G',
        stellar_address: 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G',
        memo_type: 'text',
        memo: 'PaymentMemo1',
      }),
    };
  };

  const res = await resolveTag('alice', mockOptions, mockFetch);
  assert.equal(res.accountId, 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G');
  assert.equal(res.memo, 'PaymentMemo1');
});

test('resolveTag exits with USER_ERROR on 404', async () => {
  const mockOptions = { api: 'http://mock-api', domain: 'stellar-tags.org' };
  const mockFetch = async () => ({ ok: false, status: 404 });

  await assert.rejects(
    async () => resolveTag('unknown', mockOptions, mockFetch),
    (err) => {
      assert.equal(err.exitCode, EXIT_CODES.USER_ERROR);
      return true;
    },
  );
});

test('resolveTag exits with NETWORK_ERROR on network down', async () => {
  const mockOptions = { api: 'http://mock-api', domain: 'stellar-tags.org' };
  const mockFetch = async () => {
    throw new Error('Connection refused');
  };

  await assert.rejects(
    async () => resolveTag('alice', mockOptions, mockFetch),
    (err) => {
      assert.equal(err.exitCode, EXIT_CODES.NETWORK_ERROR);
      return true;
    },
  );
});

test('lookupAddress success with mocked API', async () => {
  const mockOptions = { api: 'http://mock-api' };
  const mockFetch = async (url) => {
    assert.match(url, /address=GDQ4X7/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        address: 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G',
        username: 'alice*stellar-tags.org',
        balances: [{ asset_type: 'native', balance: '100.0000000' }],
      }),
    };
  };

  const res = await lookupAddress('GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G', mockOptions, mockFetch);
  assert.equal(res.username, 'alice*stellar-tags.org');
});

test('lookupAddress exits with USER_ERROR on 404', async () => {
  const mockOptions = { api: 'http://mock-api' };
  const mockFetch = async () => ({ ok: false, status: 404 });

  await assert.rejects(
    async () => lookupAddress('GDQ4X7...', mockOptions, mockFetch),
    (err) => {
      assert.equal(err.exitCode, EXIT_CODES.USER_ERROR);
      return true;
    },
  );
});
