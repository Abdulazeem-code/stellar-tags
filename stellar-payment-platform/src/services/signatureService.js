'use strict';

const { Keypair, StrKey } = require('@stellar/stellar-sdk');
const { verifySignedMessage } = require('./signedMessage');

const verifyFreighterRegistrationSignature = ({
  username,
  address,
  signature,
  signerAddress,
}) => {
  const message = `register:${username}:${address}`;
  const claimedSigner = signerAddress || address;

  if (!StrKey.isValidEd25519PublicKey(claimedSigner)) {
    const error = new Error('Invalid signer address format.');
    error.statusCode = 400;
    throw error;
  }

  const keypair = Keypair.fromPublicKey(claimedSigner);

  // SEP-53 first, then the raw and unhashed forms some wallets sign, with
  // base64, hex or double-base64 encodings (see signedMessage.js).
  if (!verifySignedMessage(keypair, message, signature)) {
    const error = new Error('Signature verification failed.');
    error.statusCode = 401;
    throw error;
  }

  if (claimedSigner !== address) {
    const error = new Error('Signer address does not match the connected wallet.');
    error.statusCode = 401;
    throw error;
  }

  return claimedSigner;
};

module.exports = {
  verifyFreighterRegistrationSignature,
};
