import { rpc, TransactionBuilder } from '@stellar/stellar-sdk';

export const SOROBAN_RPC = 'https://soroban-testnet.stellar.org';

const TX_CODES = {
  txBadSeq: 'The transaction was built for an old account sequence. Try again.',
  txBadAuth: 'The wallet signature does not match the account sending the payment.',
  txNoAccount: 'Your account does not exist on testnet yet. Fund it with Friendbot first.',
  txInsufficientBalance: 'Not enough XLM to cover the payment, the router fee and the network fee.',
  txInsufficientFee: 'The network fee was too low. Try again.',
  txTooLate: 'The transaction expired before it was submitted. Try again.',
  txTooEarly: 'The transaction is not valid yet. Check your device clock and try again.',
  txSorobanInvalid: 'The network rejected the contract call as invalid. Try again.',
};

const OP_CODES = {
  invokeHostFunctionTrapped: 'The payment_router contract rejected the payment.',
  invokeHostFunctionResourceLimitExceeded: 'The contract call ran out of resources. Try again.',
  invokeHostFunctionEntryArchived: 'Some contract data is archived on testnet. Try again shortly.',
  invokeHostFunctionInsufficientRefundableFee: 'The network fee was too low. Try again.',
};

// Turns a TransactionResult into a sentence a person can act on, keeping the
// raw code so it can be searched for.
export function describeTxResult(result) {
  let code = 'unknown';
  try {
    const inner = result.result();
    code = inner.switch().name;
    if (code === 'txFailed') {
      const op = inner.results()[0]?.tr?.();
      const opCode = op?.value?.()?.switch?.().name;
      if (opCode) return `${OP_CODES[opCode] || 'The contract call failed.'} (${opCode})`;
    }
  } catch {
    // Unknown result shape; fall through with the generic message.
  }
  return `${TX_CODES[code] || 'The network rejected the transaction.'} (${code})`;
}

// Submits a signed transaction and waits for the ledger to include it.
export async function submitAndWait(signedXdr, networkPassphrase) {
  const server = new rpc.Server(SOROBAN_RPC);
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  const sent = await server.sendTransaction(tx);

  if (sent.status === 'ERROR') throw new Error(describeTxResult(sent.errorResult));
  if (sent.status === 'TRY_AGAIN_LATER') {
    throw new Error('The network is busy. Wait a few seconds and send again.');
  }

  const final = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (final.status === 'SUCCESS') return sent.hash;
  if (final.status === 'FAILED') throw new Error(describeTxResult(final.resultXdr));
  throw new Error(`The payment is still pending. Check transaction ${sent.hash} on Stellar Expert.`);
}
