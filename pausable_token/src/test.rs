#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::{Address, Env, String, Symbol, TryFromVal, Vec};

struct Fixture {
    env: Env,
    admin: Address,
    alice: Address,
    bob: Address,
    token: PausableTokenClient<'static>,
}

impl Fixture {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let id = env.register_contract(None, PausableToken);
        let token = PausableTokenClient::new(&env, &id);

        token.initialize(
            &admin,
            &String::from_str(&env, "Pausable USD"),
            &String::from_str(&env, "PUSD"),
            &7,
        );

        token.mint(&alice, &1_000_000);
        token.mint(&bob, &1_000_000);

        Fixture {
            env,
            admin,
            alice,
            bob,
            token,
        }
    }

    fn ledger(&self) -> u32 {
        self.env.ledger().sequence()
    }
}

#[test]
fn reports_token_metadata() {
    let f = Fixture::new();
    assert_eq!(f.token.name(), String::from_str(&f.env, "Pausable USD"));
    assert_eq!(f.token.symbol(), String::from_str(&f.env, "PUSD"));
    assert_eq!(f.token.decimals(), 7);
    assert_eq!(f.token.total_supply(), 2_000_000);
    assert_eq!(f.token.balance(&f.alice), 1_000_000);
    assert_eq!(f.token.balance(&f.bob), 1_000_000);
}

#[test]
fn transfers_between_accounts() {
    let f = Fixture::new();
    f.token.transfer(&f.alice, &f.bob, &250_000);
    assert_eq!(f.token.balance(&f.alice), 750_000);
    assert_eq!(f.token.balance(&f.bob), 1_250_000);
    assert_eq!(f.token.total_supply(), 2_000_000);
}

#[test]
fn spenders_move_funds_under_an_allowance() {
    let f = Fixture::new();
    let spender = Address::generate(&f.env);

    f.token
        .approve(&f.alice, &spender, &300_000, &(f.ledger() + 1_000));
    assert_eq!(f.token.allowance(&f.alice, &spender), 300_000);

    f.token.transfer_from(&spender, &f.alice, &f.bob, &120_000);
    assert_eq!(f.token.allowance(&f.alice, &spender), 180_000);
    assert_eq!(f.token.balance(&f.alice), 880_000);
    assert_eq!(f.token.balance(&f.bob), 1_120_000);
}

#[test]
fn burn_reduces_balance_and_supply() {
    let f = Fixture::new();

    f.token.burn(&f.alice, &400_000);
    assert_eq!(f.token.balance(&f.alice), 600_000);
    assert_eq!(f.token.total_supply(), 1_600_000);
}

#[test]
fn allowance_expires_and_reads_as_zero() {
    let f = Fixture::new();
    let spender = Address::generate(&f.env);

    let issued_at = f.ledger();
    f.token
        .approve(&f.alice, &spender, &300_000, &(issued_at + 10));
    assert_eq!(f.token.allowance(&f.alice, &spender), 300_000);

    let expired_at = issued_at + 11;
    f.env
        .ledger()
        .with_mut(|info| info.sequence_number = expired_at);
    assert_eq!(f.token.allowance(&f.alice, &spender), 0);
}

#[test]
fn pause_blocks_every_movement_and_unpause_restores_it() {
    let f = Fixture::new();
    let spender = Address::generate(&f.env);
    f.token
        .approve(&f.alice, &spender, &10, &(f.ledger() + 1_000));

    assert!(!f.token.is_paused());
    assert!(f.token.transfer_allowed(&f.alice, &f.bob));

    f.token.pause();
    assert!(f.token.is_paused());

    // No holder may send or receive while paused, and the spender path is
    // covered too because it moves someone else's balance.
    assert!(!f.token.transfer_allowed(&f.alice, &f.bob));
    assert!(!f.token.transfer_allowed(&f.bob, &f.alice));
    assert!(!f.token.transfer_allowed(&f.alice, &spender));

    // Reads stay available so wallets can still render state.
    assert_eq!(f.token.balance(&f.alice), 1_000_000);
    assert_eq!(f.token.total_supply(), 2_000_000);
    assert_eq!(f.token.allowance(&f.alice, &spender), 10);

    f.token.unpause();
    assert!(!f.token.is_paused());
    assert!(f.token.transfer_allowed(&f.alice, &f.bob));
    f.token.transfer(&f.alice, &f.bob, &1);
    assert_eq!(f.token.balance(&f.bob), 1_000_001);
}

#[test]
fn pause_is_reversible_through_set_paused() {
    let f = Fixture::new();

    f.token.set_paused(&true);
    assert!(f.token.is_paused());
    assert!(!f.token.transfer_allowed(&f.alice, &f.bob));

    f.token.set_paused(&false);
    assert!(!f.token.is_paused());
    assert!(f.token.transfer_allowed(&f.alice, &f.bob));
}

#[test]
fn freezing_blocks_an_account_in_both_directions_only() {
    let f = Fixture::new();

    f.token.freeze(&f.alice);
    assert!(f.token.is_frozen(&f.alice));
    assert!(!f.token.is_frozen(&f.bob));

    assert!(!f.token.transfer_allowed(&f.alice, &f.bob));
    assert!(!f.token.transfer_allowed(&f.bob, &f.alice));

    // Everyone else is untouched and can still move funds.
    assert!(f.token.transfer_allowed(&f.bob, &f.admin));
    f.token.transfer(&f.bob, &f.admin, &10);
    assert_eq!(f.token.balance(&f.admin), 10);

    // Freezing does not seize or burn the balance.
    assert_eq!(f.token.balance(&f.alice), 1_000_000);
    assert_eq!(f.token.total_supply(), 2_000_000);

    f.token.unfreeze(&f.alice);
    assert!(!f.token.is_frozen(&f.alice));
    assert!(f.token.transfer_allowed(&f.alice, &f.bob));
    f.token.transfer(&f.alice, &f.bob, &1);
    // bob started at 1_000_000, sent 10 above, and has just received 1.
    assert_eq!(f.token.balance(&f.bob), 999_991);
}

#[test]
fn freezing_is_reversible_through_set_frozen() {
    let f = Fixture::new();

    f.token.set_frozen(&f.bob, &true);
    assert!(f.token.is_frozen(&f.bob));
    assert!(!f.token.transfer_allowed(&f.bob, &f.alice));

    f.token.set_frozen(&f.bob, &false);
    assert!(!f.token.is_frozen(&f.bob));
    assert!(f.token.transfer_allowed(&f.bob, &f.alice));
}

#[test]
fn freeze_and_pause_lift_independently() {
    let f = Fixture::new();

    f.token.freeze(&f.alice);
    f.token.pause();

    // The global switch is reported first while it is still engaged.
    f.token.unpause();
    assert!(!f.token.is_paused());
    // The per-account freeze is still in force and is the reason transfers
    // remain blocked.
    assert!(!f.token.transfer_allowed(&f.alice, &f.bob));

    f.token.unfreeze(&f.alice);
    assert!(f.token.transfer_allowed(&f.alice, &f.bob));
    f.token.transfer(&f.alice, &f.bob, &1);
    assert_eq!(f.token.balance(&f.bob), 1_000_001);
}

#[test]
fn frozen_spender_cannot_be_used_to_move_someone_elses_funds() {
    let f = Fixture::new();
    let spender = Address::generate(&f.env);

    f.token
        .approve(&f.alice, &spender, &300_000, &(f.ledger() + 1_000));
    f.token.freeze(&spender);

    // The frozen spender is blocked, but the allowance holder is untouched.
    assert!(!f.token.transfer_allowed(&f.alice, &spender));
    assert!(f.token.transfer_allowed(&f.alice, &f.bob));
    assert_eq!(f.token.balance(&f.alice), 1_000_000);

    f.token.unfreeze(&spender);
    f.token.transfer_from(&spender, &f.alice, &f.bob, &1_000);
    assert_eq!(f.token.allowance(&f.alice, &spender), 299_000);
    assert_eq!(f.token.balance(&f.bob), 1_001_000);
}

#[test]
fn initialize_cannot_be_repeated_to_seize_the_contract() {
    let f = Fixture::new();
    let attacker = Address::generate(&f.env);

    let result = f.token.try_initialize(
        &attacker,
        &String::from_str(&f.env, "Hijacked"),
        &String::from_str(&f.env, "HJK"),
        &7,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::AlreadyInitialized);
    assert_eq!(f.token.admin(), f.admin);
    assert_eq!(f.token.symbol(), String::from_str(&f.env, "PUSD"));
    assert_eq!(f.token.decimals(), 7);
}

#[test]
fn admin_handover_moves_every_privilege() {
    let f = Fixture::new();
    let new_admin = Address::generate(&f.env);

    f.token.set_admin(&new_admin);
    assert_eq!(f.token.admin(), new_admin);

    f.token.mint(&new_admin, &5);
    assert_eq!(f.token.balance(&new_admin), 5);

    f.token.pause();
    assert!(f.token.is_paused());
    f.token.unpause();
    assert!(!f.token.is_paused());

    f.token.freeze(&f.bob);
    assert!(f.token.is_frozen(&f.bob));
    f.token.unfreeze(&f.bob);
    assert!(!f.token.is_frozen(&f.bob));
}

#[test]
fn frozen_address_cannot_be_installed_as_admin() {
    let f = Fixture::new();
    let candidate = Address::generate(&f.env);

    f.token.freeze(&candidate);
    let result = f.token.try_set_admin(&candidate);

    assert_eq!(result.unwrap_err().unwrap(), Error::AccountFrozen);
    assert_eq!(f.token.admin(), f.admin);
}

#[test]
fn admin_address_is_exposed_and_stable() {
    let f = Fixture::new();
    assert_eq!(f.token.admin(), f.admin);
    assert_eq!(f.token.admin(), f.admin);
}

#[test]
fn mint_increases_supply_only_for_the_recipient() {
    let f = Fixture::new();
    let carol = Address::generate(&f.env);

    f.token.mint(&carol, &750);
    assert_eq!(f.token.balance(&carol), 750);
    assert_eq!(f.token.total_supply(), 2_000_750);
    assert_eq!(f.token.balance(&f.alice), 1_000_000);

    let result = f.token.try_mint(&carol, &0);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidAmount);
}

#[test]
fn mint_is_blocked_for_a_frozen_recipient() {
    let f = Fixture::new();
    let carol = Address::generate(&f.env);

    f.token.freeze(&carol);
    let result = f.token.try_mint(&carol, &10);

    assert_eq!(result.unwrap_err().unwrap(), Error::AccountFrozen);
    assert_eq!(f.token.balance(&carol), 0);
    assert_eq!(f.token.total_supply(), 2_000_000);
}

#[test]
fn mint_is_blocked_while_paused() {
    let f = Fixture::new();
    let carol = Address::generate(&f.env);

    f.token.pause();
    let result = f.token.try_mint(&carol, &10);

    assert_eq!(result.unwrap_err().unwrap(), Error::Paused);
    assert_eq!(f.token.total_supply(), 2_000_000);
}

#[test]
fn emits_standard_transfer_and_control_events() {
    let f = Fixture::new();

    f.token.transfer(&f.alice, &f.bob, &1_000);
    f.token.pause();
    f.token.freeze(&f.bob);

    let mut names: Vec<Symbol> = Vec::new(&f.env);
    for (_, topics, _) in f.env.events().all() {
        if let Some(first) = topics.first() {
            if let Ok(name) = Symbol::try_from_val(&f.env, &first) {
                names.push_back(name);
            }
        }
    }

    assert!(names.contains(symbol_short!("transfer")));
    assert!(names.contains(symbol_short!("paused")));
    assert!(names.contains(symbol_short!("frozen")));
    assert!(names.contains(symbol_short!("init")));
}
