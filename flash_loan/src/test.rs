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

mod recursive_borrower {
    use super::*;

    #[contract]
    pub struct RecursiveBorrower;

    #[contractimpl]
    impl RecursiveBorrower {
        pub fn on_flash_loan(
            env: Env,
            lender: Address,
            initiator: Address,
            token_address: Address,
            amount: i128,
            fee: i128,
            _data: Bytes,
        ) {
            let provider = FlashLoanProviderClient::new(&env, &lender);
            let recursive_result = provider.try_flash_loan(
                &initiator,
                &env.current_contract_address(),
                &token_address,
                &amount,
                &Bytes::new(&env),
            );
            env.storage()
                .instance()
                .set(&symbol_short!("reenter"), &recursive_result.is_err());

            TokenClient::new(&env, &token_address).transfer(
                &env.current_contract_address(),
                &lender,
                &(amount + fee),
            );
        }

        pub fn reentrancy_rejected(env: Env) -> bool {
            env.storage()
                .instance()
                .get(&symbol_short!("reenter"))
                .unwrap_or(false)
        }
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
    asset.mint(&borrower, &6);

    let fee = provider.flash_loan(
        &initiator,
        &borrower,
        &token.address,
        &10_000,
        &Bytes::new(&env),
    );

    assert_eq!(fee, 6);
    assert_eq!(token.balance(&provider_id), 100_006);
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

    // A failed invocation rolls back its lock, so a later valid loan can run.
    provider.flash_loan(
        &initiator,
        &borrower,
        &token.address,
        &10_000,
        &Bytes::new(&env),
    );
    assert_eq!(token.balance(&provider_id), 100_005);
}

#[test]
fn recursive_flash_loan_is_rejected_and_outer_loan_completes() {
    let env = Env::default();
    env.mock_all_auths();

    let provider_id = env.register_contract(None, FlashLoanProvider);
    let provider = FlashLoanProviderClient::new(&env, &provider_id);
    let borrower_id = env.register_contract(None, recursive_borrower::RecursiveBorrower);
    let borrower = recursive_borrower::RecursiveBorrowerClient::new(&env, &borrower_id);
    let token_id = env.register_stellar_asset_contract(Address::generate(&env));
    let token = TokenClient::new(&env, &token_id);
    let asset = StellarAssetClient::new(&env, &token_id);
    let initiator = Address::generate(&env);

    asset.mint(&provider_id, &100_000);
    asset.mint(&borrower_id, &5);

    provider.flash_loan(
        &initiator,
        &borrower_id,
        &token.address,
        &10_000,
        &Bytes::new(&env),
    );

    assert!(borrower.reentrancy_rejected());
    assert_eq!(token.balance(&provider_id), 100_005);
    assert_eq!(token.balance(&borrower_id), 0);
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

#[test]
fn dynamic_fee_scales_with_pool_utilization() {
    let (_env, provider_id, provider, _borrower, _token, asset) = setup();
    asset.mint(&provider_id, &100_000);

    // The same reserve balance gives these fee quotes at 10%, 50%, 85%,
    // and 99% utilization. Amounts and fees are in the token's base units.
    assert_eq!(provider.get_flash_loan_fee(&10_000, &asset.address), 6);
    assert_eq!(provider.get_flash_loan_fee(&50_000, &asset.address), 45);
    assert_eq!(provider.get_flash_loan_fee(&85_000, &asset.address), 170);
    assert_eq!(provider.get_flash_loan_fee(&99_000, &asset.address), 476);
}

#[test]
fn dynamic_fee_rejects_zero_amount_and_amount_above_reserves() {
    let (_env, provider_id, provider, _borrower, _token, asset) = setup();
    asset.mint(&provider_id, &100_000);

    assert_eq!(
        provider.try_get_flash_loan_fee(&0, &asset.address),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        provider.try_get_flash_loan_fee(&100_001, &asset.address),
        Err(Ok(Error::InsufficientLiquidity))
    );
}
