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
//! * Prices must be positive and at or below [`MAX_PRICE`]. Cumulative arithmetic
//!   uses 256-bit unsigned integers (`u256`) with modular wrapping math, so
//!   accumulators never panic on large price-elapsed products and TWAP differences
//!   remain exact across 2^256 overflow boundaries.
//! * History is capped at [`MAX_OBSERVATIONS`]; the oldest entry is pruned, so
//!   storage cannot grow without bound.
//! * The TWAP window is bounded by [`MAX_WINDOW_SECONDS`] and requires enough
//!   retained history to cover it, so a caller cannot average over a single
//!   freshly written observation.

use core::cmp::Ordering;
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, BytesN, Env, Symbol, Vec,
};

/// A Soroban-compatible 256-bit unsigned integer type backed by high and low 128-bit words.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord, Default)]
pub struct U256 {
    pub hi: u128,
    pub lo: u128,
}

#[allow(non_camel_case_types)]
pub type u256 = U256;

impl U256 {
    pub const ZERO: Self = Self { hi: 0, lo: 0 };
    pub const MAX: Self = Self {
        hi: u128::MAX,
        lo: u128::MAX,
    };

    #[inline]
    pub const fn from_words(hi: u128, lo: u128) -> Self {
        Self { hi, lo }
    }

    #[inline]
    pub const fn into_words(self) -> (u128, u128) {
        (self.hi, self.lo)
    }

    #[inline]
    fn as_ethnum(self) -> ethnum::u256 {
        ethnum::u256::from_words(self.hi, self.lo)
    }

    #[inline]
    fn from_ethnum(val: ethnum::u256) -> Self {
        let (hi, lo) = val.into_words();
        Self { hi, lo }
    }

    #[inline]
    #[must_use]
    pub fn wrapping_add(self, rhs: Self) -> Self {
        Self::from_ethnum(self.as_ethnum().wrapping_add(rhs.as_ethnum()))
    }

    #[inline]
    #[must_use]
    pub fn wrapping_sub(self, rhs: Self) -> Self {
        Self::from_ethnum(self.as_ethnum().wrapping_sub(rhs.as_ethnum()))
    }

    #[inline]
    #[must_use]
    pub fn wrapping_mul(self, rhs: Self) -> Self {
        Self::from_ethnum(self.as_ethnum().wrapping_mul(rhs.as_ethnum()))
    }
}

impl From<u64> for U256 {
    #[inline]
    fn from(val: u64) -> Self {
        Self {
            hi: 0,
            lo: u128::from(val),
        }
    }
}

impl From<u128> for U256 {
    #[inline]
    fn from(val: u128) -> Self {
        Self { hi: 0, lo: val }
    }
}

impl From<ethnum::u256> for U256 {
    #[inline]
    fn from(val: ethnum::u256) -> Self {
        Self::from_ethnum(val)
    }
}

impl From<U256> for ethnum::u256 {
    #[inline]
    fn from(val: U256) -> Self {
        val.as_ethnum()
    }
}

impl core::ops::Div for U256 {
    type Output = Self;
    #[inline]
    fn div(self, rhs: Self) -> Self::Output {
        Self::from_ethnum(self.as_ethnum() / rhs.as_ethnum())
    }
}

impl core::ops::Mul for U256 {
    type Output = Self;
    #[inline]
    fn mul(self, rhs: Self) -> Self::Output {
        Self::from_ethnum(self.as_ethnum() * rhs.as_ethnum())
    }
}

impl core::ops::Sub for U256 {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self::Output {
        Self::from_ethnum(self.as_ethnum() - rhs.as_ethnum())
    }
}

impl core::ops::Add for U256 {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self::Output {
        Self::from_ethnum(self.as_ethnum() + rhs.as_ethnum())
    }
}

impl TryFrom<U256> for i128 {
    type Error = Error;
    #[inline]
    fn try_from(val: U256) -> Result<Self, Self::Error> {
        i128::try_from(val.as_ethnum()).map_err(|_| Error::PriceOverflow)
    }
}

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
/// Default maximum single-update price deviation (1000 bps = 10%).
pub const DEFAULT_MAX_SINGLE_UPDATE_DEVIATION_BPS: u32 = 1_000;

/// Divisor for basis points calculations.
pub const BPS_DIVISOR: i128 = 10_000;
const Q64: i128 = 1i128 << 64;
#[allow(dead_code)]
const Q63: u128 = 1u128 << 63;
#[allow(dead_code)]
const OUTLIER_BPS: i128 = 1_500;

/// Upper bound for a single observation price. Keeps `price * elapsed` well
/// inside `i128` for any realistic ledger gap.
pub const MAX_PRICE: i128 = i128::MAX / 1_000_000_000;

/// A single price observation.
///
/// `cumulative_price` is the integral of price over time up to and including
/// this observation, expressed in `price * seconds` modulo 2^256.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Observation {
    pub timestamp: u64,
    pub price: i128,
    pub cumulative_price: u256,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LogObservation {
    pub timestamp: u64,
    pub cumulative_log_price: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignedPricePayload {
    pub base: Symbol,
    pub quote: Symbol,
    pub price: i128,
    pub timestamp: u64,
    pub signer: BytesN<32>,
    pub signature: BytesN<64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AggregatedOraclePrice {
    pub base: Symbol,
    pub quote: Symbol,
    pub price: i128,
    pub timestamp: u64,
    pub valid_signatures: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolObservation {
    pub price: i128,
    pub liquidity: i128,
    pub timestamp: u64,
}

/// Storage keys for the oracle.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Pair(Address, Address),
    Staleness(Address, Address),
    CircuitBreakerTripped,
    MaxSingleUpdateDeviationBps,
    CumulativeLogs(Address, Address),
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
    CircuitBreakerTripped = 12,
    InvalidConfig = 13,
    OracleUnavailable = 14,
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

fn read_cumulative_logs(
    env: &Env,
    base: &Address,
    quote: &Address,
    observations: &Vec<Observation>,
) -> Result<Vec<LogObservation>, Error> {
    let key = DataKey::CumulativeLogs(base.clone(), quote.clone());
    let stored: Option<Vec<LogObservation>> = env.storage().instance().get(&key);
    if let Some(logs) = stored {
        if logs.len() == observations.len() {
            return Ok(logs);
        }
    }

    let mut logs = Vec::new(env);
    let mut cumulative = 0i128;
    let mut index = 0u32;
    while index < observations.len() {
        let observation = observations.get(index).unwrap();
        if index > 0 {
            let previous = observations.get(index - 1).unwrap();
            let elapsed = i128::from(
                observation
                    .timestamp
                    .checked_sub(previous.timestamp)
                    .ok_or(Error::TimestampNotMonotonic)?,
            );
            cumulative = cumulative
                .checked_add(
                    log2_q64(previous.price)?
                        .checked_mul(elapsed)
                        .ok_or(Error::PriceOverflow)?,
                )
                .ok_or(Error::PriceOverflow)?;
        }
        logs.push_back(LogObservation {
            timestamp: observation.timestamp,
            cumulative_log_price: cumulative,
        });
        index += 1;
    }
    Ok(logs)
}

fn log2_q64(value: i128) -> Result<i128, Error> {
    if value <= 0 {
        return Err(Error::InvalidPrice);
    }
    let value = u128::try_from(value).map_err(|_| Error::InvalidPrice)?;
    let highest_bit = value.ilog2();
    let integer = i128::from(highest_bit);
    let mut normalized = if highest_bit >= 63 {
        value >> (highest_bit - 63)
    } else {
        value << (63 - highest_bit)
    };
    let mut fraction = 0u128;
    let mut bit = 0u32;
    while bit < 32 {
        normalized = normalized
            .checked_mul(normalized)
            .ok_or(Error::PriceOverflow)?
            >> 63;
        if normalized >= (1u128 << 64) {
            normalized >>= 1;
            fraction |= 1u128 << (63 - bit);
        }
        bit += 1;
    }
    let fractional = i128::try_from(fraction).map_err(|_| Error::PriceOverflow)?;
    integer
        .checked_mul(Q64)
        .and_then(|whole| whole.checked_add(fractional))
        .ok_or(Error::PriceOverflow)
}

#[allow(dead_code)]
fn exp2_q64(value: i128) -> Result<i128, Error> {
    const ROOTS_Q63: [u128; 32] = [
        13043817825332782212,
        10968499650544839023,
        10058158527438640871,
        9631725603661576981,
        9425337585438007767,
        9323807973325342579,
        9273454034941487980,
        9248379135337035441,
        9235867122425417553,
        9229617465154500136,
        9226494222562136017,
        9224932997620185949,
        9224152484218207415,
        9223762252282022473,
        9223567142504825508,
        9223469589163912706,
        9223420812880372951,
        9223396424835331638,
        9223384230836993049,
        9223378133843869261,
        9223375085348818743,
        9223373561101671328,
        9223372798978192081,
        9223372417916476073,
        9223372227385623972,
        9223372132120199398,
        9223372084487487480,
        9223372060671131613,
        9223372048762953703,
        9223372042808864754,
        9223372039831820280,
        9223372038343298044,
    ];
    if value < 0 {
        return Err(Error::InvalidPrice);
    }
    let whole = value / Q64;
    if whole > 126 {
        return Err(Error::PriceOverflow);
    }
    let fractional = u128::try_from(value % Q64).map_err(|_| Error::PriceOverflow)? >> 1;
    let mut result = Q63;
    let mut bit = 0u32;
    while bit < 32 {
        if (fractional & (1u128 << (62 - bit))) != 0 {
            result = result
                .checked_mul(ROOTS_Q63[bit as usize])
                .ok_or(Error::PriceOverflow)?
                >> 63;
        }
        bit += 1;
    }
    let integer_scaled = match whole.cmp(&63) {
        Ordering::Less => {
            let whole_bits = u32::try_from(whole).map_err(|_| Error::PriceOverflow)?;
            let shift = 63 - whole_bits;
            let truncated = result >> shift;
            let remainder = result & ((1u128 << shift) - 1);
            if remainder >= (1u128 << (shift - 1)) {
                truncated + 1
            } else {
                truncated
            }
        }
        Ordering::Equal => result,
        Ordering::Greater => result
            .checked_shl(u32::try_from(whole - 63).map_err(|_| Error::PriceOverflow)?)
            .ok_or(Error::PriceOverflow)?,
    };
    i128::try_from(integer_scaled).map_err(|_| Error::PriceOverflow)
}

#[allow(unused_mut)]
#[allow(dead_code)]
fn median(mut prices: Vec<i128>) -> Result<i128, Error> {
    if prices.is_empty() {
        return Err(Error::OracleUnavailable);
    }
    let mut i = 1u32;
    while i < prices.len() {
        let value = prices.get(i).unwrap();
        let mut j = i;
        while j > 0 && prices.get(j - 1).unwrap() > value {
            prices.set(j, prices.get(j - 1).unwrap());
            j -= 1;
        }
        prices.set(j, value);
        i += 1;
    }
    let mid = prices.len() / 2;
    if prices.len() % 2 == 1 {
        Ok(prices.get(mid).unwrap())
    } else {
        let lower = prices.get(mid - 1).unwrap();
        let upper = prices.get(mid).unwrap();
        Ok(i128::midpoint(lower, upper))
    }
}

#[allow(dead_code)]
fn oracle_price_digest(
    env: &Env,
    base: &Symbol,
    quote: &Symbol,
    price: i128,
    timestamp: u64,
    signer: &BytesN<32>,
) -> BytesN<32> {
    let encoded = (
        env.current_contract_address(),
        base.clone(),
        quote.clone(),
        price,
        timestamp,
        signer.clone(),
    )
        .to_xdr(env);
    env.crypto().sha256(&encoded)
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

        env.storage()
            .instance()
            .set(&DataKey::Staleness(base, quote), &max_staleness_seconds);

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

        if Self::is_circuit_breaker_tripped(env.clone()) {
            return Err(Error::CircuitBreakerTripped);
        }

        if price <= 0 || price > MAX_PRICE {
            return Err(Error::InvalidPrice);
        }
        if timestamp > env.ledger().timestamp() {
            return Err(Error::TimestampInFuture);
        }

        let mut observations = read_observations(&env, &base, &quote);
        let mut log_observations = read_cumulative_logs(&env, &base, &quote, &observations)?;

        let mut cumulative_price = u256::ZERO;
        let mut cumulative_log_price = 0;
        if !observations.is_empty() {
            let previous = observations.get(observations.len() - 1).unwrap();

            if timestamp <= previous.timestamp {
                return Err(Error::TimestampNotMonotonic);
            }
            if timestamp - previous.timestamp < MIN_INTERVAL_SECONDS {
                return Err(Error::ObservationTooSoon);
            }

            // Circuit breaker: reject single-block price deviations exceeding the
            // configured maximum, then freeze the oracle pair.
            let max_deviation_bps = Self::max_single_update_dev_bps(env.clone());
            let deviation_bps = (price - previous.price)
                .abs()
                .checked_mul(BPS_DIVISOR)
                .ok_or(Error::PriceOverflow)?
                / previous.price;

            if deviation_bps > i128::from(max_deviation_bps) {
                env.storage()
                    .instance()
                    .set(&DataKey::CircuitBreakerTripped, &true);

                env.events().publish(
                    (
                        soroban_sdk::symbol_short!("breaker"),
                        soroban_sdk::symbol_short!("tripped"),
                    ),
                    (previous.price, price, deviation_bps),
                );

                return Ok(observations.len());
            }

            let elapsed = u256::from(timestamp - previous.timestamp);
            let increment = u256::from(previous.price.cast_unsigned()).wrapping_mul(elapsed);
            cumulative_price = previous.cumulative_price.wrapping_add(increment);

            let previous_log = log_observations.get(log_observations.len() - 1).unwrap();
            let log_increment = log2_q64(previous.price)?
                .checked_mul(i128::from(timestamp - previous.timestamp))
                .ok_or(Error::PriceOverflow)?;
            cumulative_log_price = previous_log
                .cumulative_log_price
                .checked_add(log_increment)
                .ok_or(Error::PriceOverflow)?;
        }

        observations.push_back(Observation {
            timestamp,
            price,
            cumulative_price,
        });
        log_observations.push_back(LogObservation {
            timestamp,
            cumulative_log_price,
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

            let mut pruned_logs = Vec::new(&env);
            index = 1;
            while index < log_observations.len() {
                pruned_logs.push_back(log_observations.get(index).unwrap());
                index += 1;
            }
            log_observations = pruned_logs;
        }

        let count = observations.len();
        env.storage()
            .instance()
            .set(&DataKey::Pair(base.clone(), quote.clone()), &observations);
        env.storage()
            .instance()
            .set(&DataKey::CumulativeLogs(base, quote), &log_observations);

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
    pub fn twap(
        env: Env,
        base: Address,
        quote: Address,
        window_seconds: u64,
    ) -> Result<i128, Error> {
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
            let elapsed = u256::from(target - base_obs.timestamp);
            let increment = u256::from(base_obs.price.cast_unsigned()).wrapping_mul(elapsed);
            base_obs.cumulative_price.wrapping_add(increment)
        };

        // Modular arithmetic (uint256 wrapping difference) remains exact across overflows.
        let accumulated = latest.cumulative_price.wrapping_sub(cumulative_at_target);

        let avg = accumulated / u256::from(window_seconds);
        i128::try_from(avg).map_err(|_| Error::PriceOverflow)
    }

    pub fn is_circuit_breaker_tripped(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::CircuitBreakerTripped)
            .unwrap_or(false)
    }

    pub fn is_circuit_breaker_active(env: Env, _base: Address, _quote: Address) -> bool {
        Self::is_circuit_breaker_tripped(env)
    }

    pub fn trip_circuit_breaker(env: Env) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::CircuitBreakerTripped, &true);
        Ok(())
    }

    pub fn reset_circuit_breaker(env: Env) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::CircuitBreakerTripped, &false);
        Ok(())
    }

    /// Configures the maximum allowed single-update price deviation in basis
    /// points (e.g. 1000 bps = 10%). If a new observation differs from the last
    /// observation by more than this deviation, the circuit breaker is tripped
    /// and the pair is frozen.
    ///
    /// Requires authorization from the configured admin.
    pub fn set_max_single_update_dev_bps(env: Env, max_deviation_bps: u32) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();

        if max_deviation_bps > 10_000 {
            return Err(Error::InvalidConfig);
        }

        env.storage()
            .instance()
            .set(&DataKey::MaxSingleUpdateDeviationBps, &max_deviation_bps);

        Ok(())
    }

    /// Returns the maximum single-update deviation threshold in basis points
    /// (defaults to 1000 bps = 10%).
    pub fn max_single_update_dev_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MaxSingleUpdateDeviationBps)
            .unwrap_or(DEFAULT_MAX_SINGLE_UPDATE_DEVIATION_BPS)
    }

    /// Consult the TWAP price for a token pair over `window_seconds`, enforcing
    /// a heartbeat freshness check rejecting prices older than `max_staleness_seconds`.
    ///
    /// # Panics
    ///
    /// Panics if the internal observations vector fails to retrieve its non-empty latest element.
    pub fn consult(
        env: Env,
        base: Address,
        quote: Address,
        window_seconds: u64,
    ) -> Result<i128, Error> {
        if Self::is_circuit_breaker_tripped(env.clone()) {
            return Err(Error::CircuitBreakerTripped);
        }

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
