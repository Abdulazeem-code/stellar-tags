const { rpc, Contract, xdr, scValToNative, TransactionBuilder, Account, Keypair, Networks } = require('@stellar/stellar-sdk');

const RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.CONTRACT_ID;


let cache = {
  data: null,
  timestamp: 0,
};

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getContractStatus() {
  if (!CONTRACT_ID) {
    throw new Error('CONTRACT_ID environment variable is not set');
  }

  const now = Date.now();
  if (cache.data && (now - cache.timestamp < CACHE_TTL)) {
    return cache.data;
  }

  // Initialize lazily to avoid breaking unit tests that mock stellar-sdk
  // Assume testnet by default if not specified with a safe fallback to prevent tests from crashing
  const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || (Networks && Networks.TESTNET) || 'Test SDF Network ; September 2015';
  const server = new rpc.Server(RPC_URL);
  const contract = new Contract(CONTRACT_ID);
  
  // 1. Fetch Instance Storage
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contract.address().toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );

  const response = await server.getLedgerEntries(ledgerKey);
  if (!response || !response.entries || response.entries.length === 0) {
    throw new Error('Contract instance not found on the ledger');
  }

  const entry = response.entries[0];
  const ledgerEntryData = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64');
  const instance = ledgerEntryData.contractData().val().instance();
  const storageMap = instance.storage();

  const status = {
    contract_id: CONTRACT_ID,
    version: null,
    paused_state: false,
    fee_bps: null,
    fee_cap: null,
    treasury: null,
  };

  if (storageMap) {
    for (const mapEntry of storageMap) {
      const keyVal = mapEntry.key();
      if (keyVal.switch() === xdr.ScValType.scvSymbol()) {
        const keyName = keyVal.sym().toString();
        const value = scValToNative(mapEntry.val());
        
        switch (keyName) {
          case 'Paused':
            status.paused_state = value;
            break;
          case 'FeeBps':
          case 'FeeRateBps':
            status.fee_bps = Number(value);
            break;
          case 'FeeCap':
            status.fee_cap = Number(value);
            break;
          case 'PlatformTreasury':
          case 'Treasury':
            status.treasury = value;
            break;
        }
      }
    }
  }

  // 2. Simulate `version()` call to get the contract version
  try {
    const dummyKeypair = Keypair.random();
    const source = new Account(dummyKeypair.publicKey(), "0");
    const tx = new TransactionBuilder(source, { 
      fee: "100", 
      networkPassphrase: NETWORK_PASSPHRASE 
    })
      .addOperation(contract.call("version"))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (sim && sim.result && sim.result.retval) {
      status.version = Number(scValToNative(sim.result.retval));
    }
  } catch (error) {
    console.error('Failed to simulate version() call:', error);
  }

  cache.data = status;
  cache.timestamp = now;

  return status;
}

module.exports = {
  getContractStatus
};
