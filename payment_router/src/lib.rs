#![no_std]
use soroban_sdk::{contract, contractimpl, log, token, Address, Env};

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct UserSpending {
    pub last_reset_time: u64,
    pub accumulated_amount: i128,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
enum DataKey {
    UserSpending(Address),
}

#[contract]
pub struct PaymentRouter;

#[contractimpl]
impl PaymentRouter {
    const FEE_BPS: i128 = 40;
    const BPS_DIVISOR: i128 = 10_000;
    const XLM_DECIMALS: i128 = 10_000_000;
    const FEE_CAP_XLM: i128 = 30;
    const FEE_CAP: i128 = Self::FEE_CAP_XLM * Self::XLM_DECIMALS;

    // Limits
    const DAILY_MAX_LIMIT: i128 = 1_000_000 * Self::XLM_DECIMALS; // Example limit
    const SECONDS_IN_24H: u64 = 24 * 3600;

    /// Routes a payment from a sender to a recipient, deducting a platform fee.
    pub fn route_payment(
        env: Env,
        sender: Address,
        recipient: Address,
        platform_treasury: Address,
        token_address: Address,
        amount: i128,
    ) {
        // 1. Verify the sender authorized this transaction
        sender.require_auth();

        // 1.5 Check spending limits
        let current_time = env.ledger().timestamp();
        let mut spending = env.storage().instance().get(&DataKey::UserSpending(sender.clone()))
            .unwrap_or(UserSpending { last_reset_time: current_time, accumulated_amount: 0 });

        if current_time - spending.last_reset_time >= Self::SECONDS_IN_24H {
            spending.last_reset_time = current_time;
            spending.accumulated_amount = 0;
        }

        spending.accumulated_amount += amount;

        if spending.accumulated_amount > Self::DAILY_MAX_LIMIT {
            panic!("Daily spending limit exceeded");
        }

        env.storage().instance().set(&DataKey::UserSpending(sender.clone()), &spending);

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
        // The client moves funds directly from the sender to the treasury
        token_client.transfer(&sender, &platform_treasury, &fee_amount);

        // 5. Transfer the remaining balance to the recipient (the Anchor)
        token_client.transfer(&sender, &recipient, &recipient_amount);

        // 6. Log success for testing
        log!(&env, "Platform fee routed to treasury");
        log!(&env, "Remaining balance routed to Anchor");
    }
}