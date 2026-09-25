'use strict';

/**
 * Unit tests for src/services/ownershipService.js.
 *
 * The real @stellar/stellar-sdk ships ESM entry points Jest 29 cannot parse,
 * so Keypair.verify is stubbed while the message-hashing and validation logic
 * inside verifyFreighterSignedMessage is exercised for real.
 */

jest.mock('@stellar/stellar-sdk', () => {
  const mockVerify = jest.fn();
  return {
    Keypair: {
      fromPublicKey: jest.fn(() => ({ verify: mockVerify })),
      random: jest.fn(() => ({ publicKey: () => 'GFAKE' })),
    },
    StrKey: {
      isValidEd25519PublicKey: (value) =>
        typeof value === 'string' && value.startsWith('G') && value.length === 56,
    },
    __mockVerify: mockVerify,
  };
});

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock('../src/db', () => ({
  poolGet: jest.fn(),
}));

jest.mock('../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn(),
}));

jest.mock('../src/utils', () => {
  const actual = jest.requireActual('../src/utils');
  return {
    ...actual,
    shouldFallbackToLocalRegistry: jest.fn().mockReturnValue(false),
  };
});

const { prisma } = require('../prismaClient');
const { poolGet } = require('../src/db');
const { verifyMultiSignerThreshold } = require('../src/multisigner-verifier');
const sdk = require('@stellar/stellar-sdk');
const {
  authenticateUsernameOwner,
  verifyFreighterSignedMessage,
} = require('../src/services/ownershipService');

const crypto = require('crypto');

const VALID_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const OTHER_ADDRESS = 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ';

const hashMessage = (message) => {
  const prefix = Buffer.from('Stellar Signed Message:\n', 'utf8');
  const payload = Buffer.concat([prefix, Buffer.from(message, 'utf8')]);
  return crypto.createHash('sha256').update(payload).digest();
};

const BASE64_SIGNATURE = Buffer.alloc(64, 7).toString('base64');

describe('verifyFreighterSignedMessage', () => {
  beforeEach(() => {
    sdk.__mockVerify.mockReset();
    sdk.__mockVerify.mockReturnValue(true);
  });

  it('accepts a valid signed message from the registered account', () => {
    const message = 'webhook:alice';

    const result = verifyFreighterSignedMessage({
      message,
      signature: BASE64_SIGNATURE,
      publicKey: VALID_ADDRESS,
    });

    expect(result).toBe(VALID_ADDRESS);
    expect(sdk.__mockVerify).toHaveBeenCalledTimes(1);
    // The verified payload must be the sha256 hash of the prefixed message.
    const [messageHash, signatureBuffer] = sdk.__mockVerify.mock.calls[0];
    expect(messageHash).toEqual(hashMessage(message));
    expect(Buffer.isBuffer(signatureBuffer)).toBe(true);
  });

  it('accepts a Buffer signature directly', () => {
    const result = verifyFreighterSignedMessage({
      message: 'webhook:alice',
      signature: Buffer.alloc(64, 1),
      publicKey: VALID_ADDRESS,
    });

    expect(result).toBe(VALID_ADDRESS);
    expect(sdk.__mockVerify).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid signer address format', () => {
    expect(() =>
      verifyFreighterSignedMessage({
        message: 'webhook:alice',
        signature: BASE64_SIGNATURE,
        publicKey: 'not-a-valid-address',
      }),
    ).toThrow(/Invalid signer address format/);
  });

  it('rejects a signature in an unsupported format', () => {
    expect(() =>
      verifyFreighterSignedMessage({
        message: 'webhook:alice',
        signature: 12345,
        publicKey: VALID_ADDRESS,
      }),
    ).toThrow(/Invalid message signature format/);
  });

  it('rejects a signature that does not verify', () => {
    sdk.__mockVerify.mockReturnValue(false);

    expect(() =>
      verifyFreighterSignedMessage({
        message: 'webhook:alice',
        signature: BASE64_SIGNATURE,
        publicKey: VALID_ADDRESS,
      }),
    ).toThrow(/Signature verification failed/);
  });

  it('rejects a valid signature from a different signer address', () => {
    expect(() =>
      verifyFreighterSignedMessage({
        message: 'webhook:alice',
        signature: BASE64_SIGNATURE,
        signerAddress: OTHER_ADDRESS,
        publicKey: VALID_ADDRESS,
      }),
    ).toThrow(/Signer address does not match the registered account/);
  });
});

describe('authenticateUsernameOwner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sdk.__mockVerify.mockReturnValue(true);
    prisma.user.findUnique.mockResolvedValue({
      username: 'alice',
      address: VALID_ADDRESS,
    });
  });

  it('returns the user record after verifying a Freighter signature', async () => {
    const result = await authenticateUsernameOwner({
      username: 'alice',
      signature: BASE64_SIGNATURE,
      publicKey: VALID_ADDRESS,
    });

    expect(result.username).toBe('alice');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { username: 'alice*localhost' },
      select: { username: true, address: true },
    });
  });

  it('uses the multi-signer path when the signature is a Stellar address', async () => {
    verifyMultiSignerThreshold.mockResolvedValue({ success: true });

    const result = await authenticateUsernameOwner({
      username: 'alice',
      signature: OTHER_ADDRESS,
    });

    expect(result.username).toBe('alice');
    expect(verifyMultiSignerThreshold).toHaveBeenCalledWith(
      VALID_ADDRESS,
      [OTHER_ADDRESS],
      { operationType: 'management' },
    );
  });

  it('rejects a failed multi-signer verification', async () => {
    verifyMultiSignerThreshold.mockResolvedValue({
      success: false,
      errorMessage: 'Not enough signers',
    });

    await expect(
      authenticateUsernameOwner({ username: 'alice', signature: OTHER_ADDRESS }),
    ).rejects.toMatchObject({ message: 'Not enough signers', statusCode: 401 });
  });

  it('rejects a missing username', async () => {
    await expect(
      authenticateUsernameOwner({ username: '', signature: 'x' }),
    ).rejects.toMatchObject({ message: 'Missing required field: username.', statusCode: 400 });
  });

  it('rejects a missing signature', async () => {
    await expect(
      authenticateUsernameOwner({ username: 'alice', signature: '' }),
    ).rejects.toMatchObject({ message: 'Missing required field: signature.', statusCode: 400 });
  });

  it('rejects an unregistered username', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      authenticateUsernameOwner({ username: 'ghost', signature: 'x' }),
    ).rejects.toMatchObject({ message: 'Username not registered.', statusCode: 404 });
  });

  it('falls back to the local registry when the primary lookup fails', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('db unavailable'));
    const { shouldFallbackToLocalRegistry } = require('../src/utils');
    shouldFallbackToLocalRegistry.mockReturnValue(true);
    poolGet.mockResolvedValue({ username: 'alice', address: VALID_ADDRESS });

    const result = await authenticateUsernameOwner({
      username: 'alice',
      signature: BASE64_SIGNATURE,
    });

    expect(result.username).toBe('alice');
    expect(poolGet).toHaveBeenCalledWith(
      'SELECT username, address FROM username_registry WHERE username = $1 LIMIT 1',
      ['alice*localhost'],
    );
  });
});