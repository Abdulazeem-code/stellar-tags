# Axelar Cross-Chain Integration

## Overview

This implementation adds **cross-chain payment routing** capabilities to the Stellar payment router contract using Axelar's General Message Passing (GMP) protocol. Users can now initiate payments from Ethereum (or other supported chains) that are executed on Stellar.

## Architecture

### Components

1. **Axelar Module** (`payment_router/src/axelar.rs`)
   - Cross-chain payment data structures
   - Payload encoding/decoding
   - Axelar Gateway interface definitions
   - Validation helpers

2. **Payment Router Integration** (`payment_router/src/lib.rs`)
   - Implements `IAxelarExecutable` interface
   - Gateway validation and authorization
   - Trusted chain management
   - Cross-chain payment execution

### Flow

```
Ethereum (Source) → Axelar Network → Stellar (Destination)
     User              Gateway          Payment Router
       |                  |                    |
       | 1. Send tokens   |                    |
       |  + call GMP      |                    |
       |----------------->|                    |
       |                  |                    |
       |                  | 2. Route message   |
       |                  |  + validate        |
       |                  |------------------->|
       |                  |                    |
       |                  |                    | 3. Execute payment
       |                  |                    |    - Validate payload
       |                  |                    |    - Check trusted chain
       |                  |                    |    - Route payment
       |                  |                    |    - Collect fee
       |                  |                    |
```

## Smart Contract Functions

### Admin Functions

#### Set Axelar Gateway
```rust
pub fn set_axelar_gateway(env: Env, gateway: Address) -> Result<(), Error>
```
Configure the Axelar Gateway contract address. Only callable by admin.

**Parameters:**
- `gateway` - Address of the Axelar Gateway contract on Stellar

**Example:**
```rust
router.set_axelar_gateway(&env, &gateway_address);
```

#### Add Trusted Chain
```rust
pub fn add_trusted_chain(env: Env, chain_name: String) -> Result<(), Error>
```
Whitelist a source chain for cross-chain payments. Only callable by admin.

**Parameters:**
- `chain_name` - Chain identifier (e.g., "ethereum", "polygon", "avalanche")

**Example:**
```rust
router.add_trusted_chain(&env, &String::from_str(&env, "ethereum"));
```

#### Remove Trusted Chain
```rust
pub fn remove_trusted_chain(env: Env, chain_name: String) -> Result<(), Error>
```
Remove a chain from the trusted list. Only callable by admin.

### Execution Functions

#### Execute Cross-Chain Payment
```rust
pub fn execute_cross_chain(
    env: Env,
    command_id: Bytes,
    source_chain: String,
    source_address: String,
    payload: Bytes,
) -> Result<(), Error>
```

Called by Axelar Gateway to execute a cross-chain payment.

**Parameters:**
- `command_id` - Unique 32-byte identifier from Axelar
- `source_chain` - Source chain name (must be trusted)
- `source_address` - Original sender address on source chain
- `payload` - Encoded payment instruction

**Validation:**
- Gateway authorization required
- Command ID must be valid (32 bytes)
- Source chain must be trusted
- Payload must decode correctly
- Contract must not be frozen or paused

### Query Functions

#### Get Axelar Gateway
```rust
pub fn get_axelar_gateway(env: Env) -> Option<Address>
```
Returns the configured Axelar Gateway address.

## Payload Format

Cross-chain payment payloads are encoded as follows:

```
Offset  | Size | Field
--------|------|------------------
0       | 32   | Recipient address (Stellar)
32      | 32   | Token address (Stellar)
64      | 16   | Amount (i128, big-endian)
80      | 2    | Source address length
82      | var  | Source address (string)
82+n    | 2    | Source chain length
84+n    | var  | Source chain name (string)
84+n+m  | var  | Memo (optional)
```

### Encoding Example (TypeScript)

```typescript
import { ethers } from 'ethers';

function encodePayload(
  recipientAddress: string,  // Stellar address
  tokenAddress: string,      // Stellar token address
  amount: bigint,
  sourceAddress: string,     // Ethereum address
  sourceChain: string,       // "ethereum"
  memo: string = ""
): string {
  const buffer = Buffer.alloc(256); // Allocate sufficient space
  let offset = 0;

  // Recipient address (32 bytes)
  buffer.write(recipientAddress.padEnd(32), offset);
  offset += 32;

  // Token address (32 bytes)
  buffer.write(tokenAddress.padEnd(32), offset);
  offset += 32;

  // Amount (16 bytes, big-endian i128)
  const amountBuf = Buffer.alloc(16);
  amountBuf.writeBigInt64BE(amount >> 64n, 0);
  amountBuf.writeBigInt64BE(amount & 0xFFFFFFFFFFFFFFFFn, 8);
  amountBuf.copy(buffer, offset);
  offset += 16;

  // Source address length (2 bytes)
  buffer.writeUInt16BE(sourceAddress.length, offset);
  offset += 2;

  // Source address
  buffer.write(sourceAddress, offset);
  offset += sourceAddress.length;

  // Source chain length (2 bytes)
  buffer.writeUInt16BE(sourceChain.length, offset);
  offset += 2;

  // Source chain
  buffer.write(sourceChain, offset);
  offset += sourceChain.length;

  // Memo (if provided)
  if (memo) {
    buffer.write(memo, offset);
    offset += memo.length;
  }

  return '0x' + buffer.slice(0, offset).toString('hex');
}
```

## Ethereum Integration Example

### Solidity Contract

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@axelar-network/axelar-gmp-sdk-solidity/contracts/interfaces/IAxelarGateway.sol";
import "@axelar-network/axelar-gmp-sdk-solidity/contracts/interfaces/IAxelarGasService.sol";

contract StellarPaymentBridge {
    IAxelarGateway public gateway;
    IAxelarGasService public gasService;
    
    string public stellarChainName = "stellar";
    string public stellarRouterAddress;
    
    event PaymentBridged(
        address indexed sender,
        string recipientOnStellar,
        uint256 amount,
        string memo
    );
    
    constructor(
        address _gateway,
        address _gasService,
        string memory _stellarRouter
    ) {
        gateway = IAxelarGateway(_gateway);
        gasService = IAxelarGasService(_gasService);
        stellarRouterAddress = _stellarRouter;
    }
    
    function bridgePayment(
        string calldata recipientAddress,  // Stellar address
        string calldata tokenAddress,      // Stellar token address
        uint128 amount,
        string calldata memo
    ) external payable {
        // Encode payload
        bytes memory payload = abi.encode(
            recipientAddress,
            tokenAddress,
            amount,
            msg.sender,
            "ethereum",
            memo
        );
        
        // Pay for gas on destination chain
        gasService.payNativeGasForContractCall{value: msg.value}(
            address(this),
            stellarChainName,
            stellarRouterAddress,
            payload,
            msg.sender
        );
        
        // Call Axelar Gateway
        gateway.callContract(
            stellarChainName,
            stellarRouterAddress,
            payload
        );
        
        emit PaymentBridged(msg.sender, recipientAddress, amount, memo);
    }
}
```

### Usage from Web3

```typescript
import { ethers } from 'ethers';

async function sendCrossChainPayment(
  bridgeContract: Contract,
  recipientOnStellar: string,
  tokenOnStellar: string,
  amount: bigint,
  gasPayment: bigint
) {
  const tx = await bridgeContract.bridgePayment(
    recipientOnStellar,    // Stellar recipient address
    tokenOnStellar,        // Stellar token contract address
    amount,                // Amount in smallest unit
    "Cross-chain payment", // Memo
    { value: gasPayment }  // Gas payment for Axelar
  );
  
  await tx.wait();
  console.log("Cross-chain payment initiated:", tx.hash);
}
```

## Security Features

### 1. Gateway Authorization
Only the configured Axelar Gateway can call `execute_cross_chain`
```rust
gateway_addr.require_auth();
```

### 2. Trusted Chain Whitelist
Only pre-approved chains can send payments
```rust
if !Self::is_chain_trusted(&env, &source_chain) {
    return Err(Error::UntrustedChain);
}
```

### 3. Command ID Validation
Prevents replay attacks and ensures message uniqueness
```rust
if !axelar_helpers::is_valid_command_id(&command_id) {
    return Err(Error::InvalidCrossChainPayload);
}
```

### 4. Payload Validation
All payloads are validated before execution
- Amount must be positive
- Contract must not be frozen/paused
- Addresses must be valid

### 5. Fee Collection
Platform fees are collected on all cross-chain payments
```rust
let fee = Self::compute_fee(amount, fee_bps, fee_cap);
```

## Error Codes

| Code | Error | Description |
|------|-------|-------------|
| 26 | `AxelarValidationFailed` | Gateway validation failed |
| 27 | `InvalidCrossChainPayload` | Payload decode failed |
| 28 | `UntrustedChain` | Source chain not whitelisted |
| 29 | `AxelarGatewayNotConfigured` | Gateway address not set |

## Deployment Steps

### 1. Deploy Axelar Gateway (or use existing)
```bash
# Axelar provides gateway contracts on each chain
# For testnet: use Axelar's testnet gateway addresses
```

### 2. Deploy Payment Router
```bash
soroban contract deploy \
  --wasm payment_router.wasm \
  --source ADMIN_SECRET
```

### 3. Initialize Router
```rust
router.initialize(
    &env,
    &admin,
    &treasury,
    initial_fee_bps,
    initial_fee_cap
);
```

### 4. Configure Axelar Integration
```rust
// Set gateway
router.set_axelar_gateway(&env, &gateway_address);

// Add trusted chains
router.add_trusted_chain(&env, &String::from_str(&env, "ethereum"));
router.add_trusted_chain(&env, &String::from_str(&env, "polygon"));
router.add_trusted_chain(&env, &String::from_str(&env, "avalanche"));
```

### 5. Deploy Ethereum Bridge Contract
```bash
npx hardhat run scripts/deploy-bridge.ts --network ethereum-testnet
```

## Testing

### Unit Tests
```bash
cd payment_router
cargo test axelar
```

### Integration Tests
```bash
# Test cross-chain flow on testnet
node scripts/test-cross-chain-payment.js
```

### Manual Testing

1. **Configure contracts**
   ```bash
   ./scripts/setup-axelar-testnet.sh
   ```

2. **Send test payment from Ethereum**
   ```bash
   npx hardhat run scripts/send-payment.ts --network goerli
   ```

3. **Verify on Stellar**
   ```bash
   soroban contract invoke \
     --id $ROUTER_ID \
     --fn get_axelar_gateway
   ```

## Monitoring

### Events

Cross-chain payments emit the `xchain` event:
```rust
env.events().publish(
    (symbol_short!("xchain"), gateway_addr),
    (source_chain, source_address, recipient, amount, net_amount)
);
```

### Logs

Monitor contract logs for cross-chain activity:
```bash
soroban events --id $ROUTER_ID --start-ledger 12345
```

## Supported Chains

Currently supported source chains (configurable):
- Ethereum
- Polygon
- Avalanche
- Binance Smart Chain
- Fantom
- Moonbeam
- (Any chain supported by Axelar)

Add more chains via `add_trusted_chain()`.

## Gas Considerations

Cross-chain transactions involve gas on multiple chains:

1. **Source chain** - User pays for bridge transaction + Axelar gas
2. **Axelar network** - Covered by gas payment
3. **Stellar** - Paid by gateway (fees from gas payment)

Typical cost: $5-20 depending on source chain gas prices.

## Limitations

1. **Payload size** - Limited to ~1KB for practical gas costs
2. **Speed** - Cross-chain messages take 1-5 minutes
3. **Finality** - Waits for source chain finality before execution
4. **Token support** - Only tokens that exist on both chains

## Future Enhancements

- [ ] Support for token swaps during bridging
- [ ] Batch cross-chain payments
- [ ] Conditional execution logic
- [ ] Cross-chain governance
- [ ] Dynamic fee adjustment based on gas costs
- [ ] Support for NFT transfers

## Resources

- [Axelar Documentation](https://docs.axelar.dev/)
- [Axelar GMP SDK](https://github.com/axelarnetwork/axelar-gmp-sdk-solidity)
- [Soroban Documentation](https://soroban.stellar.org/docs)
- [Axelar Testnet](https://testnet.axelarscan.io/)

## Support

For issues or questions:
- GitHub Issues: [stellar-tags/issues](https://github.com/Abdulazeem-code/stellar-tags/issues)
- Axelar Discord: [axelar.network/discord](https://axelar.network/discord)
- Stellar Discord: [stellar.org/discord](https://stellar.org/discord)
