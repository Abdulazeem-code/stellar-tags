#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Map, Symbol, TryFromVal,
};

struct Setup {
    env: Env,
    contract_id: Address,
    client: SplitBillContractClient<'static>,
    organiser: Address,
    recipient: Address,
    token: TokenClient<'static>,
    token_admin: StellarAssetClient<'static>,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, SplitBillContract);
    let client = SplitBillContractClient::new(&env, &contract_id);

    let organiser = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin_addr = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin_addr);
    let token = TokenClient::new(&env, &token_id);
    let token_admin = StellarAssetClient::new(&env, &token_id);

    Setup {
        env,
        contract_id,
        client,
        organiser,
        recipient,
        token,
        token_admin,
    }
}

fn set_time(env: &Env, ts: u64) {
    env.ledger().with_mut(|l| {
        l.timestamp = ts;
    });
}

fn has_event(env: &Env, contract_id: &Address, name: &str, id: u64) -> bool {
    env.events().all().iter().any(|(addr, topics, _)| {
        if &addr != contract_id || topics.len() != 2 {
            return false;
        }
        let t0: Symbol = match Symbol::try_from_val(env, &topics.get(0).unwrap()) {
            Ok(v) => v,
            Err(_) => return false,
        };
        let t1: u64 = match u64::try_from_val(env, &topics.get(1).unwrap()) {
            Ok(v) => v,
            Err(_) => return false,
        };
        t0 == Symbol::new(env, name) && t1 == id
    })
}

#[test]
fn full_payment_releases_funds_and_zero_balance() {
    let s = setup();
    set_time(&s.env, 100);

    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let mut shares = Map::new(&s.env);
    shares.set(alice.clone(), 40);
    shares.set(bob.clone(), 60);

    s.token_admin.mint(&alice, &100);
    s.token_admin.mint(&bob, &100);

    let id = s
        .client
        .create(&s.organiser, &s.recipient, &s.token.address, &shares, &200);

    s.client.pay(&id, &alice);
    assert_eq!(s.token.balance(&s.contract_id), 40);
    assert_eq!(s.token.balance(&s.recipient), 0);
    let bill = s.client.get(&id).unwrap();
    assert_eq!(bill.status, BillStatus::Open);
    assert!(bill.paid.get(alice.clone()).unwrap());
    assert!(!bill.paid.get(bob.clone()).unwrap());

    s.client.pay(&id, &bob);
    assert_eq!(s.token.balance(&s.recipient), 100);
    assert_eq!(s.token.balance(&s.contract_id), 0);
    let bill = s.client.get(&id).unwrap();
    assert_eq!(bill.status, BillStatus::Completed);
    assert!(bill.paid.get(bob).unwrap());

    assert!(has_event(&s.env, &s.contract_id, "created", id));
    assert!(has_event(&s.env, &s.contract_id, "paid", id));
    assert!(has_event(&s.env, &s.contract_id, "released", id));
}

#[test]
fn partial_payment_then_refund_after_deadline() {
    let s = setup();
    set_time(&s.env, 100);

    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let carol = Address::generate(&s.env);
    let mut shares = Map::new(&s.env);
    shares.set(alice.clone(), 30);
    shares.set(bob.clone(), 50);
    shares.set(carol.clone(), 20);

    s.token_admin.mint(&alice, &100);
    s.token_admin.mint(&bob, &100);
    s.token_admin.mint(&carol, &100);

    let id = s
        .client
        .create(&s.organiser, &s.recipient, &s.token.address, &shares, &150);

    s.client.pay(&id, &alice);
    s.client.pay(&id, &bob);
    assert_eq!(s.token.balance(&s.contract_id), 80);
    assert_eq!(s.token.balance(&alice), 70);
    assert_eq!(s.token.balance(&bob), 50);
    assert_eq!(s.token.balance(&carol), 100);

    set_time(&s.env, 151);
    s.client.refund(&id);

    assert_eq!(s.token.balance(&alice), 100);
    assert_eq!(s.token.balance(&bob), 100);
    assert_eq!(s.token.balance(&carol), 100);
    assert_eq!(s.token.balance(&s.recipient), 0);
    assert_eq!(s.token.balance(&s.contract_id), 0);

    let bill = s.client.get(&id).unwrap();
    assert_eq!(bill.status, BillStatus::Refunded);
    assert!(has_event(&s.env, &s.contract_id, "refunded", id));
}

#[test]
fn refund_before_deadline_rejected() {
    let s = setup();
    set_time(&s.env, 100);

    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let mut shares = Map::new(&s.env);
    shares.set(alice.clone(), 25);
    shares.set(bob.clone(), 35);
    s.token_admin.mint(&alice, &100);
    s.token_admin.mint(&bob, &100);

    let id = s
        .client
        .create(&s.organiser, &s.recipient, &s.token.address, &shares, &200);

    s.client.pay(&id, &alice);

    set_time(&s.env, 200);
    let err = s.client.try_refund(&id).err().unwrap();
    assert_eq!(err, Ok(Error::DeadlineNotPassed));

    set_time(&s.env, 199);
    let err = s.client.try_refund(&id).err().unwrap();
    assert_eq!(err, Ok(Error::DeadlineNotPassed));

    assert_eq!(s.token.balance(&s.contract_id), 25);
    assert_eq!(s.client.get(&id).unwrap().status, BillStatus::Open);
}

#[test]
fn double_payment_rejected() {
    let s = setup();
    set_time(&s.env, 100);

    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let mut shares = Map::new(&s.env);
    shares.set(alice.clone(), 10);
    shares.set(bob.clone(), 20);
    s.token_admin.mint(&alice, &100);
    s.token_admin.mint(&bob, &100);

    let id = s
        .client
        .create(&s.organiser, &s.recipient, &s.token.address, &shares, &200);

    s.client.pay(&id, &alice);
    let err = s.client.try_pay(&id, &alice).err().unwrap();
    assert_eq!(err, Ok(Error::AlreadyPaid));

    assert_eq!(s.token.balance(&alice), 90);
    assert_eq!(s.token.balance(&s.contract_id), 10);
}

#[test]
fn non_participant_payment_rejected() {
    let s = setup();
    set_time(&s.env, 100);

    let alice = Address::generate(&s.env);
    let eve = Address::generate(&s.env);
    let mut shares = Map::new(&s.env);
    shares.set(alice.clone(), 10);
    s.token_admin.mint(&alice, &100);
    s.token_admin.mint(&eve, &100);

    let id = s
        .client
        .create(&s.organiser, &s.recipient, &s.token.address, &shares, &200);

    let err = s.client.try_pay(&id, &eve).err().unwrap();
    assert_eq!(err, Ok(Error::NotParticipant));

    assert_eq!(s.token.balance(&eve), 100);
    assert_eq!(s.token.balance(&s.contract_id), 0);
}

#[test]
fn cancel_before_first_payment_succeeds_and_zero_balance() {
    let s = setup();
    set_time(&s.env, 100);

    let alice = Address::generate(&s.env);
    let mut shares = Map::new(&s.env);
    shares.set(alice, 10);

    let id = s
        .client
        .create(&s.organiser, &s.recipient, &s.token.address, &shares, &200);

    s.client.cancel(&s.organiser, &id);

    let bill = s.client.get(&id).unwrap();
    assert_eq!(bill.status, BillStatus::Cancelled);
    assert_eq!(s.token.balance(&s.contract_id), 0);
    assert!(has_event(&s.env, &s.contract_id, "canceled", id));
}

#[test]
fn cancel_after_first_payment_rejected() {
    let s = setup();
    set_time(&s.env, 100);

    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let mut shares = Map::new(&s.env);
    shares.set(alice.clone(), 10);
    shares.set(bob.clone(), 20);
    s.token_admin.mint(&alice, &100);
    s.token_admin.mint(&bob, &100);

    let id = s
        .client
        .create(&s.organiser, &s.recipient, &s.token.address, &shares, &200);

    s.client.pay(&id, &alice);

    let err = s.client.try_cancel(&s.organiser, &id).err().unwrap();
    assert_eq!(err, Ok(Error::AlreadyHasPayments));

    assert_eq!(s.client.get(&id).unwrap().status, BillStatus::Open);
    assert_eq!(s.token.balance(&s.contract_id), 10);
}

#[test]
fn get_returns_shares_paid_and_status() {
    let s = setup();
    set_time(&s.env, 100);

    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let mut shares = Map::new(&s.env);
    shares.set(alice.clone(), 7);
    shares.set(bob.clone(), 3);
    s.token_admin.mint(&alice, &100);
    s.token_admin.mint(&bob, &100);

    let id = s
        .client
        .create(&s.organiser, &s.recipient, &s.token.address, &shares, &200);

    let view = s.client.get(&id).unwrap();
    assert_eq!(view.id, id);
    assert_eq!(view.organiser, s.organiser);
    assert_eq!(view.recipient, s.recipient);
    assert_eq!(view.token, s.token.address);
    assert_eq!(view.deadline, 200);
    assert_eq!(view.status, BillStatus::Open);
    assert_eq!(view.shares.get(alice.clone()).unwrap(), 7);
    assert_eq!(view.shares.get(bob.clone()).unwrap(), 3);
    assert!(!view.paid.get(alice.clone()).unwrap());
    assert!(!view.paid.get(bob.clone()).unwrap());

    s.client.pay(&id, &alice);
    let view = s.client.get(&id).unwrap();
    assert!(view.paid.get(alice).unwrap());
    assert!(!view.paid.get(bob).unwrap());
    assert_eq!(view.status, BillStatus::Open);
}
