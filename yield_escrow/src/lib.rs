#![no_std]

//! Yield-bearing escrow.
//!
//! A variant of the classic escrow that does not leave locked funds idle: the
//! principal is supplied to a Soroban lending protocol through the same
//! `LendingProtocol` adapter shape the payment router already uses for treasury
//! yield (a Blend-compatible deployment satisfies it), the position is tracked
//! per escrow, and on settlement the interest accrued while the funds were
//! locked is split between the beneficiary and the payer according to a
//! per-escrow basis-point share.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token,
    Address, Env,
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
    /// Number of escrows that are still locked (not released or cancelled).
    ActiveEscrows,
    /// A single escrow position, keyed by the caller-supplied id.
    Escrow(u64),
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
        env.storage().instance().set(&DataKey::ActiveEscrows, &0_u32);
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
        Self::bump_instance(&env);

        env.events()
            .publish((symbol_short!("adapter"), admin), adapter);
        Ok(())
    }

    // ── Escrow lifecycle ─────────────────────────────────────────────────

    /// Locks `amount` of `token` from `payer` and supplies it to the adapter.
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
        let adapter = Self::adapter(&env)?;

        // Move the principal into this contract, then let the adapter pull it
        // into the lending pool. Both calls happen inside the payer's
        // authorization tree, so the payer signs a single transaction.
        token::Client::new(&env, &token).transfer(&payer, &contract, &amount);
        LendingProtocolClient::new(&env, &adapter).deposit(&contract, &token, &amount);

        Self::add_active(&env)?;
        let record = Escrow {
            payer: payer.clone(),
            beneficiary: beneficiary.clone(),
            token: token.clone(),
            principal: amount,
            release_ledger,
            beneficiary_interest_bps,
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

        let (principal, interest) = Self::redeem_position(&env, &record)?;
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

        let (principal, interest) = Self::redeem_position(&env, &record)?;
        let refund = principal + interest;
        if refund > 0 {
            token::Client::new(&env, &record.token).transfer(
                &env.current_contract_address(),
                &record.payer,
                &refund,
            );
        }

        record.cancelled = true;
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

    /// Returns the contract version.
    pub fn version(_env: Env) -> u32 {
        VERSION
    }

    // ── Internal helpers ─────────────────────────────────────────────────

    /// Withdraws the escrowed principal and harvests the interest into this
    /// contract, returning `(principal, interest)`.
    fn redeem_position(env: &Env, record: &Escrow) -> Result<(i128, i128), Error> {
        let adapter = Self::adapter(env)?;
        let contract = env.current_contract_address();
        let protocol = LendingProtocolClient::new(env, &adapter);

        protocol.withdraw(&contract, &record.token, &record.principal);
        let interest = protocol.harvest(&contract, &record.token);
        if interest < 0 {
            return Err(Error::InvalidInterest);
        }
        Ok((record.principal, interest))
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
