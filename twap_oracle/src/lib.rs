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

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Vec};

/// Maximum number of observations retained. When the buffer is full the oldest
/// observation is dropped before the new one is appended.
pub const MAX_OBSERVATIONS: u32 = 64;

/// Minimum number of seconds between two consecutive observations.
pub const MIN_INTERVAL_SECONDS: u64 = 60;

/// Largest permitted TWAP window (7 days).
pub const MAX_WINDOW_SECONDS: u64 = 7 * 24 * 60 * 60;

/// Default staleness threshold (1 hour) if not explicitly set for a pair.
pub const DEFAULT_MAX_STALENESS_SECONDS: u64 = 3600;

/// Upper bound for a single observation price. Keeps `price * elapsed` well
/// inside `i128` for any realistic ledger gap.
pub const MAX_PRICE: i128 = i128::MAX / 1_000_000_000;

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
    Pair(Address, Address),
    Staleness(Address, Address),
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
    PriceStale = 11,
}

fn read_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)
}

fn read_observations(env: &Env, base: &Address, quote: &Address) -> Vec<Observation> {
    env.storage()
        .instance()
        .get(&DataKey::Pair(base.clone(), quote.clone()))
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

        Ok(())
    }

    /// Returns the admin allowed to write observations, if initialized.
    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// Configure the maximum staleness threshold in seconds for a specific token pair.
    ///
    /// Admin authorization required.
    pub fn set_max_staleness(
        env: Env,
        base: Address,
        quote: Address,
        max_staleness_seconds: u64,
    ) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();

        env.storage().instance().set(
            &DataKey::Staleness(base, quote),
            &max_staleness_seconds,
        );

        Ok(())
    }

    /// Get configured maximum staleness for a pair, returning DEFAULT_MAX_STALENESS_SECONDS if not set.
    pub fn get_max_staleness(env: Env, base: Address, quote: Address) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::Staleness(base, quote))
            .unwrap_or(DEFAULT_MAX_STALENESS_SECONDS)
    }

    /// Append a price observation for a specific token pair, returning the number
    /// of retained observations after the write.
    ///
    /// `timestamp` must not be in the future and must be strictly greater than
    /// the previous observation by at least [`MIN_INTERVAL_SECONDS`].
    ///
    /// # Panics
    ///
    /// Panics if the caller is not the admin or if retrieving previous observation fails.
    pub fn observe(
        env: Env,
        base: Address,
        quote: Address,
        price: i128,
        timestamp: u64,
    ) -> Result<u32, Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();

        if price <= 0 || price > MAX_PRICE {
            return Err(Error::InvalidPrice);
        }
        if timestamp > env.ledger().timestamp() {
            return Err(Error::TimestampInFuture);
        }

        let mut observations = read_observations(&env, &base, &quote);

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
            .set(&DataKey::Pair(base, quote), &observations);

        Ok(count)
    }

    /// Number of retained observations for a pair.
    pub fn observation_count(env: Env, base: Address, quote: Address) -> u32 {
        read_observations(&env, &base, &quote).len()
    }

    /// The most recent observation for a pair, if any have been recorded.
    pub fn latest_observation(env: Env, base: Address, quote: Address) -> Option<Observation> {
        let observations = read_observations(&env, &base, &quote);
        observations.get(observations.len().saturating_sub(1))
    }

    /// All retained observations for a pair, oldest first.
    pub fn observations(env: Env, base: Address, quote: Address) -> Vec<Observation> {
        read_observations(&env, &base, &quote)
    }

    /// Time-weighted average price for a pair over `window_seconds` ending at the most
    /// recent observation.
    ///
    /// The window start is interpolated within the segment that contains it, so
    /// the average is computed over exactly `window_seconds`.
    ///
    /// # Panics
    ///
    /// Panics if accessing the stored observations fails.
    pub fn twap(env: Env, base: Address, quote: Address, window_seconds: u64) -> Result<i128, Error> {
        if window_seconds == 0 || window_seconds > MAX_WINDOW_SECONDS {
            return Err(Error::InvalidWindow);
        }

        let observations = read_observations(&env, &base, &quote);
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

        let base_obs = observations.get(base_index).unwrap();
        let cumulative_at_target = if base_obs.timestamp == target {
            base_obs.cumulative_price
        } else {
            // Interpolate to the exact window start inside the base segment.
            let elapsed = i128::from(target - base_obs.timestamp);
            let increment = base_obs
                .price
                .checked_mul(elapsed)
                .ok_or(Error::PriceOverflow)?;
            base_obs.cumulative_price
                .checked_add(increment)
                .ok_or(Error::PriceOverflow)?
        };

        let accumulated = latest
            .cumulative_price
            .checked_sub(cumulative_at_target)
            .ok_or(Error::PriceOverflow)?;

        Ok(accumulated / i128::from(window_seconds))
    }

    /// Consult the TWAP price for a token pair over `window_seconds`, enforcing
    /// a heartbeat freshness check rejecting prices older than `max_staleness_seconds`.
    pub fn consult(
        env: Env,
        base: Address,
        quote: Address,
        window_seconds: u64,
    ) -> Result<i128, Error> {
        let observations = read_observations(&env, &base, &quote);
        let length = observations.len();
        if length == 0 {
            return Err(Error::NoObservations);
        }

        let latest = observations.get(length - 1).unwrap();
        let max_staleness = Self::get_max_staleness(env.clone(), base.clone(), quote.clone());

        let current_time = env.ledger().timestamp();
        if current_time.saturating_sub(latest.timestamp) > max_staleness {
            return Err(Error::PriceStale);
        }

        Self::twap(env, base, quote, window_seconds)
    }
}

#[cfg(test)]
mod test;
