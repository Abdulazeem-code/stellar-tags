# TWAP Oracle

A Soroban contract that records append-only price observations and exposes a
time-weighted average price (TWAP) over a caller-supplied window. Fees that
need a fiat reference price can read the TWAP instead of trusting a single
spot price that a flash loan can move in one ledger.

This is a standalone contract (separate from `payment_router`) so the router's
public ABI — and the TypeScript bindings checked into `packages/types` — do not
change when the oracle evolves.

## Interface

| Function | Description |
| --- | --- |
| `initialize(admin)` | One-time setup. Records the admin allowed to write observations. Requires `admin` authorization. |
| `admin()` | Returns the configured admin, if initialized. |
| `observe(price, timestamp)` | Appends an observation and returns the retained count. Admin-only. |
| `observation_count()` | Number of retained observations. |
| `latest_observation()` | Most recent observation, if any. |
| `observations()` | All retained observations, oldest first. |
| `twap(window_seconds)` | Time-weighted average price over the window ending at the latest observation. |

Prices are `i128` in whatever unit the caller uses (for example, stroops of a
reference asset). No scaling is applied by the contract.

## Manipulation resistance

* **Admin-only writes.** `observe` checks the stored admin's authorization;
  external callers cannot insert observations.
* **Append-only history.** A new timestamp must be strictly greater than the
  previous one and at least `MIN_INTERVAL_SECONDS` (60s) later, so a single key
  cannot rewrite the curve or spam observations inside one ledger.
* **No future timestamps.** `timestamp` may not exceed the ledger clock.
* **Derived cumulative.** `cumulative_price` is computed inside the contract
  from the previous observation; callers never supply it.
* **Bounded, checked prices.** Prices must be positive and at or below
  `MAX_PRICE`; every multiply/add is checked, so an out-of-range value cannot
  wrap the accumulator into a bogus average.
* **Bounded storage.** At most `MAX_OBSERVATIONS` (64) entries are retained; the
  oldest is pruned when the buffer is full.
* **Bounded window.** The TWAP window must be non-zero and at most
  `MAX_WINDOW_SECONDS` (7 days), and history must cover it, so a caller cannot
  average over a single freshly written observation.

## TWAP math

Each observation stores `cumulative_price`, the integral of price over time up
to that point. The TWAP over `window` seconds is:

```
twap = (cumulative_at_latest - cumulative_at_target) / window
```

where `target = latest.timestamp - window`, and `cumulative_at_target` is
interpolated inside the segment that contains `target`. The result is truncated
toward zero (integer division).

## Building and testing

```bash
cd twap_oracle
cargo test                          # unit tests
cargo clippy --all-targets --all-features -- -D warnings
cargo build --target wasm32-unknown-unknown --release
```

The `twap-oracle-checks` job in `.github/workflows/soroban.yml` runs the same
commands (plus `cargo fmt --check`) on every pull request.
