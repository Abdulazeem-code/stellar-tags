'use strict';

const mockKeypairInstance = {
  publicKey: jest.fn(() => 'GD6W2P5U37N4U2XMY3R47YJLXE4KJWV4M5H6Z7T8U9V0W1X2Y3Z4A5B6'),
  secret: jest.fn(() => 'SD6W2P5U37N4U2XMY3R47YJLXE4KJWV4M5H6Z7T8U9V0W1X2Y3Z4A5B6'),
  signatureHint: jest.fn(() => Buffer.from('hint')),
  sign: jest.fn(() => Buffer.alloc(64, 1)),
  verify: jest.fn(() => true),
};

class MockDecoratedSignature {
  constructor(opts) {
    this._hint = opts.hint;
    this._signature = opts.signature;
  }
  hint() {
    return this._hint;
  }
  signature() {
    return this._signature;
  }
}

jest.mock('@stellar/stellar-sdk', () => ({
  Keypair: {
    fromSecret: jest.fn(() => mockKeypairInstance),
    fromPublicKey: jest.fn(() => mockKeypairInstance),
    random: jest.fn(() => mockKeypairInstance),
  },
  xdr: {
    DecoratedSignature: MockDecoratedSignature,
  },
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
  },
}));

const { KmsSigner } = require('../src/services/kmsSigner');

describe('Hardware Security Module (HSM) / KMS Transaction Signer', () => {
  function buildMockTransaction() {
    return {
      hash: jest.fn(() => Buffer.alloc(32, 0xaa)),
      signatures: [],
    };
  }

  describe('KMS Mode (Zero Private Keys in Memory)', () => {
    it('signs transaction via external KMS API without accessing private keys', async () => {
      const mockKmsClient = {
        sign: jest.fn().mockImplementation(async () => {
          return { Signature: Buffer.alloc(64, 0xbb) };
        }),
      };

      const signer = new KmsSigner({
        provider: 'aws-kms',
        keyId: 'arn:aws:kms:us-east-1:123456789012:key/stellar-master-key',
        publicKey: 'GD6W2P5U37N4U2XMY3R47YJLXE4KJWV4M5H6Z7T8U9V0W1X2Y3Z4A5B6',
        kmsClient: mockKmsClient,
      });

      process.env.KMS_ENABLED = 'true';
      delete process.env.STELLAR_SECRET_KEY; // Zero secret keys in process memory

      const tx = buildMockTransaction();
      expect(tx.signatures.length).toBe(0);

      await signer.signTransaction(tx);

      // Verify KMS was called with raw 32-byte hash
      expect(mockKmsClient.sign).toHaveBeenCalledTimes(1);
      const callArg = mockKmsClient.sign.mock.calls[0][0];
      expect(callArg.KeyId).toBe('arn:aws:kms:us-east-1:123456789012:key/stellar-master-key');
      expect(callArg.MessageType).toBe('RAW');
      expect(callArg.SigningAlgorithm).toBe('ED25519_SHA_512');
      expect(callArg.Message).toEqual(Buffer.alloc(32, 0xaa));

      // Verify transaction signature
      expect(tx.signatures.length).toBe(1);
      const decSig = tx.signatures[0];
      expect(decSig.hint()).toEqual(Buffer.from('hint'));
      expect(decSig.signature()).toEqual(Buffer.alloc(64, 0xbb));
    });

    it('supports custom or Vault HSM signers', async () => {
      const customSigner = jest.fn().mockImplementation(async () => {
        return Buffer.alloc(64, 0xcc);
      });

      const signer = new KmsSigner({
        provider: 'vault',
        keyId: 'transit/keys/stellar-payment',
        publicKey: 'GD6W2P5U37N4U2XMY3R47YJLXE4KJWV4M5H6Z7T8U9V0W1X2Y3Z4A5B6',
        customSigner,
      });

      const tx = buildMockTransaction();
      await signer.signTransaction(tx);

      expect(customSigner).toHaveBeenCalledTimes(1);
      expect(tx.signatures.length).toBe(1);
      expect(tx.signatures[0].signature()).toEqual(Buffer.alloc(64, 0xcc));
    });
  });

  describe('Local Development Fallback Mode', () => {
    it('falls back to local software secret key when KMS_ENABLED is false', async () => {
      process.env.KMS_ENABLED = 'false';
      process.env.STELLAR_SECRET_KEY = 'SD6W2P5U37N4U2XMY3R47YJLXE4KJWV4M5H6Z7T8U9V0W1X2Y3Z4A5B6';

      const signer = new KmsSigner();
      expect(signer.isKmsEnabled()).toBe(false);

      const tx = buildMockTransaction();
      await signer.signTransaction(tx);

      expect(tx.signatures.length).toBe(1);
      expect(mockKeypairInstance.sign).toHaveBeenCalledWith(Buffer.alloc(32, 0xaa));
    });

    it('throws when fallback secret key is missing', async () => {
      process.env.KMS_ENABLED = 'false';
      delete process.env.STELLAR_SECRET_KEY;

      const signer = new KmsSigner();
      const tx = buildMockTransaction();

      await expect(signer.signTransaction(tx)).rejects.toThrow(
        /STELLAR_SECRET_KEY/
      );
    });
  });

  describe('Validation & Edge Cases', () => {
    it('rejects invalid or non-32-byte hashes', async () => {
      const signer = new KmsSigner();
      await expect(signer.signHash('not-a-buffer')).rejects.toThrow(/Invalid hash buffer/);
      await expect(signer.signHash(Buffer.alloc(16))).rejects.toThrow(/Invalid hash buffer/);
    });

    it('rejects objects that are not Stellar transactions', async () => {
      const signer = new KmsSigner();
      await expect(signer.signTransaction(null)).rejects.toThrow(/Invalid transaction object/);
      await expect(signer.signTransaction({})).rejects.toThrow(/must possess \.hash\(\) method/);
    });
  });
});
