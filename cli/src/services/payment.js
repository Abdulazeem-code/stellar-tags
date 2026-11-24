const StellarSdk = require('@stellar/stellar-sdk');
const { EXIT_CODES, getNetworkPassphrase, getHorizonUrl } = require('../constants');
const { validateAmount, parseAsset } = require('./sep7');

/**
 * Builds and submits a Stellar payment transaction to Horizon.
 *
 * @param {object} params
 * @param {string} params.secretKey - Raw Stellar secret key (S...)
 * @param {string} params.destination - Stellar destination address (G...)
 * @param {string} params.amount - Transaction amount
 * @param {string} [params.asset] - Asset string ("XLM", "USDC", "USDC:G...")
 * @param {string} [params.memo] - Optional memo text
 * @param {string} [params.memoType] - Optional memo type
 * @param {string} [params.network='testnet'] - 'testnet' or 'public'
 * @param {object} [deps] - Optional dependency overrides for testing
 * @returns {Promise<object>} Submission result with hash, ledger, etc.
 */
async function submitPayment(params, deps = {}) {
  const {
    secretKey,
    destination,
    amount,
    asset,
    memo,
    memoType,
    network = 'testnet',
  } = params;

  if (!secretKey) {
    const error = new Error('Secret key is missing.');
    error.exitCode = EXIT_CODES.USER_ERROR;
    throw error;
  }

  let sourceKeypair;
  try {
    const KeypairClass = deps.Keypair || StellarSdk.Keypair;
    sourceKeypair = KeypairClass.fromSecret(secretKey);
  } catch {
    const error = new Error('Invalid secret key format.');
    error.exitCode = EXIT_CODES.USER_ERROR;
    throw error;
  }

  const validAmount = validateAmount(amount);
  const assetInfo = parseAsset(asset);

  const horizonUrl = deps.horizonUrl || getHorizonUrl(network);
  const networkPassphrase = deps.networkPassphrase || getNetworkPassphrase(network);

  const ServerClass = deps.Server || StellarSdk.Horizon.Server;
  const server = new ServerClass(horizonUrl);

  let sourceAccount;
  try {
    sourceAccount = await server.loadAccount(sourceKeypair.publicKey());
  } catch (err) {
    const status = err.response?.status || err.status;
    if (status === 404) {
      const error = new Error(`Source account "${sourceKeypair.publicKey()}" does not exist on ${network}. Please fund it first.`);
      error.exitCode = EXIT_CODES.USER_ERROR;
      throw error;
    }
    const error = new Error(`Failed to load source account: ${err.message}`);
    error.exitCode = EXIT_CODES.NETWORK_ERROR;
    throw error;
  }

  let stellarAsset;
  const AssetClass = deps.Asset || StellarSdk.Asset;
  if (assetInfo.isNative) {
    stellarAsset = AssetClass.native();
  } else {
    if (!assetInfo.assetIssuer) {
      const error = new Error(`Issuer address is required for asset "${assetInfo.assetCode}". Format: CODE:ISSUER`);
      error.exitCode = EXIT_CODES.USER_ERROR;
      throw error;
    }
    stellarAsset = new AssetClass(assetInfo.assetCode, assetInfo.assetIssuer);
  }

  const fee = (deps.fetchBaseFee ? await deps.fetchBaseFee() : await server.fetchBaseFee().catch(() => 100)) || 100;

  const TransactionBuilderClass = deps.TransactionBuilder || StellarSdk.TransactionBuilder;
  const OperationClass = deps.Operation || StellarSdk.Operation;
  const MemoClass = deps.Memo || StellarSdk.Memo;

  const builder = new TransactionBuilderClass(sourceAccount, {
    fee: String(fee),
    networkPassphrase,
  }).addOperation(
    OperationClass.payment({
      destination,
      asset: stellarAsset,
      amount: validAmount,
    }),
  ).setTimeout(60);

  if (memo) {
    if (memoType === 'id') {
      builder.addMemo(MemoClass.id(memo));
    } else if (memoType === 'hash') {
      builder.addMemo(MemoClass.hash(memo));
    } else if (memoType === 'return') {
      builder.addMemo(MemoClass.return(memo));
    } else {
      builder.addMemo(MemoClass.text(memo));
    }
  }

  const transaction = builder.build();
  transaction.sign(sourceKeypair);

  try {
    const result = await server.submitTransaction(transaction);
    return {
      successful: true,
      hash: result.hash,
      ledger: result.ledger,
      network,
      from: sourceKeypair.publicKey(),
      to: destination,
      amount: validAmount,
      asset: assetInfo.isNative ? 'XLM' : `${assetInfo.assetCode}:${assetInfo.assetIssuer}`,
    };
  } catch (err) {
    const errorDetails = err.response?.data?.extras?.result_codes
      ? JSON.stringify(err.response.data.extras.result_codes)
      : err.message;
    const error = new Error(`Transaction submission failed: ${errorDetails}`);
    error.exitCode = EXIT_CODES.NETWORK_ERROR;
    throw error;
  }
}

module.exports = {
  submitPayment,
};
