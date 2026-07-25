#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, log, token, Address, Env};

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    PlatformTreasury,
    FeeBps,
    FeeCap,
    UserVolume(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RouterError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
}

#[contract]
pub struct PaymentRouter;

#[contractimpl]
impl PaymentRouter {
    const BPS_DIVISOR: i128 = 10_000;

    // Instance storage backs the contract's own lifetime, so admin/config data
    // (small, read on every call) is bumped alongside it.
    const DAY_IN_LEDGERS: u32 = 17280;
    const INSTANCE_BUMP_AMOUNT: u32 = 7 * Self::DAY_IN_LEDGERS;
    const INSTANCE_LIFETIME_THRESHOLD: u32 = Self::INSTANCE_BUMP_AMOUNT - Self::DAY_IN_LEDGERS;

    // Persistent storage entries have independent TTLs, so per-user data is
    // extended on its own schedule instead of riding on the contract's TTL.
    const USER_BUMP_AMOUNT: u32 = 30 * Self::DAY_IN_LEDGERS;
    const USER_LIFETIME_THRESHOLD: u32 = Self::USER_BUMP_AMOUNT - Self::DAY_IN_LEDGERS;

    /// One-time setup: records the admin and the initial fee configuration
    /// in instance storage. Must be called before `route_payment`.
    pub fn initialize(
        env: Env,
        admin: Address,
        platform_treasury: Address,
        fee_bps: i128,
        fee_cap: i128,
    ) -> Result<(), RouterError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(RouterError::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::PlatformTreasury, &platform_treasury);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage().instance().set(&DataKey::FeeCap, &fee_cap);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        Ok(())
    }

    /// Updates the treasury address that receives the platform fee. Admin-only.
    pub fn set_platform_treasury(env: Env, new_treasury: Address) -> Result<(), RouterError> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::PlatformTreasury, &new_treasury);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Updates the fee basis points and fee cap. Admin-only.
    pub fn set_fee_config(env: Env, fee_bps: i128, fee_cap: i128) -> Result<(), RouterError> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage().instance().set(&DataKey::FeeCap, &fee_cap);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Returns the cumulative amount a given sender has routed through the contract.
    pub fn get_user_volume(env: Env, user: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::UserVolume(user))
            .unwrap_or(0)
    }

    /// Routes a payment from a sender to a recipient, deducting a platform fee.
    ///
    /// The fee is calculated as a percentage (`fee_bps` / 10,000) of the `amount`,
    /// capped at `fee_cap`. Both values, along with the treasury address, are
    /// read from instance storage set via `initialize` / `set_fee_config`.
    /// The platform fee is transferred to the configured treasury, and the
    /// remaining balance is transferred to `recipient`.
    ///
    /// # Parameters
    /// * `env` - The Soroban environment interface.
    /// * `sender` - The address initiating the payment. Must authorize the transaction.
    /// * `recipient` - The destination address for the payment (e.g., the Anchor's wallet for fiat withdrawals).
    /// * `token_address` - The contract ID of the token asset being transferred (e.g., NGNC or USDC).
    /// * `amount` - The total amount of tokens to be routed (inclusive of the fee).
    ///
    /// # Return Value
    /// This function does not return a value.
    ///
    /// # Errors
    /// * Fails if the contract has not been initialized.
    /// * Fails if `sender.require_auth()` fails (i.e., the sender has not authorized the transaction).
    /// * Fails if the `token_client.transfer` calls fail (e.g., insufficient balance, or invalid token).
    ///
    /// # Events
    /// This function does not emit custom contract events natively via `env.events().publish(...)`, but it
    /// internally logs success messages. The underlying token transfers will emit their respective standard transfer events.
    pub fn route_payment(
        env: Env,
        sender: Address,
        recipient: Address, // For fiat withdrawals, this is the Anchor's wallet
        token_address: Address, // The ID of the asset being sent (e.g., NGNC or USDC)
        amount: i128,
    ) -> Result<(), RouterError> {
        // 1. Verify the sender authorized this transaction
        sender.require_auth();

        // 2. Load fee configuration from instance storage
        let platform_treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::PlatformTreasury)
            .ok_or(RouterError::NotInitialized)?;
        let fee_bps: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeBps)
            .ok_or(RouterError::NotInitialized)?;
        let fee_cap: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeCap)
            .ok_or(RouterError::NotInitialized)?;
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        // 3. Calculate the split
        let mut fee_amount = (amount * fee_bps) / Self::BPS_DIVISOR;
        if fee_amount > fee_cap {
            fee_amount = fee_cap;
        }
        if fee_amount > amount {
            fee_amount = amount;
        }
        let recipient_amount = amount - fee_amount;

        // 4. Initialize the token client for the specific currency
        let token_client = token::Client::new(&env, &token_address);

        // 5. Transfer the platform fee to the treasury
        // The client moves funds directly from the sender to the treasury
        token_client.transfer(&sender, &platform_treasury, &fee_amount);

        // 6. Transfer the remaining balance to the recipient (the Anchor)
        token_client.transfer(&sender, &recipient, &recipient_amount);

        // 7. Record the sender's cumulative routed volume in persistent storage,
        // since this data belongs to the user, not the contract instance.
        let volume_key = DataKey::UserVolume(sender.clone());
        let prev_volume: i128 = env.storage().persistent().get(&volume_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&volume_key, &(prev_volume + amount));
        env.storage().persistent().extend_ttl(
            &volume_key,
            Self::USER_LIFETIME_THRESHOLD,
            Self::USER_BUMP_AMOUNT,
        );

        // 8. Log success for testing
        log!(&env, "Platform fee routed to treasury");
        log!(&env, "Remaining balance routed to Anchor");

        Ok(())
    }

    fn require_admin(env: &Env) -> Result<Address, RouterError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(RouterError::NotInitialized)
    }
}
