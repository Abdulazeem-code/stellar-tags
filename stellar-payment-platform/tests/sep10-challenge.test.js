'use strict';

/**
 * Tests for the SEP-10 GET /auth challenge endpoint.
 *
 * The repo's CJS Jest setup cannot load the SDK's ESM hash dependency, so this
 * file supplies a compact mock that mirrors the SEP-10 behaviour we rely on.
 * The assertions deliberately go through WebAuth.readChallengeTx, the same
 * helper the real SDK exposes, to check every challenge field.
 */

const crypto = require('crypto');

jest.mock('@stellar/stellar-sdk', () => {
  const { randomBytes } = require('crypto');
  const TESTNET = 'Test SDF Network ; September 2015';
  const PUBLIC = 'Public Global Stellar Network ; September 2015';
  const BAD_CHECKSUM_KEY = `G${'B'.repeat(55)}`;

  const encodeTx = (tx) => Buffer.from(JSON.stringify(tx)).toString('base64');
  const decodeTx = (xdr) => JSON.parse(Buffer.from(xdr, 'base64').toString('utf8'));
  const fail = (message) => {
    throw new Error(message);
  };

  const buildChallengeTx = jest.fn((
    keypair,
    clientAccountID,
    homeDomain,
    timeout = 300,
    networkPassphrase,
    webAuthDomain,
    memo = null,
    clientDomain = null,
    clientSigningKey = null,
  ) => {
    if (clientAccountID.startsWith('M') && memo) {
      fail('memo cannot be used if clientAccountID is a muxed account');
    }
    if (clientDomain && !clientSigningKey) {
      fail('clientSigningKey is required if clientDomain is provided');
    }

    const serverAccountID = keypair.publicKey();
    const now = Math.floor(Date.now() / 1000);
    const tx = {
      sequence: '0',
      source: serverAccountID,
      networkPassphrase,
      timeBounds: { minTime: now, maxTime: now + timeout },
      memo: memo ? { type: 'id', value: memo } : { type: 'none', value: null },
      operations: [
        {
          type: 'manageData',
          name: `${homeDomain} auth`,
          value: randomBytes(48).toString('base64'),
          source: clientAccountID,
        },
        {
          type: 'manageData',
          name: 'web_auth_domain',
          value: webAuthDomain,
          source: serverAccountID,
        },
      ],
      signatures: [serverAccountID],
    };
    return encodeTx(tx);
  });

  const readChallengeTx = jest.fn((
    challengeTx,
    serverAccountID,
    networkPassphrase,
    homeDomains,
    webAuthDomain,
  ) => {
    const tx = decodeTx(challengeTx);

    if (Number.parseInt(tx.sequence, 10) !== 0) fail('The sequence number should be zero');
    if (tx.source !== serverAccountID) fail('The source account is not the server');
    if (tx.networkPassphrase !== networkPassphrase) fail('Wrong network passphrase');
    if (!tx.timeBounds || !Number.isFinite(tx.timeBounds.minTime) ||
        !Number.isFinite(tx.timeBounds.maxTime) || tx.timeBounds.maxTime <= tx.timeBounds.minTime) {
      fail('Invalid time bounds');
    }
    if (tx.operations.some((op) => op.type !== 'manageData')) fail('Non-manageData operation');

    const [first, ...rest] = tx.operations;
    if (!first || !first.source) fail('First operation has no source');
    if (Buffer.from(first.value, 'base64').length !== 48) fail('Nonce is not 48 bytes');

    const domains = Array.isArray(homeDomains) ? homeDomains : [homeDomains];
    const matchedHomeDomain = domains.find((domain) => `${domain} auth` === first.name);
    if (!matchedHomeDomain) fail('Home domain does not match');

    const webAuthOp = rest.find((op) => op.name === 'web_auth_domain');
    if (!webAuthOp || webAuthOp.value !== webAuthDomain || webAuthOp.source !== serverAccountID) {
      fail('web_auth_domain operation is missing or invalid');
    }

    if (tx.memo.type !== 'none' && tx.memo.type !== 'id') fail('Memo is not an ID memo');
    if (tx.memo.type === 'id') {
      if (first.source.startsWith('M')) fail('A muxed account cannot have a memo');
      if (!/^\d+$/.test(String(tx.memo.value))) fail('Invalid ID memo');
    }

    if (!tx.signatures.includes(serverAccountID)) fail('Transaction is not signed by the server');

    return {
      tx,
      clientAccountID: first.source,
      matchedHomeDomain,
      memo: tx.memo.type === 'id' ? tx.memo.value : null,
    };
  });

  return {
    Networks: { TESTNET, PUBLIC },
    Keypair: {
      fromSecret: jest.fn((secret) => {
        if (typeof secret !== 'string' || !/^S[A-Z2-7]{55}$/.test(secret)) {
          throw new Error('Invalid Secret Seed');
        }
        return { publicKey: () => `G${secret.slice(1)}` };
      }),
    },
    StrKey: {
      isValidEd25519PublicKey: jest.fn(
        (key) => /^G[A-Z2-7]{55}$/.test(key) && key !== BAD_CHECKSUM_KEY,
      ),
      isValidMed25519PublicKey: jest.fn((key) => /^M[A-Z2-7]{55}$/.test(key)),
    },
    WebAuth: { buildChallengeTx, readChallengeTx },
    _badChecksumKey: BAD_CHECKSUM_KEY,
  };
});

const express = require('express');
const request = require('supertest');
const {
  WebAuth,
  StrKey,
  _badChecksumKey: BAD_CHECKSUM_KEY,
} = require('@stellar/stellar-sdk');
const authRoutes = require('../src/routes/v1/authRoutes');
const { CHALLENGE_KEY_PREFIX } = require('../src/services/sep10');

const SECRET = `S${'A'.repeat(55)}`;
const SERVER_KEY = `G${'A'.repeat(55)}`;
const CLIENT_KEY = `G${'C'.repeat(55)}`;
const MUXED_KEY = `M${'C'.repeat(55)}`;
const HOME_DOMAIN = 'example.com';
const WEB_AUTH_DOMAIN = 'auth.example.com';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const TIMEOUT = 900;

const ENV_KEYS = [
  'STELLAR_TAG_DOMAIN',
  'SEP10_SIGNING_SECRET',
  'SEP10_HOME_DOMAIN',
  'SEP10_WEB_AUTH_DOMAIN',
  'SEP10_CHALLENGE_TIMEOUT_SECONDS',
  'SEP10_JWT_EXPIRY',
  'HORIZON_NETWORK',
];

const enabledEnv = (overrides = {}) => ({
  STELLAR_TAG_DOMAIN: HOME_DOMAIN,
  SEP10_SIGNING_SECRET: SECRET,
  SEP10_HOME_DOMAIN: HOME_DOMAIN,
  SEP10_WEB_AUTH_DOMAIN: WEB_AUTH_DOMAIN,
  SEP10_CHALLENGE_TIMEOUT_SECONDS: String(TIMEOUT),
  SEP10_JWT_EXPIRY: '24h',
  HORIZON_NETWORK: 'testnet',
  ...overrides,
});

const withEnv = async (overrides, callback) => {
  const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  ENV_KEYS.forEach((key) => delete process.env[key]);
  Object.entries(overrides).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  try {
    return await callback();
  } finally {
    ENV_KEYS.forEach((key) => {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
};

const makeRedis = () => ({ set: jest.fn().mockResolvedValue(1) });

const makeApp = (redisClient) => {
  const app = express();
  app.use('/auth', authRoutes(redisClient));
  return app;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /auth — challenge issuance', () => {
  it('returns a valid SEP-10 challenge and records only its hash in Redis', async () => {
    await withEnv(enabledEnv(), async () => {
      const redis = makeRedis();
      const response = await request(makeApp(redis))
        .get('/auth')
        .query({
          account: CLIENT_KEY,
          memo: '42',
          home_domain: HOME_DOMAIN,
          client_domain: 'wallet.example.com',
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        transaction: expect.any(String),
        network_passphrase: NETWORK_PASSPHRASE,
      });

      const { tx, clientAccountID, matchedHomeDomain, memo } = WebAuth.readChallengeTx(
        response.body.transaction,
        SERVER_KEY,
        NETWORK_PASSPHRASE,
        HOME_DOMAIN,
        WEB_AUTH_DOMAIN,
      );

      expect(tx.sequence).toBe('0');
      expect(tx.source).toBe(SERVER_KEY);
      expect(tx.timeBounds.maxTime).toBeGreaterThan(tx.timeBounds.minTime);
      expect(clientAccountID).toBe(CLIENT_KEY);
      expect(matchedHomeDomain).toBe(HOME_DOMAIN);
      expect(memo).toBe('42');

      expect(tx.operations[0].type).toBe('manageData');
      expect(tx.operations[0].name).toBe(`${HOME_DOMAIN} auth`);
      expect(tx.operations[0].source).toBe(CLIENT_KEY);
      expect(Buffer.from(tx.operations[0].value, 'base64')).toHaveLength(48);

      const webAuthOp = tx.operations.find((op) => op.name === 'web_auth_domain');
      expect(webAuthOp).toBeDefined();
      expect(webAuthOp.value).toBe(WEB_AUTH_DOMAIN);
      expect(webAuthOp.source).toBe(SERVER_KEY);

      expect(tx.signatures).toContain(SERVER_KEY);

      // client_domain is accepted but intentionally not passed to the SDK.
      expect(WebAuth.buildChallengeTx).toHaveBeenCalledWith(
        expect.objectContaining({ publicKey: expect.any(Function) }),
        CLIENT_KEY,
        HOME_DOMAIN,
        TIMEOUT,
        NETWORK_PASSPHRASE,
        WEB_AUTH_DOMAIN,
        '42',
        null,
        null,
      );

      const hash = crypto.createHash('sha256').update(response.body.transaction).digest('hex');
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith(`${CHALLENGE_KEY_PREFIX}${hash}`, hash, {
        EX: TIMEOUT,
      });
    });
  });

  it('accepts a muxed account without a memo', async () => {
    await withEnv(enabledEnv(), async () => {
      const response = await request(makeApp(makeRedis()))
        .get('/auth')
        .query({ account: MUXED_KEY });

      expect(response.status).toBe(200);
      const { clientAccountID, memo } = WebAuth.readChallengeTx(
        response.body.transaction,
        SERVER_KEY,
        NETWORK_PASSPHRASE,
        HOME_DOMAIN,
        WEB_AUTH_DOMAIN,
      );
      expect(clientAccountID).toBe(MUXED_KEY);
      expect(memo).toBeNull();
    });
  });

  it('never returns the same challenge twice', async () => {
    await withEnv(enabledEnv(), async () => {
      const redis = makeRedis();
      const app = makeApp(redis);

      const first = await request(app).get('/auth').query({ account: CLIENT_KEY });
      const second = await request(app).get('/auth').query({ account: CLIENT_KEY });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.transaction).not.toBe(second.body.transaction);

      const storedKeys = redis.set.mock.calls.map((call) => call[0]);
      expect(storedKeys).toHaveLength(2);
      expect(new Set(storedKeys).size).toBe(2);
    });
  });
});

describe('GET /auth — validation errors', () => {
  it.each([
    ['a missing account', {}, /account is required/],
    ['a malformed account', { account: 'Gshort' }, /valid Stellar G\.\.\. or M\.\.\. address/],
    ['an invalid StrKey checksum', { account: BAD_CHECKSUM_KEY }, /valid Stellar G\.\.\. or M\.\.\. address/],
    ['a non-ID memo', { account: CLIENT_KEY, memo: 'hello' }, /ID memo/],
    ['a negative memo', { account: CLIENT_KEY, memo: '-1' }, /ID memo/],
    ['an oversized memo', { account: CLIENT_KEY, memo: '18446744073709551616' }, /uint64/],
    ['a memo with a muxed account', { account: MUXED_KEY, memo: '1' }, /muxed/],
    ['a wrong home_domain', { account: CLIENT_KEY, home_domain: 'wrong.example.com' }, /home_domain/],
  ])('returns 400 for %s', async (_label, query, message) => {
    await withEnv(enabledEnv(), async () => {
      const redis = makeRedis();
      const response = await request(makeApp(redis)).get('/auth').query(query);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: expect.stringMatching(message) });
      expect(WebAuth.buildChallengeTx).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });
  });
});

describe('GET /auth — disabled and unavailable services', () => {
  it('returns 404 without building a challenge when SEP-10 is disabled', async () => {
    await withEnv({ STELLAR_TAG_DOMAIN: HOME_DOMAIN }, async () => {
      const redis = makeRedis();
      const response = await request(makeApp(redis))
        .get('/auth')
        .query({ account: CLIENT_KEY });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'SEP-10 is not enabled' });
      expect(WebAuth.buildChallengeTx).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
      expect(StrKey.isValidEd25519PublicKey).not.toHaveBeenCalled();
    });
  });

  it('returns 503 when Redis is not configured', async () => {
    await withEnv(enabledEnv(), async () => {
      const response = await request(makeApp(null))
        .get('/auth')
        .query({ account: CLIENT_KEY });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Redis is not configured' });
      expect(WebAuth.buildChallengeTx).not.toHaveBeenCalled();
    });
  });

  it('returns 503 when Redis rejects the write', async () => {
    await withEnv(enabledEnv(), async () => {
      const redis = { set: jest.fn().mockRejectedValue(new Error('connection lost')) };
      const response = await request(makeApp(redis))
        .get('/auth')
        .query({ account: CLIENT_KEY });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Redis is unavailable' });
    });
  });
});
