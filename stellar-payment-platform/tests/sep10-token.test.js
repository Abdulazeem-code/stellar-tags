'use strict';

/**
 * Tests for SEP-10 POST /auth.
 *
 * The CJS Jest setup cannot load the SDK's ESM hash dependency, so a compact
 * mock implements the WebAuth helpers the service calls. The service is still
 * driven through the real Express route and the real RS256 JWT utility.
 */

const crypto = require('crypto');

jest.mock('@stellar/stellar-sdk', () => {
  const { randomBytes } = require('crypto');
  const TESTNET = 'Test SDF Network ; September 2015';
  const PUBLIC = 'Public Global Stellar Network ; September 2015';
  const SERVER_KEY = `G${'A'.repeat(55)}`;
  const CLIENT_KEY = `G${'C'.repeat(55)}`;
  const MUXED_KEY = `M${'C'.repeat(55)}`;
  const CLIENT_DOMAIN_KEY = `G${'D'.repeat(55)}`;
  const EXTRA_KEY = `G${'E'.repeat(55)}`;
  const HOME_DOMAIN = 'example.com';
  const WEB_AUTH_DOMAIN = 'auth.example.com';

  const encodeTx = (tx) => Buffer.from(JSON.stringify(tx)).toString('base64');
  const decodeTx = (xdr) => JSON.parse(Buffer.from(xdr, 'base64').toString('utf8'));
  const fail = (message) => {
    throw new Error(message);
  };

  const validateChallenge = (
    challengeTx,
    serverAccountID,
    networkPassphrase,
    homeDomains,
    webAuthDomain,
  ) => {
    const tx = decodeTx(challengeTx);
    const now = Math.floor(Date.now() / 1000);

    if (Number.parseInt(tx.sequence, 10) !== 0) fail('Sequence must be zero');
    if (tx.source !== serverAccountID) fail('Wrong source');
    if (tx.networkPassphrase !== networkPassphrase) fail('Wrong network passphrase');
    if (!tx.timeBounds || tx.timeBounds.minTime > now ||
        tx.timeBounds.maxTime <= now || tx.timeBounds.maxTime - now < 300) {
      fail('Expired time bounds');
    }
    if (!Array.isArray(tx.operations) || tx.operations.length === 0) fail('No operations');
    if (tx.operations.some((op) => op.type !== 'manageData')) fail('Non-manageData operation');

    const [first, ...rest] = tx.operations;
    if (!first.source) fail('First operation has no source');
    if (Buffer.from(first.value, 'base64').length !== 48) fail('Invalid nonce');

    const domains = Array.isArray(homeDomains) ? homeDomains : [homeDomains];
    const matchedHomeDomain = domains.find((domain) => `${domain} auth` === first.name);
    if (!matchedHomeDomain) fail('Home domain mismatch');

    const webAuthOp = rest.find((op) => op.name === 'web_auth_domain');
    if (!webAuthOp || webAuthOp.value !== webAuthDomain || webAuthOp.source !== serverAccountID) {
      fail('Invalid web_auth_domain operation');
    }
    for (const op of rest) {
      if (op.name === 'web_auth_domain' || op.name === 'client_domain') continue;
      if (op.source !== serverAccountID) fail('Unrecognized operation source');
    }

    if (tx.memo.type !== 'none' && tx.memo.type !== 'id') fail('Invalid memo type');
    if (tx.memo.type === 'id' && first.source.startsWith('M')) fail('Muxed account with memo');

    if (!tx.signatures.includes(serverAccountID)) fail('Not signed by server');

    return {
      tx,
      clientAccountID: first.source,
      matchedHomeDomain,
      memo: tx.memo.type === 'id' ? tx.memo.value : null,
    };
  };

  const buildChallengeTx = jest.fn((
    keypair,
    clientAccountID,
    homeDomain,
    timeout = 300,
    networkPassphrase,
    webAuthDomain,
    memo = null,
  ) => {
    const now = Math.floor(Date.now() / 1000);
    return encodeTx({
      sequence: '0',
      source: keypair.publicKey(),
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
          source: keypair.publicKey(),
        },
      ],
      signatures: [keypair.publicKey()],
    });
  });

  const readChallengeTx = jest.fn(validateChallenge);

  const verifyChallengeTxSigners = jest.fn((
    challengeTx,
    serverAccountID,
    networkPassphrase,
    signers,
    homeDomains,
    webAuthDomain,
  ) => {
    const { tx } = validateChallenge(
      challengeTx,
      serverAccountID,
      networkPassphrase,
      homeDomains,
      webAuthDomain,
    );
    const clientDomainOp = tx.operations.find((op) => op.name === 'client_domain');
    const clientDomainSigner = clientDomainOp && clientDomainOp.source;
    if (clientDomainSigner && !tx.signatures.includes(clientDomainSigner)) {
      fail('Client domain signature missing');
    }

    const clientSignatures = tx.signatures.filter(
      (sig) => sig !== serverAccountID && sig !== clientDomainSigner,
    );
    if (clientSignatures.length !== 1) fail('Expected exactly one client signature');
    if (!signers.includes(clientSignatures[0])) fail('Unrecognized signer');
    return clientSignatures;
  });

  const verifyChallengeTxThreshold = jest.fn((
    challengeTx,
    serverAccountID,
    networkPassphrase,
    threshold,
    signerSummary,
    homeDomains,
    webAuthDomain,
  ) => {
    const { tx } = validateChallenge(
      challengeTx,
      serverAccountID,
      networkPassphrase,
      homeDomains,
      webAuthDomain,
    );
    const clientDomainOp = tx.operations.find((op) => op.name === 'client_domain');
    const clientDomainSigner = clientDomainOp && clientDomainOp.source;
    if (clientDomainSigner && !tx.signatures.includes(clientDomainSigner)) {
      fail('Client domain signature missing');
    }

    const weights = new Map(
      signerSummary.map((signer) => [signer.key, Number(signer.weight) || 0]),
    );
    const clientSignatures = tx.signatures.filter(
      (sig) => sig !== serverAccountID && sig !== clientDomainSigner,
    );
    if (clientSignatures.length === 0) fail('No client signatures');

    let totalWeight = 0;
    for (const signature of clientSignatures) {
      const weight = weights.get(signature) || 0;
      if (!weight) fail('Unrecognized signature');
      totalWeight += weight;
    }
    if (totalWeight < threshold) fail('Threshold not met');
    return clientSignatures;
  });

  const makeChallenge = (overrides = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return encodeTx({
      sequence: '0',
      source: SERVER_KEY,
      networkPassphrase: TESTNET,
      timeBounds: { minTime: now, maxTime: now + 900 },
      memo: { type: 'none', value: null },
      operations: [
        {
          type: 'manageData',
          name: `${HOME_DOMAIN} auth`,
          value: Buffer.from('x'.repeat(48)).toString('base64'),
          source: CLIENT_KEY,
        },
        {
          type: 'manageData',
          name: 'web_auth_domain',
          value: WEB_AUTH_DOMAIN,
          source: SERVER_KEY,
        },
      ],
      signatures: [SERVER_KEY, CLIENT_KEY],
      ...overrides,
    });
  };

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
      isValidEd25519PublicKey: jest.fn((key) => /^G[A-Z2-7]{55}$/.test(key)),
      isValidMed25519PublicKey: jest.fn((key) => /^M[A-Z2-7]{55}$/.test(key)),
    },
    WebAuth: {
      buildChallengeTx,
      readChallengeTx,
      verifyChallengeTxSigners,
      verifyChallengeTxThreshold,
    },
    _test: {
      TESTNET,
      SERVER_KEY,
      CLIENT_KEY,
      MUXED_KEY,
      CLIENT_DOMAIN_KEY,
      EXTRA_KEY,
      HOME_DOMAIN,
      WEB_AUTH_DOMAIN,
      encodeTx,
      decodeTx,
      makeChallenge,
    },
  };
});

jest.mock('../src/services/stellarService', () => ({ loadAccount: jest.fn() }));

// JWT keys are read once when src/utils/jwt.js is first required, so install
// them before any application module is loaded.
const generatedKeys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
process.env.JWT_PRIVATE_KEY = generatedKeys.privateKey;
process.env.JWT_PUBLIC_KEY = generatedKeys.publicKey;

const express = require('express');
const request = require('supertest');
const jsonwebtoken = require('jsonwebtoken');
const { WebAuth, _test } = require('@stellar/stellar-sdk');
const { loadAccount } = require('../src/services/stellarService');
const { getJwks, verifyToken } = require('../src/utils/jwt');
const authRoutes = require('../src/routes/v1/authRoutes');
const { challengeHash, CHALLENGE_KEY_PREFIX } = require('../src/services/sep10');

const {
  TESTNET,
  SERVER_KEY,
  CLIENT_KEY,
  CLIENT_DOMAIN_KEY,
  EXTRA_KEY,
  HOME_DOMAIN,
  WEB_AUTH_DOMAIN,
  makeChallenge,
} = _test;
const SECRET = `S${'A'.repeat(55)}`;
const AUTH_ENDPOINT = `https://${WEB_AUTH_DOMAIN}/auth`;

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
  SEP10_CHALLENGE_TIMEOUT_SECONDS: '900',
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

const makeRedis = (hashes = []) => {
  const store = new Map(
    hashes.map((hash) => [`${CHALLENGE_KEY_PREFIX}${hash}`, hash]),
  );
  return {
    get: jest.fn(async (key) => store.get(key) ?? null),
    del: jest.fn(async (key) => (store.delete(key) ? 1 : 0)),
    set: jest.fn(async (key, value) => {
      store.set(key, value);
      return 'OK';
    }),
  };
};

const makeApp = (redisClient) => {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes(redisClient));
  return app;
};

const missingAccount = () =>
  Promise.reject({ response: { status: 404 } });

const assertJwksVerification = (token) => {
  const jwk = getJwks().keys[0];
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const claims = jsonwebtoken.verify(token, publicKey, { algorithms: ['RS256'] });
  expect(claims.sub).toBe(CLIENT_KEY);
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /auth — successful exchanges', () => {
  it('issues a JWT for a new account signed by its master key (JSON body)', async () => {
    await withEnv(enabledEnv(), async () => {
      const transaction = makeChallenge();
      const hash = challengeHash(transaction);
      const redis = makeRedis([hash]);
      loadAccount.mockImplementation(missingAccount);

      const response = await request(makeApp(redis))
        .post('/auth')
        .send({ transaction });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ token: expect.any(String) });
      expect(response.headers['access-control-allow-origin']).toBe('*');

      const claims = verifyToken(response.body.token);
      expect(claims.iss).toBe(AUTH_ENDPOINT);
      expect(claims.sub).toBe(CLIENT_KEY);
      expect(claims.jti).toBe(hash);
      expect(claims.home_domain).toBe(HOME_DOMAIN);
      expect(claims.iat).toEqual(expect.any(Number));
      expect(claims.exp).toBe(claims.iat + 24 * 60 * 60);
      expect(claims.client_domain).toBeUndefined();

      assertJwksVerification(response.body.token);

      expect(WebAuth.verifyChallengeTxSigners).toHaveBeenCalledWith(
        transaction,
        SERVER_KEY,
        TESTNET,
        [CLIENT_KEY],
        HOME_DOMAIN,
        WEB_AUTH_DOMAIN,
      );
      expect(WebAuth.verifyChallengeTxThreshold).not.toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalledWith(`${CHALLENGE_KEY_PREFIX}${hash}`);
    });
  });

  it('accepts application/x-www-form-urlencoded bodies', async () => {
    await withEnv(enabledEnv(), async () => {
      const transaction = makeChallenge();
      const redis = makeRedis([challengeHash(transaction)]);
      loadAccount.mockImplementation(missingAccount);

      const response = await request(makeApp(redis))
        .post('/auth')
        .type('form')
        .send({ transaction });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ token: expect.any(String) });
    });
  });

  it('uses the medium threshold and signer weights for an existing account', async () => {
    await withEnv(enabledEnv(), async () => {
      const signerKey = `G${'F'.repeat(55)}`;
      const transaction = makeChallenge({
        signatures: [SERVER_KEY, CLIENT_KEY, signerKey],
      });
      const redis = makeRedis([challengeHash(transaction)]);
      const signers = [
        { key: CLIENT_KEY, weight: 1 },
        { key: signerKey, weight: 1 },
      ];
      loadAccount.mockResolvedValue({
        id: CLIENT_KEY,
        thresholds: { med_threshold: 2 },
        signers,
      });

      const response = await request(makeApp(redis))
        .post('/auth')
        .send({ transaction });

      expect(response.status).toBe(200);
      expect(WebAuth.verifyChallengeTxThreshold).toHaveBeenCalledWith(
        transaction,
        SERVER_KEY,
        TESTNET,
        2,
        signers,
        HOME_DOMAIN,
        WEB_AUTH_DOMAIN,
      );
      expect(WebAuth.verifyChallengeTxSigners).not.toHaveBeenCalled();
    });
  });

  it('includes client_domain in the JWT when the challenge contains it', async () => {
    await withEnv(enabledEnv(), async () => {
      const transaction = makeChallenge({
        operations: [
          {
            type: 'manageData',
            name: `${HOME_DOMAIN} auth`,
            value: Buffer.from('x'.repeat(48)).toString('base64'),
            source: CLIENT_KEY,
          },
          {
            type: 'manageData',
            name: 'web_auth_domain',
            value: WEB_AUTH_DOMAIN,
            source: SERVER_KEY,
          },
          {
            type: 'manageData',
            name: 'client_domain',
            value: 'wallet.example.com',
            source: CLIENT_DOMAIN_KEY,
          },
        ],
        signatures: [SERVER_KEY, CLIENT_KEY, CLIENT_DOMAIN_KEY],
      });
      const redis = makeRedis([challengeHash(transaction)]);
      loadAccount.mockImplementation(missingAccount);

      const response = await request(makeApp(redis))
        .post('/auth')
        .send({ transaction });

      expect(response.status).toBe(200);
      expect(verifyToken(response.body.token).client_domain).toBe('wallet.example.com');
    });
  });

  it('handles a browser preflight request with wildcard CORS', async () => {
    const response = await request(makeApp(makeRedis())).options('/auth');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
  });
});

describe('POST /auth — signature and threshold failures', () => {
  it.each([
    [
      'signatures below the medium threshold',
      {
        signatures: [SERVER_KEY, CLIENT_KEY],
        account: {
          thresholds: { med_threshold: 2 },
          signers: [
            { key: CLIENT_KEY, weight: 1 },
            { key: `G${'F'.repeat(55)}`, weight: 1 },
          ],
        },
      },
    ],
    [
      'an extra unrecognised signature',
      {
        signatures: [SERVER_KEY, CLIENT_KEY, EXTRA_KEY],
        account: {
          thresholds: { med_threshold: 1 },
          signers: [{ key: CLIENT_KEY, weight: 1 }],
        },
      },
    ],
  ])('rejects %s with 401', async (_label, { signatures, account }) => {
    await withEnv(enabledEnv(), async () => {
      const transaction = makeChallenge({ signatures });
      const redis = makeRedis([challengeHash(transaction)]);
      loadAccount.mockResolvedValue(account);

      const response = await request(makeApp(redis))
        .post('/auth')
        .send({ transaction });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Invalid challenge signature' });
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  it('rejects more than one client signature for a new account', async () => {
    await withEnv(enabledEnv(), async () => {
      const transaction = makeChallenge({
        signatures: [SERVER_KEY, CLIENT_KEY, EXTRA_KEY],
      });
      const redis = makeRedis([challengeHash(transaction)]);
      loadAccount.mockImplementation(missingAccount);

      const response = await request(makeApp(redis))
        .post('/auth')
        .send({ transaction });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Invalid challenge signature' });
    });
  });
});

describe('POST /auth — structural challenge failures', () => {
  it.each([
    [
      'a wrong network passphrase',
      { networkPassphrase: 'Wrong Network ; September 2015' },
    ],
    [
      'expired time bounds',
      (() => {
        const now = Math.floor(Date.now() / 1000);
        return { timeBounds: { minTime: now - 100, maxTime: now + 10 } };
      })(),
    ],
    [
      'tampered operations',
      {
        operations: [
          {
            type: 'manageData',
            name: 'wrong.example.com auth',
            value: Buffer.from('x'.repeat(48)).toString('base64'),
            source: CLIENT_KEY,
          },
          {
            type: 'manageData',
            name: 'web_auth_domain',
            value: WEB_AUTH_DOMAIN,
            source: SERVER_KEY,
          },
        ],
      },
    ],
    ['a missing server signature', { signatures: [CLIENT_KEY] }],
  ])('rejects %s with a generic 400', async (_label, overrides) => {
    await withEnv(enabledEnv(), async () => {
      const transaction = makeChallenge(overrides);
      const redis = makeRedis([challengeHash(transaction)]);

      const response = await request(makeApp(redis))
        .post('/auth')
        .send({ transaction });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid challenge transaction' });
      expect(loadAccount).not.toHaveBeenCalled();
      expect(redis.del).not.toHaveBeenCalled();
    });
  });
});

describe('POST /auth — replay and service availability', () => {
  it('rejects a replayed challenge on the second exchange', async () => {
    await withEnv(enabledEnv(), async () => {
      const transaction = makeChallenge();
      const redis = makeRedis([challengeHash(transaction)]);
      loadAccount.mockImplementation(missingAccount);
      const app = makeApp(redis);

      const first = await request(app).post('/auth').send({ transaction });
      const second = await request(app).post('/auth').send({ transaction });

      expect(first.status).toBe(200);
      expect(second.status).toBe(400);
      expect(second.body).toEqual({ error: 'Invalid or expired challenge' });
      expect(redis.del).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects a challenge that was never issued', async () => {
    await withEnv(enabledEnv(), async () => {
      const response = await request(makeApp(makeRedis()))
        .post('/auth')
        .send({ transaction: makeChallenge() });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid or expired challenge' });
    });
  });

  it('returns 503 for Horizon failures other than account-not-found', async () => {
    await withEnv(enabledEnv(), async () => {
      const transaction = makeChallenge();
      const redis = makeRedis([challengeHash(transaction)]);
      loadAccount.mockRejectedValue({ response: { status: 500 } });

      const response = await request(makeApp(redis))
        .post('/auth')
        .send({ transaction });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Horizon is unavailable' });
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  it('returns 404 when SEP-10 is disabled', async () => {
    await withEnv({ STELLAR_TAG_DOMAIN: HOME_DOMAIN }, async () => {
      const response = await request(makeApp(makeRedis()))
        .post('/auth')
        .send({ transaction: makeChallenge() });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'SEP-10 is not enabled' });
    });
  });

  it('returns 503 when Redis is not configured', async () => {
    await withEnv(enabledEnv(), async () => {
      const response = await request(makeApp(null))
        .post('/auth')
        .send({ transaction: makeChallenge() });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Redis is not configured' });
    });
  });

  it('returns 400 for a missing transaction field', async () => {
    await withEnv(enabledEnv(), async () => {
      const response = await request(makeApp(makeRedis()))
        .post('/auth')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'transaction is required' });
    });
  });
});
