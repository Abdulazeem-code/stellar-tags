'use strict';

/**
 * Unit tests for src/config/sep10.js — opt-in behaviour, defaults, overrides
 * and fail-fast validation. No secret values are ever asserted in messages.
 */

// The SDK's Ed25519 dependency is ESM and cannot be required by this repo's
// CJS Jest setup, so substitute a minimal key derivation for config unit tests.
jest.mock('@stellar/stellar-sdk', () => {
  const TESTNET = 'Test SDF Network ; September 2015';
  const PUBLIC = 'Public Global Stellar Network ; September 2015';
  return {
    Networks: { TESTNET, PUBLIC },
    Keypair: {
      fromSecret: jest.fn((value) => {
        if (typeof value !== 'string' || !/^S[A-Z2-7]{55}$/.test(value)) {
          throw new Error('Invalid Secret Seed');
        }
        return { publicKey: () => `G${value.slice(1)}` };
      }),
    },
  };
});

const { Networks } = require('@stellar/stellar-sdk');
const {
  getSep10Config,
  DEFAULT_CHALLENGE_TIMEOUT_SECONDS,
  DEFAULT_JWT_EXPIRY,
} = require('../src/config/sep10');

const secret = `S${'A'.repeat(55)}`;
const expectedPublicKey = `G${'A'.repeat(55)}`;

const enabledEnv = (overrides = {}) => ({
  STELLAR_TAG_DOMAIN: 'example.com',
  HORIZON_NETWORK: 'testnet',
  SEP10_SIGNING_SECRET: secret,
  ...overrides,
});

describe('getSep10Config — disabled', () => {
  it('is off when the signing secret is unset', () => {
    const config = getSep10Config({ STELLAR_TAG_DOMAIN: 'example.com' });

    expect(config.enabled).toBe(false);
    expect(config.signingKey).toBeNull();
    expect(config.webAuthEndpoint).toBeNull();
    expect(config.networkPassphrase).toBeNull();
    expect(config).not.toHaveProperty('signingSecret');
  });

  it('does not validate other settings while disabled', () => {
    expect(() =>
      getSep10Config({
        SEP10_SIGNING_SECRET: '   ',
        HORIZON_NETWORK: 'not-a-network',
        SEP10_CHALLENGE_TIMEOUT_SECONDS: 'abc',
        SEP10_JWT_EXPIRY: 'nonsense',
      }),
    ).not.toThrow();
  });
});

describe('getSep10Config — enabled defaults', () => {
  it('derives the public key and fills in defaults from the existing environment', () => {
    const config = getSep10Config(enabledEnv());

    expect(config.enabled).toBe(true);
    expect(config.signingKey).toBe(expectedPublicKey);
    expect(config.homeDomain).toBe('example.com');
    expect(config.webAuthDomain).toBe('example.com');
    expect(config.webAuthEndpoint).toBe('https://example.com/auth');
    expect(config.challengeTimeoutSeconds).toBe(DEFAULT_CHALLENGE_TIMEOUT_SECONDS);
    expect(config.challengeTimeoutSeconds).toBe(900);
    expect(config.jwtExpiry).toBe(DEFAULT_JWT_EXPIRY);
    expect(config.jwtExpiry).toBe('24h');
    expect(config.networkPassphrase).toBe(Networks.TESTNET);
    expect(config.network).toBe('testnet');
  });

  it('never exposes the secret on the returned object', () => {
    const config = getSep10Config(enabledEnv());

    expect(config).not.toHaveProperty('SEP10_SIGNING_SECRET');
    expect(config).not.toHaveProperty('signingSecret');
    expect(JSON.stringify(config)).not.toContain(secret);
  });
});

describe('getSep10Config — overrides', () => {
  it('honours domains, timeout, JWT expiry and the public network', () => {
    const config = getSep10Config(
      enabledEnv({
        SEP10_HOME_DOMAIN: 'wallet.example.com',
        SEP10_WEB_AUTH_DOMAIN: 'auth.example.com',
        SEP10_CHALLENGE_TIMEOUT_SECONDS: '60',
        SEP10_JWT_EXPIRY: '1h',
        HORIZON_NETWORK: 'public',
      }),
    );

    expect(config.homeDomain).toBe('wallet.example.com');
    expect(config.webAuthDomain).toBe('auth.example.com');
    expect(config.webAuthEndpoint).toBe('https://auth.example.com/auth');
    expect(config.challengeTimeoutSeconds).toBe(60);
    expect(config.jwtExpiry).toBe('1h');
    expect(config.networkPassphrase).toBe(Networks.PUBLIC);
    expect(config.network).toBe('public');
  });

  it('accepts a signing secret with surrounding whitespace', () => {
    const config = getSep10Config(enabledEnv({ SEP10_SIGNING_SECRET: `  ${secret}  ` }));
    expect(config.signingKey).toBe(expectedPublicKey);
  });
});

describe('getSep10Config — invalid values', () => {
  it('fails fast on an invalid secret without echoing it', () => {
    const badSecret = 'not-a-real-secret';
    let error;

    try {
      getSep10Config(enabledEnv({ SEP10_SIGNING_SECRET: badSecret }));
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toMatch(/SEP10_SIGNING_SECRET/);
    expect(error.message).not.toContain(badSecret);
  });

  it('requires a home domain when enabled', () => {
    expect(() =>
      getSep10Config({
        SEP10_SIGNING_SECRET: secret,
        STELLAR_TAG_DOMAIN: undefined,
        SEP10_HOME_DOMAIN: undefined,
      }),
    ).toThrow(/SEP10_HOME_DOMAIN/);
  });

  it.each(['0', '-5', '1.5', 'abc', '86401'])(
    'rejects a bad challenge timeout (%s)',
    (value) => {
      expect(() =>
        getSep10Config(enabledEnv({ SEP10_CHALLENGE_TIMEOUT_SECONDS: value })),
      ).toThrow(/SEP10_CHALLENGE_TIMEOUT_SECONDS/);
    },
  );

  it.each(['tomorrow', '0h', '24 hours', '-1h'])(
    'rejects a bad JWT expiry (%s)',
    (value) => {
      expect(() => getSep10Config(enabledEnv({ SEP10_JWT_EXPIRY: value }))).toThrow(
        /SEP10_JWT_EXPIRY/,
      );
    },
  );

  it.each(['https://example.com', 'example.com/auth', 'exa mple.com', 'example.com:8080'])(
    'rejects a malformed domain (%s)',
    (value) => {
      expect(() => getSep10Config(enabledEnv({ SEP10_WEB_AUTH_DOMAIN: value }))).toThrow(
        /SEP10_WEB_AUTH_DOMAIN/,
      );
    },
  );

  it('rejects an unknown network', () => {
    expect(() => getSep10Config(enabledEnv({ HORIZON_NETWORK: 'mainnet' }))).toThrow(
      /HORIZON_NETWORK/,
    );
  });
});
