# Token swaps in payment routing

Issue #665 adds cross-contract token swaps to `payment_router`, so a sender can
pay in any token they hold and have it converted into the merchant's preferred
token before the payment is delivered.

The direct path (`route_payment` / `route_payments`) is unchanged. Everything
below is additive.

## The flow

```text
sender ──sell_token──> router ──sell_token──> DEX adapter
router <──buy_token──────────────────────────┘
  ├──fee──> platform treasury
  └───────> recipient
```

All of it happens inside one Soroban transaction:

1. The router pulls `amount_in` of `sell_token` from the sender.
2. The router forwards that amount to the DEX adapter and calls
   `swap(sell_token, buy_token, amount_in, min_amount_out, recipient)`.
3. The adapter sells the input and sends the `buy_token` it buys to
   `recipient`, which is the router.
4. The router checks the `buy_token` it actually received, takes the platform
   fee on the output, and forwards the rest to the recipient.

Daily limits, lifetime volume, the blacklist, the pause switch, and the freeze
switch all apply exactly as they do on the direct path, denominated in
`sell_token` — the token the sender actually parts with. The platform fee is
taken on the `buy_token` output, so `fee_cap` applies in `buy_token` units for
this route.

## Atomicity

Any failure — a reverting DEX, a slippage breach, an expired deadline, a
transfer that the recipient cannot accept — returns an `Err`, and the Soroban
host reverts every balance and storage change the payment had already made. The
sender is never left having paid a fee, the recipient never sees a partial
payment, and no volume or spending record is booked. `route_payments_with_swap`
behaves the same way for a batch: if the third payment fails, the two that
already executed are rolled back with it.

## Slippage

Two independent guards protect the sender, and both are checked against the
`buy_token` balance the router actually receives rather than against the number
the DEX reports:

| Guard | Where it comes from | What it does |
| --- | --- | --- |
| `min_amount_out` | Per payment, by the caller | A hard floor on the output. Below it, the payment reverts with `SlippageExceeded`. |
| `max_slippage_bps` | Contract configuration, default 1 000 bps (10%) | A ceiling on how far the output may fall below the caller's own `expected_amount_out`. |

`quote_swap` returns both the quoted output and the `min_amount_out` that
matches the configured ceiling, so a client can price a swap and immediately
build a payment that is guaranteed to accept it:

```text
quote        = quote_swap(dex, sell_token, buy_token, amount_in)
payment      = SwapPayment {
    seller pays   sell_token,
    recipient gets buy_token,
    amount_in         = amount_in,
    min_amount_out    = quote.min_amount_out,
    expected_amount_out = quote.amount_out,
    deadline          = <now + your own margin>,
}
```

A deadline can be set on every payment as well. `deadline = 0` means "no
router-level deadline", leaving the DEX to apply its own.

## The DEX adapter interface

The router calls a fixed interface rather than forwarding an opaque payload, so
it stays independent of any one DEX's argument layout. An adapter can wrap
Soroswap, or any other Soroban DEX, behind these two functions:

```rust
// Sells the amount_in sell_token the adapter has already been funded with and
// sends the buy_token it buys to `recipient` (the router).
fn swap(
    sell_token: Address,
    buy_token: Address,
    amount_in: i128,
    min_amount_out: i128,
    recipient: Address,
) -> i128;

// Prices the same swap without moving funds.
fn quote(sell_token: Address, buy_token: Address, amount_in: i128) -> i128;
```

Because the router transfers the input to the adapter before calling it, the
adapter never needs authority over the router's balance.

The router funds the adapter first and settles against the balance delta, so a
DEX cannot claim an output it did not deliver.

## Registering a DEX

Only a DEX the admin has registered may be called. A payment naming anything
else fails with `DexNotRegistered`.

Registration is a sensitive parameter change, so like the other trusted
settings it goes through the 24-hour timelock:

```text
queue_action(ActionType::RegisterDex(dex))
wait 24 hours
execute_action(nonce)
```

`ActionType::DeregisterDex` revokes a registration on the same delay, and
`ActionType::SetMaxSlippageBps` changes the slippage ceiling. All three are
also available as direct admin-only setters (`register_dex`, `deregister_dex`,
`set_max_slippage_bps`) for off-chain tooling, matching how the other sensitive
setters in this contract work.

## Contract API

| Call | Purpose |
| --- | --- |
| `route_payment_with_swap(SwapPayment) -> i128` | Route one swap-routed payment; returns the `buy_token` delivered. |
| `route_payments_with_swap(Vec<SwapPayment>) -> i128` | Route a batch atomically; returns the total delivered. |
| `quote_swap(dex, sell_token, buy_token, amount_in) -> SwapQuote` | Price a swap and derive a slippage-adjusted floor. |
| `register_dex(dex)` / `deregister_dex(dex)` / `is_dex_registered(dex)` | Manage the DEX allowlist. |
| `set_max_slippage_bps(bps)` / `get_max_slippage_bps()` | Manage the slippage ceiling. |

New errors, all stable codes a client can branch on:

| Code | Meaning |
| --- | --- |
| `DexNotRegistered` (15) | The DEX was not on the allowlist. |
| `SwapFailed` (16) | The DEX call reverted or returned an unusable value. |
| `SlippageExceeded` (17) | The output breached `min_amount_out` or `max_slippage_bps`. |
| `SwapDeadlineExpired` (18) | The payment arrived after its `deadline`. |
| `InvalidSwapParams` (19) | Unusable parameters, e.g. `sell_token == buy_token`. |

A successful swap emits `swap_executed` with the DEX and both tokens as topics
and `(amount_in, amount_out, min_amount_out)` as data, alongside the usual
`payment_initiated` and `routed` events.

## Example

```ts
import { Client as PaymentRouterClient, networks } from "@stellar-tags/payment-router";

const client = new PaymentRouterClient({
  ...networks.testnet,
  publicKey: sender,
});

const quote = await client.quote_swap({
  dex: SOROSWAP_ADAPTER_ID,
  sell_token: USDC_ID,
  buy_token: XLM_ID,
  amount_in: 1_000_000n,
});

const delivered = await client.route_payment_with_swap({
  payment: {
    sender,
    recipient: merchant,
    sell_token: USDC_ID,
    buy_token: XLM_ID,
    amount_in: 1_000_000n,
    min_amount_out: quote.min_amount_out,
    expected_amount_out: quote.amount_out,
    deadline: Math.floor(Date.now() / 1000) + 300,
    dex: SOROSWAP_ADAPTER_ID,
  },
});

if (delivered < quote.min_amount_out) {
  // Unreachable: the router reverts rather than settling below the floor.
}
```

## Tests

`payment_router/src/lib.rs` carries a `MockDex` that implements the adapter
interface at a configurable rate, and the swap tests cover the happy path, a
worse exchange rate, both slippage guards, a reverting DEX, an unregistered
DEX, an expired and a live deadline, unusable parameters, balance and recipient
rules, pause and freeze, batch settlement, batch rollback, quoting, the
slippage bound, and timelocked DEX registration and revocation.

```bash
cd payment_router
cargo test
```
