#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

#[test]
fn test_admin_pause_toggle() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentRouter);
    let client = PaymentRouterClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    
    client.initialize(&admin);

    // Default state should not be paused
    assert_eq!(client.is_paused(), false);

    // Pause the contract
    client.pause(&admin);
    assert_eq!(client.is_paused(), true);

    // Unpause the contract
    client.unpause(&admin);
    assert_eq!(client.is_paused(), false);
}

#[test]
#[should_panic(expected = "contract is paused")]
fn test_routing_fails_when_paused() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentRouter);
    let client = PaymentRouterClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin);

    client.pause(&admin);

    // Setup accounts and token
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let treasury = Address::generate(&env);
    
    // Pass a dummy address for the token
    let token_address = Address::generate(&env);

    client.route_payment(
        &sender,
        &recipient,
        &treasury,
        &token_address,
        &1000,
    );
}

#[test]
#[should_panic(expected = "not admin")]
fn test_pause_not_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentRouter);
    let client = PaymentRouterClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let not_admin = Address::generate(&env);
    client.initialize(&admin);

    client.pause(&not_admin);
}
