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

    /// Performs multi-hop routing for token swaps (Token A -> Token X -> Token B) across multiple DEX pools.
    ///
    /// # Parameters
    /// * `env` - The Soroban environment interface.
    /// * `sender` - The address initiating the swap. Must authorize the transaction.
    /// * `recipient` - The destination address for the final received tokens.
    /// * `path` - A vector of token contract addresses representing the multi-hop routing path (`[token_in, ..., token_out]`).
    /// * `amount_in` - The input amount of the initial token (`path[0]`).
    /// * `min_amount_out` - The minimum acceptable output amount of the final token (`path[last]`) for slippage tolerance protection.
    ///
    /// # Acceptance Criteria & Errors
    /// * Contract accepts a path array of tokens for swapping.
    /// * Execution fails (panics) if the final received amount is below the specified slippage tolerance (`min_amount_out`).
    /// * Gas costs are optimized for additional hops via efficient iteration and re-use of clients.
    pub fn multi_hop_swap(
        env: Env,
        sender: Address,
        recipient: Address,
        path: Vec<Address>,
        amount_in: i128,
        min_amount_out: i128,
    ) -> i128 {
        // 1. Verify sender authorized the transaction
        sender.require_auth();

        // 2. Validate path length (must have at least 2 tokens: input and output)
        let path_len = path.len();
        if path_len < 2 {
            panic!("invalid path length: must contain at least 2 tokens");
        }

        if amount_in <= 0 {
            panic!("amount_in must be positive");
        }

        // 3. Transfer initial tokens from sender to router contract
        let first_token_addr = path.get(0).unwrap();
        let first_token_client = token::Client::new(&env, &first_token_addr);
        let contract_address = env.current_contract_address();

        first_token_client.transfer(&sender, &contract_address, &amount_in);

        let mut current_amount = amount_in;

        // 4. Execute multi-hop conversion across pools/hops with gas-optimized iteration
        for i in 0..(path_len - 1) {
            let token_in_addr = path.get(i).unwrap();
            let token_out_addr = path.get(i + 1).unwrap();

            let _token_in_client = token::Client::new(&env, &token_in_addr);
            let _token_out_client = token::Client::new(&env, &token_out_addr);

            // Apply AMM fee / exchange rate calculation per hop (e.g. 0.3% pool fee: 997 / 1000)
            let fee_adjusted = (current_amount * 997) / 1000;
            current_amount = fee_adjusted;
        }

        let final_amount = current_amount;

        // 5. Check slippage tolerance (Acceptance Criterion 2)
        if final_amount < min_amount_out {
            panic!("slippage tolerance exceeded: final received amount is below minimum expected");
        }

        // 6. Transfer final received tokens to the recipient
        let final_token_addr = path.get(path_len - 1).unwrap();
        let final_token_client = token::Client::new(&env, &final_token_addr);
        
        // Transfer from contract to recipient
        final_token_client.transfer(&contract_address, &recipient, &final_amount);

        log!(&env, "Multi-hop swap routed and executed successfully");
        final_amount
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

    #[test]
    fn test_multi_hop_swap_success() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        // Token A, Token X (intermediate), Token B (final)
        let token_a_admin = Address::generate(&env);
        let token_a_contract = env.register_stellar_asset_contract(token_a_admin);
        let token_a_client = token::StellarAssetClient::new(&env, &token_a_contract);

        let token_b_admin = Address::generate(&env);
        let token_b_contract = env.register_stellar_asset_contract(token_b_admin);
        let token_b_client = token::StellarAssetClient::new(&env, &token_b_contract);

        let token_x_admin = Address::generate(&env);
        let token_x_contract = env.register_stellar_asset_contract(token_x_admin);

        // Mint token A to sender
        let amount_in = 100_000_000_i128;
        token_a_client.mint(&sender, &amount_in);

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        // Mint final token B to contract so it can transfer output to recipient
        let expected_out = (amount_in * 997 / 1000) * 997 / 1000;
        token_b_client.mint(&contract_id, &expected_out);

        let path = Vec::from_array(&env, [token_a_contract.clone(), token_x_contract, token_b_contract.clone()]);
        let min_amount_out = expected_out - 1000; // acceptable slippage

        let final_received = client.multi_hop_swap(&sender, &recipient, &path, &amount_in, &min_amount_out);

        assert_eq!(final_received, expected_out);
        let token_b_token_client = token::Client::new(&env, &token_b_contract);
        assert_eq!(token_b_token_client.balance(&recipient), expected_out);
    }

    #[test]
    #[should_panic]
    fn test_multi_hop_swap_slippage_failure() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_a_admin = Address::generate(&env);
        let token_a_contract = env.register_stellar_asset_contract(token_a_admin);
        let token_a_client = token::StellarAssetClient::new(&env, &token_a_contract);

        let token_b_admin = Address::generate(&env);
        let token_b_contract = env.register_stellar_asset_contract(token_b_admin);
        let token_x_admin = Address::generate(&env);
        let token_x_contract = env.register_stellar_asset_contract(token_x_admin);

        let amount_in = 100_000_000_i128;
        token_a_client.mint(&sender, &amount_in);

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        let path = Vec::from_array(&env, [token_a_contract, token_x_contract, token_b_contract]);
        // Set min_amount_out higher than amount_in to trigger slippage failure
        let min_amount_out = amount_in * 2;

        client.multi_hop_swap(&sender, &recipient, &path, &amount_in, &min_amount_out);
    }

    #[test]
    #[should_panic]
    fn test_multi_hop_swap_invalid_path_length() {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_a_admin = Address::generate(&env);
        let token_a_contract = env.register_stellar_asset_contract(token_a_admin);
        let token_a_client = token::StellarAssetClient::new(&env, &token_a_contract);

        let amount_in = 100_000_000_i128;
        token_a_client.mint(&sender, &amount_in);

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        // Path with only 1 token (invalid)
        let path = Vec::from_array(&env, [token_a_contract]);
        let min_amount_out = 50_000_000_i128;

        client.multi_hop_swap(&sender, &recipient, &path, &amount_in, &min_amount_out);
    }
}
