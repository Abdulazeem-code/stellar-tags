# Split Bill Escrow Contract

`soroban-sdk = "20.0.0"` Soroban contract for collecting fixed participant shares into escrow and releasing funds to a recipient once fully paid, or refunding payers after a deadline.

## Overview

A split bill flow:

1. An **organiser** creates a bill for a **recipient** and token with a fixed `shares` map (`Address -> i128`) and a `deadline`.
2. Each **participant** pays exactly their share into the contract by calling `pay`.
3. When all shares are paid, the full amount is released to the recipient automatically in the same `pay` call.
4. If the bill is not fully paid after `deadline`, anyone can call `refund` to return each paid share to its payer.
5. The organiser can `cancel` the bill only before anyone has paid.

The contract's token balance is zero after every completed, refunded, or cancelled bill.

## Contract API

- `create(organiser, recipient, token, shares: Map<Address, i128>, deadline) -> u64`
  - Requires `organiser` authorization.
  - Each participant's share is fixed up front; shares must be non-empty and every share must be > 0.
  - `deadline` must be in the future relative to the current ledger timestamp.
  - Emits `created`.
- `pay(id, participant)`
  - Requires `participant` authorization.
  - Transfers exactly the participant's fixed share into the contract.
  - Rejects non-participants and double payments.
  - Emits `paid` for each successful contribution.
  - When all shares are paid, transfers the full escrowed amount to `recipient` in the same call, sets status to `completed`, and emits `released`.
- `refund(id)`
  - Callable by anyone.
  - Allowed only when the bill is still open, not fully paid, and the ledger timestamp is after `deadline`.
  - Returns each paid share to its payer, sets status to `refunded`, and emits `refunded` (per payer) and `closed`.
- `cancel(caller, id)`
  - Requires `caller` authorization; only the organiser may cancel.
  - Allowed only while open and before anyone has paid.
  - Sets status to `cancelled` and emits `canceled`.
- `get(id) -> Option<BillView>`
  - Returns bill details: `id`, `organiser`, `recipient`, `token`, `shares`, `paid` (who has paid), `deadline`, and `status`.

## Status values

`BillStatus`: `Open`, `Completed`, `Refunded`, `Cancelled`.

## Events

- `created (id)` - bill created
- `paid (id)` - participant share received
- `released (id)` - fully paid bill released to recipient
- `refunded (id)` - a paid share returned during refund
- `closed (id)` - refund completed (summary/state change)
- `canceled (id)` - bill cancelled by organiser

## Testnet example (Soroban CLI)

Replace placeholders (`<...>`) with your values. Participants must be able to authorize token transfers to the contract when calling `pay`.

```bash
# 1) Build and deploy
cd split_bill
soroban contract build
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/split_bill.wasm \
  --source <ORGANISER_IDENTITY> \
  --network testnet

# Save the returned contract id as SPLIT_BILL_ID

# 2) Create a bill (example: two participants with fixed shares, deadline is a unix timestamp)
#    Shares are passed as a Soroban map: {"<ADDR_A>": "40", "<ADDR_B>": "60"}
soroban contract invoke \
  --id <SPLIT_BILL_ID> \
  --source <ORGANISER_IDENTITY> \
  --network testnet \
  -- create \
  --organiser <ORGANISER_ADDRESS> \
  --recipient <RECIPIENT_ADDRESS> \
  --token <TOKEN_CONTRACT_ID> \
  --shares '{"<PARTICIPANT_A>":"40","<PARTICIPANT_B>":"60"}' \
  --deadline 1893456000

# 3) Each participant pays their exact share (participant must authorize)
soroban contract invoke \
  --id <SPLIT_BILL_ID> \
  --source <PARTICIPANT_A_IDENTITY> \
  --network testnet \
  -- pay --id 1 --participant <PARTICIPANT_A>

soroban contract invoke \
  --id <SPLIT_BILL_ID> \
  --source <PARTICIPANT_B_IDENTITY> \
  --network testnet \
  -- pay --id 1 --participant <PARTICIPANT_B>
# When the final share is paid, the full amount is released to the recipient automatically.

# 4) Inspect bill state (shares, who paid, status)
soroban contract invoke --id <SPLIT_BILL_ID> --network testnet -- get --id 1

# 5) If not fully paid and deadline has passed, anyone can refund paid shares
soroban contract invoke \
  --id <SPLIT_BILL_ID> \
  --source <ANY_IDENTITY> \
  --network testnet \
  -- refund --id 1

# 6) Organiser can cancel before anyone has paid
soroban contract invoke \
  --id <SPLIT_BILL_ID> \
  --source <ORGANISER_IDENTITY> \
  --network testnet \
  -- cancel --caller <ORGANISER_ADDRESS> --id 1
```

## Local checks

```bash
cargo test -p split_bill
cargo clippy -p split_bill -- -D warnings
cargo fmt --all -- --check
cargo build -p split_bill --target wasm32-unknown-unknown --release
```
