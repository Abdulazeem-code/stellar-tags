#![cfg(test)]
#![allow(
    clippy::bool_assert_comparison,
    clippy::cast_possible_truncation,
    clippy::cast_lossless,
    clippy::too_many_lines
)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _, LedgerInfo};
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{Address, Env};

// ── Test fixture ─────────────────────────────────────────────────────────────

struct Fixture {
    env: Env,
    admin: Address,
    payer: Address,
    beneficiary: Address,
    token: Address,
    contract_id: Address,
    pool_id: Address,
    client: YieldEscrowClient<'static>,
    pool: MockLendingPoolClient<'static>,
    token_client: token::Client<'static>,
    token_admin: StellarAssetClient<'static>,
}

impl Fixture {
    fn new() -> Self {
        let env = Env::default();
        // The escrow contract authorizes its own calls into the lending pool
        // (the SAC transfers are invoked by the escrow), so the non-root mock
        // auth mode is required; plain `mock_all_auths` only mocks auths that
        // appear in the root invocation.
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let payer = Address::generate(&env);
        let beneficiary = Address::generate(&env);

        let token_admin_address = Address::generate(&env);
        let token = env.register_stellar_asset_contract(token_admin_address);
        let token_client = token::Client::new(&env, &token);
        let token_admin = StellarAssetClient::new(&env, &token);

        let pool_id = env.register_contract(None, MockLendingPool);
        let pool = MockLendingPoolClient::new(&env, &pool_id);

        let contract_id = env.register_contract(None, YieldEscrow);
        let client = YieldEscrowClient::new(&env, &contract_id);
        client.initialize(&admin, &pool_id);

        Fixture {
            env,
            admin,
            payer,
            beneficiary,
            token,
            contract_id,
            pool_id,
            client,
            pool,
            token_client,
            token_admin,
        }
    }

    /// Funds the lending pool so that it can pay out simulated interest.
    fn accrue(&self, yield_amount: i128) {
        self.token_admin.mint(&self.pool_id, &yield_amount);
        self.pool.accrue_yield(&self.token, &yield_amount);
    }

    fn set_rate(&self, rate_bps: u32) {
        self.pool.set_yield_rate_bps(&self.token, &rate_bps);
    }
}

/// Moves the ledger sequence forward, preserving the rest of the ledger info.
fn set_sequence(env: &Env, sequence_number: u32) {
    env.ledger().set(LedgerInfo {
        timestamp: env.ledger().timestamp(),
        protocol_version: env.ledger().protocol_version(),
        sequence_number,
        network_id: env.ledger().network_id().into(),
        base_reserve: 100,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 4096,
        max_entry_ttl: 6_312_000,
    });
}

fn set_timestamp(env: &Env, timestamp: u64) {
    env.ledger().set(LedgerInfo {
        timestamp,
        protocol_version: env.ledger().protocol_version(),
        sequence_number: env.ledger().sequence(),
        network_id: env.ledger().network_id().into(),
        base_reserve: 100,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 4096,
        max_entry_ttl: 6_312_000,
    });
}

// ── In-process lending protocol mock ─────────────────────────────────────────
//
// Mirrors the mock used by the payment router's test suite: it pulls principal
// in on `deposit`, releases it on `withdraw` and reports whatever interest the
// test has accrued on `harvest`.

#[contracttype]
#[derive(Clone)]
enum MockLendingKey {
    Principal(Address),
    Yield(Address),
    Rate(Address),
}

#[contract]
struct MockLendingPool;

#[contractimpl]
impl MockLendingPool {
    pub fn deposit(env: Env, from: Address, token: Address, amount: i128) {
        from.require_auth();
        token::Client::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);
        let key = MockLendingKey::Principal(token);
        let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
        env.storage().instance().set(&key, &(current + amount));
    }

    pub fn withdraw(env: Env, to: Address, token: Address, amount: i128) {
        let p_key = MockLendingKey::Principal(token.clone());
        let y_key = MockLendingKey::Yield(token.clone());
        let principal: i128 = env.storage().instance().get(&p_key).unwrap_or(0);
        let accrued: i128 = env.storage().instance().get(&y_key).unwrap_or(0);
        assert!(principal + accrued >= amount);
        token::Client::new(&env, &token).transfer(&env.current_contract_address(), &to, &amount);
        if amount <= principal {
            env.storage().instance().set(&p_key, &(principal - amount));
        } else {
            env.storage().instance().set(&p_key, &0_i128);
            let rem = amount - principal;
            env.storage().instance().set(&y_key, &(accrued - rem));
        }
    }

    pub fn harvest(env: Env, to: Address, token: Address) -> i128 {
        let key = MockLendingKey::Yield(token.clone());
        let amount: i128 = env.storage().instance().get(&key).unwrap_or(0);
        if amount > 0 {
            token::Client::new(&env, &token).transfer(
                &env.current_contract_address(),
                &to,
                &amount,
            );
            env.storage().instance().remove(&key);
        }
        amount
    }

    pub fn get_balance(env: Env, token: Address) -> i128 {
        let p_key = MockLendingKey::Principal(token.clone());
        let y_key = MockLendingKey::Yield(token);
        let principal: i128 = env.storage().instance().get(&p_key).unwrap_or(0);
        let accrued: i128 = env.storage().instance().get(&y_key).unwrap_or(0);
        principal + accrued
    }

    /// Test helper: records interest the pool will pay on the next `harvest`.
    pub fn accrue_yield(env: Env, token: Address, amount: i128) {
        let key = MockLendingKey::Yield(token);
        let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
        env.storage().instance().set(&key, &(current + amount));
    }

    pub fn yield_rate_bps(env: Env, token: Address) -> u32 {
        env.storage()
            .instance()
            .get(&MockLendingKey::Rate(token))
            .unwrap_or(0)
    }

    pub fn set_yield_rate_bps(env: Env, token: Address, rate_bps: u32) {
        env.storage()
            .instance()
            .set(&MockLendingKey::Rate(token), &rate_bps);
    }
}

// ── Configuration ────────────────────────────────────────────────────────────

#[test]
fn initialize_is_guarded_and_required() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let admin = Address::generate(&env);
    let adapter = Address::generate(&env);
    let contract_id = env.register_contract(None, YieldEscrow);
    let client = YieldEscrowClient::new(&env, &contract_id);

    // Before initialisation the contract refuses to operate.
    assert_eq!(client.try_get_adapter(), Err(Ok(Error::NotInitialized)));
    assert_eq!(
        client.try_set_adapter(&adapter),
        Err(Ok(Error::NotInitialized))
    );

    client.initialize(&admin, &adapter);
    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_adapter(), adapter);
    assert_eq!(client.get_active_escrows(), 0);
    assert_eq!(client.version(), 1);

    // A second initialisation must not be able to re-point the contract.
    assert_eq!(
        client.try_initialize(&admin, &adapter),
        Err(Ok(Error::AlreadyInitialized))
    );
}

#[test]
fn create_escrow_validates_its_arguments() {
    let f = Fixture::new();
    f.token_admin.mint(&f.payer, &1_000);

    assert_eq!(
        f.client.try_create_escrow(
            &1_u64,
            &f.payer,
            &f.beneficiary,
            &f.token,
            &0_i128,
            &150_u32,
            &100_u32
        ),
        Err(Ok(Error::InvalidAmount))
    );
    // The ledger sequence is still 0, so a deadline of 0 is not in the future.
    assert_eq!(
        f.client.try_create_escrow(
            &2_u64,
            &f.payer,
            &f.beneficiary,
            &f.token,
            &100_i128,
            &0_u32,
            &100_u32
        ),
        Err(Ok(Error::InvalidReleaseLedger))
    );
    assert_eq!(
        f.client.try_create_escrow(
            &3_u64,
            &f.payer,
            &f.beneficiary,
            &f.token,
            &100_i128,
            &150_u32,
            &10_001_u32
        ),
        Err(Ok(Error::InvalidInterestSplit))
    );

    f.client.create_escrow(
        &4_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &100_i128,
        &150_u32,
        &100_u32,
    );
    assert_eq!(
        f.client.try_create_escrow(
            &4_u64,
            &f.payer,
            &f.beneficiary,
            &f.token,
            &100_i128,
            &150_u32,
            &100_u32
        ),
        Err(Ok(Error::EscrowExists))
    );

    assert_eq!(
        f.client.try_get_escrow(&99_u64),
        Err(Ok(Error::EscrowNotFound))
    );
    assert_eq!(
        f.client.try_release(&99_u64),
        Err(Ok(Error::EscrowNotFound))
    );
    assert_eq!(f.client.try_cancel(&99_u64), Err(Ok(Error::EscrowNotFound)));
}

// ── Release ──────────────────────────────────────────────────────────────────

#[test]
fn release_splits_principal_and_accrued_interest() {
    let f = Fixture::new();
    f.set_rate(1_000);
    f.token_admin.mint(&f.payer, &1_000);
    f.client.create_escrow(
        &1_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &1_000_i128,
        &150_u32,
        &2_500_u32,
    );

    // The principal is sitting in the lending pool, not in the escrow contract.
    assert_eq!(f.token_client.balance(&f.payer), 0);
    assert_eq!(f.token_client.balance(&f.contract_id), 0);
    assert_eq!(f.token_client.balance(&f.pool_id), 1_000);

    f.accrue(100);
    set_timestamp(&f.env, SECONDS_PER_YEAR as u64);
    set_sequence(&f.env, 150);

    let outcome = f.client.release(&1_u64);
    assert_eq!(outcome.principal, 1_000);
    assert_eq!(outcome.interest, 100);
    // 2_500 bps of the 100 interest goes to the beneficiary.
    assert_eq!(outcome.to_beneficiary, 1_025);
    assert_eq!(outcome.to_payer, 75);
    assert_eq!(outcome.to_beneficiary + outcome.to_payer, 1_100);

    assert_eq!(f.token_client.balance(&f.beneficiary), 1_025);
    assert_eq!(f.token_client.balance(&f.payer), 75);
    assert_eq!(f.token_client.balance(&f.pool_id), 0);
    assert_eq!(f.token_client.balance(&f.contract_id), 0);

    let stored = f.client.get_escrow(&1_u64);
    assert!(stored.released);
    assert!(!stored.is_active());
    assert_eq!(f.client.get_active_escrows(), 0);

    // The matured position cannot be settled twice.
    assert_eq!(
        f.client.try_release(&1_u64),
        Err(Ok(Error::EscrowNotActive))
    );
}

#[test]
fn release_uses_the_beneficiary_share_even_without_interest() {
    let f = Fixture::new();
    f.token_admin.mint(&f.payer, &250);
    f.client.create_escrow(
        &21_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &250_i128,
        &150_u32,
        &4_000_u32,
    );
    set_sequence(&f.env, 150);

    // `release` performs no authorization of its own, so a matured escrow can
    // be settled by the beneficiary or any keeper.
    let outcome = f.client.release(&21_u64);
    assert_eq!(outcome.to_beneficiary, 250);
    assert_eq!(f.token_client.balance(&f.beneficiary), 250);
}

#[test]
fn release_before_the_deadline_is_rejected() {
    let f = Fixture::new();
    f.token_admin.mint(&f.payer, &100);
    f.client.create_escrow(
        &3_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &100_i128,
        &150_u32,
        &1_000_u32,
    );

    assert_eq!(
        f.client.try_release(&3_u64),
        Err(Ok(Error::NotYetReleasable))
    );

    // The deadline is inclusive: sequence 150 unlocks the escrow.
    set_sequence(&f.env, 150);
    let outcome = f.client.release(&3_u64);
    assert_eq!(outcome.to_beneficiary, 100);
    assert_eq!(f.token_client.balance(&f.beneficiary), 100);
}

#[test]
fn release_without_interest_pays_the_principal_to_the_beneficiary() {
    let f = Fixture::new();
    f.token_admin.mint(&f.payer, &500);
    f.client.create_escrow(
        &7_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &500_i128,
        &150_u32,
        &5_000_u32,
    );
    set_sequence(&f.env, 150);

    let outcome = f.client.release(&7_u64);
    assert_eq!(outcome.interest, 0);
    assert_eq!(outcome.to_beneficiary, 500);
    assert_eq!(outcome.to_payer, 0);
    assert_eq!(f.token_client.balance(&f.beneficiary), 500);
    assert_eq!(f.token_client.balance(&f.payer), 0);
}

#[test]
fn interest_split_stays_exact_when_the_share_does_not_divide_evenly() {
    let f = Fixture::new();
    f.set_rate(70);
    f.token_admin.mint(&f.payer, &1_000);
    // 3_333 bps of the interest goes to the beneficiary.
    f.client.create_escrow(
        &31_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &1_000_i128,
        &150_u32,
        &3_333_u32,
    );
    f.accrue(7);
    set_timestamp(&f.env, SECONDS_PER_YEAR as u64);
    set_sequence(&f.env, 150);

    let outcome = f.client.release(&31_u64);
    // floor(7 * 3_333 / 10_000) = 2, the rounding dust goes to the payer.
    assert_eq!(outcome.interest, 7);
    assert_eq!(outcome.to_beneficiary, 1_002);
    assert_eq!(outcome.to_payer, 5);
    assert_eq!(outcome.to_beneficiary + outcome.to_payer, 1_007);
    assert_eq!(f.token_client.balance(&f.beneficiary), 1_002);
    assert_eq!(f.token_client.balance(&f.payer), 5);
}

#[test]
fn the_beneficiary_can_be_assigned_the_whole_interest() {
    let f = Fixture::new();
    f.set_rate(1_000);
    f.token_admin.mint(&f.payer, &200);
    f.client.create_escrow(
        &41_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &200_i128,
        &150_u32,
        &10_000_u32,
    );
    f.accrue(20);
    set_timestamp(&f.env, SECONDS_PER_YEAR as u64);
    set_sequence(&f.env, 150);

    let outcome = f.client.release(&41_u64);
    assert_eq!(outcome.to_beneficiary, 220);
    assert_eq!(outcome.to_payer, 0);
    assert_eq!(f.token_client.balance(&f.beneficiary), 220);
    assert_eq!(f.token_client.balance(&f.payer), 0);
}

// ── Cancel ───────────────────────────────────────────────────────────────────

#[test]
fn cancel_refunds_the_payer_with_interest_and_is_blocked_after_the_deadline() {
    let f = Fixture::new();
    f.set_rate(1_000);
    f.token_admin.mint(&f.payer, &400);
    f.client.create_escrow(
        &11_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &400_i128,
        &500_u32,
        &3_000_u32,
    );
    f.accrue(40);
    set_timestamp(&f.env, SECONDS_PER_YEAR as u64);
    set_sequence(&f.env, 100);

    let outcome = f.client.cancel(&11_u64);
    assert_eq!(outcome.principal, 400);
    assert_eq!(outcome.interest, 40);
    assert_eq!(outcome.to_beneficiary, 0);
    assert_eq!(outcome.to_payer, 440);
    assert_eq!(f.token_client.balance(&f.payer), 440);
    assert_eq!(f.token_client.balance(&f.beneficiary), 0);
    assert_eq!(f.client.get_active_escrows(), 0);

    // The payer is the only address that may cancel, and a cancelled position
    // stays cancelled.
    assert_eq!(
        f.client.try_cancel(&11_u64),
        Err(Ok(Error::EscrowNotActive))
    );

    // Past the deadline the payer can no longer pull the funds back.
    f.token_admin.mint(&f.payer, &100);
    f.client.create_escrow(
        &12_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &100_i128,
        &150_u32,
        &1_000_u32,
    );
    set_sequence(&f.env, 150);
    assert_eq!(f.client.try_cancel(&12_u64), Err(Ok(Error::StillLocked)));

    let outcome = f.client.release(&12_u64);
    assert_eq!(outcome.to_beneficiary, 100);
    assert_eq!(f.token_client.balance(&f.beneficiary), 100);
}

// ── Adapter management ───────────────────────────────────────────────────────

#[test]
fn streamed_interest_scales_with_lock_duration() {
    let amount = 1_000_000_000_000_i128;
    let one_block = Fixture::new();
    one_block.set_rate(1_200);
    one_block.token_admin.mint(&one_block.payer, &amount);
    one_block.client.create_escrow(
        &51_u64,
        &one_block.payer,
        &one_block.beneficiary,
        &one_block.token,
        &amount,
        &150_u32,
        &10_000_u32,
    );
    set_timestamp(&one_block.env, 5);
    let short_index = one_block.client.get_yield_state(&one_block.token).index;
    let short_interest = amount * short_index / INDEX_SCALE;
    let expected_short_index = INDEX_SCALE * 1_200 * 5 / (SECONDS_PER_YEAR * BPS_DENOMINATOR);
    assert_eq!(short_index, expected_short_index);
    assert!(short_interest > 0);
    assert!(short_interest < 20_000_000);
    one_block.accrue(short_interest);
    set_sequence(&one_block.env, 150);
    assert_eq!(one_block.client.release(&51_u64).interest, short_interest);

    let month = Fixture::new();
    month.set_rate(1_200);
    month.token_admin.mint(&month.payer, &amount);
    month.client.create_escrow(
        &52_u64,
        &month.payer,
        &month.beneficiary,
        &month.token,
        &amount,
        &150_u32,
        &10_000_u32,
    );
    let thirty_days = 30 * 24 * 60 * 60;
    set_timestamp(&month.env, thirty_days);
    let long_index = month.client.get_yield_state(&month.token).index;
    let long_interest = amount * long_index / INDEX_SCALE;
    let expected_long_index =
        INDEX_SCALE * 1_200 * thirty_days as i128 / (SECONDS_PER_YEAR * BPS_DENOMINATOR);
    assert_eq!(long_index, expected_long_index);
    assert!(long_interest > short_interest * 1_000);
    assert_eq!(
        long_interest,
        amount * 1_200 * thirty_days as i128 / (10_000 * SECONDS_PER_YEAR)
    );
    month.accrue(long_interest);
    set_sequence(&month.env, 150);
    assert_eq!(month.client.release(&52_u64).interest, long_interest);
}

#[test]
fn rate_changes_apply_only_to_elapsed_time_after_the_update() {
    let f = Fixture::new();
    f.set_rate(1_000);
    f.token_admin.mint(&f.payer, &1_000);
    f.client.create_escrow(
        &53_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &1_000_i128,
        &150_u32,
        &10_000_u32,
    );

    set_timestamp(&f.env, SECONDS_PER_YEAR as u64);
    f.set_rate(2_000);
    let first_year = f.client.get_yield_state(&f.token);
    assert_eq!(first_year.index, INDEX_SCALE * 1_000 / BPS_DENOMINATOR);

    set_timestamp(&f.env, (SECONDS_PER_YEAR + SECONDS_PER_YEAR / 2) as u64);
    let half_year_later = f.client.get_yield_state(&f.token);
    let expected_index = INDEX_SCALE * 2_000 / BPS_DENOMINATOR;
    assert_eq!(half_year_later.index, expected_index);
    let expected_interest = 1_000 * expected_index / INDEX_SCALE;
    f.accrue(expected_interest);
    set_sequence(&f.env, 150);
    assert_eq!(f.client.release(&53_u64).interest, expected_interest);
}

#[test]
fn adapter_can_only_be_replaced_while_no_escrow_is_active() {
    let f = Fixture::new();
    let new_pool_id = f.env.register_contract(None, MockLendingPool);

    assert_eq!(f.client.get_admin(), f.admin);
    assert_eq!(f.client.get_active_escrows(), 0);

    f.token_admin.mint(&f.payer, &300);
    f.client.create_escrow(
        &9_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &300_i128,
        &150_u32,
        &1_000_u32,
    );
    assert_eq!(f.client.get_active_escrows(), 1);

    // Re-pointing the adapter with funds still locked would strand them.
    assert_eq!(
        f.client.try_set_adapter(&new_pool_id),
        Err(Ok(Error::ActiveEscrowsRemain))
    );
    assert_eq!(f.client.get_adapter(), f.pool_id);

    set_sequence(&f.env, 150);
    f.client.release(&9_u64);
    assert_eq!(f.client.get_active_escrows(), 0);

    // With nothing locked the admin may swap the adapter.
    f.client.set_adapter(&new_pool_id);
    assert_eq!(f.client.get_adapter(), new_pool_id);
}

#[test]
fn set_adapter_requires_the_admin_to_authorize() {
    // Uses the strict auth mock on purpose: only a plain admin -> contract call
    // happens here, so the recorded authorizations can be asserted. `env.auths`
    // returns the trees of the last invocation, which must contain the admin.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let adapter = Address::generate(&env);
    let replacement = Address::generate(&env);
    let contract_id = env.register_contract(None, YieldEscrow);
    let client = YieldEscrowClient::new(&env, &contract_id);

    client.initialize(&admin, &adapter);
    client.set_adapter(&replacement);

    // `auths` reports the authorizations of the most recent invocation, so read
    // it before any further (view) call.
    let auths = env.auths();
    assert!(
        auths.iter().any(|(addr, _)| *addr == admin),
        "set_adapter must require the admin to authorize"
    );

    assert_eq!(client.get_adapter(), replacement);
}

// ── Multi-Strategy Allocation & Rebalancing Tests ─────────────────────────────

#[test]
fn strategy_registration_up_to_4_and_max_limit() {
    let f = Fixture::new();

    let pool1 = Address::generate(&f.env);
    let pool2 = Address::generate(&f.env);
    let pool3 = Address::generate(&f.env);
    let pool4 = Address::generate(&f.env);
    let pool5 = Address::generate(&f.env);

    // Initial state after initialize: 1 default strategy with 10,000 bps
    assert_eq!(f.client.get_strategy_count(), 1);
    let init_strats = f.client.get_strategies();
    assert_eq!(init_strats.len(), 1);
    assert_eq!(init_strats.get(0).unwrap().address, f.pool_id);
    assert_eq!(init_strats.get(0).unwrap().weight_bps, 10_000);

    // 1 strategy: 10,000 bps
    let s1 = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: pool1.clone(),
            weight_bps: 10_000,
        },
    ];
    f.client.set_strategies(&s1);
    assert_eq!(f.client.get_strategy_count(), 1);

    // 2 strategies: 6,000 + 4,000 bps
    let s2 = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: pool1.clone(),
            weight_bps: 6_000,
        },
        StrategyAllocation {
            address: pool2.clone(),
            weight_bps: 4_000,
        },
    ];
    f.client.set_strategies(&s2);
    assert_eq!(f.client.get_strategy_count(), 2);

    // 3 strategies: 3,334 + 3,333 + 3,333 bps
    let s3 = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: pool1.clone(),
            weight_bps: 3_334,
        },
        StrategyAllocation {
            address: pool2.clone(),
            weight_bps: 3_333,
        },
        StrategyAllocation {
            address: pool3.clone(),
            weight_bps: 3_333,
        },
    ];
    f.client.set_strategies(&s3);
    assert_eq!(f.client.get_strategy_count(), 3);

    // 4 strategies: 2,500 + 2,500 + 2,500 + 2,500 bps
    let s4 = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: pool1.clone(),
            weight_bps: 2_500,
        },
        StrategyAllocation {
            address: pool2.clone(),
            weight_bps: 2_500,
        },
        StrategyAllocation {
            address: pool3.clone(),
            weight_bps: 2_500,
        },
        StrategyAllocation {
            address: pool4.clone(),
            weight_bps: 2_500,
        },
    ];
    f.client.set_strategies(&s4);
    assert_eq!(f.client.get_strategy_count(), 4);

    // 5 strategies: exceeds max of 4
    let s5 = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: pool1.clone(),
            weight_bps: 2_000,
        },
        StrategyAllocation {
            address: pool2.clone(),
            weight_bps: 2_000,
        },
        StrategyAllocation {
            address: pool3.clone(),
            weight_bps: 2_000,
        },
        StrategyAllocation {
            address: pool4.clone(),
            weight_bps: 2_000,
        },
        StrategyAllocation {
            address: pool5.clone(),
            weight_bps: 2_000,
        },
    ];
    assert_eq!(
        f.client.try_set_strategies(&s5),
        Err(Ok(Error::MaxStrategiesExceeded))
    );

    // 0 strategies: empty portfolio rejected
    let empty_strats: soroban_sdk::Vec<StrategyAllocation> = soroban_sdk::Vec::new(&f.env);
    assert_eq!(
        f.client.try_set_strategies(&empty_strats),
        Err(Ok(Error::InvalidStrategyCount))
    );
}

#[test]
fn strategy_allocation_weights_validation() {
    let f = Fixture::new();

    let pool1 = Address::generate(&f.env);
    let pool2 = Address::generate(&f.env);
    let pool3 = Address::generate(&f.env);

    // Sum is 9,999 (less than 10,000)
    let s_under = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: pool1.clone(),
            weight_bps: 5_000,
        },
        StrategyAllocation {
            address: pool2.clone(),
            weight_bps: 4_999,
        },
    ];
    assert_eq!(
        f.client.try_set_strategies(&s_under),
        Err(Ok(Error::InvalidWeights))
    );

    // Sum is 10,001 (greater than 10,000)
    let s_over = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: pool1.clone(),
            weight_bps: 5_000,
        },
        StrategyAllocation {
            address: pool2.clone(),
            weight_bps: 5_001,
        },
    ];
    assert_eq!(
        f.client.try_set_strategies(&s_over),
        Err(Ok(Error::InvalidWeights))
    );

    // Weight of 0 is rejected
    let s_zero = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: pool1.clone(),
            weight_bps: 10_000,
        },
        StrategyAllocation {
            address: pool2.clone(),
            weight_bps: 0,
        },
    ];
    assert_eq!(
        f.client.try_set_strategies(&s_zero),
        Err(Ok(Error::InvalidWeights))
    );

    // Duplicate strategy address is rejected
    let s_dup = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: pool1.clone(),
            weight_bps: 5_000,
        },
        StrategyAllocation {
            address: pool1.clone(),
            weight_bps: 5_000,
        },
    ];
    assert_eq!(
        f.client.try_set_strategies(&s_dup),
        Err(Ok(Error::DuplicateStrategy))
    );

    // Registering a strategy with invalid weights
    assert_eq!(
        f.client.try_register_strategy(&pool3, &0),
        Err(Ok(Error::InvalidWeights))
    );
    assert_eq!(
        f.client.try_register_strategy(&pool3, &10_001),
        Err(Ok(Error::InvalidWeights))
    );
}

#[test]
fn three_way_capital_allocation_and_rebalancing_following_uneven_yield_accrual() {
    let f = Fixture::new();

    // Register 3 separate mock lending pools
    let pool1_id = f.env.register_contract(None, MockLendingPool);
    let pool2_id = f.env.register_contract(None, MockLendingPool);
    let pool3_id = f.env.register_contract(None, MockLendingPool);

    let pool1 = MockLendingPoolClient::new(&f.env, &pool1_id);

    // Configure 3 strategies with balanced weights: 3,334 + 3,333 + 3,333 = 10,000 bps
    let strategies = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: pool1_id.clone(),
            weight_bps: 3_334,
        },
        StrategyAllocation {
            address: pool2_id.clone(),
            weight_bps: 3_333,
        },
        StrategyAllocation {
            address: pool3_id.clone(),
            weight_bps: 3_333,
        },
    ];
    f.client.set_strategies(&strategies);
    assert_eq!(f.client.get_strategy_count(), 3);

    // Fund the payer with 3,000 tokens
    let total_principal = 3_000_i128;
    f.token_admin.mint(&f.payer, &total_principal);

    // Create escrow position
    f.client.create_escrow(
        &1_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &total_principal,
        &100_u32,
        &5_000_u32, // 50% interest split
    );

    // Verify 3-way capital allocation across all 3 pools
    // 3,000 * 3334 / 10000 = 1000 (+1 remainder) = 1001 or 1000
    let bal1_initial = f.client.get_strategy_balance(&pool1_id, &f.token);
    let bal2_initial = f.client.get_strategy_balance(&pool2_id, &f.token);
    let bal3_initial = f.client.get_strategy_balance(&pool3_id, &f.token);

    assert_eq!(bal1_initial + bal2_initial + bal3_initial, total_principal);
    assert_eq!(bal1_initial, 1_001);
    assert_eq!(bal2_initial, 1_000);
    assert_eq!(bal3_initial, 999);

    // Initial state is balanced within threshold
    assert_eq!(f.client.check_rebalance_needed(&f.token), false);

    // Simulate uneven yield accrual:
    // Pool 1 generates 600 tokens of yield!
    // Pool 2 and Pool 3 generate 0 tokens of yield.
    let yield_amount = 600_i128;
    f.token_admin.mint(&pool1_id, &yield_amount);
    pool1.accrue_yield(&f.token, &yield_amount);

    // Balances before rebalance:
    let bal1_before = f.client.get_strategy_balance(&pool1_id, &f.token);
    let bal2_before = f.client.get_strategy_balance(&pool2_id, &f.token);
    let bal3_before = f.client.get_strategy_balance(&pool3_id, &f.token);
    let total_capital_before = f.client.get_total_strategy_balance(&f.token);

    assert_eq!(bal1_before, 1_601); // 1001 + 600
    assert_eq!(bal2_before, 1_000);
    assert_eq!(bal3_before, 999);
    assert_eq!(total_capital_before, 3_600);

    // Pool 1 now holds ~44.47% of total capital (vs target 33.34%) -> drift ~11.13% = 1113 bps
    // Default rebalance threshold is 100 bps (1.00%), so check_rebalance_needed must be true!
    assert_eq!(f.client.check_rebalance_needed(&f.token), true);

    // Execute automated rebalance
    f.client.rebalance(&f.token);

    // Verify balances after rebalance:
    // Total capital = 3,600
    // Target 1: 3,600 * 3334 / 10000 = 1200 + 1 (remainder) = 1201
    // Target 2: 3,600 * 3333 / 10000 = 1199 + 1 (remainder) = 1200
    // Target 3: 3,600 * 3333 / 10000 = 1199
    let bal1_after = f.client.get_strategy_balance(&pool1_id, &f.token);
    let bal2_after = f.client.get_strategy_balance(&pool2_id, &f.token);
    let bal3_after = f.client.get_strategy_balance(&pool3_id, &f.token);
    let total_capital_after = f.client.get_total_strategy_balance(&f.token);

    assert_eq!(total_capital_after, 3_600);
    assert_eq!(bal1_after, 1_201);
    assert_eq!(bal2_after, 1_200);
    assert_eq!(bal3_after, 1_199);

    // Excess capital from Pool 1 (1601 - 1201 = 400) was successfully shifted:
    // 200 deposited into Pool 2 (1000 + 200 = 1200)
    // 200 deposited into Pool 3 (999 + 200 = 1199)
    assert_eq!(bal1_after + bal2_after + bal3_after, 3_600);

    // After rebalance, portfolio is balanced and check_rebalance_needed is false
    assert_eq!(f.client.check_rebalance_needed(&f.token), false);
}

#[test]
fn three_way_allocation_with_asymmetric_weights_and_rebalancing() {
    let f = Fixture::new();

    let pool1_id = f.env.register_contract(None, MockLendingPool);
    let pool2_id = f.env.register_contract(None, MockLendingPool);
    let pool3_id = f.env.register_contract(None, MockLendingPool);

    let pool3 = MockLendingPoolClient::new(&f.env, &pool3_id);

    // Asymmetric weights: 50% (5,000 bps), 30% (3,000 bps), 20% (2,000 bps)
    let strategies = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: pool1_id.clone(),
            weight_bps: 5_000,
        },
        StrategyAllocation {
            address: pool2_id.clone(),
            weight_bps: 3_000,
        },
        StrategyAllocation {
            address: pool3_id.clone(),
            weight_bps: 2_000,
        },
    ];
    f.client.set_strategies(&strategies);

    let deposit_amount = 10_000_i128;
    f.token_admin.mint(&f.payer, &deposit_amount);

    f.client.create_escrow(
        &2_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &deposit_amount,
        &100_u32,
        &5_000_u32,
    );

    // Check initial 3-way asymmetric allocation
    assert_eq!(f.client.get_strategy_balance(&pool1_id, &f.token), 5_000);
    assert_eq!(f.client.get_strategy_balance(&pool2_id, &f.token), 3_000);
    assert_eq!(f.client.get_strategy_balance(&pool3_id, &f.token), 2_000);

    // Accrue 2,000 uneven yield on Pool 3
    let yield_amount = 2_000_i128;
    f.token_admin.mint(&pool3_id, &yield_amount);
    pool3.accrue_yield(&f.token, &yield_amount);

    // Total capital is now 12,000
    // Pool 3 has 4,000 (33.33% vs target 20%) -> drift 13.33% = 1333 bps
    assert_eq!(f.client.get_strategy_balance(&pool3_id, &f.token), 4_000);
    assert_eq!(f.client.check_rebalance_needed(&f.token), true);

    // Rebalance
    f.client.rebalance(&f.token);

    // Target balances for 12,000 capital:
    // Pool 1 (50%): 6,000
    // Pool 2 (30%): 3,600
    // Pool 3 (20%): 2,400
    assert_eq!(f.client.get_strategy_balance(&pool1_id, &f.token), 6_000);
    assert_eq!(f.client.get_strategy_balance(&pool2_id, &f.token), 3_600);
    assert_eq!(f.client.get_strategy_balance(&pool3_id, &f.token), 2_400);
    assert_eq!(f.client.get_total_strategy_balance(&f.token), 12_000);
    assert_eq!(f.client.check_rebalance_needed(&f.token), false);
}

#[test]
fn settlement_and_cancel_after_multi_strategy_allocation() {
    let f = Fixture::new();

    let pool1_id = f.env.register_contract(None, MockLendingPool);
    let pool2_id = f.env.register_contract(None, MockLendingPool);

    let pool1 = MockLendingPoolClient::new(&f.env, &pool1_id);
    let pool2 = MockLendingPoolClient::new(&f.env, &pool2_id);

    // 2-way 50/50 allocation
    let strategies = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: pool1_id.clone(),
            weight_bps: 5_000,
        },
        StrategyAllocation {
            address: pool2_id.clone(),
            weight_bps: 5_000,
        },
    ];
    f.client.set_strategies(&strategies);

    let amount = 2_000_i128;
    f.token_admin.mint(&f.payer, &amount);

    f.client.create_escrow(
        &3_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &amount,
        &100_u32,
        &5_000_u32, // 50% split
    );

    assert_eq!(f.client.get_strategy_balance(&pool1_id, &f.token), 1_000);
    assert_eq!(f.client.get_strategy_balance(&pool2_id, &f.token), 1_000);

    // Cancel before deadline refunds payer full principal
    let outcome = f.client.cancel(&3_u64);
    assert_eq!(outcome.principal, 2_000);
    assert_eq!(outcome.to_payer, 2_000);
    assert_eq!(outcome.to_beneficiary, 0);

    assert_eq!(f.token_client.balance(&f.payer), 2_000);
    assert_eq!(f.client.get_active_escrows(), 0);

    // Now test release with yield across multi-strategies
    pool1.set_yield_rate_bps(&f.token, &1_000);
    pool2.set_yield_rate_bps(&f.token, &1_000);

    let amount2 = 1_000_i128;
    f.token_admin.mint(&f.payer, &amount2);

    f.client.create_escrow(
        &4_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &amount2,
        &100_u32,
        &5_000_u32,
    );

    // Both pools accrue yield (50 each = 100 total)
    f.token_admin.mint(&pool1_id, &50);
    pool1.accrue_yield(&f.token, &50);
    f.token_admin.mint(&pool2_id, &50);
    pool2.accrue_yield(&f.token, &50);

    set_timestamp(&f.env, SECONDS_PER_YEAR as u64);
    set_sequence(&f.env, 100);
    let release_outcome = f.client.release(&4_u64);
    assert_eq!(release_outcome.principal, 1_000);
    assert_eq!(release_outcome.interest, 100);
    assert_eq!(release_outcome.to_beneficiary, 1_050); // principal + 50% of 100
    assert_eq!(release_outcome.to_payer, 50); // remainder 50% of 100

    assert_eq!(f.token_client.balance(&f.beneficiary), 1_050);
}

#[test]
fn rebalance_edge_cases_and_threshold_configuration() {
    let f = Fixture::new();

    // Default threshold is 100 bps (1%)
    assert_eq!(f.client.get_rebalance_threshold(), 100);

    // Admin sets new threshold to 250 bps (2.5%)
    f.client.set_rebalance_threshold(&250);
    assert_eq!(f.client.get_rebalance_threshold(), 250);

    // Setting threshold > 10,000 bps fails
    assert_eq!(
        f.client.try_set_rebalance_threshold(&10_001),
        Err(Ok(Error::InvalidThreshold))
    );

    // Rebalance on a single strategy portfolio is a clean no-op
    f.client.rebalance(&f.token);

    // check_rebalance_needed on single strategy returns false
    assert_eq!(f.client.check_rebalance_needed(&f.token), false);

    // Zero balance portfolio returns false and rebalances cleanly
    let p1 = f.env.register_contract(None, MockLendingPool);
    let p2 = f.env.register_contract(None, MockLendingPool);
    let strats = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: p1.clone(),
            weight_bps: 5_000,
        },
        StrategyAllocation {
            address: p2.clone(),
            weight_bps: 5_000,
        },
    ];
    f.client.set_strategies(&strats);
    assert_eq!(f.client.check_rebalance_needed(&f.token), false);
}

#[test]
fn active_escrows_restrict_changing_strategy_addresses() {
    let f = Fixture::new();

    let pool1_id = f.env.register_contract(None, MockLendingPool);
    let pool2_id = f.env.register_contract(None, MockLendingPool);
    let pool3_id = f.env.register_contract(None, MockLendingPool);

    let strats = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: pool1_id.clone(),
            weight_bps: 6_000,
        },
        StrategyAllocation {
            address: pool2_id.clone(),
            weight_bps: 4_000,
        },
    ];
    f.client.set_strategies(&strats);

    // Lock funds
    let amount = 1_000_i128;
    f.token_admin.mint(&f.payer, &amount);
    f.client.create_escrow(
        &5_u64,
        &f.payer,
        &f.beneficiary,
        &f.token,
        &amount,
        &100_u32,
        &1_000_u32,
    );
    assert_eq!(f.client.get_active_escrows(), 1);

    // Attempting to change to a new strategy address while active escrows exist must fail
    let strats_new_addr = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: pool1_id.clone(),
            weight_bps: 6_000,
        },
        StrategyAllocation {
            address: pool3_id.clone(),
            weight_bps: 4_000,
        },
    ];
    assert_eq!(
        f.client.try_set_strategies(&strats_new_addr),
        Err(Ok(Error::ActiveEscrowsRemain))
    );

    // Updating weights for the EXACT SAME strategies while active escrows exist is allowed!
    let strats_reweighted = soroban_sdk::vec![
        &f.env,
        StrategyAllocation {
            address: pool1_id.clone(),
            weight_bps: 5_000,
        },
        StrategyAllocation {
            address: pool2_id.clone(),
            weight_bps: 5_000,
        },
    ];
    f.client.set_strategies(&strats_reweighted);
    assert_eq!(f.client.get_strategies().get(0).unwrap().weight_bps, 5_000);
    assert_eq!(f.client.get_strategies().get(1).unwrap().weight_bps, 5_000);

    // Rebalancing shifts funds to the new target weights
    f.client.rebalance(&f.token);
    assert_eq!(f.client.get_strategy_balance(&pool1_id, &f.token), 500);
    assert_eq!(f.client.get_strategy_balance(&pool2_id, &f.token), 500);
}
