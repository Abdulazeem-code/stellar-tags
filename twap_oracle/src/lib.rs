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
}

#[cfg(test)]
mod test;
