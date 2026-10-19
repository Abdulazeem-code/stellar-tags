# Cross-Chain Payment Setup Guide

## Quick Start

This guide helps you set up cross-chain payments from Ethereum to Stellar using Axelar.

## Prerequisites

- Stellar payment router contract deployed
- Axelar Gateway addresses (testnet or mainnet)
- Ethereum wallet with ETH for gas
- Node.js and npm installed

## Step 1: Configure Stellar Payment Router

```bash
# Set Axelar Gateway on Stellar
soroban contract invoke \
  --id <ROUTER_CONTRACT_ID> \
  --fn set_axelar_gateway \
  -- \
  --gateway <AXELAR_GATEWAY_ADDRESS>

# Add trusted chains
soroban contract invoke \
  --id <ROUTER_CONTRACT_ID> \
  --fn add_trusted_chain \
  -- \
  --chain_name "ethereum"

soroban contract invoke \
  --id <ROUTER_CONTRACT_ID> \
  --fn add_trusted_chain \
  -- \
  --chain_name "polygon"
```

## Step 2: Deploy Ethereum Bridge Contract

```bash
# Install dependencies
npm install @axelar-network/axelar-gmp-sdk-solidity

# Deploy contract
npx hardhat run scripts/deploy-bridge.js --network goerli
```

### Deploy Script Example

```javascript
// scripts/deploy-bridge.js
const hre = require("hardhat");

async function main() {
  const AXELAR_GATEWAY = "0x..."; // Goerli testnet gateway
  const AXELAR_GAS_SERVICE = "0x..."; // Goerli testnet gas service
  const STELLAR_ROUTER = "C..."; // Your Stellar router contract ID
  
  const Bridge = await hre.ethers.getContractFactory("StellarPaymentBridge");
  const bridge = await Bridge.deploy(
    AXELAR_GATEWAY,
    AXELAR_GAS_SERVICE,
    STELLAR_ROUTER
  );
  
  await bridge.deployed();
  console.log("Bridge deployed to:", bridge.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

## Step 3: Send Test Payment

```javascript
// scripts/send-payment.js
const { ethers } = require("ethers");

async function sendPayment() {
  const provider = new ethers.providers.JsonRpcProvider("https://goerli.infura.io/v3/YOUR_KEY");
  const wallet = new ethers.Wallet("YOUR_PRIVATE_KEY", provider);
  
  const bridgeAddress = "0x..."; // Your deployed bridge
  const bridge = new ethers.Contract(
    bridgeAddress,
    BridgeABI,
    wallet
  );
  
  const tx = await bridge.bridgePayment(
    "GDEST_STELLAR_ADDRESS", // Stellar recipient
    "CTOKEN_STELLAR_ADDRESS", // Stellar token contract
    "1000000", // Amount (1 USDC with 6 decimals)
    "Test cross-chain payment", // Memo
    {
      value: ethers.utils.parseEther("0.01") // Gas payment
    }
  );
  
  console.log("Transaction sent:", tx.hash);
  await tx.wait();
  console.log("Payment bridged!");
}

sendPayment();
```

## Step 4: Monitor Execution

### On Axelar

Visit [Axelarscan Testnet](https://testnet.axelarscan.io/) and search for your transaction hash.

### On Stellar

```bash
# Check router events
soroban events \
  --id <ROUTER_CONTRACT_ID> \
  --start-ledger <RECENT_LEDGER>
```

## Testnet Addresses

### Ethereum Goerli
- Gateway: `0xe432150cce91c13a887f7D836923d5597adD8E31`
- Gas Service: `0xbE406F0189A0B4cf3A05C286473D23791Dd44Cc6`

### Polygon Mumbai
- Gateway: `0xBF62ef1486468a6bd26Dd669C06db43dEd5B849B`
- Gas Service: `0xbE406F0189A0B4cf3A05C286473D23791Dd44Cc6`

### Stellar Testnet
- Deploy your router contract and configure

## Troubleshooting

### "Untrusted chain" error
Make sure you added the source chain:
```bash
soroban contract invoke --id <ROUTER> --fn add_trusted_chain -- --chain_name "ethereum"
```

### "Gateway not configured" error
Set the Axelar Gateway address:
```bash
soroban contract invoke --id <ROUTER> --fn set_axelar_gateway -- --gateway <GATEWAY_ADDR>
```

### Transaction stuck
- Check Axelarscan for message status
- Ensure sufficient gas was paid
- Verify source chain finality

## Gas Costs

Typical costs for cross-chain payments:

| Source Chain | Gas Cost | Axelar Fee | Total |
|--------------|----------|------------|-------|
| Ethereum     | $5-15    | $1-3       | $6-18 |
| Polygon      | $0.01-0.05 | $1-3     | $1-3  |
| BSC          | $0.10-0.30 | $1-3     | $1-3  |

## Production Deployment

1. Use mainnet gateway addresses
2. Set up monitoring and alerts
3. Test with small amounts first
4. Configure gas estimates dynamically
5. Implement emergency pause mechanism

## Support

- Axelar Docs: https://docs.axelar.dev/
- Stellar Docs: https://soroban.stellar.org/
- GitHub Issues: https://github.com/Abdulazeem-code/stellar-tags/issues
