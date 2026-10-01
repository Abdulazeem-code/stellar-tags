extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

#[contract]
struct Borrower;

#[contractimpl]
impl Borrower {
    pub fn on_flash_loan(
        env: Env,
        lender: Address,
        _initiator: Address,
        token_address: Address,
        amount: i128,
        fee: i128,
        data: Bytes,
    ) {
        let underpay = !data.is_empty();
        let repayment = if underpay { amount } else { amount + fee };
        TokenClient::new(&env, &token_address).transfer(
            &env.current_contract_address(),
            &lender,
            &repayment,
        );
    }
}

fn setup() -> (
    Env,
    Address,
    FlashLoanProviderClient<'static>,
    Address,
    TokenClient<'static>,
    StellarAssetClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();

    let provider_id = env.register_contract(None, FlashLoanProvider);
    let provider = FlashLoanProviderClient::new(&env, &provider_id);
    let borrower = env.register_contract(None, Borrower);
    let token_id = env.register_stellar_asset_contract(Address::generate(&env));
    let token = TokenClient::new(&env, &token_id);
    let asset = StellarAssetClient::new(&env, &token_id);

    (env, provider_id, provider, borrower, token, asset)
}

#[test]
fn repaid_loan_keeps_the_fee() {
    let (env, provider_id, provider, borrower, token, asset) = setup();
    let initiator = Address::generate(&env);
    asset.mint(&provider_id, &100_000);
    asset.mint(&borrower, &5);

    let fee = provider.flash_loan(
        &initiator,
        &borrower,
        &token.address,
        &10_000,
        &Bytes::new(&env),
    );

    assert_eq!(fee, 5);
    assert_eq!(token.balance(&provider_id), 100_005);
    assert_eq!(token.balance(&borrower), 0);
}

#[test]
fn short_repayment_reverts_every_transfer() {
    let (env, provider_id, provider, borrower, token, asset) = setup();
    let initiator = Address::generate(&env);
    asset.mint(&provider_id, &100_000);
    asset.mint(&borrower, &5);

    let result = provider.try_flash_loan(
        &initiator,
        &borrower,
        &token.address,
        &10_000,
        &Bytes::from_slice(&env, &[1]),
    );

    assert!(result.is_err());
    assert_eq!(token.balance(&provider_id), 100_000);
    assert_eq!(token.balance(&borrower), 5);
}

#[test]
fn rejects_invalid_or_unfunded_loans() {
    let (env, _provider_id, provider, borrower, _token, asset) = setup();
    let initiator = Address::generate(&env);

    assert!(provider
        .try_flash_loan(&initiator, &borrower, &asset.address, &0, &Bytes::new(&env),)
        .is_err());
    assert!(provider
        .try_flash_loan(&initiator, &borrower, &asset.address, &1, &Bytes::new(&env),)
        .is_err());
}
