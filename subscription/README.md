# Subscription Contract

`soroban-sdk = "20.0.0"` Soroban contract for recurring pull payments (subscriptions, rent, payroll) on Stellar.

## Overview

This crate implements a pull-payment subscription flow:

- A **payer** creates a subscription for a **merchant** with a fixed `amount_per_period`, `period_seconds`, and `max_periods`.
- The payer approves the subscription contract as a spender on the payment token.
- Anyone can call `charge(id)` once a full period has elapsed. The contract pulls funds from the payer to the merchant using the token's `transfer_from`.
- Missed periods can be caught up in a single `charge` call, up to `max_periods` total.
- Either the payer or the merchant can cancel the subscription.

## Contract API

- `create(payer, merchant, token, amount_per_period, period_seconds, max_periods) -> u64`
  - Requires `payer` authorization.
  - Stores the subscription, indexed by id for payer and merchant lookups.
  - Emits `created`.
- `charge(id) -> u32`
  - Callable by anyone.
  - Charges each due period sequentially while `now >= last_charged_at + period_seconds`.
  - Catches up missed periods in one call, never exceeding `max_periods` total.
  - Returns the number of periods successfully charged in this call.
  - Rejects when the subscription is inactive, no full period has elapsed, or `max_periods` has already been reached.
  - On token transfer failure (insufficient balance or allowance), emits `charge_failed` and does **not** panic. Any periods already charged in the same call remain charged.
  - Emits `charged` for each successfully charged period.
- `cancel(caller, id)`
  - Requires `caller` authorization; `caller` must be the payer or merchant.
  - Marks the subscription inactive so no further charges are possible.
  - Emits `cancelled`.
- `get(id) -> Option<Subscription>` returns subscription state.
- `list_by_payer(payer) -> Vec<u64>` returns subscription ids for a payer.
- `list_by_merchant(merchant) -> Vec<u64>` returns subscription ids for a merchant.

## Events

- `created (id)` - subscription created.
- `charged (id)` - one period charged successfully.
- `charge_failed (id)` - token `transfer_from` failed (for example insufficient allowance or balance); no panic.
- `cancelled (id)` - subscription cancelled by payer or merchant.

## Token approval step (required)

Because charges are pull-based, the payer must approve the subscription contract to spend tokens **before** anyone can charge:

1. Deploy or identify the token contract to be used for payments.
2. Deploy the subscription contract and note its contract ID.
3. From the payer account, call the token contract's `approve`:
   - `from`: payer address
   - `spender`: subscription contract ID
   - `amount`: enough allowance to cover expected charges (for example `amount_per_period * periods_to_preapprove`)
   - `expiration_ledger`: a ledger sequence in the future that covers the subscription lifetime
4. Create the subscription with `create(...)`.
5. After each full `period_seconds`, any caller may invoke `charge(id)`.

If allowance or balance is insufficient at charge time, `charge` emits `charge_failed` and returns without panicking.

## Testnet example (Soroban CLI)

Replace placeholders (`<...>`) with your values.

```bash
# 1) Build and deploy the subscription contract
cd subscription
soroban contract build
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/subscription.wasm \
  --source <PAYER_IDENTITY> \
  --network testnet

# Save the returned contract id as SUBSCRIPTION_ID

# 2) Approve the subscription contract to spend the payment token
#    (run as the payer; amount/expiration must cover future charges)
soroban contract invoke \
  --id <TOKEN_CONTRACT_ID> \
  --source <PAYER_IDENTITY> \
  --network testnet \
  -- approve \
  --from <PAYER_ADDRESS> \
  --spender <SUBSCRIPTION_ID> \
  --amount 1200 \
  --expiration_ledger <FUTURE_LEDGER>

# 3) Create a subscription: 100 tokens every 86400 seconds (1 day), up to 12 periods
soroban contract invoke \
  --id <SUBSCRIPTION_ID> \
  --source <PAYER_IDENTITY> \
  --network testnet \
  -- create \
  --payer <PAYER_ADDRESS> \
  --merchant <MERCHANT_ADDRESS> \
  --token <TOKEN_CONTRACT_ID> \
  --amount_per_period 100 \
  --period_seconds 86400 \
  --max_periods 12

# 4) After at least one period has passed, anyone can charge due periods
soroban contract invoke \
  --id <SUBSCRIPTION_ID> \
  --source <ANY_IDENTITY> \
  --network testnet \
  -- charge \
  --id 1

# 5) Inspect state
soroban contract invoke --id <SUBSCRIPTION_ID> --network testnet -- get --id 1
soroban contract invoke --id <SUBSCRIPTION_ID> --network testnet -- list_by_payer --payer <PAYER_ADDRESS>
soroban contract invoke --id <SUBSCRIPTION_ID> --network testnet -- list_by_merchant --merchant <MERCHANT_ADDRESS>

# 6) Cancel (payer or merchant)
soroban contract invoke \
  --id <SUBSCRIPTION_ID> \
  --source <PAYER_OR_MERCHANT_IDENTITY> \
  --network testnet \
  -- cancel \
  --caller <PAYER_OR_MERCHANT_ADDRESS> \
  --id 1
```

## Local checks

```bash
cargo test -p subscription
cargo clippy -p subscription -- -D warnings
cargo fmt --all -- --check
cargo build -p subscription --target wasm32-unknown-unknown --release
```
