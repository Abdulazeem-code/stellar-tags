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

use core::cmp::Ordering;
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address,
    Bytes, BytesN, Env, Symbol, Vec,
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
const Q64: i128 = 1i128 << 64;
const Q63: u128 = 1u128 << 63;
const OUTLIER_BPS: i128 = 1_500;

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
    Observations,
    SecondaryOracle,
    MaxDivergenceBps,
    StalenessThreshold,
    Weights,
    CircuitBreakerTripped,
    OracleSigners,
    OracleThreshold,
    SignedOraclePrice(Symbol, Symbol),
    PoolAddresses(Symbol, Symbol),
    PoolObservation(Symbol, Symbol, Address),
    PrimaryPool(Symbol, Symbol),
    VolatilePool(Symbol, Symbol, Address),
    CumulativeLogs,
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
    InvalidSigner = 16,
    InsufficientSignatures = 17,
    InvalidPair = 18,
    StalePrice = 19,
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

fn read_cumulative_logs(
    env: &Env,
    observations: &Vec<Observation>,
) -> Result<Vec<LogObservation>, Error> {
    let stored: Option<Vec<LogObservation>> =
        env.storage().instance().get(&DataKey::CumulativeLogs);
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
        env.storage()
            .instance()
            .set(&DataKey::Observations, &Vec::<Observation>::new(&env));
        env.storage()
            .instance()
            .set(&DataKey::CumulativeLogs, &Vec::<LogObservation>::new(&env));

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
        let mut log_observations = read_cumulative_logs(&env, &observations)?;
        let mut cumulative_log_price = 0i128;
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

            cumulative_log_price = log_observations
                .get(log_observations.len() - 1)
                .unwrap()
                .cumulative_log_price
                .checked_add(
                    log2_q64(previous.price)?
                        .checked_mul(elapsed)
                        .ok_or(Error::PriceOverflow)?,
                )
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
            .set(&DataKey::Observations, &observations);
        env.storage()
            .instance()
            .set(&DataKey::CumulativeLogs, &log_observations);

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

    /// Geometric mean TWAP over the window ending at the newest observation.
    /// Logarithms are accumulated in signed Q64.64 fixed-point form; no
    /// floating-point arithmetic is used.
    ///
    /// # Panics
    ///
    /// Panics if stored observation or accumulator data cannot be read.
    pub fn geometric_twap(env: Env, window_seconds: u64) -> Result<i128, Error> {
        if window_seconds == 0 || window_seconds > MAX_WINDOW_SECONDS {
            return Err(Error::InvalidWindow);
        }

        let observations = read_observations(&env);
        let length = observations.len();
        if length == 0 {
            return Err(Error::NoObservations);
        }
        let log_observations = read_cumulative_logs(&env, &observations)?;
        let latest = observations.get(length - 1).unwrap();
        let latest_log = log_observations.get(length - 1).unwrap();
        let target = latest
            .timestamp
            .checked_sub(window_seconds)
            .ok_or(Error::InsufficientHistory)?;
        let first = observations.get(0).unwrap();
        if target < first.timestamp {
            return Err(Error::InsufficientHistory);
        }

        let mut base_index = 0u32;
        let mut index = 0u32;
        while index < length {
            if observations.get(index).unwrap().timestamp > target {
                break;
            }
            base_index = index;
            index += 1;
        }
        let base = observations.get(base_index).unwrap();
        let base_log = log_observations.get(base_index).unwrap();
        let cumulative_at_target = if base.timestamp == target {
            base_log.cumulative_log_price
        } else {
            let elapsed = i128::from(target - base.timestamp);
            base_log
                .cumulative_log_price
                .checked_add(
                    log2_q64(base.price)?
                        .checked_mul(elapsed)
                        .ok_or(Error::PriceOverflow)?,
                )
                .ok_or(Error::PriceOverflow)?
        };
        let accumulated = latest_log
            .cumulative_log_price
            .checked_sub(cumulative_at_target)
            .ok_or(Error::PriceOverflow)?;
        exp2_q64(accumulated / i128::from(window_seconds))
    }

    /// Returns the domain-separated digest oracle signers must sign for a
    /// price submission.
    pub fn oracle_price_digest(
        env: Env,
        base: Symbol,
        quote: Symbol,
        price: i128,
        timestamp: u64,
        signer: BytesN<32>,
    ) -> BytesN<32> {
        oracle_price_digest(&env, &base, &quote, price, timestamp, &signer)
    }

    /// Configures the trusted Ed25519 oracle keys and the strict-majority
    /// signature threshold used by `push_oracle_prices`.
    ///
    /// # Panics
    ///
    /// Panics if the admin does not authorize this call.
    #[allow(unused_mut)]
    pub fn set_oracle_signers(
        env: Env,
        mut signers: Vec<BytesN<32>>,
        threshold: u32,
    ) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();
        if signers.is_empty() || threshold == 0 || threshold > signers.len() {
            return Err(Error::InvalidConfig);
        }
        if threshold <= signers.len() / 2 {
            return Err(Error::InvalidConfig);
        }
        let mut i = 0u32;
        while i < signers.len() {
            let mut j = i + 1;
            while j < signers.len() {
                if signers.get(i) == signers.get(j) {
                    return Err(Error::InvalidConfig);
                }
                j += 1;
            }
            i += 1;
        }
        i = 1;
        while i < signers.len() {
            let value = signers.get(i).unwrap();
            let mut j = i;
            while j > 0 && signers.get(j - 1).unwrap().to_array() > value.to_array() {
                signers.set(j, signers.get(j - 1).unwrap());
                j -= 1;
            }
            signers.set(j, value);
            i += 1;
        }
        env.storage()
            .instance()
            .set(&DataKey::OracleSigners, &signers);
        env.storage()
            .instance()
            .set(&DataKey::OracleThreshold, &threshold);
        Ok(())
    }

    /// Returns the trusted oracle public keys and their signature threshold.
    pub fn oracle_signers(env: Env) -> (Vec<BytesN<32>>, u32) {
        let signers: Vec<BytesN<32>> = env
            .storage()
            .instance()
            .get(&DataKey::OracleSigners)
            .unwrap_or_else(|| Vec::new(&env));
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::OracleThreshold)
            .unwrap_or(0);
        (signers, threshold)
    }

    /// Verifies a batch of signed prices, requires the configured M-of-N
    /// quorum for one pair and timestamp, and stores the median.
    ///
    /// # Panics
    ///
    /// Panics if any supplied signature fails Ed25519 verification or storage
    /// access fails.
    pub fn push_oracle_prices(
        env: Env,
        submissions: Vec<SignedPricePayload>,
    ) -> Result<AggregatedOraclePrice, Error> {
        let (trusted_signers, threshold) = Self::oracle_signers(env.clone());
        if trusted_signers.is_empty() || threshold == 0 {
            return Err(Error::InvalidConfig);
        }
        if submissions.is_empty() {
            return Err(Error::InsufficientSignatures);
        }
        let first = submissions.get(0).unwrap();
        if first.base == first.quote {
            return Err(Error::InvalidPair);
        }
        if first.price <= 0 || first.price > MAX_PRICE {
            return Err(Error::InvalidPrice);
        }
        let current_time = env.ledger().timestamp();
        if first.timestamp > current_time {
            return Err(Error::TimestampInFuture);
        }
        if current_time.saturating_sub(first.timestamp) > Self::staleness_threshold(env.clone()) {
            return Err(Error::StalePrice);
        }

        let mut prices = Vec::new(&env);
        let mut seen = Vec::new(&env);
        let mut i = 0u32;
        while i < submissions.len() {
            let submission = submissions.get(i).unwrap();
            if submission.base != first.base
                || submission.quote != first.quote
                || submission.timestamp != first.timestamp
            {
                return Err(Error::InvalidPair);
            }
            if submission.price <= 0 || submission.price > MAX_PRICE {
                return Err(Error::InvalidPrice);
            }
            if !trusted_signers.contains(&submission.signer) || seen.contains(&submission.signer) {
                return Err(Error::InvalidSigner);
            }
            let digest = oracle_price_digest(
                &env,
                &submission.base,
                &submission.quote,
                submission.price,
                submission.timestamp,
                &submission.signer,
            );
            let message = Bytes::from(digest);
            env.crypto()
                .ed25519_verify(&submission.signer, &message, &submission.signature);
            seen.push_back(submission.signer);
            prices.push_back(submission.price);
            i += 1;
        }
        if prices.len() < threshold {
            return Err(Error::InsufficientSignatures);
        }

        let aggregate = AggregatedOraclePrice {
            base: first.base,
            quote: first.quote,
            price: median(prices)?,
            timestamp: first.timestamp,
            valid_signatures: seen.len(),
        };
        let key = DataKey::SignedOraclePrice(aggregate.base.clone(), aggregate.quote.clone());
        if let Some(previous) = env
            .storage()
            .persistent()
            .get::<_, AggregatedOraclePrice>(&key)
        {
            if aggregate.timestamp <= previous.timestamp {
                return Err(Error::TimestampNotMonotonic);
            }
        }
        env.storage().persistent().set(&key, &aggregate);
        env.events().publish(
            (
                Symbol::new(&env, "oracle_price"),
                aggregate.base.clone(),
                aggregate.quote.clone(),
            ),
            (
                aggregate.price,
                aggregate.timestamp,
                aggregate.valid_signatures,
            ),
        );
        Ok(aggregate)
    }

    /// Reads the last M-of-N aggregated signed price for a pair.
    pub fn signed_oracle_price(
        env: Env,
        base: Symbol,
        quote: Symbol,
    ) -> Option<AggregatedOraclePrice> {
        env.storage()
            .persistent()
            .get(&DataKey::SignedOraclePrice(base, quote))
    }

    /// Selects the primary pool for a pair. A primary pool update rejected as
    /// an outlier is excluded from consensus until a non-outlier update lands.
    pub fn set_primary_pool(
        env: Env,
        base: Symbol,
        quote: Symbol,
        pool: Address,
    ) -> Result<(), Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();
        if base == quote {
            return Err(Error::InvalidPair);
        }
        env.storage()
            .persistent()
            .set(&DataKey::PrimaryPool(base, quote), &pool);
        Ok(())
    }

    /// Adds a DEX pool observation. Prices more than 15% from the current
    /// cross-pool median are rejected with an anomaly event and are not stored.
    ///
    /// # Panics
    ///
    /// Panics if the admin does not authorize this call or storage access fails.
    #[allow(unused_mut)]
    pub fn observe_pool(
        env: Env,
        base: Symbol,
        quote: Symbol,
        pool: Address,
        price: i128,
        liquidity: i128,
        timestamp: u64,
    ) -> Result<bool, Error> {
        let admin = read_admin(&env)?;
        admin.require_auth();
        if base == quote {
            return Err(Error::InvalidPair);
        }
        if price <= 0 || price > MAX_PRICE {
            return Err(Error::InvalidPrice);
        }
        if liquidity <= 0 || liquidity > i128::MAX / MAX_PRICE {
            return Err(Error::InvalidConfig);
        }
        if timestamp > env.ledger().timestamp() {
            return Err(Error::TimestampInFuture);
        }
        let key = DataKey::PoolObservation(base.clone(), quote.clone(), pool.clone());
        if let Some(previous) = env.storage().persistent().get::<_, PoolObservation>(&key) {
            if timestamp <= previous.timestamp {
                return Err(Error::TimestampNotMonotonic);
            }
        }

        let pool_key = DataKey::PoolAddresses(base.clone(), quote.clone());
        let pools: Vec<Address> = env
            .storage()
            .persistent()
            .get(&pool_key)
            .unwrap_or_else(|| Vec::new(&env));
        let mut existing_prices = Vec::new(&env);
        let now = env.ledger().timestamp();
        let mut index = 0u32;
        while index < pools.len() {
            let existing_pool = pools.get(index).unwrap();
            let volatile: bool = env
                .storage()
                .persistent()
                .get(&DataKey::VolatilePool(
                    base.clone(),
                    quote.clone(),
                    existing_pool.clone(),
                ))
                .unwrap_or(false);
            if let Some(observation) =
                env.storage()
                    .persistent()
                    .get::<_, PoolObservation>(&DataKey::PoolObservation(
                        base.clone(),
                        quote.clone(),
                        existing_pool,
                    ))
            {
                if !volatile
                    && now.saturating_sub(observation.timestamp)
                        <= Self::staleness_threshold(env.clone())
                {
                    existing_prices.push_back(observation.price);
                }
            }
            index += 1;
        }
        if !existing_prices.is_empty() {
            let center = median(existing_prices)?;
            let deviation = if price >= center {
                price - center
            } else {
                center - price
            };
            let scaled_deviation = deviation
                .checked_mul(BPS_DIVISOR)
                .ok_or(Error::PriceOverflow)?;
            let allowed_deviation = center
                .checked_mul(OUTLIER_BPS)
                .ok_or(Error::PriceOverflow)?;
            if scaled_deviation > allowed_deviation {
                env.storage().persistent().set(
                    &DataKey::VolatilePool(base.clone(), quote.clone(), pool.clone()),
                    &true,
                );
                env.events().publish(
                    (Symbol::new(&env, "oracle_anomaly_detected"), base, quote),
                    (pool, price, center, timestamp),
                );
                return Ok(false);
            }
        }

        env.storage().persistent().set(
            &key,
            &PoolObservation {
                price,
                liquidity,
                timestamp,
            },
        );
        let mut pools = pools;
        if !pools.contains(&pool) {
            pools.push_back(pool.clone());
            env.storage().persistent().set(&pool_key, &pools);
        }
        env.storage()
            .persistent()
            .set(&DataKey::VolatilePool(base, quote, pool), &false);
        Ok(true)
    }

    /// Liquidity-weighted trimmed mean of fresh pool prices after excluding
    /// observations more than 15% from the median.
    ///
    /// # Panics
    ///
    /// Panics if pool observation storage cannot be read.
    pub fn pool_consensus_price(env: Env, base: Symbol, quote: Symbol) -> Result<i128, Error> {
        let pools: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::PoolAddresses(base.clone(), quote.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        let now = env.ledger().timestamp();
        let mut observations = Vec::new(&env);
        let mut prices = Vec::new(&env);
        let mut i = 0u32;
        while i < pools.len() {
            let pool = pools.get(i).unwrap();
            let volatile: bool = env
                .storage()
                .persistent()
                .get(&DataKey::VolatilePool(
                    base.clone(),
                    quote.clone(),
                    pool.clone(),
                ))
                .unwrap_or(false);
            if !volatile {
                if let Some(observation) =
                    env.storage()
                        .persistent()
                        .get::<_, PoolObservation>(&DataKey::PoolObservation(
                            base.clone(),
                            quote.clone(),
                            pool,
                        ))
                {
                    if now.saturating_sub(observation.timestamp)
                        <= Self::staleness_threshold(env.clone())
                    {
                        prices.push_back(observation.price);
                        observations.push_back(observation);
                    }
                }
            }
            i += 1;
        }
        let center = median(prices)?;
        let mut weighted_price = 0i128;
        let mut total_liquidity = 0i128;
        i = 0;
        while i < observations.len() {
            let observation = observations.get(i).unwrap();
            let deviation = if observation.price >= center {
                observation.price - center
            } else {
                center - observation.price
            };
            if deviation
                .checked_mul(BPS_DIVISOR)
                .ok_or(Error::PriceOverflow)?
                <= center
                    .checked_mul(OUTLIER_BPS)
                    .ok_or(Error::PriceOverflow)?
            {
                weighted_price = weighted_price
                    .checked_add(
                        observation
                            .price
                            .checked_mul(observation.liquidity)
                            .ok_or(Error::PriceOverflow)?,
                    )
                    .ok_or(Error::PriceOverflow)?;
                total_liquidity = total_liquidity
                    .checked_add(observation.liquidity)
                    .ok_or(Error::PriceOverflow)?;
            }
            i += 1;
        }
        if total_liquidity == 0 {
            return Err(Error::OracleUnavailable);
        }
        Ok(weighted_price / total_liquidity)
    }

    /// Median price from secondary pools, excluding the configured primary.
    ///
    /// # Panics
    ///
    /// Panics if pool observation storage cannot be read.
    pub fn secondary_pool_median(env: Env, base: Symbol, quote: Symbol) -> Result<i128, Error> {
        let pools: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::PoolAddresses(base.clone(), quote.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        let primary: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::PrimaryPool(base.clone(), quote.clone()));
        let now = env.ledger().timestamp();
        let mut prices = Vec::new(&env);
        let mut i = 0u32;
        while i < pools.len() {
            let pool = pools.get(i).unwrap();
            let volatile: bool = env
                .storage()
                .persistent()
                .get(&DataKey::VolatilePool(
                    base.clone(),
                    quote.clone(),
                    pool.clone(),
                ))
                .unwrap_or(false);
            if primary.as_ref() != Some(&pool) && !volatile {
                if let Some(observation) =
                    env.storage()
                        .persistent()
                        .get::<_, PoolObservation>(&DataKey::PoolObservation(
                            base.clone(),
                            quote.clone(),
                            pool,
                        ))
                {
                    if now.saturating_sub(observation.timestamp)
                        <= Self::staleness_threshold(env.clone())
                    {
                        prices.push_back(observation.price);
                    }
                }
            }
            i += 1;
        }
        median(prices)
    }

    /// Uses secondary-pool median whenever the designated primary is flagged
    /// volatile; otherwise returns the liquidity-weighted trimmed pool price.
    pub fn consult_pair(env: Env, base: Symbol, quote: Symbol) -> Result<i128, Error> {
        let primary: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::PrimaryPool(base.clone(), quote.clone()));
        if let Some(pool) = primary {
            let volatile: bool = env
                .storage()
                .persistent()
                .get(&DataKey::VolatilePool(base.clone(), quote.clone(), pool))
                .unwrap_or(false);
            if volatile {
                return Self::secondary_pool_median(env, base, quote);
            }
        }
        Self::pool_consensus_price(env, base, quote)
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

        env.events()
            .publish((symbol_short!("breaker"), symbol_short!("reset")), ());

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
    ///   - If divergence exceeds the threshold, rejects the consultation with
    ///     [`Error::CircuitBreakerTripped`]. Because the caller's invocation is
    ///     rolled back, the breaker itself has to be tripped separately with
    ///     [`Self::trip_circuit_breaker`] to freeze pricing until an admin
    ///     resets it.
    ///   - If within threshold, returns the weighted consensus average.
    /// - If primary is stale and secondary is fresh, falls back to secondary with a warning event emission.
    /// - If primary is fresh and secondary is stale or absent, returns the primary price.
    /// - If both feeds are stale, returns [`Error::PrimaryStale`].
    ///
    /// # Panics
    ///
    /// Panics if stored observations are inconsistent or storage access fails.
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

        if let Some(latest) = observations.last() {
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
            let divergence_bps =
                diff.checked_mul(BPS_DIVISOR).ok_or(Error::PriceOverflow)? / primary_price;

            if divergence_bps > i128::from(max_bps) {
                // Soroban rolls an invocation back in full as soon as an
                // entrypoint returns an error, so a trip recorded here (and its
                // event) could never outlive this failing call.  The
                // disagreement is enforced by rejecting the consultation;
                // freezing pricing until an admin resets it is the job of
                // `trip_circuit_breaker`, which runs as its own successful
                // transaction.
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
            let avg = p_part.checked_add(s_part).ok_or(Error::PriceOverflow)? / total_w;

            env.events()
                .publish((symbol_short!("oracle"), symbol_short!("consensus")), avg);

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
