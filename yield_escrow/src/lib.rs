#![no_std]
#![allow(
    clippy::cast_possible_truncation,
    clippy::missing_panics_doc,
    clippy::cast_lossless
)]

//! Yield-bearing escrow.
//!
//! A variant of the classic escrow that does not leave locked funds idle: the
//! principal is supplied to a Soroban lending protocol through the same
//! `LendingProtocol` adapter shape the payment router already uses for treasury
//! yield (a Blend-compatible deployment satisfies it), the position is tracked
//! per escrow, and on settlement the interest accrued while the funds were
//! locked is split between the beneficiary and the payer according to a
//! per-escrow basis-point share.
//!
//! Adapters also expose a live annual yield rate in basis points. The escrow
//! checkpoints that rate against ledger timestamps in a cumulative per-token
//! index, so changes in protocol revenue or utilization apply prospectively.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token,
    Address, Env, Vec,
};

// ── Constants ────────────────────────────────────────────────────────────────

/// Ledgers per day, assuming the ~5s close time of the Stellar public network.
const DAY_IN_LEDGERS: u32 = 17_280;
/// Target lifetime for the contract instance (admin, adapter, counters).
const INSTANCE_BUMP: u32 = 7 * DAY_IN_LEDGERS;
/// Bump the instance once it falls below this many ledgers.
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP - DAY_IN_LEDGERS;
/// Target lifetime for an individual escrow record. Long enough for a
/// multi-week lock without the record expiring mid-escrow.
const ESCROW_BUMP: u32 = 30 * DAY_IN_LEDGERS;
/// Bump an escrow record once it falls below this many ledgers.
const ESCROW_THRESHOLD: u32 = ESCROW_BUMP - DAY_IN_LEDGERS;
/// 100% expressed in basis points.
const BPS_DENOMINATOR: i128 = 10_000;
/// Fixed-point precision for the cumulative per-token yield index.
const INDEX_SCALE: i128 = 1_000_000_000_000;
const SECONDS_PER_YEAR: i128 = 31_536_000;
/// Value reported by `version()`.
const VERSION: u32 = 1;

// ── Storage ──────────────────────────────────────────────────────────────────

/// Storage keys used by the escrow contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Set once by `initialize`; guards against re-initialisation.
    Initialized,
    /// Address allowed to replace the yield adapter.
    Admin,
    /// Lending protocol new positions are supplied to.
    Adapter,
    /// Configured multi-strategy portfolio allocations.
    Strategies,
    /// Minimum deviation in bps before automated rebalance is indicated.
    RebalanceThreshold,
    /// Ledger sequence of the last rebalance operation for a token.
    LastRebalance(Address),
    /// Number of escrows that are still locked (not released or cancelled).
    ActiveEscrows,
    /// A single escrow position, keyed by the caller-supplied id.
    Escrow(u64),
    /// Cumulative time-weighted yield index and active principal for a token.
    YieldState(Address),
}

/// Strategy allocation entry defining a verified lending protocol and target weight in bps.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrategyAllocation {
    pub address: Address,
    pub weight_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct YieldState {
    pub index: i128,
    pub updated_at: u64,
    pub rate_bps: u32,
    pub total_principal: i128,
}

/// A single locked escrow position.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    /// Account that funded the position and can cancel it before the deadline.
    pub payer: Address,
    /// Account that receives the principal once the deadline has passed.
    pub beneficiary: Address,
    /// Token supplied to the yield adapter on creation.
    pub token: Address,
    /// Amount of `token` supplied, in the token's smallest unit.
    pub principal: i128,
    /// Ledger sequence at or after which `release` is allowed.
    pub release_ledger: u32,
    /// Share of the accrued interest, in basis points, paid to `beneficiary`.
    /// The remainder goes to `payer`. At most 10_000 (100%).
    pub beneficiary_interest_bps: u32,
    /// Cumulative yield index at which this position began accruing.
    pub reward_debt: i128,
    /// True once the position has been settled in favour of the beneficiary.
    pub released: bool,
    /// True once the position has been refunded to the payer.
    pub cancelled: bool,
}

impl Escrow {
    /// True while the position is still locked and has not been settled.
    pub fn is_active(&self) -> bool {
        !self.released && !self.cancelled
    }
}

/// Amounts moved when an escrow is settled.
///
/// `to_beneficiary + to_payer` always equals `principal + interest`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseOutcome {
    /// Principal returned by the lending protocol.
    pub principal: i128,
    /// Interest harvested from the lending protocol. Never negative.
    pub interest: i128,
    /// Amount transferred to the beneficiary.
    pub to_beneficiary: i128,
    /// Amount transferred to the payer.
    pub to_payer: i128,
}

// ── Errors ───────────────────────────────────────────────────────────────────

/// Errors returned by the escrow contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `initialize` was called on an already configured contract.
    AlreadyInitialized = 1,
    /// The contract has not been initialized yet.
    NotInitialized = 2,
    /// `amount` was not strictly positive.
    InvalidAmount = 3,
    /// `release_ledger` is not in the future.
    InvalidReleaseLedger = 4,
    /// `beneficiary_interest_bps` exceeds 10_000.
    InvalidInterestSplit = 5,
    /// An escrow with the supplied id already exists.
    EscrowExists = 6,
    /// No escrow exists for the supplied id.
    EscrowNotFound = 7,
    /// The escrow was already released or cancelled.
    EscrowNotActive = 8,
    /// The release deadline has not been reached yet.
    NotYetReleasable = 9,
    /// The escrow is past its deadline and can no longer be cancelled.
    StillLocked = 10,
    /// The adapter may not be replaced while escrows are still open.
    ActiveEscrowsRemain = 11,
    /// The adapter reported a negative interest amount.
    InvalidInterest = 12,
    /// An arithmetic operation overflowed.
    MathOverflow = 13,
    InvalidYieldRate = 14,
    InsufficientAccruedYield = 15,
    TimestampRegression = 16,
    InvalidStrategyCount = 17,
    InvalidWeights = 18,
    DuplicateStrategy = 19,
    StrategyNotFound = 20,
    MaxStrategiesExceeded = 21,
    InvalidThreshold = 22,
}

// ── Lending protocol adapter ─────────────────────────────────────────────────

/// Interface implemented by the supported Soroban lending protocols.
///
/// This is the same adapter shape the payment router uses for treasury yield
/// (`payment_router::LendingProtocol`), so a Blend-compatible deployment that
/// already serves the router can serve the escrow too; tests use an in-process
/// mock, mirroring the router's test suite.
#[contractclient(name = "LendingProtocolClient")]
pub trait LendingProtocol {
    fn deposit(env: Env, from: Address, token: Address, amount: i128);
    fn withdraw(env: Env, to: Address, token: Address, amount: i128);
    fn harvest(env: Env, to: Address, token: Address) -> i128;
    /// Dynamic annualized rate derived by the adapter from protocol revenue
    /// and utilization, expressed in basis points.
    fn yield_rate_bps(env: Env, token: Address) -> u32;
    /// Current pool balance (principal plus accrued interest).
    fn get_balance(env: Env, token: Address) -> i128;
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct YieldEscrow;

#[contractimpl]
impl YieldEscrow {
    // ── Admin ────────────────────────────────────────────────────────────

    /// Configures the escrow contract.
    ///
    /// `admin` may replace the yield adapter; `adapter` is the lending protocol
    /// that new positions are supplied to.
    ///
    /// # Errors
    /// Returns `Error::AlreadyInitialized` when called more than once.
    pub fn initialize(env: Env, admin: Address, adapter: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Adapter, &adapter);
        let mut strats = Vec::new(&env);
        strats.push_back(StrategyAllocation {
            address: adapter.clone(),
            weight_bps: BPS_DENOMINATOR as u32,
        });
        env.storage().instance().set(&DataKey::Strategies, &strats);
        env.storage()
            .instance()
            .set(&DataKey::ActiveEscrows, &0_u32);
        Self::bump_instance(&env);

        env.events()
            .publish((symbol_short!("init"), admin), adapter);
        Ok(())
    }

    /// Replaces the yield adapter. Admin only.
    ///
    /// Only callable while no escrow is locked, so that an open position can
    /// never be stranded in an adapter the contract is no longer wired to.
    ///
    /// # Errors
    /// Returns `Error::NotInitialized` before initialization and
    /// `Error::ActiveEscrowsRemain` while any escrow is still active.
    pub fn set_adapter(env: Env, adapter: Address) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        if Self::active_escrows(&env) != 0 {
            return Err(Error::ActiveEscrowsRemain);
        }

        env.storage().instance().set(&DataKey::Adapter, &adapter);
        let mut strats = Vec::new(&env);
        strats.push_back(StrategyAllocation {
            address: adapter.clone(),
            weight_bps: BPS_DENOMINATOR as u32,
        });
        env.storage().instance().set(&DataKey::Strategies, &strats);
        Self::bump_instance(&env);

        env.events()
            .publish((symbol_short!("adapter"), admin), adapter);
        Ok(())
    }

    // ── Strategy Management ──────────────────────────────────────────────

    /// Sets the multi-strategy portfolio allocation. Admin only.
    ///
    /// Supports registration of up to 4 verified strategy contracts.
    /// Validates that weights sum to exactly 10,000 basis points.
    ///
    /// # Errors
    /// Returns `Error::NotInitialized` before initialization,
    /// `Error::InvalidStrategyCount` if empty,
    /// `Error::MaxStrategiesExceeded` if > 4 strategies,
    /// `Error::DuplicateStrategy` if duplicate addresses exist,
    /// `Error::InvalidWeights` if weights are 0 or sum != 10_000,
    /// and `Error::ActiveEscrowsRemain` if changing strategy addresses while escrows are open.
    pub fn set_strategies(env: Env, strategies: Vec<StrategyAllocation>) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        if Self::active_escrows(&env) != 0 {
            let current = Self::get_strategies(env.clone());
            if !Self::same_strategy_addresses(&current, &strategies) {
                return Err(Error::ActiveEscrowsRemain);
            }
        }
        Self::validate_strategies(&strategies)?;

        env.storage()
            .instance()
            .set(&DataKey::Strategies, &strategies);
        if let Some(first) = strategies.get(0) {
            env.storage()
                .instance()
                .set(&DataKey::Adapter, &first.address);
        }
        Self::bump_instance(&env);

        env.events()
            .publish((symbol_short!("strats"), admin), strategies.len());
        Ok(())
    }

    /// Registers or updates a strategy in the portfolio with a target weight. Admin only.
    pub fn register_strategy(env: Env, strategy: Address, weight_bps: u32) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        if weight_bps == 0 || weight_bps > (BPS_DENOMINATOR as u32) {
            return Err(Error::InvalidWeights);
        }
        let current = Self::get_strategies(env.clone());
        let mut new_strats = Vec::new(&env);
        let mut found = false;

        for s in current.iter() {
            if s.address == strategy {
                found = true;
                new_strats.push_back(StrategyAllocation {
                    address: strategy.clone(),
                    weight_bps,
                });
            } else {
                new_strats.push_back(s);
            }
        }

        if !found {
            if Self::active_escrows(&env) != 0 {
                return Err(Error::ActiveEscrowsRemain);
            }
            if new_strats.len() >= 4 {
                return Err(Error::MaxStrategiesExceeded);
            }
            new_strats.push_back(StrategyAllocation {
                address: strategy.clone(),
                weight_bps,
            });
        }

        Self::validate_strategies(&new_strats)?;

        env.storage()
            .instance()
            .set(&DataKey::Strategies, &new_strats);
        if let Some(first) = new_strats.get(0) {
            env.storage()
                .instance()
                .set(&DataKey::Adapter, &first.address);
        }
        Self::bump_instance(&env);

        env.events()
            .publish((symbol_short!("reg_strat"), admin), strategy);
        Ok(())
    }

    /// Returns the currently configured multi-strategy portfolio.
    pub fn get_strategies(env: Env) -> Vec<StrategyAllocation> {
        if let Some(strategies) = env.storage().instance().get(&DataKey::Strategies) {
            strategies
        } else if let Ok(adapter) = Self::adapter(&env) {
            let mut s = Vec::new(&env);
            s.push_back(StrategyAllocation {
                address: adapter,
                weight_bps: BPS_DENOMINATOR as u32,
            });
            s
        } else {
            Vec::new(&env)
        }
    }

    /// Returns the count of registered strategies.
    pub fn get_strategy_count(env: Env) -> u32 {
        Self::get_strategies(env).len()
    }

    /// Sets the rebalance threshold in basis points. Admin only.
    pub fn set_rebalance_threshold(env: Env, threshold_bps: u32) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        if threshold_bps > (BPS_DENOMINATOR as u32) {
            return Err(Error::InvalidThreshold);
        }
        env.storage()
            .instance()
            .set(&DataKey::RebalanceThreshold, &threshold_bps);
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("thresh"), admin), threshold_bps);
        Ok(())
    }

    /// Returns the configured rebalance threshold in basis points (default: 100 bps / 1%).
    pub fn get_rebalance_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::RebalanceThreshold)
            .unwrap_or(100)
    }

    /// Checks if any strategy's current weight has drifted from target weight
    /// by more than the configured rebalance threshold.
    pub fn check_rebalance_needed(env: Env, token: Address) -> Result<bool, Error> {
        Self::require_initialized(&env)?;
        let strategies = Self::get_strategies(env.clone());
        if strategies.len() <= 1 {
            return Ok(false);
        }
        let threshold_bps = Self::get_rebalance_threshold(env.clone()) as i128;
        let mut total_balance: i128 = 0;
        let mut balances = Vec::new(&env);
        for strat in strategies.iter() {
            let bal = LendingProtocolClient::new(&env, &strat.address).get_balance(&token);
            balances.push_back(bal);
            total_balance = total_balance.checked_add(bal).ok_or(Error::MathOverflow)?;
        }
        if total_balance <= 0 {
            return Ok(false);
        }
        for i in 0..strategies.len() {
            let strat = strategies.get(i).unwrap();
            let bal = balances.get(i).unwrap();
            let current_weight_bps = bal
                .checked_mul(BPS_DENOMINATOR)
                .ok_or(Error::MathOverflow)?
                / total_balance;
            let target_weight_bps = strat.weight_bps as i128;
            let drift = if current_weight_bps >= target_weight_bps {
                current_weight_bps - target_weight_bps
            } else {
                target_weight_bps - current_weight_bps
            };
            if drift >= threshold_bps {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Rebalances capital across all configured strategies to match target allocation weights.
    ///
    /// Checks current balances in each strategy, calculates target balances, and executes
    /// withdrawals from excess strategies followed by deposits into deficit strategies.
    pub fn rebalance(env: Env, token: Address) -> Result<(), Error> {
        Self::require_initialized(&env)?;
        let strategies = Self::get_strategies(env.clone());
        let num_strats = strategies.len();
        if num_strats <= 1 {
            return Ok(());
        }

        let contract = env.current_contract_address();

        // 1. Query current balances of all strategies
        let mut total_balance: i128 = 0;
        let mut balances = Vec::new(&env);
        for strat in strategies.iter() {
            let bal = LendingProtocolClient::new(&env, &strat.address).get_balance(&token);
            balances.push_back(bal);
            total_balance = total_balance.checked_add(bal).ok_or(Error::MathOverflow)?;
        }

        if total_balance <= 0 {
            return Ok(());
        }

        // 2. Compute target balances based on weights
        let mut target_balances = Vec::new(&env);
        let mut allocated_target: i128 = 0;
        for strat in strategies.iter() {
            let target = total_balance
                .checked_mul(strat.weight_bps as i128)
                .ok_or(Error::MathOverflow)?
                / BPS_DENOMINATOR;
            target_balances.push_back(target);
            allocated_target = allocated_target
                .checked_add(target)
                .ok_or(Error::MathOverflow)?;
        }

        let remainder = total_balance - allocated_target;
        let mut final_targets = Vec::new(&env);
        for i in 0..num_strats {
            let mut target = target_balances.get(i).unwrap();
            if (i as i128) < remainder {
                target += 1;
            }
            final_targets.push_back(target);
        }

        // 3. Step 1: Withdraw from strategies with surplus
        for i in 0..num_strats {
            let strat = strategies.get(i).unwrap();
            let current = balances.get(i).unwrap();
            let target = final_targets.get(i).unwrap();
            if current > target {
                let excess = current - target;
                LendingProtocolClient::new(&env, &strat.address)
                    .withdraw(&contract, &token, &excess);
            }
        }

        // 4. Step 2: Deposit into strategies with deficit
        for i in 0..num_strats {
            let strat = strategies.get(i).unwrap();
            let current = balances.get(i).unwrap();
            let target = final_targets.get(i).unwrap();
            if current < target {
                let deficit = target - current;
                LendingProtocolClient::new(&env, &strat.address)
                    .deposit(&contract, &token, &deficit);
            }
        }

        env.storage().persistent().set(
            &DataKey::LastRebalance(token.clone()),
            &env.ledger().sequence(),
        );

        env.events()
            .publish((symbol_short!("rebal"), token), (total_balance, num_strats));
        Ok(())
    }

    /// Returns the current balance of a specific strategy for the given token.
    pub fn get_strategy_balance(env: Env, strategy: Address, token: Address) -> i128 {
        LendingProtocolClient::new(&env, &strategy).get_balance(&token)
    }

    /// Returns the aggregate balance across all configured strategies for the given token.
    pub fn get_total_strategy_balance(env: Env, token: Address) -> Result<i128, Error> {
        let strategies = Self::get_strategies(env.clone());
        let mut total: i128 = 0;
        for strat in strategies.iter() {
            let bal = LendingProtocolClient::new(&env, &strat.address).get_balance(&token);
            total = total.checked_add(bal).ok_or(Error::MathOverflow)?;
        }
        Ok(total)
    }

    // ── Escrow lifecycle ─────────────────────────────────────────────────

    /// Locks `amount` of `token` from `payer` and supplies it across strategies.
    ///
    /// `payer` must authorize the call. `beneficiary_interest_bps` is the share
    /// of the interest accrued while the funds are locked that the beneficiary
    /// receives on release; the remainder is returned to the payer.
    /// `release_ledger` is the ledger sequence from which `release` becomes
    /// callable.
    ///
    /// # Errors
    /// Returns `Error::InvalidAmount` for a non-positive amount,
    /// `Error::InvalidReleaseLedger` when the deadline is not in the future,
    /// `Error::InvalidInterestSplit` when the interest share exceeds 10_000 bps
    /// and `Error::EscrowExists` when `escrow_id` is already taken.
    pub fn create_escrow(
        env: Env,
        escrow_id: u64,
        payer: Address,
        beneficiary: Address,
        token: Address,
        amount: i128,
        release_ledger: u32,
        beneficiary_interest_bps: u32,
    ) -> Result<(), Error> {
        Self::require_initialized(&env)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if release_ledger <= env.ledger().sequence() {
            return Err(Error::InvalidReleaseLedger);
        }
        if beneficiary_interest_bps as i128 > BPS_DENOMINATOR {
            return Err(Error::InvalidInterestSplit);
        }
        payer.require_auth();

        let key = DataKey::Escrow(escrow_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::EscrowExists);
        }

        let contract = env.current_contract_address();
        let strategies = Self::get_strategies(env.clone());
        let mut yield_state = Self::update_yield_state(&env, &token)?;

        // Move the principal into this contract, then supply across strategies
        token::Client::new(&env, &token).transfer(&payer, &contract, &amount);

        let num_strats = strategies.len();
        let mut allocated: i128 = 0;
        let mut amounts = Vec::new(&env);
        for strat in strategies.iter() {
            let strat_amount = amount
                .checked_mul(strat.weight_bps as i128)
                .ok_or(Error::MathOverflow)?
                / BPS_DENOMINATOR;
            amounts.push_back(strat_amount);
            allocated = allocated
                .checked_add(strat_amount)
                .ok_or(Error::MathOverflow)?;
        }
        let remainder = amount - allocated;
        for i in 0..num_strats {
            let strat = strategies.get(i).unwrap();
            let mut strat_amount = amounts.get(i).unwrap();
            if (i as i128) < remainder {
                strat_amount += 1;
            }
            if strat_amount > 0 {
                LendingProtocolClient::new(&env, &strat.address).deposit(
                    &contract,
                    &token,
                    &strat_amount,
                );
            }
        }

        yield_state.total_principal = yield_state
            .total_principal
            .checked_add(amount)
            .ok_or(Error::MathOverflow)?;
        // Refresh after depositing so the next interval uses utilization that
        // includes this position.
        yield_state.rate_bps = Self::get_weighted_yield_rate(&env, &token)?;
        if yield_state.rate_bps > 100_000 {
            return Err(Error::InvalidYieldRate);
        }
        env.storage()
            .persistent()
            .set(&DataKey::YieldState(token.clone()), &yield_state);
        env.storage().persistent().extend_ttl(
            &DataKey::YieldState(token.clone()),
            ESCROW_THRESHOLD,
            ESCROW_BUMP,
        );

        Self::add_active(&env)?;
        let record = Escrow {
            payer: payer.clone(),
            beneficiary: beneficiary.clone(),
            token: token.clone(),
            principal: amount,
            release_ledger,
            beneficiary_interest_bps,
            reward_debt: yield_state.index,
            released: false,
            cancelled: false,
        };
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, ESCROW_THRESHOLD, ESCROW_BUMP);
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("created"), escrow_id),
            (
                payer,
                beneficiary,
                token,
                amount,
                release_ledger,
                beneficiary_interest_bps,
            ),
        );
        Ok(())
    }

    /// Settles a matured escrow.
    ///
    /// The principal is withdrawn and the accrued interest harvested back into
    /// this contract, then the beneficiary is paid `principal +
    /// floor(interest * bps / 10_000)` and the payer receives the rest of the
    /// interest.
    ///
    /// Deliberately permissionless: once `release_ledger` is reached anybody
    /// (typically the beneficiary or a keeper) may settle the position, which
    /// is what makes the lock self-enforcing.
    ///
    /// # Errors
    /// Returns `Error::EscrowNotFound` for an unknown id,
    /// `Error::EscrowNotActive` when the position was already settled and
    /// `Error::NotYetReleasable` before the deadline.
    pub fn release(env: Env, escrow_id: u64) -> Result<ReleaseOutcome, Error> {
        Self::require_initialized(&env)?;
        let key = DataKey::Escrow(escrow_id);
        let mut record: Escrow = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::EscrowNotFound)?;
        if !record.is_active() {
            return Err(Error::EscrowNotActive);
        }
        if env.ledger().sequence() < record.release_ledger {
            return Err(Error::NotYetReleasable);
        }

        let yield_state = Self::update_yield_state(&env, &record.token)?;
        let (principal, harvested) = Self::redeem_position(&env, &record)?;
        let interest = Self::position_yield(&record, &yield_state)?;
        if harvested < interest {
            return Err(Error::InsufficientAccruedYield);
        }
        let (to_beneficiary, to_payer) =
            Self::split_interest(principal, interest, record.beneficiary_interest_bps)?;

        let contract = env.current_contract_address();
        let token_client = token::Client::new(&env, &record.token);
        if to_beneficiary > 0 {
            token_client.transfer(&contract, &record.beneficiary, &to_beneficiary);
        }
        if to_payer > 0 {
            token_client.transfer(&contract, &record.payer, &to_payer);
        }

        record.released = true;
        Self::remove_active_principal(&env, &record.token, principal)?;
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, ESCROW_THRESHOLD, ESCROW_BUMP);
        Self::sub_active(&env)?;

        env.events().publish(
            (symbol_short!("released"), escrow_id),
            (principal, interest, to_beneficiary, to_payer),
        );
        Ok(ReleaseOutcome {
            principal,
            interest,
            to_beneficiary,
            to_payer,
        })
    }

    /// Refunds an escrow to its payer before the release deadline. Payer only.
    ///
    /// Any interest accrued up to this point is refunded with the principal,
    /// since the payer carried the position risk.
    ///
    /// # Errors
    /// Returns `Error::EscrowNotFound` for an unknown id,
    /// `Error::EscrowNotActive` when the position was already settled and
    /// `Error::StillLocked` once the deadline has passed.
    pub fn cancel(env: Env, escrow_id: u64) -> Result<ReleaseOutcome, Error> {
        Self::require_initialized(&env)?;
        let key = DataKey::Escrow(escrow_id);
        let mut record: Escrow = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::EscrowNotFound)?;
        if !record.is_active() {
            return Err(Error::EscrowNotActive);
        }
        if env.ledger().sequence() >= record.release_ledger {
            return Err(Error::StillLocked);
        }
        record.payer.require_auth();

        let yield_state = Self::update_yield_state(&env, &record.token)?;
        let (principal, harvested) = Self::redeem_position(&env, &record)?;
        let interest = Self::position_yield(&record, &yield_state)?;
        if harvested < interest {
            return Err(Error::InsufficientAccruedYield);
        }
        let refund = principal + interest;
        if refund > 0 {
            token::Client::new(&env, &record.token).transfer(
                &env.current_contract_address(),
                &record.payer,
                &refund,
            );
        }

        record.cancelled = true;
        Self::remove_active_principal(&env, &record.token, principal)?;
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, ESCROW_THRESHOLD, ESCROW_BUMP);
        Self::sub_active(&env)?;

        env.events().publish(
            (symbol_short!("cancelled"), escrow_id),
            (principal, interest, refund),
        );
        Ok(ReleaseOutcome {
            principal,
            interest,
            to_beneficiary: 0,
            to_payer: refund,
        })
    }

    // ── Views ────────────────────────────────────────────────────────────

    /// Returns the escrow stored under `escrow_id`.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<Escrow, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::EscrowNotFound)
    }

    /// Returns the configured yield adapter.
    pub fn get_adapter(env: Env) -> Result<Address, Error> {
        Self::adapter(&env)
    }

    /// Returns the admin address.
    pub fn get_admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    /// Returns the number of escrows that are still locked.
    pub fn get_active_escrows(env: Env) -> u32 {
        Self::active_escrows(&env)
    }

    /// Returns the current cumulative yield index and active principal for a
    /// token, first accruing the adapter's previous rate through now.
    pub fn get_yield_state(env: Env, token: Address) -> Result<YieldState, Error> {
        Self::require_initialized(&env)?;
        Self::update_yield_state(&env, &token)
    }

    /// Returns the contract version.
    pub fn version(_env: Env) -> u32 {
        VERSION
    }

    // ── Internal helpers ─────────────────────────────────────────────────

    /// Validates strategy allocations: between 1 and 4 entries, no duplicates,
    /// each weight > 0, and weights sum to exactly 10,000 basis points.
    fn validate_strategies(strategies: &Vec<StrategyAllocation>) -> Result<(), Error> {
        let len = strategies.len();
        if len == 0 {
            return Err(Error::InvalidStrategyCount);
        }
        if len > 4 {
            return Err(Error::MaxStrategiesExceeded);
        }

        let mut total_weight: u32 = 0;
        for i in 0..len {
            let strat_i = strategies.get(i).unwrap();
            if strat_i.weight_bps == 0 {
                return Err(Error::InvalidWeights);
            }
            total_weight = total_weight
                .checked_add(strat_i.weight_bps)
                .ok_or(Error::MathOverflow)?;

            // Check for duplicate strategy addresses
            for j in (i + 1)..len {
                let strat_j = strategies.get(j).unwrap();
                if strat_i.address == strat_j.address {
                    return Err(Error::DuplicateStrategy);
                }
            }
        }

        if total_weight != (BPS_DENOMINATOR as u32) {
            return Err(Error::InvalidWeights);
        }

        Ok(())
    }

    /// Returns true if both collections share the exact same strategy addresses.
    fn same_strategy_addresses(
        current: &Vec<StrategyAllocation>,
        new_strats: &Vec<StrategyAllocation>,
    ) -> bool {
        if current.len() != new_strats.len() {
            return false;
        }
        for i in 0..current.len() {
            let curr_addr = current.get(i).unwrap().address;
            let mut found = false;
            for j in 0..new_strats.len() {
                if new_strats.get(j).unwrap().address == curr_addr {
                    found = true;
                    break;
                }
            }
            if !found {
                return false;
            }
        }
        true
    }

    /// Computes the weighted average yield rate across all registered strategies in basis points.
    fn get_weighted_yield_rate(env: &Env, token: &Address) -> Result<u32, Error> {
        let strategies = Self::get_strategies(env.clone());
        if strategies.is_empty() {
            let adapter = Self::adapter(env)?;
            return Ok(LendingProtocolClient::new(env, &adapter).yield_rate_bps(token));
        }
        let mut total_weighted_rate: u128 = 0;
        for strat in strategies.iter() {
            let rate = LendingProtocolClient::new(env, &strat.address).yield_rate_bps(token);
            if rate > 100_000 {
                return Err(Error::InvalidYieldRate);
            }
            total_weighted_rate = total_weighted_rate
                .checked_add((rate as u128) * (strat.weight_bps as u128))
                .ok_or(Error::MathOverflow)?;
        }
        let avg_rate = (total_weighted_rate / (BPS_DENOMINATOR as u128)) as u32;
        Ok(avg_rate)
    }

    /// Withdraws the escrowed principal and harvests the interest across all strategies,
    /// returning `(principal, interest)`.
    fn redeem_position(env: &Env, record: &Escrow) -> Result<(i128, i128), Error> {
        let strategies = Self::get_strategies(env.clone());
        let contract = env.current_contract_address();
        let num_strats = strategies.len();

        let mut total_balance: i128 = 0;
        let mut balances = Vec::new(env);
        for strat in strategies.iter() {
            let bal = LendingProtocolClient::new(env, &strat.address).get_balance(&record.token);
            balances.push_back(bal);
            total_balance = total_balance.checked_add(bal).ok_or(Error::MathOverflow)?;
        }

        let mut to_withdraw = Vec::new(env);
        let mut allocated: i128 = 0;

        if total_balance > 0 {
            for i in 0..num_strats {
                let bal = balances.get(i).unwrap();
                let amt = record
                    .principal
                    .checked_mul(bal)
                    .ok_or(Error::MathOverflow)?
                    / total_balance;
                to_withdraw.push_back(amt);
                allocated = allocated.checked_add(amt).ok_or(Error::MathOverflow)?;
            }
        } else {
            for strat in strategies.iter() {
                let amt = record
                    .principal
                    .checked_mul(strat.weight_bps as i128)
                    .ok_or(Error::MathOverflow)?
                    / BPS_DENOMINATOR;
                to_withdraw.push_back(amt);
                allocated = allocated.checked_add(amt).ok_or(Error::MathOverflow)?;
            }
        }

        let remainder = record.principal - allocated;
        let mut total_interest: i128 = 0;

        for i in 0..num_strats {
            let strat = strategies.get(i).unwrap();
            let mut amt = to_withdraw.get(i).unwrap();
            if (i as i128) < remainder {
                amt += 1;
            }
            if amt > 0 {
                LendingProtocolClient::new(env, &strat.address).withdraw(
                    &contract,
                    &record.token,
                    &amt,
                );
            }
            let harvested =
                LendingProtocolClient::new(env, &strat.address).harvest(&contract, &record.token);
            if harvested < 0 {
                return Err(Error::InvalidInterest);
            }
            total_interest = total_interest
                .checked_add(harvested)
                .ok_or(Error::MathOverflow)?;
        }

        Ok((record.principal, total_interest))
    }

    fn update_yield_state(env: &Env, token: &Address) -> Result<YieldState, Error> {
        let now = env.ledger().timestamp();
        let key = DataKey::YieldState(token.clone());
        let mut state: YieldState = env.storage().persistent().get(&key).unwrap_or(YieldState {
            index: 0,
            updated_at: now,
            rate_bps: 0,
            total_principal: 0,
        });
        if now < state.updated_at {
            return Err(Error::TimestampRegression);
        }
        let elapsed = (now - state.updated_at) as i128;
        let growth = INDEX_SCALE
            .checked_mul(state.rate_bps as i128)
            .and_then(|value| value.checked_mul(elapsed))
            .ok_or(Error::MathOverflow)?
            / (SECONDS_PER_YEAR * BPS_DENOMINATOR);
        state.index = state.index.checked_add(growth).ok_or(Error::MathOverflow)?;
        state.updated_at = now;

        state.rate_bps = Self::get_weighted_yield_rate(env, token)?;
        if state.rate_bps > 100_000 {
            return Err(Error::InvalidYieldRate);
        }
        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .extend_ttl(&key, ESCROW_THRESHOLD, ESCROW_BUMP);
        Ok(state)
    }

    fn position_yield(record: &Escrow, state: &YieldState) -> Result<i128, Error> {
        let index_delta = state
            .index
            .checked_sub(record.reward_debt)
            .ok_or(Error::MathOverflow)?;
        record
            .principal
            .checked_mul(index_delta)
            .map(|value| value / INDEX_SCALE)
            .ok_or(Error::MathOverflow)
    }

    fn remove_active_principal(env: &Env, token: &Address, principal: i128) -> Result<(), Error> {
        let key = DataKey::YieldState(token.clone());
        let mut state: YieldState = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotInitialized)?;
        state.total_principal = state
            .total_principal
            .checked_sub(principal)
            .ok_or(Error::MathOverflow)?;
        state.rate_bps = Self::get_weighted_yield_rate(env, token)?;
        if state.rate_bps > 100_000 {
            return Err(Error::InvalidYieldRate);
        }
        env.storage().persistent().set(&key, &state);
        env.storage()
            .persistent()
            .extend_ttl(&key, ESCROW_THRESHOLD, ESCROW_BUMP);
        Ok(())
    }

    /// Splits `interest` between the beneficiary and the payer.
    ///
    /// The beneficiary always receives the full principal plus
    /// `floor(interest * bps / 10_000)`; the payer receives the remainder. The
    /// floor keeps the split exact: the two legs always add up to
    /// `principal + interest`, with any rounding dust going to the payer.
    fn split_interest(
        principal: i128,
        interest: i128,
        beneficiary_bps: u32,
    ) -> Result<(i128, i128), Error> {
        let beneficiary_interest = interest
            .checked_mul(beneficiary_bps as i128)
            .ok_or(Error::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(Error::MathOverflow)?;
        Ok((
            principal + beneficiary_interest,
            interest - beneficiary_interest,
        ))
    }

    fn require_initialized(env: &Env) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Initialized) {
            Ok(())
        } else {
            Err(Error::NotInitialized)
        }
    }

    fn require_admin(env: &Env) -> Result<Address, Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        Ok(admin)
    }

    fn adapter(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Adapter)
            .ok_or(Error::NotInitialized)
    }

    fn active_escrows(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ActiveEscrows)
            .unwrap_or(0)
    }

    fn add_active(env: &Env) -> Result<(), Error> {
        let next = Self::active_escrows(env)
            .checked_add(1)
            .ok_or(Error::MathOverflow)?;
        env.storage().instance().set(&DataKey::ActiveEscrows, &next);
        Ok(())
    }

    fn sub_active(env: &Env) -> Result<(), Error> {
        let next = Self::active_escrows(env)
            .checked_sub(1)
            .ok_or(Error::MathOverflow)?;
        env.storage().instance().set(&DataKey::ActiveEscrows, &next);
        Ok(())
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
    }
}

#[cfg(test)]
mod test;
