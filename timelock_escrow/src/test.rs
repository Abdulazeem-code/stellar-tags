#![cfg(test)]

use crate::{Error, TimelockEscrow, TimelockEscrowClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env,
};

fn create_token_contract<'a>(
    e: &Env,
    admin: &Address,
) -> (token::Client<'a>, token::StellarAssetClient<'a>) {
    let address = e.register_stellar_asset_contract(admin.clone());
    (
        token::Client::new(e, &address),
        token::StellarAssetClient::new(e, &address),
    )
}

#[test]
fn test_escrow_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

    let depositor = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &token_admin);

    let escrow_contract_id = env.register_contract(None, TimelockEscrow);
    let escrow_client = TimelockEscrowClient::new(&env, &escrow_contract_id);

    // Mint tokens to depositor
    token_admin.mint(&depositor, &1000);
    assert_eq!(token.balance(&depositor), 1000);

    // Setup ledger time
    env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });

    let release_time = 2000;

    // Deposit
    let id = escrow_client.deposit(&depositor, &recipient, &token.address, &500, &release_time);
    assert_eq!(id, 1);

    assert_eq!(token.balance(&depositor), 500);
    assert_eq!(token.balance(&escrow_contract_id), 500);

    // Try to claim before release time (should fail)
    env.ledger().with_mut(|li| {
        li.timestamp = 1500;
    });

    // Now fast forward time
    env.ledger().with_mut(|li| {
        li.timestamp = 2500;
    });

    // Claim
    escrow_client.claim(&id);

    assert_eq!(token.balance(&escrow_contract_id), 0);
    assert_eq!(token.balance(&recipient), 500);
}

#[test]
fn test_escrow_early_claim_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let depositor = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &token_admin);
    let escrow_contract_id = env.register_contract(None, TimelockEscrow);
    let escrow_client = TimelockEscrowClient::new(&env, &escrow_contract_id);

    token_admin.mint(&depositor, &1000);

    env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });

    let id = escrow_client.deposit(&depositor, &recipient, &token.address, &500, &2000);

    // Attempt claim early
    env.ledger().with_mut(|li| {
        li.timestamp = 1500;
    });

    let res = escrow_client.try_claim(&id);
    assert_eq!(res.unwrap_err().unwrap(), Error::StillLocked);
}

#[test]
fn test_deposit_zero_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let depositor = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &token_admin);
    let escrow_contract_id = env.register_contract(None, TimelockEscrow);
    let escrow_client = TimelockEscrowClient::new(&env, &escrow_contract_id);

    token_admin.mint(&depositor, &1000);

    let res = escrow_client.try_deposit(&depositor, &recipient, &token.address, &0, &2000);
    assert_eq!(res.unwrap_err().unwrap(), Error::InvalidAmount);
}

#[test]
fn test_double_claim_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let depositor = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let (token, token_admin) = create_token_contract(&env, &token_admin);
    let escrow_contract_id = env.register_contract(None, TimelockEscrow);
    let escrow_client = TimelockEscrowClient::new(&env, &escrow_contract_id);

    token_admin.mint(&depositor, &1000);
    env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });
    let id = escrow_client.deposit(&depositor, &recipient, &token.address, &500, &2000);

    env.ledger().with_mut(|li| {
        li.timestamp = 2500;
    });
    escrow_client.claim(&id);
    // Double claim
    let res = escrow_client.try_claim(&id);
    assert_eq!(res.unwrap_err().unwrap(), Error::AlreadyClaimed);
}
