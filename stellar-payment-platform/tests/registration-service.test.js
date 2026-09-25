'use strict';

/**
 * Unit tests for src/services/registrationService.js — transferAccount.
 */

jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: {
    isValidEd25519PublicKey: (value) =>
      typeof value === 'string' && value.startsWith('G') && value.length === 56,
  },
}));

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn(),
}));

jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { prisma } = require('../prismaClient');
const { verifyMultiSignerThreshold } = require('../src/multisigner-verifier');
const { transferAccount } = require('../src/services/registrationService');

const VALID_NEW_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('transferAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    verifyMultiSignerThreshold.mockResolvedValue({ success: true });
    prisma.user.findUnique.mockResolvedValue({
      username: 'alice',
      address: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
    });
    prisma.user.update.mockResolvedValue({ username: 'alice', address: VALID_NEW_ADDRESS });
  });

  it('transfers a username to a new verified address', async () => {
    const updated = await transferAccount(
      'alice',
      'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
      VALID_NEW_ADDRESS,
      'sig-old',
      'sig-new',
    );

    expect(updated.address).toBe(VALID_NEW_ADDRESS);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { username: 'alice' },
      data: { address: VALID_NEW_ADDRESS },
    });
    expect(verifyMultiSignerThreshold).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing username', async () => {
    await expect(
      transferAccount('', 'old', VALID_NEW_ADDRESS, 's1', 's2'),
    ).rejects.toMatchObject({ message: 'Username is required', statusCode: 400 });
  });

  it('rejects missing addresses', async () => {
    await expect(
      transferAccount('alice', null, VALID_NEW_ADDRESS, 's1', 's2'),
    ).rejects.toMatchObject({
      message: 'Both oldAddress and newAddress are required',
      statusCode: 400,
    });
  });

  it('rejects an invalid new Stellar address', async () => {
    await expect(
      transferAccount('alice', 'old', 'not-valid', 's1', 's2'),
    ).rejects.toMatchObject({
      message: 'Invalid Stellar Public Key format for new address',
      statusCode: 400,
    });
  });

  it('rejects missing signatures', async () => {
    await expect(
      transferAccount('alice', 'old', VALID_NEW_ADDRESS, '', 's2'),
    ).rejects.toMatchObject({
      message: 'Signatures from both old and new addresses are required',
      statusCode: 400,
    });
  });

  it('rejects an unknown user with 404', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      transferAccount('ghost', 'old', VALID_NEW_ADDRESS, 's1', 's2'),
    ).rejects.toMatchObject({ message: 'User not found', statusCode: 404 });
  });

  it('rejects an address that does not match the current record', async () => {
    await expect(
      transferAccount('alice', 'GDIFFERENTADDRESS', VALID_NEW_ADDRESS, 's1', 's2'),
    ).rejects.toMatchObject({
      message: 'Old address does not match current record',
      statusCode: 400,
    });
  });

  it('rejects a failed old-address signature verification', async () => {
    verifyMultiSignerThreshold.mockResolvedValue({
      success: false,
      errorMessage: 'Old signature invalid',
    });
    await expect(
      transferAccount('alice', 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ', VALID_NEW_ADDRESS, 's1', 's2'),
    ).rejects.toMatchObject({ message: 'Old signature invalid', statusCode: 401 });
  });

  it('rejects a failed new-address signature verification', async () => {
    verifyMultiSignerThreshold
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, errorMessage: 'New signature invalid' });
    await expect(
      transferAccount('alice', 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ', VALID_NEW_ADDRESS, 's1', 's2'),
    ).rejects.toMatchObject({ message: 'New signature invalid', statusCode: 401 });
  });
});