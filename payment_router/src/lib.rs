#![no_std]
use soroban_sdk::{contract, contractimpl, log, token, Address, Env, Vec};

#[contract]
pub struct PaymentRouter;

#[contractimpl]
impl PaymentRouter {
    const FEE_BPS: i128 = 40;
    const BPS_DIVISOR: i128 = 10_000;
    const XLM_DECIMALS: i128 = 10_000_000;
    const FEE_CAP_XLM: i128 = 30;
    const FEE_CAP: i128 = Self::FEE_CAP_XLM * Self::XLM_DECIMALS;

    /// Routes a payment from a sender to a recipient, deducting a platform fee.
    ///
    /// The fee is calculated as a percentage (`FEE_BPS` / 10,000) of the `amount`,
    /// capped at `FEE_CAP`. The platform fee is transferred to `platform_treasury`,
    /// and the remaining balance is transferred to `recipient`.
    ///
    /// # Parameters
    /// * `env` - The Soroban environment interface.
    /// * `sender` - The address initiating the payment. Must authorize the transaction.
    /// * `recipient` - The destination address for the payment (e.g., the Anchor's wallet for fiat withdrawals).
    /// * `platform_treasury` - The address where the platform fee will be deposited.
    /// * `token_address` - The contract ID of the token asset being transferred (e.g., NGNC or USDC).
    /// * `amount` - The total amount of tokens to be routed (inclusive of the fee).
    pub fn route_payment(
        env: Env,
        sender: Address,
        recipient: Address,         // For fiat withdrawals, this is the Anchor's wallet
        platform_treasury: Address,
        token_address: Address,     // The ID of the asset being sent (e.g., NGNC or USDC)
        amount: i128,
    ) {
        // 1. Verify the sender authorized this transaction
        sender.require_auth();

        // 2. Calculate the split
        let mut fee_amount = (amount * Self::FEE_BPS) / Self::BPS_DIVISOR;
        if fee_amount > Self::FEE_CAP {
            fee_amount = Self::FEE_CAP;
        }
        if fee_amount > amount {
            fee_amount = amount;
        }
        let recipient_amount = amount - fee_amount;

        // 3. Initialize the token client for the specific currency
        let token_client = token::Client::new(&env, &token_address);

        // 4. Transfer the platform fee to your treasury
        token_client.transfer(&sender, &platform_treasury, &fee_amount);

        // 5. Transfer the remaining balance to the recipient
        token_client.transfer(&sender, &recipient, &recipient_amount);

        // 6. Log success
        log!(&env, "Platform fee routed to treasury");
        log!(&env, "Remaining balance routed to recipient");
    }

    /// Routes multiple payments from a sender to multiple recipients/tags in a single contract invocation.
    ///
    /// # Parameters
    /// * `env` - The Soroban environment interface.
    /// * `sender` - The address initiating the payments. Must authorize the transaction.
    /// * `recipients` - A vector of destination addresses (tags) for the payments.
    /// * `platform_treasury` - The address where the platform fees will be deposited.
    /// * `token_address` - The contract ID of the token asset being transferred.
    /// * `amounts` - A vector of amounts corresponding to each recipient.
    ///
    /// # Errors & Atomicity
    /// * Fails if `sender.require_auth()` fails.
    /// * Fails if `recipients` and `amounts` lengths do not match.
    /// * Fails and atomically reverts the entire batch if any individual transfer fails (e.g., insufficient funds).
    pub fn batch_pay(
        env: Env,
        sender: Address,
        recipients: Vec<Address>,
        platform_treasury: Address,
        token_address: Address,
        amounts: Vec<i128>,
    ) {
        // 1. Verify the sender authorized this transaction
        sender.require_auth();

        // 2. Ensure input vectors match in length
        if recipients.len() != amounts.len() {
            panic!("recipients and amounts vector length mismatch");
        }

        // 3. Initialize the token client
        let token_client = token::Client::new(&env, &token_address);

        // 4. Process each payment iteratively within a single atomic transaction
        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();
            let amount = amounts.get(i).unwrap();

            // Calculate the fee split for this recipient
            let mut fee_amount = (amount * Self::FEE_BPS) / Self::BPS_DIVISOR;
            if fee_amount > Self::FEE_CAP {
                fee_amount = Self::FEE_CAP;
            }
            if fee_amount > amount {
                fee_amount = amount;
            }
            let recipient_amount = amount - fee_amount;

            // Transfer platform fee and recipient amount
            token_client.transfer(&sender, &platform_treasury, &fee_amount);
            token_client.transfer(&sender, &recipient, &recipient_amount);
        }

        // 5. Log success
        log!(&env, "Batch payments processed successfully in a single transaction");
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{Env, Address, token};

    #[test]
    fn test_batch_pay_success() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let treasury = Address::generate(&env);
        let recipient1 = Address::generate(&env);
        let recipient2 = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract(token_admin);
        let token_client = token::Client::new(&env, &token_contract);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_contract);

        // Mint tokens to sender
        token_admin_client.mint(&sender, &1000_000_000);

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        let recipients = Vec::from_array(&env, [recipient1.clone(), recipient2.clone()]);
        let amounts = Vec::from_array(&env, [100_000_000_i128, 200_000_000_i128]);

        client.batch_pay(&sender, &recipients, &treasury, &token_contract, &amounts);

        // Verify balances and fees
        // Total amount = 300,000,000. Fees: 40 bps of 100M = 400,000; 40 bps of 200M = 800,000. Total fee = 1,200,000.
        assert_eq!(token_client.balance(&recipient1), 99_600_000);
        assert_eq!(token_client.balance(&recipient2), 199_200_000);
        assert_eq!(token_client.balance(&treasury), 1_200_000);
    }

    #[test]
    #[should_panic]
    fn test_batch_pay_length_mismatch() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let treasury = Address::generate(&env);
        let recipient1 = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract(token_admin);

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        let recipients = Vec::from_array(&env, [recipient1]);
        let amounts = Vec::from_array(&env, [100_000_000_i128, 200_000_000_i128]);

        client.batch_pay(&sender, &recipients, &treasury, &token_contract, &amounts);
    }

    #[test]
    #[should_panic]
    fn test_batch_pay_atomicity_revert_on_insufficient_funds() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let treasury = Address::generate(&env);
        let recipient1 = Address::generate(&env);
        let recipient2 = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract(token_admin);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_contract);

        // Mint only enough for recipient1, but not recipient2 (or mint 0)
        token_admin_client.mint(&sender, &50_000_000);

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        let recipients = Vec::from_array(&env, [recipient1, recipient2]);
        let amounts = Vec::from_array(&env, [20_000_000_i128, 100_000_000_i128]);

        // Second payment exceeds sender's balance, should panic and revert entire batch
        client.batch_pay(&sender, &recipients, &treasury, &token_contract, &amounts);
    }
}
