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
| `geometric_twap(window_seconds)` | Fixed-point geometric mean TWAP over the requested window. |
| `set_oracle_signers(signers, threshold)` | Admin-only trusted Ed25519 signer and strict-majority quorum configuration. |
| `push_oracle_prices(submissions)` | Verifies signed pair prices and stores their M-of-N median. |
| `oracle_price_digest(base, quote, price, timestamp, signer)` | Returns the domain-separated digest oracle keys sign. |
| `signed_oracle_price(base, quote)` | Reads the latest verified signed aggregate for a pair. |
| `set_primary_pool(base, quote, pool)` | Selects the pool whose anomalies trigger secondary-pool fallback. |
| `observe_pool(base, quote, pool, price, liquidity, timestamp)` | Records a pool observation unless it deviates over 15% from the median. |
| `pool_consensus_price(base, quote)` | Returns the outlier-filtered liquidity-weighted pool price. |
| `secondary_pool_median(base, quote)` | Returns a median excluding the configured primary pool. |
| `consult_pair(base, quote)` | Uses the secondary-pool median when the primary pool is volatile. |
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
* **Geometric TWAP.** Observations also accumulate `log2(price)` in Q64.64
  fixed-point form. `geometric_twap` averages that accumulator and applies a
  fixed-point `exp2`; no floating-point arithmetic is used.
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

The geometric variant integrates `log2(price)` over the same segments, divides
by the window, and applies `2^x` using fixed-point iteration. This reduces the
upward bias of arithmetic averages when prices oscillate.

## Signed Oracle Consensus and Pool Fallback

`set_oracle_signers` installs a unique, sorted list of Ed25519 public keys and
requires a strict-majority threshold. Each `SignedPricePayload` contains a
base/quote symbol pair, a positive price, timestamp, signer public key, and
signature over the digest returned by `oracle_price_digest`. A batch must use
one pair and timestamp, contain no repeated signers, meet the configured
quorum, and pass every signature check; the median is persisted by pair.

For on-chain pools, `observe_pool` retains the latest price and liquidity per
pool. An observation more than 15% from the existing pool median is not stored
and emits `oracle_anomaly_detected`. `pool_consensus_price` excludes prices
outside that band and computes a liquidity-weighted mean of the remainder.
When the configured primary pool is flagged, `consult_pair` falls back to the
median of fresh secondary pools.

## Dual-Source Consensus & Circuit Breaker

The oracle provides a dual-source consensus engine to protect downstream contracts (e.g. `payment_router`) if the primary on-chain AMM pool halts or prices go stale:

* **Secondary Oracle Registration.** The admin registers a secondary price feed contract address stored persistently on-chain.
* **Dual-Feed Staleness Checks.** `consult(window_seconds)` checks timestamps against `staleness_threshold` (default 3,600s).
* **Consensus Pricing.** If both primary and secondary feeds are fresh and within `max_divergence_bps` (default 500 bps = 5%), `consult` returns the weighted average (default 50/50, configurable via `set_consensus_weights`).
* **Fallback Switchover.** If the primary feed exceeds the staleness threshold, `consult` falls back to the secondary feed and emits an `(oracle, fallback)` warning event.
* **Dynamic Discrepancy Circuit Breaker.** If price discrepancy exceeds `max_divergence_bps` (500 bps), `consult` rejects the call with `Error::CircuitBreakerTripped` instead of serving a price. A rejected invocation is rolled back in full, so the trip itself cannot be persisted from that call: to freeze pricing until an admin resets it, trip the breaker in its own transaction with `trip_circuit_breaker`, and clear it with `reset_circuit_breaker`.

## Building and testing

```bash
cd twap_oracle
cargo test                          # unit tests
cargo clippy --all-targets --all-features -- -D warnings
cargo build --target wasm32-unknown-unknown --release
```

The `twap-oracle-checks` job in `.github/workflows/soroban.yml` runs the same
commands (plus `cargo fmt --check`) on every pull request.
