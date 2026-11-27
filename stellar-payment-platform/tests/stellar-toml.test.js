'use strict';

/**
 * Regression tests for GET /.well-known/stellar.toml.
 *
 * The server is loaded in isolation with the heavy infrastructure mocked so we
 * can assert the exact disabled response and parse the enabled one as TOML.
 */

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
  Keypair: {
    fromSecret: jest.fn((value) => {
      if (typeof value !== 'string' || !value.startsWith('S')) {
        throw new Error('Invalid Secret Seed');
      }
      return { publicKey: () => 'GTESTPUBLICKEYEXAMPLE' };
    }),
  },
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC: 'Public Global Stellar Network ; September 2015',
  },
}));

jest.mock('pdfkit', () => jest.fn());
jest.mock('bad-words', () =>
  jest.fn().mockImplementation(() => ({ isProfane: jest.fn(() => false) })),
);
jest.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    walletBalance: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ '1': 1 }]),
  },
  isPrismaConnectionError: () => false,
}));

jest.mock('../src/cleanup-cron', () => ({ scheduleCleanupJob: jest.fn() }));
jest.mock('../src/soft-delete-purge-cron', () => ({ scheduleSoftDeletePurgeJob: jest.fn() }));
jest.mock('../src/reconciliation-cron', () => ({
  scheduleReconciliationJob: jest.fn(),
  scheduleLedgerReconciliationJob: jest.fn(),
}));
jest.mock('../src/graphql', () => ({
  createGraphQLMiddleware: jest.fn(() => (req, res, next) => next()),
}));
jest.mock('../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn(),
  isSingleSignerAccount: jest.fn(() => true),
}));
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: jest.fn().mockResolvedValue({ query: jest.fn(), release: jest.fn() }),
    end: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    options: { max: 10 },
  })),
}));
jest.mock('../src/sse', () => ({
  ...jest.requireActual('../src/sse'),
  initSse: jest.fn(),
  closeSse: jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const { parse } = require('smol-toml');
const { buildStellarToml } = require('../src/utils/stellarToml');

const SEP10_ENV_KEYS = [
  'SEP10_SIGNING_SECRET',
  'SEP10_HOME_DOMAIN',
  'SEP10_WEB_AUTH_DOMAIN',
  'SEP10_CHALLENGE_TIMEOUT_SECONDS',
  'SEP10_JWT_EXPIRY',
  'FEDERATION_SERVER_URL',
  'STELLAR_TAG_DOMAIN',
  'HORIZON_NETWORK',
];

const withEnv = async (overrides, callback) => {
  const original = new Map(SEP10_ENV_KEYS.map((key) => [key, process.env[key]]));
  SEP10_ENV_KEYS.forEach((key) => delete process.env[key]);
  Object.entries(overrides).forEach(([key, value]) => {
    process.env[key] = value;
  });
  try {
    return await callback();
  } finally {
    SEP10_ENV_KEYS.forEach((key) => {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
};

const loadApp = () => {
  let app;
  jest.isolateModules(() => {
    app = require('../server').app;
  });
  return app;
};

describe('buildStellarToml', () => {
  it('is byte-for-byte identical when SEP-10 is disabled', () => {
    expect(
      buildStellarToml({
        domain: 'example.com',
        sep10: { enabled: false, signingKey: 'GIGNORED' },
      }),
    ).toBe('FEDERATION_SERVER="https://example.com/federation"\n');

    expect(
      buildStellarToml({
        federationServerUrl: 'https://federation.example.com/custom',
        domain: 'example.com',
        sep10: undefined,
      }),
    ).toBe('FEDERATION_SERVER="https://federation.example.com/custom"\n');
  });

  it('emits valid TOML with the three SEP-10 discovery fields when enabled', () => {
    const toml = buildStellarToml({
      domain: 'example.com',
      sep10: {
        enabled: true,
        networkPassphrase: 'Test SDF Network ; September 2015',
        signingKey: 'GTESTPUBLICKEYEXAMPLE',
        webAuthEndpoint: 'https://auth.example.com/auth',
      },
    });

    expect(parse(toml)).toEqual({
      FEDERATION_SERVER: 'https://example.com/federation',
      NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
      SIGNING_KEY: 'GTESTPUBLICKEYEXAMPLE',
      WEB_AUTH_ENDPOINT: 'https://auth.example.com/auth',
    });
  });
});

describe('GET /.well-known/stellar.toml', () => {
  it('refuses to boot when the signing secret is invalid', async () => {
    await withEnv(
      { STELLAR_TAG_DOMAIN: 'example.com', SEP10_SIGNING_SECRET: 'definitely-not-a-secret' },
      () => {
        expect(() => loadApp()).toThrow(/SEP10_SIGNING_SECRET/);
      },
    );
  });

  it('publishes only FEDERATION_SERVER while SEP-10 is disabled', async () => {
    await withEnv({ STELLAR_TAG_DOMAIN: 'example.com' }, async () => {
      const response = await request(loadApp()).get('/.well-known/stellar.toml');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/plain/);
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.text).toBe('FEDERATION_SERVER="https://example.com/federation"\n');
      expect(response.text).not.toContain('SIGNING_KEY');
      expect(response.text).not.toContain('WEB_AUTH_ENDPOINT');
    });
  });

  // Render had no STELLAR_TAG_DOMAIN and published "https://undefined/federation".
  it('falls back to the request host when STELLAR_TAG_DOMAIN is not set', async () => {
    await withEnv({}, async () => {
      const response = await request(loadApp())
        .get('/.well-known/stellar.toml')
        .set('Host', 'stellar-tags.onrender.com');

      expect(response.status).toBe(200);
      expect(response.text).toBe('FEDERATION_SERVER="https://stellar-tags.onrender.com/federation"\n');
      expect(response.text).not.toContain('undefined');
    });
  });

  it('uses plain http for a local development host', async () => {
    await withEnv({}, async () => {
      const response = await request(loadApp())
        .get('/.well-known/stellar.toml')
        .set('Host', 'localhost:5000');

      expect(response.text).toBe('FEDERATION_SERVER="http://localhost:5000/federation"\n');
    });
  });

  it('FEDERATION_SERVER_URL still overrides everything', async () => {
    await withEnv(
      { STELLAR_TAG_DOMAIN: 'example.com', FEDERATION_SERVER_URL: 'https://fed.example.com/custom' },
      async () => {
        const response = await request(loadApp()).get('/.well-known/stellar.toml');
        expect(response.text).toBe('FEDERATION_SERVER="https://fed.example.com/custom"\n');
      },
    );
  });

  it('publishes parseable SEP-10 discovery fields when enabled', async () => {
    await withEnv(
      {
        STELLAR_TAG_DOMAIN: 'example.com',
        SEP10_SIGNING_SECRET: 'S-MOCKED-NOT-A-REAL-SECRET',
        SEP10_WEB_AUTH_DOMAIN: 'auth.example.com',
      },
      async () => {
        const response = await request(loadApp()).get('/.well-known/stellar.toml');

        expect(response.status).toBe(200);
        expect(response.text).toContain('FEDERATION_SERVER="https://example.com/federation"');
        const parsed = parse(response.text);
        expect(parsed.NETWORK_PASSPHRASE).toBe('Test SDF Network ; September 2015');
        expect(parsed.SIGNING_KEY).toBe('GTESTPUBLICKEYEXAMPLE');
        expect(parsed.WEB_AUTH_ENDPOINT).toBe('https://auth.example.com/auth');
      },
    );
  });
});
