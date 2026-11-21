#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::{symbol_short, Address, Env, String, Symbol, TryIntoVal};

struct Fixture {
    env: Env,
    alice: Address,
    bob: Address,
    client: TagRegistryClient<'static>,
}

impl Fixture {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let id = env.register_contract(None, TagRegistry);
        let client = TagRegistryClient::new(&env, &id);
        client.initialize(&admin, &10, &5);
        Self {
            env,
            alice,
            bob,
            client,
        }
    }

    fn tag(&self, value: &str) -> String {
        String::from_str(&self.env, value)
    }
}

#[test]
fn accepts_only_lowercase_tag_format() {
    let f = Fixture::new();
    f.client.register(&f.alice, &f.tag("a1_b-c"));
    for invalid in [
        "ab",
        "Alic",
        "alice!",
        "has space",
        "abcdefghijklmnopqrstuvwxyz1234567",
    ] {
        assert!(f.client.try_register(&f.alice, &f.tag(invalid)).is_err());
    }
}

#[test]
fn rejects_duplicate_and_tracks_reverse_lookup() {
    let f = Fixture::new();
    let tag = f.tag("alice");
    f.client.register(&f.alice, &tag);
    assert!(f.client.try_register(&f.bob, &tag).is_err());
    assert_eq!(f.client.resolve(&tag), Some(f.alice.clone()));
    assert_eq!(f.client.reverse(&f.alice), soroban_sdk::vec![&f.env, tag]);
}

#[test]
fn transfer_requires_the_current_owner_authentication() {
    let f = Fixture::new();
    let tag = f.tag("alice");
    f.client.register(&f.alice, &tag);
    f.env.mock_auths(&[]);
    assert!(f.client.try_transfer(&tag, &f.bob).is_err());
}

#[test]
fn tag_can_be_reregistered_only_after_expiry_and_grace() {
    let f = Fixture::new();
    let tag = f.tag("alice");
    f.client.register(&f.alice, &tag);
    let expiry = f.env.ledger().sequence() + 10;

    f.env.ledger().set_sequence_number(expiry + 5);
    assert_eq!(f.client.resolve(&tag), Some(f.alice.clone()));
    assert!(f.client.try_register(&f.bob, &tag).is_err());

    f.env.ledger().set_sequence_number(expiry + 6);
    f.client.register(&f.bob, &tag);
    assert_eq!(f.client.resolve(&tag), Some(f.bob.clone()));
    assert!(f.client.reverse(&f.alice).is_empty());
}

#[test]
fn reserved_tags_cannot_be_registered_until_unreserved() {
    let f = Fixture::new();
    let tag = f.tag("admin");
    f.client.reserve(&tag);
    assert_eq!(f.client.resolve(&tag), None);
    assert!(f.client.try_register(&f.alice, &tag).is_err());
    f.client.unreserve(&tag);
    f.client.register(&f.alice, &tag);
    assert_eq!(f.client.resolve(&tag), Some(f.alice.clone()));
}

#[test]
fn owners_are_limited_to_five_tags_and_can_renew() {
    let f = Fixture::new();
    for name in ["one1", "two2", "three", "four", "five"] {
        f.client.register(&f.alice, &f.tag(name));
    }
    assert!(f.client.try_register(&f.alice, &f.tag("sixxx")).is_err());
    let renewed = f.tag("one1");
    f.client.renew(&renewed);
    assert_eq!(f.client.reverse(&f.alice).len(), 5);
}

#[test]
fn publishes_register_transfer_renew_and_release_events() {
    let f = Fixture::new();
    let tag = f.tag("alice");
    f.client.register(&f.alice, &tag);
    f.client.transfer(&tag, &f.bob);
    f.client.renew(&tag);
    f.client.release(&tag);

    let event_names: std::vec::Vec<Symbol> = f
        .env
        .events()
        .all()
        .iter()
        .map(|(_, topics, _)| topics.get(0).unwrap().try_into_val(&f.env).unwrap())
        .collect();
    assert!(event_names.contains(&symbol_short!("register")));
    assert!(event_names.contains(&symbol_short!("transfer")));
    assert!(event_names.contains(&symbol_short!("renew")));
    assert!(event_names.contains(&symbol_short!("release")));
}
