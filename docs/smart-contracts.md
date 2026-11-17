# Smart contracts

The Soroban contracts in this repository: building, testing, the payment router's on-chain features, and deployment with multisig-gated upgrades.

> Back to the [README](../README.md).

## Smart contract (Soroban)

```bash
cd payment_router
cargo build
```

## ZK anonymous tag routing (issue #668)

The `zk_payment/` crate is a standalone Soroban contract (SDK 27) that verifies
a Groth16/BLS12-381 proof before recording a private payment, using only a
commitment and a one-time nullifier as public inputs. The research spike is in
[docs/research-zk-anonymous-routing.md](research-zk-anonymous-routing.md)
and the contract/circuit usage guide is in
[docs/zk-private-payments.md](zk-private-payments.md).

```bash
cd zk_payment
cargo test
```

The checked-in setup is for tests only and is not safe for real funds; see the
research document's limitations section.

## Contract storage benchmarks (issue #663)

Per-user tag registration writes a single packed `UserRecord` ledger entry
(24-hour spending window + lifetime volume in one `BytesN<40>`) instead of the
legacy two-entry `UserSpending` + `UserVolume` split. The benchmark tests fail
CI if the registration write path ever costs more than 80% of the legacy path:

```bash
cd payment_router
cargo test benchmark -- --nocapture
```

## Contract TypeScript bindings

The TypeScript client for the `payment_router` contract lives in
[`packages/types`](../packages/types) and is **auto-generated** from the contract
ABI, so the React dashboard gets end-to-end type safety with the Rust contract
instead of manually copying contract IDs and argument shapes.

Regenerate the bindings after any change to the contract's public interface
(the contract must build with the `wasm32-unknown-unknown` target, and the
`stellar` CLI must be on your PATH):

```bash
npm run generate:bindings
```

The result is committed to `packages/types` and consumed by the frontend as
`@stellar-tags/payment-router` (a `file:` dependency). The `bindings-check` CI
job fails the build if the checked-in bindings ever drift from the contract
ABI.


## Smart Contract Refund Mechanism

When a recipient cannot receive routed tokens (e.g. missing trustline, invalid contract recipient, or transfer rejection), the `PaymentRouter` smart contract prevents whole-transaction aborts by capturing the unrouteable tokens into the contract and crediting the sender's internal refund ledger (`DataKey::RefundBalance(user, token)`).

### Claiming Refunds
Users can query and withdraw their credited refunds at any time using the pull-based withdrawal pattern:
- `get_refund_balance(user: Address, token: Address) -> i128`: Query available internal refund balance.
- `withdraw_refund(user: Address, token: Address, amount: i128) -> Result<(), Error>`: Withdraw a specific amount of credited tokens.
- `claim_all_refunds(user: Address, token: Address) -> Result<i128, Error>`: Claim and withdraw the entire available refund balance in a single transaction.

### Arbitrary-token swaps

`route_payment_with_swap` accepts a DEX adapter, an input/output token pair, a
full token `path`, and `min_amount_out`. The adapter receives the input token and
must return `[amount_received, unused_input]`; the router rejects malformed
paths or slippage below the caller's minimum and credits unused input to the
sender's refund balance. Existing same-token `route_payment` and
`route_payments` calls remain unchanged.

### Fee governance

The contract supports token-weighted fee proposals. A SuperAdmin first calls
`configure_governance(governance_token, quorum)`. A token holder can then call
`propose_fee_change` and `vote_fee_proposal`; after the voting period, anyone
can call `execute_fee_proposal` when yes votes exceed no votes and quorum is
met. A voter can vote only once per proposal, and fee updates are applied only
after successful finalization.

## Smart Contract Deployment & Upgrades

The repository includes a dedicated CLI tool (`scripts/deploy.js` and `./scripts/deploy_contract.sh`) to automate WASM compilation, optimization, network deployment, contract initialization, and contract upgrades.

### CLI Usage

```bash
# Display help and available options
./scripts/deploy_contract.sh --help

# Deploy contract to testnet (compiles, optimizes, deploys, and updates .env configs)
./scripts/deploy_contract.sh deploy --network testnet

# Dry-run deployment (simulates workflow without on-chain transactions)
./scripts/deploy_contract.sh deploy --network testnet --dry-run

# Deploy with custom admin and funding source
./scripts/deploy_contract.sh deploy --network testnet --source S... --admin G... --treasury G...

# Deploy to mainnet
./scripts/deploy_contract.sh deploy --network mainnet --source S... --admin G...

# Compile and optimize WASM only
./scripts/deploy_contract.sh build
```

### Multisig Contract Upgrades

A contract's WASM can only be replaced by an **M-of-N signer group** — no single key, not even the admin, can upgrade it on its own. A contract with no group configured is permanently frozen against upgrades, which is deliberate: an unconfigured deployment fails closed rather than falling back to the admin.

An upgrade proceeds in two steps:

1. **Collect M approvals.** Each signer records their own signature against one exact WASM hash via `approve_upgrade`. Approvals are bound to that artifact, so a different build starts from zero.
2. **Install.** Once M of the N signers have approved, *anyone* can call `upgrade` with the hash to install it. No further signature is needed at this step, and the approvals are consumed so they cannot be replayed.

```bash
# Configure a 2-of-3 upgrade group (the admin must sign this once)
./scripts/deploy_contract.sh set-multisig --contract-id C... --network testnet --source S... \
  --signer G1...:S1... --signer G2...:S2... --signer G3...:S3... --threshold 2

# Upload new WASM, collect 2 approvals, and install it
./scripts/deploy_contract.sh upgrade --contract-id C... --network testnet --source S... \
  --signer G1...:S1... --signer G2...:S2...
```

When signers coordinate separately, each one can approve on its own and whoever collects the last required signature runs the upgrade:

```bash
# Each signer runs this for the same hash
./scripts/deploy_contract.sh approve --contract-id C... --network testnet \
  --signer G1...:S1... --new-wasm-hash <HASH>

# Then, once the threshold is met
./scripts/deploy_contract.sh upgrade --contract-id C... --network testnet --source S... \
  --signer G1...:S1... --signer G2...:S2...
```

A signer can withdraw their approval before the upgrade lands, and the admin can cancel pending approvals for a hash. Changing the group re-validates approvals already collected against the new threshold.

The first group is configured by the admin. Later rotations require approval from the current group's full threshold: each current signer calls `approve_multisig_config` for the proposed sorted signer set and threshold, after which the admin may apply it directly or queue it through the timelock (`ActionType::SetMultisigConfig`). A set with two or more signers must use a threshold of at least two; signer addresses are stored in deterministic sorted order.

### Contract Interface for Upgrades

| Function | Purpose |
| --- | --- |
| `set_multisig_config(signers, threshold)` | Configure the M-of-N group (admin-gated; existing groups must approve rotations). |
| `approve_multisig_config(signers, threshold, signer)` | Record an existing signer's approval of an exact group rotation. |
| `get_multisig_config() -> MultisigConfig` | Read the current signers and threshold. |
| `approve_upgrade(signer, new_wasm_hash)` | Record one signer approval for an exact WASM hash. |
| `revoke_upgrade_approval(signer, new_wasm_hash)` | Withdraw a recorded approval. |
| `cancel_upgrade(new_wasm_hash)` | Discard all pending approvals for a hash (admin). |
| `get_upgrade_approvals(new_wasm_hash) -> Vec<Address>` | List who has approved a hash. |
| `is_upgrade_authorized(new_wasm_hash) -> bool` | Check whether a hash has reached its threshold. |
| `upgrade(new_wasm_hash)` | Install a hash once its threshold is met. |

### Automation & Config Updates

Upon successful deployment, the tool automatically updates the contract address across:
- `stellar-payment-platform/.env` (`PAYMENT_ROUTER_CONTRACT_ID`, `CONTRACT_ID`)
- `payment-dashboard/.env` (`VITE_CONTRACT_ID`, `CONTRACT_ID`)
- `payment-dashboard/src/views/shared.js` (`CONTRACT_ID`)

