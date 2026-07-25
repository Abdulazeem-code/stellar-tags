#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token, Address, Env};

#[test]
fn test_initialize_and_auth() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentRouter);
    let client = PaymentRouterClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin);

    assert_eq!(client.get_admin(), Some(admin.clone()));
}

#[test]
fn test_set_config_with_admin_auth() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentRouter);
    let client = PaymentRouterClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin);

    // Initial config is default
    let default_cfg = client.get_config();
    assert_eq!(default_cfg.fee_bps, 40);
    assert_eq!(default_cfg.fee_cap_xlm, 30);

    // Admin updates config
    client.set_config(&admin, &50, &50);

    let new_cfg = client.get_config();
    assert_eq!(new_cfg.fee_bps, 50);
    assert_eq!(new_cfg.fee_cap_xlm, 50);
}

#[test]
fn test_set_admin_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentRouter);
    let client = PaymentRouterClient::new(&env, &contract_id);

    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);

    client.initialize(&admin1);
    assert_eq!(client.get_admin(), Some(admin1.clone()));

    client.set_admin(&admin1, &admin2);
    assert_eq!(client.get_admin(), Some(admin2.clone()));
}

#[test]
fn test_route_payment_verifies_sender_auth() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, PaymentRouter);
    let client = PaymentRouterClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let treasury = Address::generate(&env);

    // Setup mock token
    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract(token_admin);
    let token_client = token::Client::new(&env, &token_contract);
    let token_admin_client = token::StellarAssetClient::new(&env, &token_contract);

    token_admin_client.mint(&sender, &10_000_000_000);

    let initial_sender_bal = token_client.balance(&sender);
    assert_eq!(initial_sender_bal, 10_000_000_000);

    // Route payment of 1,000,000,000 stroops (100 XLM)
    // Fee = 40 bps (0.4%) = 4,000,000 stroops
    client.route_payment(&sender, &recipient, &treasury, &token_contract, &1_000_000_000);

    assert_eq!(token_client.balance(&treasury), 4_000_000);
    assert_eq!(token_client.balance(&recipient), 996_000_000);
    assert_eq!(token_client.balance(&sender), 9_000_000_000);
}
