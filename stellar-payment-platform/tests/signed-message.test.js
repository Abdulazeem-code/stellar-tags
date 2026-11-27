'use strict';

/**
 * Real ed25519 signatures: every signature shape a wallet can hand
 * back must verify, and anything else must not.
 */

const crypto = require('crypto');

// Real ed25519 keys from Node's crypto. The Stellar SDK itself cannot load
// under Jest here (an ESM dependency), so only its Keypair lookup is mocked,
// and it hands back these real keys.
const makeKey = (address) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    address,
    publicKey: () => address,
    sign: (data) => crypto.sign(null, data, privateKey),
    verify: (data, signature) => crypto.verify(null, data, publicKey, signature),
  };
};
const mockOwner = makeKey('GOWNER');
const mockStranger = makeKey('GSTRANGER');

jest.mock('@stellar/stellar-sdk', () => ({
  Keypair: {
    fromPublicKey: (address) => {
      const key = { GOWNER: mockOwner, GSTRANGER: mockStranger }[address];
      if (!key) throw new Error(`unknown test key ${address}`);
      return key;
    },
  },
  StrKey: { isValidEd25519PublicKey: (value) => value === 'GOWNER' || value === 'GSTRANGER' },
}));
jest.mock('../prismaClient', () => ({ prisma: {} }));
jest.mock('../src/multisigner-verifier', () => ({ verifyMultiSignerThreshold: jest.fn() }));
jest.mock('../src/db', () => ({ poolGet: jest.fn() }));

const {
  SEP53_PREFIX,
  decodeSignature,
  verifySignedMessage,
} = require('../src/services/signedMessage');
const { verifyFreighterSignedMessage } = require('../src/services/ownershipService');
const { verifyFreighterRegistrationSignature } = require('../src/services/signatureService');

const MESSAGE = 'payment-request:account2*localhost';

const sep53Hash = (message) =>
  crypto.createHash('sha256').update(Buffer.concat([SEP53_PREFIX, Buffer.from(message, 'utf8')])).digest();

const signatures = {
  sep53: mockOwner.sign(sep53Hash(MESSAGE)),
  raw: mockOwner.sign(Buffer.from(MESSAGE, 'utf8')),
  prefixedUnhashed: mockOwner.sign(Buffer.concat([SEP53_PREFIX, Buffer.from(MESSAGE, 'utf8')])),
};

describe('verifySignedMessage', () => {
  describe.each(Object.entries(signatures))('a %s signature', (_name, signature) => {
    test('verifies as a Buffer', () => {
      expect(verifySignedMessage(mockOwner, MESSAGE, signature)).toBe(true);
    });

    test('verifies as base64', () => {
      expect(verifySignedMessage(mockOwner, MESSAGE, signature.toString('base64'))).toBe(true);
    });

    test('verifies as hex', () => {
      expect(verifySignedMessage(mockOwner, MESSAGE, signature.toString('hex'))).toBe(true);
    });

    test('verifies as double-encoded base64', () => {
      const twice = Buffer.from(signature.toString('base64'), 'utf8').toString('base64');
      expect(verifySignedMessage(mockOwner, MESSAGE, twice)).toBe(true);
    });

    test('does not verify for another key', () => {
      expect(verifySignedMessage(mockStranger, MESSAGE, signature.toString('base64'))).toBe(false);
    });

    test('does not verify for another message', () => {
      expect(verifySignedMessage(mockOwner, 'payment-request:someoneelse*localhost', signature)).toBe(false);
    });
  });

  test('a malformed signature is a failed check, not a crash', () => {
    expect(verifySignedMessage(mockOwner, MESSAGE, 'not-a-signature')).toBe(false);
    expect(verifySignedMessage(mockOwner, MESSAGE, Buffer.alloc(10))).toBe(false);
  });

  test('a non-string, non-Buffer signature is rejected as a format error', () => {
    expect(() => decodeSignature(12345)).toThrow('Invalid message signature format.');
  });
});

describe('ownership checks accept the same wallet formats as registration', () => {
  // A raw-message signature is what passed registration but was refused by
  // POST /payment-requests ("Signature verification failed.").
  test.each([
    ['SEP-53 base64', signatures.sep53.toString('base64')],
    ['raw message base64', signatures.raw.toString('base64')],
    ['raw message hex', signatures.raw.toString('hex')],
  ])('payment request ownership accepts %s', (_name, signature) => {
    expect(
      verifyFreighterSignedMessage({
        message: MESSAGE,
        signature,
        signerAddress: mockOwner.publicKey(),
        publicKey: mockOwner.publicKey(),
      }),
    ).toBe(mockOwner.publicKey());
  });

  test('payment request ownership still refuses a signature from another key', () => {
    expect(() =>
      verifyFreighterSignedMessage({
        message: MESSAGE,
        signature: mockStranger.sign(sep53Hash(MESSAGE)).toString('base64'),
        signerAddress: mockOwner.publicKey(),
        publicKey: mockOwner.publicKey(),
      }),
    ).toThrow('Signature verification failed.');
  });

  test('registration keeps accepting the raw-message form', () => {
    const username = 'account2';
    const address = mockOwner.publicKey();
    const signature = mockOwner.sign(Buffer.from(`register:${username}:${address}`, 'utf8')).toString('base64');
    expect(verifyFreighterRegistrationSignature({ username, address, signature })).toBe(address);
  });
});
