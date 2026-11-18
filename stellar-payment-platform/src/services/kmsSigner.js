'use strict';

/**
 * Hardware Security Module (HSM) / Key Management Service (KMS) Signer
 *
 * Provides cryptographic signing for Stellar transactions without loading
 * or exposing secret keys in application memory.
 *
 * Supports AWS KMS / Vault HSM signing with a safe fallback mechanism
 * for local development.
 */

const { Keypair, xdr } = require('@stellar/stellar-sdk');
const { logger } = require('../logger');

let fallbackWarned = false;

class KmsSigner {
  constructor(options = {}) {
    this.provider = options.provider || process.env.KMS_PROVIDER || 'aws-kms';
    this.keyId = options.keyId || process.env.KMS_KEY_ID;
    this.kmsClient = options.kmsClient || null;
    this.customSigner = options.customSigner || null;
    this.publicKey = options.publicKey || process.env.KMS_PUBLIC_KEY;
  }

  /**
   * Checks whether KMS HSM signing is enabled in the current environment.
   * @returns {boolean}
   */
  isKmsEnabled() {
    return process.env.KMS_ENABLED === 'true' || Boolean(this.customSigner);
  }

  /**
   * Retrieves the Stellar public address associated with this signer.
   * In KMS mode, reads from KMS configuration or public key cache.
   * In fallback mode, derives from local secret key.
   *
   * @returns {string} Stellar public address (G...)
   */
  getPublicKey() {
    if (this.publicKey) {
      return this.publicKey;
    }

    if (!this.isKmsEnabled()) {
      const secret = process.env.STELLAR_SECRET_KEY;
      if (!secret) {
        throw new Error('[KmsSigner] No KMS_PUBLIC_KEY configured and STELLAR_SECRET_KEY missing for fallback');
      }
      return Keypair.fromSecret(secret).publicKey();
    }

    throw new Error('[KmsSigner] KMS_PUBLIC_KEY must be configured when KMS_ENABLED=true');
  }

  /**
   * Signs a 32-byte cryptographic transaction hash.
   * In KMS mode, executes an external HSM/KMS API request without holding private keys.
   * In fallback mode, signs using the development secret key.
   *
   * @param {Buffer} hashBuffer 32-byte SHA-256 hash of the transaction
   * @returns {Promise<Buffer>} 64-byte Ed25519 signature
   */
  async signHash(hashBuffer) {
    if (!Buffer.isBuffer(hashBuffer) || hashBuffer.length !== 32) {
      throw new Error(`[KmsSigner] Invalid hash buffer: expected 32 bytes, got ${hashBuffer?.length}`);
    }

    if (this.isKmsEnabled()) {
      if (this.customSigner) {
        // Mock or custom injected KMS handler
        const sig = await this.customSigner(hashBuffer, { keyId: this.keyId });
        return Buffer.isBuffer(sig) ? sig : Buffer.from(sig);
      }

      if (this.kmsClient && typeof this.kmsClient.sign === 'function') {
        const response = await this.kmsClient.sign({
          KeyId: this.keyId,
          Message: hashBuffer,
          MessageType: 'RAW',
          SigningAlgorithm: 'ED25519_SHA_512',
        });
        return Buffer.from(response.Signature);
      }

      throw new Error(`[KmsSigner] KMS enabled but no valid kmsClient or customSigner configured for provider: ${this.provider}`);
    }

    // Local Development Fallback Mode
    const secret = process.env.STELLAR_SECRET_KEY;
    if (!secret) {
      throw new Error('[KmsSigner] KMS is disabled and STELLAR_SECRET_KEY is not defined for local fallback');
    }

    if (!fallbackWarned) {
      logger.warn('[KmsSigner] ⚠️ RUNNING IN SOFTWARE-KEY FALLBACK MODE — DO NOT USE IN PRODUCTION');
      fallbackWarned = true;
    }

    const kp = Keypair.fromSecret(secret);
    return kp.sign(hashBuffer);
  }

  /**
   * Signs a Stellar Transaction or FeeBumpTransaction instance.
   * Generates transaction hash, requests KMS signature, and attaches
   * an xdr.DecoratedSignature to the transaction.
   *
   * @param {import('@stellar/stellar-sdk').Transaction | import('@stellar/stellar-sdk').FeeBumpTransaction} transaction
   * @returns {Promise<any>} The signed transaction instance
   */
  async signTransaction(transaction) {
    if (!transaction || typeof transaction.hash !== 'function') {
      throw new Error('[KmsSigner] Invalid transaction object: must possess .hash() method');
    }

    const txHash = transaction.hash();
    const signature = await this.signHash(txHash);

    const publicKey = this.getPublicKey();
    const kp = Keypair.fromPublicKey(publicKey);
    const hint = kp.signatureHint();

    const decoratedSignature = new xdr.DecoratedSignature({
      hint,
      signature,
    });

    transaction.signatures.push(decoratedSignature);
    return transaction;
  }
}

// Default singleton instance
const defaultSigner = new KmsSigner();

module.exports = {
  KmsSigner,
  defaultSigner,
  signTransaction: (tx) => defaultSigner.signTransaction(tx),
  getPublicKey: () => defaultSigner.getPublicKey(),
  isKmsEnabled: () => defaultSigner.isKmsEnabled(),
};
