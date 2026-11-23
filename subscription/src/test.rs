#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Symbol, TryFromVal,
};

fn setup() -> (
    Env,
    Address,
    SubscriptionContractClient<'static>,
    Address,
    Address,
    TokenClient<'static>,
    StellarAssetClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, SubscriptionContract);
    let client = SubscriptionContractClient::new(&env, &contract_id);

    let payer = Address::generate(&env);
    let merchant = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin);
    let token = TokenClient::new(&env, &token_id);
    let token_admin_client = StellarAssetClient::new(&env, &token_id);

    (
        env,
        contract_id,
        client,
        payer,
        merchant,
        token,
        token_admin_client,
    )
}

fn advance_time(env: &Env, seconds: u64) {
    env.ledger().with_mut(|l| {
        l.timestamp += seconds;
    });
}

#[test]
fn create_and_get_subscription() {
    let (env, contract_id, client, payer, merchant, token, _admin) = setup();

    let id = client.create(&payer, &merchant, &token.address, &100, &3600, &12);
    assert_eq!(id, 1);

    let sub = client.get(&id).expect("subscription should exist");
    assert_eq!(sub.id, 1);
    assert_eq!(sub.payer, payer);
    assert_eq!(sub.merchant, merchant);
    assert_eq!(sub.token, token.address);
    assert_eq!(sub.amount_per_period, 100);
    assert_eq!(sub.period_seconds, 3600);
    assert_eq!(sub.max_periods, 12);
    assert_eq!(sub.charged_count, 0);
    assert_eq!(sub.last_charged_at, env.ledger().timestamp());
    assert!(sub.active);

    assert_eq!(client.list_by_payer(&payer), Vec::from_array(&env, [1u64]));
    assert_eq!(
        client.list_by_merchant(&merchant),
        Vec::from_array(&env, [1u64])
    );

    let created = env.events().all().iter().find(|(_, topics, _)| {
        if topics.len() != 2 {
            return false;
        }
        let t0: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
        let t1: u64 = u64::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        t0 == symbol_short!("created") && t1 == id
    });
    assert!(created.is_some(), "created event should be emitted");
    let _ = contract_id;
}

#[test]
fn first_charge_after_one_period() {
    let (env, contract_id, client, payer, merchant, token, admin) = setup();

    let id = client.create(&payer, &merchant, &token.address, &100, &3600, &3);
    admin.mint(&payer, &1_000);
    token.approve(&payer, &contract_id, &1_000, &10_000);

    advance_time(&env, 3600);
    let charged = client.charge(&id);
    assert_eq!(charged, 1);

    assert_eq!(token.balance(&payer), 900);
    assert_eq!(token.balance(&merchant), 100);
    let sub = client.get(&id).unwrap();
    assert_eq!(sub.charged_count, 1);
}

#[test]
fn charge_too_early_rejected() {
    let (env, contract_id, client, payer, merchant, token, admin) = setup();

    let id = client.create(&payer, &merchant, &token.address, &100, &3600, &3);
    admin.mint(&payer, &1_000);
    token.approve(&payer, &contract_id, &1_000, &10_000);

    advance_time(&env, 3599);
    let err = client.try_charge(&id).err().unwrap();
    assert_eq!(err, Ok(Error::TooEarly));

    assert_eq!(token.balance(&merchant), 0);
    assert_eq!(client.get(&id).unwrap().charged_count, 0);
}

#[test]
fn missed_periods_caught_up() {
    let (env, contract_id, client, payer, merchant, token, admin) = setup();

    let id = client.create(&payer, &merchant, &token.address, &50, &100, &10);
    admin.mint(&payer, &1_000);
    token.approve(&payer, &contract_id, &1_000, &10_000);

    // 3 full periods have elapsed.
    advance_time(&env, 350);
    let charged = client.charge(&id);
    assert_eq!(charged, 3);

    assert_eq!(token.balance(&payer), 850);
    assert_eq!(token.balance(&merchant), 150);
    let sub = client.get(&id).unwrap();
    assert_eq!(sub.charged_count, 3);
    assert_eq!(sub.last_charged_at, env.ledger().timestamp() - 50);
}

#[test]
fn max_periods_reached() {
    let (env, contract_id, client, payer, merchant, token, admin) = setup();

    let id = client.create(&payer, &merchant, &token.address, &10, &100, &2);
    admin.mint(&payer, &1_000);
    token.approve(&payer, &contract_id, &1_000, &10_000);

    advance_time(&env, 250);
    assert_eq!(client.charge(&id), 2);
    assert_eq!(token.balance(&merchant), 20);
    assert_eq!(client.get(&id).unwrap().charged_count, 2);

    advance_time(&env, 200);
    let err = client.try_charge(&id).err().unwrap();
    assert_eq!(err, Ok(Error::MaxPeriodsReached));
}

#[test]
fn cancel_by_payer_and_no_further_charges() {
    let (env, contract_id, client, payer, merchant, token, admin) = setup();

    let id = client.create(&payer, &merchant, &token.address, &10, &100, &5);
    admin.mint(&payer, &1_000);
    token.approve(&payer, &contract_id, &1_000, &10_000);

    client.cancel(&payer, &id);
    let sub = client.get(&id).unwrap();
    assert!(!sub.active);

    advance_time(&env, 200);
    let err = client.try_charge(&id).err().unwrap();
    assert_eq!(err, Ok(Error::NotActive));

    let canceled = env.events().all().iter().any(|(_, topics, _)| {
        if topics.len() != 2 {
            return false;
        }
        let t0: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
        let t1: u64 = u64::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        t0 == Symbol::new(&env, "cancelled") && t1 == id
    });
    assert!(canceled, "cancelled event should be emitted");
}

#[test]
fn cancel_by_merchant() {
    let (env, contract_id, client, payer, merchant, token, admin) = setup();

    let id = client.create(&payer, &merchant, &token.address, &10, &100, &5);
    admin.mint(&payer, &1_000);
    token.approve(&payer, &contract_id, &1_000, &10_000);

    client.cancel(&merchant, &id);
    assert!(!client.get(&id).unwrap().active);

    advance_time(&env, 100);
    assert_eq!(client.try_charge(&id).err().unwrap(), Ok(Error::NotActive));
}

#[test]
fn insufficient_allowance_emits_charge_failed_without_panic() {
    let (env, contract_id, client, payer, merchant, token, admin) = setup();

    let id = client.create(&payer, &merchant, &token.address, &100, &100, &3);
    admin.mint(&payer, &1_000);
    // No approval: transfer_from must fail and be reported as charge_failed.
    advance_time(&env, 100);

    let charged = client.charge(&id);
    assert_eq!(charged, 0);
    assert_eq!(token.balance(&merchant), 0);
    assert_eq!(client.get(&id).unwrap().charged_count, 0);

    let failed = env.events().all().iter().any(|(_, topics, _)| {
        if topics.len() != 2 {
            return false;
        }
        let t0: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
        let t1: u64 = u64::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        t0 == Symbol::new(&env, "charge_failed") && t1 == id
    });
    assert!(failed, "charge_failed event should be emitted");
    let _ = contract_id;
}

#[test]
fn insufficient_balance_emits_charge_failed_without_panic() {
    let (env, contract_id, client, payer, merchant, token, admin) = setup();

    let id = client.create(&payer, &merchant, &token.address, &100, &100, &3);
    admin.mint(&payer, &50);
    token.approve(&payer, &contract_id, &1_000, &10_000);

    advance_time(&env, 100);
    let charged = client.charge(&id);
    assert_eq!(charged, 0);
    assert_eq!(token.balance(&merchant), 0);
    assert_eq!(client.get(&id).unwrap().charged_count, 0);

    let failed = env.events().all().iter().any(|(_, topics, _)| {
        if topics.len() != 2 {
            return false;
        }
        let t0: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
        let t1: u64 = u64::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        t0 == Symbol::new(&env, "charge_failed") && t1 == id
    });
    assert!(failed, "charge_failed event should be emitted");
}
