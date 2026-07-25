#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, log, token, Address, Env};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Config,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub fee_bps: i128,
    pub fee_cap_xlm: i128,
}

#[contract]
pub struct PaymentRouter;

#[contractimpl]
impl PaymentRouter {
    const DEFAULT_FEE_BPS: i128 = 40;
    const BPS_DIVISOR: i128 = 10_000;
    const XLM_DECIMALS: i128 = 10_000_000;
    const DEFAULT_FEE_CAP_XLM: i128 = 30;

    /// Initializes the contract admin.
    /// Requires authorization from `admin`.
    pub fn initialize(env: Env, admin: Address) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Sets or updates the contract admin.
    /// Requires authorization from `current_admin`.
    pub fn set_admin(env: Env, current_admin: Address, new_admin: Address) {
        current_admin.require_auth();
        if let Some(stored_admin) = env.storage().instance().get::<DataKey, Address>(&DataKey::Admin) {
            if stored_admin != current_admin {
                panic!("unauthorized admin change");
            }
        }
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    /// Sets the platform fee configuration (`fee_bps` and `fee_cap_xlm`).
    /// Requires authorization from `admin`.
    pub fn set_config(env: Env, admin: Address, fee_bps: i128, fee_cap_xlm: i128) {
        admin.require_auth();
        if let Some(stored_admin) = env.storage().instance().get::<DataKey, Address>(&DataKey::Admin) {
            if stored_admin != admin {
                panic!("unauthorized config change");
            }
        }
        let config = Config { fee_bps, fee_cap_xlm };
        env.storage().instance().set(&DataKey::Config, &config);
        log!(&env, "Fee configuration updated by admin");
    }

    /// Gets the stored admin address, if any.
    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// Gets the current fee configuration (or defaults).
    pub fn get_config(env: Env) -> Config {
        env.storage().instance().get(&DataKey::Config).unwrap_or(Config {
            fee_bps: Self::DEFAULT_FEE_BPS,
            fee_cap_xlm: Self::DEFAULT_FEE_CAP_XLM,
        })
    }

    /// Routes a payment from a sender to a recipient, deducting a platform fee.
    /// Requires authorization from `sender`.
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

        // Fetch stored config or fall back to default constants
        let config = Self::get_config(env.clone());
        let fee_cap = config.fee_cap_xlm * Self::XLM_DECIMALS;

        // 2. Calculate the split
        let mut fee_amount = (amount * config.fee_bps) / Self::BPS_DIVISOR;
        if fee_amount > fee_cap {
            fee_amount = fee_cap;
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

#[cfg(test)]
mod test;