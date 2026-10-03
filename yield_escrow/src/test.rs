#![cfg(test)]

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
}

#[contract]
struct MockLendingPool;

#[contractimpl]
impl MockLendingPool {
    pub fn deposit(env: Env, from: Address, token: Address, amount: i128) {
        from.require_auth();
        token::Client::new(&env, &token).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );
        let key = MockLendingKey::Principal(token);
        let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
        env.storage().instance().set(&key, &(current + amount));
    }

    pub fn withdraw(env: Env, to: Address, token: Address, amount: i128) {
        let key = MockLendingKey::Principal(token.clone());
        let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
        assert!(current >= amount);
        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        env.storage().instance().set(&key, &(current - amount));
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

    /// Test helper: records interest the pool will pay on the next `harvest`.
    pub fn accrue_yield(env: Env, token: Address, amount: i128) {
        let key = MockLendingKey::Yield(token);
        let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
        env.storage().instance().set(&key, &(current + amount));
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
    assert_eq!(client.try_set_adapter(&adapter), Err(Ok(Error::NotInitialized)));

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
            &1_u64, &f.payer, &f.beneficiary, &f.token, &0_i128, &150_u32, &100_u32
        ),
        Err(Ok(Error::InvalidAmount))
    );
    // The ledger sequence is still 0, so a deadline of 0 is not in the future.
    assert_eq!(
        f.client.try_create_escrow(
            &2_u64, &f.payer, &f.beneficiary, &f.token, &100_i128, &0_u32, &100_u32
        ),
        Err(Ok(Error::InvalidReleaseLedger))
    );
    assert_eq!(
        f.client.try_create_escrow(
            &3_u64, &f.payer, &f.beneficiary, &f.token, &100_i128, &150_u32, &10_001_u32
        ),
        Err(Ok(Error::InvalidInterestSplit))
    );

    f.client
        .create_escrow(&4_u64, &f.payer, &f.beneficiary, &f.token, &100_i128, &150_u32, &100_u32);
    assert_eq!(
        f.client.try_create_escrow(
            &4_u64, &f.payer, &f.beneficiary, &f.token, &100_i128, &150_u32, &100_u32
        ),
        Err(Ok(Error::EscrowExists))
    );

    assert_eq!(f.client.try_get_escrow(&99_u64), Err(Ok(Error::EscrowNotFound)));
    assert_eq!(f.client.try_release(&99_u64), Err(Ok(Error::EscrowNotFound)));
    assert_eq!(f.client.try_cancel(&99_u64), Err(Ok(Error::EscrowNotFound)));
}

// ── Release ──────────────────────────────────────────────────────────────────

#[test]
fn release_splits_principal_and_accrued_interest() {
    let f = Fixture::new();
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
    assert_eq!(f.client.try_release(&1_u64), Err(Ok(Error::EscrowNotActive)));
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

    assert_eq!(f.client.try_release(&3_u64), Err(Ok(Error::NotYetReleasable)));

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
    assert_eq!(f.client.try_cancel(&11_u64), Err(Ok(Error::EscrowNotActive)));

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
