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
| `set_secondary_oracle(address)` | Registers secondary oracle price feed address in persistent storage. Admin-only. |
| `secondary_oracle()` | Returns the secondary oracle address, if registered. |
| `set_max_divergence_bps(bps)` | Sets divergence threshold (e.g. 500 bps = 5%). Admin-only. |
| `max_divergence_bps()` | Returns current max divergence threshold (default: 500 bps). |
| `set_staleness_threshold(secs)` | Sets observation staleness threshold in seconds. Admin-only. |
| `staleness_threshold()` | Returns observation staleness limit (default: 3,600s). |
| `set_consensus_weights(w1, w2)` | Sets weighted consensus weights for primary and secondary feeds. Admin-only. |
| `consensus_weights()` | Returns consensus weights (default: 5000 / 5000). |
| `is_circuit_breaker_tripped()` | Returns whether discrepancy circuit breaker is currently tripped. |
| `trip_circuit_breaker()` | Manually trips circuit breaker to freeze swaps. Admin-only. |
| `reset_circuit_breaker()` | Resets tripped circuit breaker. Admin-only. |
| `consult(window_seconds)` | Dual-source oracle consensus query with dynamic discrepancy circuit breaker and fallback. |

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

## Dual-Source Consensus & Circuit Breaker

The oracle provides a dual-source consensus engine to protect downstream contracts (e.g. `payment_router`) if the primary on-chain AMM pool halts or prices go stale:

* **Secondary Oracle Registration.** The admin registers a secondary price feed contract address stored persistently on-chain.
* **Dual-Feed Staleness Checks.** `consult(window_seconds)` checks timestamps against `staleness_threshold` (default 3,600s).
* **Consensus Pricing.** If both primary and secondary feeds are fresh and within `max_divergence_bps` (default 500 bps = 5%), `consult` returns the weighted average (default 50/50, configurable via `set_consensus_weights`).
* **Fallback Switchover.** If the primary feed exceeds the staleness threshold, `consult` falls back to the secondary feed and emits an `(oracle, fallback)` warning event.
* **Dynamic Discrepancy Circuit Breaker.** If price discrepancy exceeds `max_divergence_bps` (500 bps), the circuit breaker trips, updates persistent storage, emits a `(breaker, tripped)` event, and reverts with `Error::CircuitBreakerTripped`. The contract remains frozen until reset by the admin via `reset_circuit_breaker`.

## Building and testing

```bash
cd twap_oracle
cargo test                          # unit tests
cargo clippy --all-targets --all-features -- -D warnings
cargo build --target wasm32-unknown-unknown --release
```

The `twap-oracle-checks` job in `.github/workflows/soroban.yml` runs the same
commands (plus `cargo fmt --check`) on every pull request.
