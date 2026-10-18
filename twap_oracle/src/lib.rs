#![no_std]
//! Time-Weighted Average Price (TWAP) oracle for the stellar-tags contracts.
//!
//! The oracle records append-only price observations and exposes a TWAP over a
//! caller-supplied window. Fees that need a fiat reference price can read the
//! TWAP instead of trusting a single, flash-loan-manipulable spot price.
//!
//! # Manipulation resistance
//!
//! * Only the admin stored at `initialize` may append an observation.
//! * Observations are append-only: a new timestamp must be strictly greater
//!   than the previous one, and at least [`MIN_INTERVAL_SECONDS`] later, so a
//!   compromised key cannot rewrite the curve or spam a single ledger.
//! * Timestamps may not be in the future relative to the ledger clock.
//! * `cumulative_price` is derived inside the contract from the previous
//!   observation; callers can never supply it.
//! * Prices must be positive and at or below [`MAX_PRICE`], and every
//!   cumulative arithmetic step is checked, so an out-of-range price cannot
//!   overflow the accumulator into a bogus average.
//! * History is capped at [`MAX_OBSERVATIONS`]; the oldest entry is pruned, so
//!   storage cannot grow without bound.
//! * The TWAP window is bounded by [`MAX_WINDOW_SECONDS`] and requires enough
//!   retained history to cover it, so a caller cannot average over a single
//!   freshly written observation.
//!
//! # Multi-window mean aggregation
//!
//! `consult_multi_window` computes all three mean types over a requested epoch:
//!
//! * **Arithmetic mean** — classic time-weighted average (cumulative price /
//!   elapsed seconds). Upward-biased when flash spikes are present.
//! * **Geometric mean** — n-th root of the product of prices, approximated via
//!   Newton's-method integer root on the product accumulator.  Naturally
//!   resistant to multiplicative outliers.
//! * **Harmonic mean** — N / Σ(1/p_i), computed with scaled reciprocal sums.
//!   The minimum of the three means; provides a manipulation-resistant lower
//!   bound.
//!
//! Before any mean is computed, samples that deviate more than 3 × MAD from the
//! median of the window are discarded (Chauvenet / median-based outlier filter).
//!
//! Illiquid-pool guard: if fewer than [`MIN_SAMPLES_FOR_MEAN`] non-outlier
//! samples survive filtering, `consult_multi_window` falls back to a safe
//! default spread rather than dividing by zero or returning a degenerate result.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address,
    Env, Vec,
};

/// Maximum number of observations retained. When the buffer is full the oldest
/// observation is dropped before the new one is appended.
pub const MAX_OBSERVATIONS: u32 = 64;

/// Minimum number of seconds between two consecutive observations.
pub const MIN_INTERVAL_SECONDS: u64 = 60;

/// Largest permitted TWAP window (7 days).
pub const MAX_WINDOW_SECONDS: u64 = 7 * 24 * 60 * 60;

/// Upper bound for a single observation price. Keeps `price * elapsed` well
/// inside `i128` for any realistic ledger gap.
pub const MAX_PRICE: i128 = i128::MAX / 1_000_000_000;

/// Default maximum divergence between primary and secondary price feeds (500 bps = 5%).
pub const DEFAULT_MAX_DIVERGENCE_BPS: u32 = 500;

/// Default staleness threshold for observations (1 hour = 3600 seconds).
pub const DEFAULT_STALENESS_THRESHOLD: u64 = 3_600;

/// Basis points divisor (10,000 bps = 100%).
pub const BPS_DIVISOR: i128 = 10_000;

// ── Multi-window epoch constants ─────────────────────────────────────────────

/// 5-minute epoch window in seconds.
pub const WINDOW_5M: u64 = 300;

/// 1-hour epoch window in seconds.
pub const WINDOW_1H: u64 = 3_600;

/// 24-hour epoch window in seconds.
pub const WINDOW_24H: u64 = 86_400;

/// Minimum non-outlier samples required to compute geometric/harmonic means.
/// Below this threshold the contract falls back to a safe default spread.
pub const MIN_SAMPLES_FOR_MEAN: u32 = 2;

/// Safe fallback price returned when the pool is illiquid (too few samples).
/// This is intentionally set to zero, signalling "no valid price"; callers
/// must handle zero prices as an illiquid-pool condition.
pub const ILLIQUID_FALLBACK_PRICE: i128 = 0;

/// Fixed-point scale used in geometric/harmonic computations (1e6 = 6 decimals).
pub const PRECISION: i128 = 1_000_000;

/// Outlier sigma multiplier (3 × MAD used as the rejection threshold).
/// Stored as a fixed-point integer (3 * PRECISION).
pub const OUTLIER_SIGMA: i128 = 3 * PRECISION;

// ── Result type for multi-window queries ─────────────────────────────────────

/// Result returned by `consult_multi_window`.
///
/// All three mean types are computed over the filtered price samples within the
/// requested window.  A `0` value for `geometric_mean` or `harmonic_mean`
/// signals an illiquid pool (fewer than [`MIN_SAMPLES_FOR_MEAN`] survived
/// outlier filtering).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MultiWindowResult {
    /// Standard time-weighted arithmetic mean (cumulative price / elapsed).
    pub arithmetic_mean: i128,
    /// Geometric mean of sampled prices (n-th root of product), approximated
    /// via Newton's-method integer root.
    pub geometric_mean: i128,
    /// Harmonic mean of sampled prices (N / Σ(1/pᵢ)), computed with scaled
    /// reciprocal sums to avoid division-by-zero on illiquid pools.
    pub harmonic_mean: i128,
    /// Number of price samples that survived outlier filtering.
    pub sample_count: u32,
    /// `true` when fewer than [`MIN_SAMPLES_FOR_MEAN`] samples were available;
    /// geometric and harmonic means are then [`ILLIQUID_FALLBACK_PRICE`].
    pub is_illiquid: bool,
}

// ── Pure math helpers (no_std, no float) ─────────────────────────────────────

/// Integer square-root via Newton's method (floor).
///
/// Returns the largest `x` such that `x*x <= n`.  Handles `n == 0`.
pub(crate) fn isqrt(n: i128) -> i128 {
    if n <= 0 {
        return 0;
    }
    if n == 1 {
        return 1;
    }
    // Initial estimate: bit-shift approximation
    let mut x = n >> (bit_length(n) / 2);
    if x == 0 {
        x = 1;
    }
    loop {
        let x_next = (x + n / x) / 2;
        if x_next >= x {
            return x;
        }
        x = x_next;
    }
}

/// Number of bits required to represent `n` (equivalent to `floor(log2(n)) + 1`).
pub(crate) fn bit_length(mut n: i128) -> u32 {
    let mut len = 0u32;
    while n > 0 {
        n >>= 1;
        len += 1;
    }
    len
}

/// General integer n-th root via Newton's method (floor).
///
/// Returns the largest `x` such that `x^k <= n`.
/// Works for `k >= 1` and `n >= 0`.
pub(crate) fn integer_nth_root(n: i128, k: u32) -> i128 {
    if k == 0 {
        return 1; // convention: 0th root is 1
    }
    if k == 1 {
        return n;
    }
    if k == 2 {
        return isqrt(n);
    }
    if n <= 1 {
        return n;
    }

    // Initial estimate via bit length
    let bits = bit_length(n);
    let est_bits = (bits + k - 1) / k;
    let mut x = if est_bits >= 63 {
        i128::MAX >> 1
    } else {
        1i128 << est_bits
    };
    if x < 2 {
        x = 2;
    }

    loop {
        // Compute x^(k-1) safely — use u128 intermediary to guard overflow
        let xk = pow_saturating(x, k - 1);
        if xk == 0 {
            return 0;
        }
        // Newton step: x_next = ((k-1)*x + n / x^(k-1)) / k
        let x_next = ((i128::from(k) - 1) * x + n / xk) / i128::from(k);
        if x_next >= x {
            return x;
        }
        x = x_next;
    }
}

/// Saturating integer power: `base^exp`, returning `i128::MAX` on overflow.
pub(crate) fn pow_saturating(mut base: i128, mut exp: u32) -> i128 {
    let mut result: i128 = 1;
    while exp > 0 {
        if exp & 1 == 1 {
            result = result.saturating_mul(base);
            if result == i128::MAX {
                return i128::MAX;
            }
        }
        base = base.saturating_mul(base);
        exp >>= 1;
    }
    result
}

/// Sort a small `Vec<i128>` in ascending order.
///
/// Builds a sorted result by inserting each element at the correct position.
/// O(n²) — fine for the small sample sizes we handle (≤ 64).
pub(crate) fn sort_ascending(env: &Env, values: &Vec<i128>) -> Vec<i128> {
    let n = values.len();
    // We build a sorted Vec<i128> by copying into a fixed-size array equivalent.
    // Since MAX_OBSERVATIONS ≤ 64, we use an unrolled approach: for each value,
    // find the insertion point in already-sorted output and rebuild.
    let mut sorted: Vec<i128> = Vec::new(env);

    let mut i = 0u32;
    while i < n {
        let val = values.get(i).unwrap();

        // Find insertion index in sorted (first position where sorted[j] > val)
        let mut insert_at = sorted.len();
        let mut j = 0u32;
        while j < sorted.len() {
            if sorted.get(j).unwrap() > val {
                insert_at = j;
                break;
            }
            j += 1;
        }

        // Rebuild sorted with val inserted at insert_at
        let mut new_sorted: Vec<i128> = Vec::new(env);
        let mut k = 0u32;
        while k < insert_at {
            new_sorted.push_back(sorted.get(k).unwrap());
            k += 1;
        }
        new_sorted.push_back(val);
        while k < sorted.len() {
            new_sorted.push_back(sorted.get(k).unwrap());
            k += 1;
        }
        sorted = new_sorted;
        i += 1;
    }
    sorted
}

/// Compute the median of a non-empty sorted Vec<i128>.
pub(crate) fn median_of_sorted(sorted: &Vec<i128>) -> i128 {
    let n = sorted.len();
    if n == 0 {
        return 0;
    }
    if n % 2 == 1 {
        sorted.get(n / 2).unwrap()
    } else {
        let a = sorted.get(n / 2 - 1).unwrap();
        let b = sorted.get(n / 2).unwrap();
        (a + b) / 2
    }
}

/// Apply median-based outlier filtering (Chauvenet / 3-sigma MAD rule).
///
/// Steps:
/// 1. Compute the median of `prices`.
/// 2. Compute absolute deviations from the median.
/// 3. Compute MAD (median of absolute deviations).
/// 4. Reject any price where `|price - median| > OUTLIER_SIGMA * MAD / PRECISION`.
///
/// Returns a new `Vec<i128>` of accepted prices.
pub(crate) fn filter_outliers(env: &Env, prices: &Vec<i128>) -> Vec<i128> {
    let n = prices.len();
    if n <= 2 {
        // Too few points for meaningful filtering — return as-is
        let mut out = Vec::new(env);
        let mut i = 0u32;
        while i < n {
            out.push_back(prices.get(i).unwrap());
            i += 1;
        }
        return out;
    }

    // 1. Sorted prices for median computation
    let sorted = sort_ascending(env, prices);
    let med = median_of_sorted(&sorted);

    // 2. Absolute deviations
    let mut deviations: Vec<i128> = Vec::new(env);
    {
        let mut i = 0u32;
        while i < n {
            let p = prices.get(i).unwrap();
            deviations.push_back((p - med).abs());
            i += 1;
        }
    }

    // 3. MAD = median of absolute deviations
    let sorted_dev = sort_ascending(env, &deviations);
    let mad = median_of_sorted(&sorted_dev);

    // If MAD is zero all prices are identical — nothing to filter
    if mad == 0 {
        let mut out = Vec::new(env);
        let mut i = 0u32;
        while i < n {
            out.push_back(prices.get(i).unwrap());
            i += 1;
        }
        return out;
    }

    // 4. Reject outliers: |price - median| > OUTLIER_SIGMA * mad / PRECISION
    //    Re-written to avoid division: |price - median| * PRECISION > OUTLIER_SIGMA * mad
    let threshold = OUTLIER_SIGMA.saturating_mul(mad); // = 3 * PRECISION * mad
    let mut filtered: Vec<i128> = Vec::new(env);
    {
        let mut i = 0u32;
        while i < n {
            let p = prices.get(i).unwrap();
            let deviation_scaled = (p - med).abs().saturating_mul(PRECISION);
            if deviation_scaled <= threshold {
                filtered.push_back(p);
            }
            i += 1;
        }
    }

    // Guarantee at least one sample survives (fall back to median-only list)
    if filtered.is_empty() {
        let mut out = Vec::new(env);
        out.push_back(med);
        return out;
    }

    filtered
}

/// Geometric mean of a non-empty slice of positive i128 prices.
///
/// Uses fixed-point scaling: multiply all prices (with intermediate rescaling
/// to prevent overflow), then take the n-th integer root.
///
/// Returns `0` if any price is ≤ 0 or if the product overflows beyond recovery.
pub(crate) fn geometric_mean(prices: &Vec<i128>) -> i128 {
    let n = prices.len();
    if n == 0 {
        return 0;
    }
    if n == 1 {
        return prices.get(0).unwrap();
    }

    // Strategy: accumulate the product scaled by PRECISION^n, then take the
    // n-th root to get back to the original price scale.
    // To prevent overflow we keep product in the range [1, i128::MAX] by
    // periodic rescaling: whenever product > PRECISION^2, we divide by PRECISION
    // and track the exponent offset.
    //
    // Simpler and safer approach for ≤ 64 samples:
    // Compute geometric mean using pair-wise multiplication with intermediate
    // root extraction: G(p1..pN) = (p1 * p2)^(1/2) then fold in each next price.
    //
    // G_{k+1} = (G_k^k * p_{k+1})^(1/(k+1))
    //         ≈ nth_root(G_k^k * p_{k+1}, k+1)
    //
    // This keeps values bounded at each step.

    let mut g = prices.get(0).unwrap();
    if g <= 0 {
        return 0;
    }

    let mut k = 1u32;
    while k < n {
        let p = prices.get(k).unwrap();
        if p <= 0 {
            return 0;
        }
        // g_new = (g^k * p)^(1/(k+1))
        // We compute g^k carefully, then multiply by p, then take (k+1)-th root.
        let gk = pow_saturating(g, k);
        // gk * p might overflow; use saturating_mul
        let product = gk.saturating_mul(p);
        if product <= 0 {
            return 0;
        }
        g = integer_nth_root(product, k + 1);
        if g <= 0 {
            return 0;
        }
        k += 1;
    }
    g
}

/// Harmonic mean of a non-empty slice of positive i128 prices.
///
/// H = N / Σ(1/pᵢ)
///
/// To avoid losing precision when prices are large (> PRECISION), we scale the
/// computation by the minimum price in the set so that all reciprocals are ≥ 1:
///
///   H = p_min * N / Σ(p_min / pᵢ)
///
/// where `p_min / pᵢ` is always ≤ 1 but still representable as a non-zero
/// integer (since pᵢ ≤ MAX_PRICE << i128::MAX).
///
/// Returns `0` if any price is ≤ 0 (illiquid guard).
pub(crate) fn harmonic_mean(prices: &Vec<i128>) -> i128 {
    let n = prices.len();
    if n == 0 {
        return 0;
    }

    // Find the minimum price for scaling
    let mut p_min = i128::MAX;
    {
        let mut i = 0u32;
        while i < n {
            let p = prices.get(i).unwrap();
            if p <= 0 {
                return 0; // illiquid guard
            }
            if p < p_min {
                p_min = p;
            }
            i += 1;
        }
    }

    // Σ(p_min / pᵢ): each term is in [0, 1] when pᵢ >= p_min.
    // We scale by PRECISION to get integer reciprocals with reasonable precision:
    //   scaled_term = p_min * PRECISION / pᵢ
    // This is safe because p_min <= pᵢ, so the result is in [1, PRECISION].
    let mut recip_sum: i128 = 0;
    {
        let mut i = 0u32;
        while i < n {
            let p = prices.get(i).unwrap();
            // p_min * PRECISION / p: numerator fits because p_min ≤ MAX_PRICE
            // and PRECISION = 1e6, so p_min * PRECISION ≤ MAX_PRICE * 1e6.
            // MAX_PRICE = i128::MAX / 1e9, so MAX_PRICE * 1e6 = i128::MAX / 1000 — no overflow.
            let r = p_min
                .checked_mul(PRECISION)
                .unwrap_or(i128::MAX)
                / p;
            recip_sum = recip_sum.saturating_add(r);
            i += 1;
        }
    }

    if recip_sum == 0 {
        return 0;
    }

    // H = p_min * n * PRECISION / recip_sum
    // = p_min * PRECISION * n / (Σ p_min * PRECISION / pᵢ)
    // = n / Σ(1/pᵢ)  ✓
    let numerator = p_min
        .checked_mul(PRECISION)
        .unwrap_or(i128::MAX)
        .saturating_mul(n as i128);
    numerator / recip_sum
}

/// Collect the distinct price values for observations within `[window_start, window_end]`.
///
/// The first synthetic sample is computed via linear interpolation at `window_start`
/// exactly, then every observation price within the window is added.
pub(crate) fn collect_window_prices(
    env: &Env,
    observations: &Vec<Observation>,
    window_start: u64,
    window_end: u64,
) -> Vec<i128> {
    let mut prices: Vec<i128> = Vec::new(env);
    let n = observations.len();
    if n == 0 {
        return prices;
    }

    // Find the observation at or just before window_start (for interpolation)
    let mut base_index: Option<u32> = None;
    let mut idx = 0u32;
    while idx < n {
        let obs = observations.get(idx).unwrap();
        if obs.timestamp <= window_start {
            base_index = Some(idx);
        } else {
            break;
        }
        idx += 1;
    }

    // Add interpolated price at the window boundary
    if let Some(bi) = base_index {
        let base_obs = observations.get(bi).unwrap();
        // Linear interpolation: use the base price (constant price segments in TWAP)
        prices.push_back(base_obs.price);
    }

    // Add all observation prices whose timestamp falls strictly inside the window
    let mut idx = 0u32;
    while idx < n {
        let obs = observations.get(idx).unwrap();
        if obs.timestamp > window_start && obs.timestamp <= window_end {
            prices.push_back(obs.price);
        }
        idx += 1;
    }

    prices
}

/// A single price observation.
///
/// `cumulative_price` is the integral of price over time up to and including
/// this observation, expressed in `price * seconds`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Observation {
    pub timestamp: u64,
    pub price: i128,
    pub cumulative_price: i128,
}

/// Storage keys for the oracle.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Observations,
    SecondaryOracle,
    MaxDivergenceBps,
    StalenessThreshold,
    Weights,
    CircuitBreakerTripped,
    /// Fallback price used when the pool is illiquid (too few clean samples).
    /// Set by the admin via `set_illiquid_fallback`.
    IlliquidFallback,
}

/// Oracle errors surfaced to callers.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidPrice = 3,
    TimestampNotMonotonic = 4,
    TimestampInFuture = 5,
    ObservationTooSoon = 6,
    PriceOverflow = 7,
    InvalidWindow = 8,
    InsufficientHistory = 9,
    NoObservations = 10,
    CircuitBreakerTripped = 11,
    PrimaryStale = 12,
    SecondaryStale = 13,
    OracleUnavailable = 14,
    InvalidConfig = 15,
    /// The pool is illiquid: too few clean price samples survived outlier
    /// filtering to compute a reliable mean.  Callers should treat this as
    /// "no valid price available" and use the fallback spread.
    IlliquidPool = 16,
}

/// Interface implemented by secondary price feed contracts.
#[contractclient(name = "SecondaryOracleClient")]
pub trait SecondaryOracle {
    fn latest_observation(env: Env) -> Option<Observation>;
    fn twap(env: Env, window_seconds: u64) -> i128;
}

fn read_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)
}

fn read_observations(env: &Env) -> Vec<Observation> {
    env.storage()
        .instance()
        .get(&DataKey::Observations)
        .unwrap_or_else(|| Vec::new(env))
}

#[contract]
pub struct TwapOracle;

#[contractimpl]
impl TwapOracle {
    /// Initialize the oracle with the address allowed to write observations.
    ///
    /// The admin must authorize the call. Can only be called once.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();

        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Observations, &Vec::<Observation>::new(&env));

        Ok(())
    }

    /// Returns the admin allowed to write observations, if initialized.
    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// Append a price observation, returning the number of retained
    /// observations after the write.
    ///
    /// `timestamp` must not be in the future and must be strictly greater than
    /// the previous observation by at least [`MIN_INTERVAL_SECONDS`].
    ///
    /// # Panics
    ///
    /// Panics if the caller is not the admin or if retrieving previous observation fails.
    pub fn observe(env: Env, price: i128, timestamp: u64) -> Result<u32, Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();

        if price <= 0 || price > MAX_PRICE {
            return Err(Error::InvalidPrice);
        }
        if timestamp > env.ledger().timestamp() {
            return Err(Error::TimestampInFuture);
        }

        let mut observations = read_observations(&env);

        let mut cumulative_price = 0i128;
        if !observations.is_empty() {
            let previous = observations.get(observations.len() - 1).unwrap();

            if timestamp <= previous.timestamp {
                return Err(Error::TimestampNotMonotonic);
            }
            if timestamp - previous.timestamp < MIN_INTERVAL_SECONDS {
                return Err(Error::ObservationTooSoon);
            }

            let elapsed = i128::from(timestamp - previous.timestamp);
            let increment = previous
                .price
                .checked_mul(elapsed)
                .ok_or(Error::PriceOverflow)?;
            cumulative_price = previous
                .cumulative_price
                .checked_add(increment)
                .ok_or(Error::PriceOverflow)?;
        }

        observations.push_back(Observation {
            timestamp,
            price,
            cumulative_price,
        });

        // Drop the oldest entry once the retained history is full.
        if observations.len() > MAX_OBSERVATIONS {
            let mut pruned = Vec::new(&env);
            let mut index = 1u32;
            while index < observations.len() {
                pruned.push_back(observations.get(index).unwrap());
                index += 1;
            }
            observations = pruned;
        }

        let count = observations.len();
        env.storage()
            .instance()
            .set(&DataKey::Observations, &observations);

        Ok(count)
    }

    /// Number of retained observations.
    pub fn observation_count(env: Env) -> u32 {
        read_observations(&env).len()
    }

    /// The most recent observation, if any have been recorded.
    pub fn latest_observation(env: Env) -> Option<Observation> {
        let observations = read_observations(&env);
        observations.get(observations.len().saturating_sub(1))
    }

    /// All retained observations, oldest first.
    pub fn observations(env: Env) -> Vec<Observation> {
        read_observations(&env)
    }

    /// Time-weighted average price over the `window_seconds` ending at the most
    /// recent observation.
    ///
    /// The window start is interpolated within the segment that contains it, so
    /// the average is computed over exactly `window_seconds`.
    ///
    /// # Panics
    ///
    /// Panics if accessing the stored observations fails.
    pub fn twap(env: Env, window_seconds: u64) -> Result<i128, Error> {
        if window_seconds == 0 || window_seconds > MAX_WINDOW_SECONDS {
            return Err(Error::InvalidWindow);
        }

        let observations = read_observations(&env);
        let length = observations.len();
        if length == 0 {
            return Err(Error::NoObservations);
        }

        let latest = observations.get(length - 1).unwrap();
        let target = latest
            .timestamp
            .checked_sub(window_seconds)
            .ok_or(Error::InsufficientHistory)?;

        let first = observations.get(0).unwrap();
        if target < first.timestamp {
            return Err(Error::InsufficientHistory);
        }

        // Last observation at or before the window start.
        let mut base_index = 0u32;
        let mut index = 0u32;
        while index < length {
            let observation = observations.get(index).unwrap();
            if observation.timestamp > target {
                break;
            }
            base_index = index;
            index += 1;
        }

        let base = observations.get(base_index).unwrap();
        let cumulative_at_target = if base.timestamp == target {
            base.cumulative_price
        } else {
            // Interpolate to the exact window start inside the base segment.
            let elapsed = i128::from(target - base.timestamp);
            let increment = base
                .price
                .checked_mul(elapsed)
                .ok_or(Error::PriceOverflow)?;
            base.cumulative_price
                .checked_add(increment)
                .ok_or(Error::PriceOverflow)?
        };

        let accumulated = latest
            .cumulative_price
            .checked_sub(cumulative_at_target)
            .ok_or(Error::PriceOverflow)?;

        Ok(accumulated / i128::from(window_seconds))
    }

    // ── Consensus & Fallback Configuration ───────────────────────────────────

    /// Registers the secondary oracle contract address in persistent storage.
    ///
    /// Requires authorization from the configured admin.
    pub fn set_secondary_oracle(env: Env, secondary_oracle: Address) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::SecondaryOracle, &secondary_oracle);

        env.events().publish(
            (symbol_short!("oracle"), symbol_short!("set_sec")),
            secondary_oracle,
        );

        Ok(())
    }

    /// Alias for [`Self::set_secondary_oracle`] to register a secondary oracle.
    pub fn register_secondary_oracle(env: Env, secondary_oracle: Address) -> Result<(), Error> {
        Self::set_secondary_oracle(env, secondary_oracle)
    }

    /// Returns the registered secondary oracle contract address, if set.
    pub fn secondary_oracle(env: Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::SecondaryOracle)
    }

    /// Configures the maximum allowed price divergence in basis points between
    /// primary and secondary oracles (e.g. 500 bps = 5%).
    ///
    /// Requires authorization from the configured admin.
    pub fn set_max_divergence_bps(env: Env, max_divergence_bps: u32) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();

        if max_divergence_bps > 10_000 {
            return Err(Error::InvalidConfig);
        }

        env.storage()
            .persistent()
            .set(&DataKey::MaxDivergenceBps, &max_divergence_bps);

        Ok(())
    }

    /// Returns the maximum divergence threshold in basis points (defaults to 500 bps).
    pub fn max_divergence_bps(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::MaxDivergenceBps)
            .unwrap_or(DEFAULT_MAX_DIVERGENCE_BPS)
    }

    /// Configures the maximum age in seconds for observations before they are considered stale.
    ///
    /// Requires authorization from the configured admin.
    pub fn set_staleness_threshold(env: Env, threshold_seconds: u64) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();

        if threshold_seconds == 0 {
            return Err(Error::InvalidConfig);
        }

        env.storage()
            .persistent()
            .set(&DataKey::StalenessThreshold, &threshold_seconds);

        Ok(())
    }

    /// Returns the staleness threshold in seconds (defaults to 3600 seconds).
    pub fn staleness_threshold(env: Env) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::StalenessThreshold)
            .unwrap_or(DEFAULT_STALENESS_THRESHOLD)
    }

    /// Configures consensus weights for primary and secondary feeds.
    ///
    /// Requires authorization from the configured admin.
    pub fn set_consensus_weights(
        env: Env,
        primary_weight: u32,
        secondary_weight: u32,
    ) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();

        if primary_weight == 0 || secondary_weight == 0 {
            return Err(Error::InvalidConfig);
        }

        env.storage()
            .persistent()
            .set(&DataKey::Weights, &(primary_weight, secondary_weight));

        Ok(())
    }

    /// Returns consensus weights (primary_weight, secondary_weight), defaulting to (5000, 5000).
    pub fn consensus_weights(env: Env) -> (u32, u32) {
        env.storage()
            .persistent()
            .get(&DataKey::Weights)
            .unwrap_or((5_000, 5_000))
    }

    /// Returns whether the dynamic discrepancy circuit breaker is currently tripped.
    pub fn is_circuit_breaker_tripped(env: Env) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::CircuitBreakerTripped)
            .unwrap_or(false)
    }

    /// Resets the circuit breaker, allowing normal oracle operations to resume.
    ///
    /// Requires authorization from the configured admin.
    pub fn reset_circuit_breaker(env: Env) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::CircuitBreakerTripped, &false);

        env.events().publish(
            (symbol_short!("breaker"), symbol_short!("reset")),
            (),
        );

        Ok(())
    }

    /// Manually trips the circuit breaker to freeze oracle pricing in emergencies.
    ///
    /// Requires authorization from the configured admin.
    pub fn trip_circuit_breaker(env: Env) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::CircuitBreakerTripped, &true);

        env.events().publish(
            (symbol_short!("breaker"), symbol_short!("tripped")),
            (0i128, 0i128, 0i128),
        );

        Ok(())
    }

    // ── Consensus Oracle Query ───────────────────────────────────────────────

    /// Consults the oracle consensus engine over the given `window_seconds`.
    ///
    /// - If the circuit breaker is tripped, reverts immediately with [`Error::CircuitBreakerTripped`].
    /// - Checks primary and secondary price feeds against the staleness limit.
    /// - If both feeds are fresh:
    ///   - Validates that discrepancy between feeds does not exceed `max_divergence_bps` (500 bps).
    ///   - If divergence exceeds threshold, trips the circuit breaker and reverts with [`Error::CircuitBreakerTripped`].
    ///   - If within threshold, returns the weighted consensus average.
    /// - If primary is stale and secondary is fresh, falls back to secondary with a warning event emission.
    /// - If primary is fresh and secondary is stale or absent, returns the primary price.
    /// - If both feeds are stale, returns [`Error::PrimaryStale`].
    pub fn consult(env: Env, window_seconds: u64) -> Result<i128, Error> {
        if Self::is_circuit_breaker_tripped(env.clone()) {
            return Err(Error::CircuitBreakerTripped);
        }

        if window_seconds > MAX_WINDOW_SECONDS {
            return Err(Error::InvalidWindow);
        }

        let staleness_limit = Self::staleness_threshold(env.clone());
        let current_time = env.ledger().timestamp();

        // 1. Evaluate primary feed
        let observations = read_observations(&env);
        let mut primary_fresh = false;
        let mut primary_price = 0i128;
        let mut primary_timestamp = 0u64;

        if !observations.is_empty() {
            let latest = observations.get(observations.len() - 1).unwrap();
            primary_timestamp = latest.timestamp;
            let elapsed = current_time.saturating_sub(latest.timestamp);
            let is_stale = staleness_limit > 0 && elapsed > staleness_limit;

            if !is_stale {
                if window_seconds == 0 {
                    primary_price = latest.price;
                    primary_fresh = true;
                } else if let Ok(twap_p) = Self::twap(env.clone(), window_seconds) {
                    primary_price = twap_p;
                    primary_fresh = true;
                }
            }
        }

        // 2. Evaluate secondary feed
        let secondary_opt = Self::secondary_oracle(env.clone());
        let mut secondary_fresh = false;
        let mut secondary_price = 0i128;

        if let Some(sec_addr) = &secondary_opt {
            let sec_client = SecondaryOracleClient::new(&env, sec_addr);
            if let Ok(Ok(Some(sec_obs))) = sec_client.try_latest_observation() {
                if sec_obs.price > 0 && sec_obs.price <= MAX_PRICE {
                    let sec_elapsed = current_time.saturating_sub(sec_obs.timestamp);
                    let sec_is_stale = staleness_limit > 0 && sec_elapsed > staleness_limit;

                    if !sec_is_stale {
                        secondary_fresh = true;
                        if window_seconds > 0 {
                            if let Ok(Ok(p)) = sec_client.try_twap(&window_seconds) {
                                if p > 0 && p <= MAX_PRICE {
                                    secondary_price = p;
                                } else {
                                    secondary_price = sec_obs.price;
                                }
                            } else {
                                secondary_price = sec_obs.price;
                            }
                        } else {
                            secondary_price = sec_obs.price;
                        }
                    }
                }
            }
        }

        // 3. Handle consensus, fallback, or failure
        if primary_fresh && secondary_fresh {
            let diff = (primary_price - secondary_price).abs();
            let max_bps = Self::max_divergence_bps(env.clone());
            let divergence_bps = diff
                .checked_mul(BPS_DIVISOR)
                .ok_or(Error::PriceOverflow)?
                / primary_price;

            if divergence_bps > i128::from(max_bps) {
                env.storage()
                    .persistent()
                    .set(&DataKey::CircuitBreakerTripped, &true);

                env.events().publish(
                    (symbol_short!("breaker"), symbol_short!("tripped")),
                    (primary_price, secondary_price, divergence_bps),
                );

                return Err(Error::CircuitBreakerTripped);
            }

            let (w1, w2) = Self::consensus_weights(env.clone());
            let total_w = i128::from(w1 + w2);
            if total_w == 0 {
                return Err(Error::InvalidConfig);
            }

            let p_part = primary_price
                .checked_mul(i128::from(w1))
                .ok_or(Error::PriceOverflow)?;
            let s_part = secondary_price
                .checked_mul(i128::from(w2))
                .ok_or(Error::PriceOverflow)?;
            let avg = p_part
                .checked_add(s_part)
                .ok_or(Error::PriceOverflow)?
                / total_w;

            env.events().publish(
                (symbol_short!("oracle"), symbol_short!("consensus")),
                avg,
            );

            Ok(avg)
        } else if !primary_fresh {
            if secondary_fresh {
                env.events().publish(
                    (symbol_short!("oracle"), symbol_short!("fallback")),
                    (primary_timestamp, secondary_price),
                );
                Ok(secondary_price)
            } else {
                Err(Error::PrimaryStale)
            }
        } else {
            // primary_fresh is true, but secondary is stale or absent
            if secondary_opt.is_some() {
                env.events().publish(
                    (symbol_short!("oracle"), symbol_short!("sec_stale")),
                    primary_price,
                );
            }
            Ok(primary_price)
        }
    }

    // ── Multi-window Geometric / Harmonic Mean Query ─────────────────────────

    /// Configures the per-admin illiquid-pool fallback price.
    ///
    /// When `consult_multi_window` detects too few clean samples to compute
    /// reliable geometric / harmonic means, it returns this value for both
    /// means and sets `is_illiquid = true`.  A value of `0` means "no
    /// fallback configured; treat as error".
    ///
    /// Requires authorization from the configured admin.
    pub fn set_illiquid_fallback(env: Env, fallback_price: i128) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();

        if fallback_price < 0 {
            return Err(Error::InvalidPrice);
        }

        env.storage()
            .persistent()
            .set(&DataKey::IlliquidFallback, &fallback_price);

        Ok(())
    }

    /// Returns the configured illiquid-pool fallback price (defaults to 0).
    pub fn illiquid_fallback(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::IlliquidFallback)
            .unwrap_or(ILLIQUID_FALLBACK_PRICE)
    }

    /// Compute arithmetic, geometric, and harmonic TWAP means over
    /// `window_seconds` of price history, with outlier filtering.
    ///
    /// # Algorithm
    ///
    /// 1. Validate `window_seconds` (must be ≤ `MAX_WINDOW_SECONDS` and > 0).
    /// 2. Collect all price samples within the window (the boundary is
    ///    interpolated exactly, as in `twap`).
    /// 3. Apply the median / 3×MAD outlier filter (`filter_outliers`).
    /// 4. If fewer than `MIN_SAMPLES_FOR_MEAN` samples survive, mark the result
    ///    illiquid and return the configured fallback for geo/harmonic means.
    /// 5. Compute arithmetic mean via the cumulative-price accumulator (same as
    ///    `twap`), geometric mean via incremental Newton's-method n-th root,
    ///    and harmonic mean via scaled reciprocal sums.
    ///
    /// The arithmetic mean is always computed from the full (unfiltered) TWAP
    /// accumulator so it is exactly consistent with `twap(window_seconds)`.
    /// Geometric and harmonic means operate on the filtered discrete samples.
    ///
    /// # Supported windows
    ///
    /// Any `window_seconds` ≤ `MAX_WINDOW_SECONDS` is accepted, including the
    /// standard epoch constants:
    /// * `WINDOW_5M` (300 s)
    /// * `WINDOW_1H` (3 600 s)
    /// * `WINDOW_24H` (86 400 s)
    pub fn consult_multi_window(
        env: Env,
        window_seconds: u64,
    ) -> Result<MultiWindowResult, Error> {
        if window_seconds == 0 || window_seconds > MAX_WINDOW_SECONDS {
            return Err(Error::InvalidWindow);
        }

        // ── 1. Arithmetic mean via cumulative accumulator ─────────────────
        let arithmetic_mean = Self::twap(env.clone(), window_seconds)?;

        // ── 2. Collect price samples within the window ────────────────────
        let observations = read_observations(&env);
        let length = observations.len();

        // We already know history is sufficient (twap succeeded).
        let latest = observations.get(length - 1).unwrap();
        let window_start = latest
            .timestamp
            .checked_sub(window_seconds)
            .ok_or(Error::InsufficientHistory)?;
        let window_end = latest.timestamp;

        let raw_prices = collect_window_prices(&env, &observations, window_start, window_end);

        // ── 3. Outlier filtering ──────────────────────────────────────────
        let filtered = filter_outliers(&env, &raw_prices);
        let sample_count = filtered.len();

        // ── 4. Illiquid-pool guard ────────────────────────────────────────
        if sample_count < MIN_SAMPLES_FOR_MEAN {
            let fallback = Self::illiquid_fallback(env.clone());
            env.events().publish(
                (symbol_short!("oracle"), symbol_short!("illiquid")),
                (window_seconds, sample_count),
            );
            return Ok(MultiWindowResult {
                arithmetic_mean,
                geometric_mean: fallback,
                harmonic_mean: fallback,
                sample_count,
                is_illiquid: true,
            });
        }

        // ── 5a. Geometric mean ────────────────────────────────────────────
        let geo = geometric_mean(&filtered);
        let geometric_mean_val = if geo <= 0 {
            // Overflow or non-positive prices — treat as illiquid
            Self::illiquid_fallback(env.clone())
        } else {
            geo
        };

        // ── 5b. Harmonic mean ─────────────────────────────────────────────
        let har = harmonic_mean(&filtered);
        let harmonic_mean_val = if har <= 0 {
            Self::illiquid_fallback(env.clone())
        } else {
            har
        };

        Ok(MultiWindowResult {
            arithmetic_mean,
            geometric_mean: geometric_mean_val,
            harmonic_mean: harmonic_mean_val,
            sample_count,
            is_illiquid: false,
        })
    }
}

#[cfg(test)]
mod test;
