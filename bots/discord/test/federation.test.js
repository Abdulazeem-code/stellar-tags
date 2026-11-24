const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTag, normalizeTag, shortenAddress } = require('../src/services/federation');

test('normalizeTag appends domain when missing', () => {
  assert.equal(normalizeTag('alice', 'stellar-tags.org'), 'alice*stellar-tags.org');
  assert.equal(normalizeTag('ALICE', 'stellar-tags.org'), 'alice*stellar-tags.org');
  assert.equal(normalizeTag('bob*custom.org', 'stellar-tags.org'), 'bob*custom.org');
});

test('shortenAddress formats public key correctly', () => {
  const address = 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G';
  assert.equal(shortenAddress(address), 'GDQ4X7...6U6C7G');
  assert.equal(shortenAddress('short'), 'short');
  assert.equal(shortenAddress(null), '');
});

test('resolveTag success with mocked federation API', async () => {
  const mockConfig = {
    apiBase: 'http://mock-api',
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
        memo: 'TestMemo123',
      }),
    };
  };

  const res = await resolveTag('alice', mockConfig, mockFetch);
  assert.equal(res.accountId, 'GDQ4X7B2QWYRDB6S2Y5R6G6U4E6U6C7G6U6C7G6U6C7G6U6C7G6U6C7G');
  assert.equal(res.memo, 'TestMemo123');
  assert.equal(res.memoType, 'text');
});

test('resolveTag throws TAG_NOT_FOUND on 404', async () => {
  const mockConfig = {
    apiBase: 'http://mock-api',
    domain: 'stellar-tags.org',
  };

  const mockFetch = async () => ({
    ok: false,
    status: 404,
  });

  await assert.rejects(
    async () => resolveTag('unknown', mockConfig, mockFetch),
    (err) => {
      assert.equal(err.code, 'TAG_NOT_FOUND');
      return true;
    },
  );
});

test('resolveTag throws TAG_BLOCKED on 403', async () => {
  const mockConfig = {
    apiBase: 'http://mock-api',
    domain: 'stellar-tags.org',
  };

  const mockFetch = async () => ({
    ok: false,
    status: 403,
  });

  await assert.rejects(
    async () => resolveTag('blocked', mockConfig, mockFetch),
    (err) => {
      assert.equal(err.code, 'TAG_BLOCKED');
      return true;
    },
  );
});

test('resolveTag throws SERVICE_UNAVAILABLE on network error', async () => {
  const mockConfig = {
    apiBase: 'http://mock-api',
    domain: 'stellar-tags.org',
  };

  const mockFetch = async () => {
    throw new Error('Connection refused');
  };

  await assert.rejects(
    async () => resolveTag('alice', mockConfig, mockFetch),
    (err) => {
      assert.equal(err.code, 'SERVICE_UNAVAILABLE');
      return true;
    },
  );
});
