#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, log, token, Address, Env, Symbol, IntoVal};

#[contract]
pub struct PaymentRouter;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    LimitExceeded = 1,
}

#[contractimpl]
impl PaymentRouter {
    const FEE_BPS: i128 = 40;
    const MAX_AMOUNT: i128 = 1_000_000_000_000_000; // 100k tokens with 7 decimals
    const BPS_DIVISOR: i128 = 10_000;
    const XLM_DECIMALS: i128 = 10_000_000;
    const FEE_CAP_XLM: i128 = 30;
    const FEE_CAP: i128 = Self::FEE_CAP_XLM * Self::XLM_DECIMALS;
    const VERSION: u32 = 1;

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
    ///
    /// # Return Value
    /// Returns `Ok(())` when successful.
    ///
    /// # Errors
    /// * `Error::LimitExceeded` if the amount is out of supported bounds.
    /// * Fails if `sender.require_auth()` fails (i.e., the sender has not authorized the transaction).
    /// * Fails if the `token_client.transfer` calls fail (e.g., insufficient balance, or invalid token).
    ///
    /// # Events
    /// Emits 'payment_failed' event with reason if validation fails due to bounds or limits.
    pub fn route_payment(
        env: Env,
        sender: Address,
        recipient: Address,         // For fiat withdrawals, this is the Anchor's wallet
        platform_treasury: Address,
        token_address: Address,     // The ID of the asset being sent (e.g., NGNC or USDC)
        amount: i128,
    ) -> Result<(), Error> {
        // 1. Verify the sender authorized this transaction
        sender.require_auth();

        // 2. Validate the requested payment amount and publish event on bounds/limits failure
        if amount <= 0 {
            env.events().publish(
                (Symbol::new(&env, "payment_failed"),),
                Symbol::new(&env, "amount_invalid"),
            );
            return Err(Error::LimitExceeded);
        }
        if amount > Self::MAX_AMOUNT {
            env.events().publish(
                (Symbol::new(&env, "payment_failed"),),
                Symbol::new(&env, "limit_exceeded"),
            );
            return Err(Error::LimitExceeded);
        }

        // 3. Calculate the split
        let mut fee_amount = (amount * Self::FEE_BPS) / Self::BPS_DIVISOR;
        if fee_amount > Self::FEE_CAP {
            fee_amount = Self::FEE_CAP;
        }
        if fee_amount > amount {
            fee_amount = amount;
        }
        let recipient_amount = amount - fee_amount;

        // 4. Initialize the token client for the specific currency
        let token_client = token::Client::new(&env, &token_address);

        // 5. Transfer the platform fee to your treasury
        // The client moves funds directly from the sender to the treasury
        token_client.transfer(&sender, &platform_treasury, &fee_amount);

        // 6. Transfer the remaining balance to the recipient (the Anchor)
        token_client.transfer(&sender, &recipient, &recipient_amount);

        // 7. Log success for testing
        log!(&env, "Platform fee routed to treasury");
        log!(&env, "Remaining balance routed to Anchor");

        Ok(())
    }

    /// Returns the contract version.
    /// This can be used by frontends to verify compatibility.
    pub fn version(_env: Env) -> u32 {
        Self::VERSION
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{Env, Address, Symbol, IntoVal};

    #[test]
    fn test_route_payment_amount_invalid() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let platform_treasury = Address::generate(&env);
        let token_address = Address::generate(&env);

        let result = client.try_route_payment(
            &sender,
            &recipient,
            &platform_treasury,
            &token_address,
            &0,
        );

        assert!(result.is_err());
        
        assert_eq!(
            env.events().all(),
            soroban_sdk::vec![
                &env,
                (
                    contract_id.clone(),
                    (Symbol::new(&env, "payment_failed"),).into_val(&env),
                    Symbol::new(&env, "amount_invalid").into_val(&env)
                )
            ]
        );
    }

    #[test]
    fn test_route_payment_limit_exceeded() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let platform_treasury = Address::generate(&env);
        let token_address = Address::generate(&env);

        let result = client.try_route_payment(
            &sender,
            &recipient,
            &platform_treasury,
            &token_address,
            &(PaymentRouter::MAX_AMOUNT + 1),
        );

        assert!(result.is_err());

        assert_eq!(
            env.events().all(),
            soroban_sdk::vec![
                &env,
                (
                    contract_id.clone(),
                    (Symbol::new(&env, "payment_failed"),).into_val(&env),
                    Symbol::new(&env, "limit_exceeded").into_val(&env)
                )
            ]
        );
    }
}