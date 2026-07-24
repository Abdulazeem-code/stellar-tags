#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Env, Address};
use soroban_sdk::token::Client as TokenClient;
use soroban_sdk::token::StellarAssetClient;

#[test]
fn test_successful_xlm_routing() {
    let env = Env::default();
    env.mock_all_auths();

    // Setup participants
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let platform_treasury = Address::generate(&env);

    // Deploy contract
    let contract_id = env.register_contract(None, PaymentRouter);
    let client = PaymentRouterClient::new(&env, &contract_id);

    client.init(&admin);

    // Deploy mock token (XLM)
    let token_admin = Address::generate(&env);
    let token_address = env.register_stellar_asset_contract(token_admin.clone());
    let token_admin_client = StellarAssetClient::new(&env, &token_address);
    let token_client = TokenClient::new(&env, &token_address);

    // Mint tokens to sender
    let initial_balance = 1_000_000_000;
    token_admin_client.mint(&sender, &initial_balance);

    assert_eq!(token_client.balance(&sender), initial_balance);
    assert_eq!(token_client.balance(&recipient), 0);
    assert_eq!(token_client.balance(&platform_treasury), 0);

    // Route payment
    let amount = 100_000_000;
    client.route_payment(&sender, &recipient, &platform_treasury, &token_address, &amount);

    // Verify balances
    // Fee = 40 bps = 40 / 10000 = 0.004 of amount.
    // 0.004 * 100_000_000 = 400_000.
    let expected_fee = 400_000;
    let expected_recipient_amount = amount - expected_fee;

    assert_eq!(token_client.balance(&sender), initial_balance - amount);
    assert_eq!(token_client.balance(&recipient), expected_recipient_amount);
    assert_eq!(token_client.balance(&platform_treasury), expected_fee);
}
