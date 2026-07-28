#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, log, token, Address, Env};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserSpending {
    pub last_reset_time: u64,
    pub accumulated_amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    PlatformTreasury,
    FeeBps,
    FeeCap,
    UserVolume(Address),
    UserSpending(Address),
    Paused,
    SupportedToken(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    Unauthorized = 1,
    InsufficientBalance = 2,
    LimitExceeded = 3,
    AlreadyInitialized = 4,
    NotInitialized = 5,
    Paused = 6,
    InvalidFeeRate = 7,
    UnsupportedToken = 8,
}

#[contract]
pub struct PaymentRouter;

#[contractimpl]
impl PaymentRouter {
    const BPS_DIVISOR: i128 = 10_000;
    const XLM_DECIMALS: i128 = 10_000_000;
    const MAX_AMOUNT: i128 = 1_000_000_000_000_000; // 100k tokens with 7 decimals
    const DAILY_MAX_LIMIT: i128 = 1_000_000 * Self::XLM_DECIMALS; // 1M tokens limit
    const SECONDS_IN_24H: u64 = 24 * 3600;
    const VERSION: u32 = 1;

    const DAY_IN_LEDGERS: u32 = 17280;
    const INSTANCE_BUMP_AMOUNT: u32 = 7 * Self::DAY_IN_LEDGERS;
    const INSTANCE_LIFETIME_THRESHOLD: u32 = Self::INSTANCE_BUMP_AMOUNT - Self::DAY_IN_LEDGERS;

    const PERSISTENT_BUMP_AMOUNT: u32 = 30 * Self::DAY_IN_LEDGERS;
    const PERSISTENT_LIFETIME_THRESHOLD: u32 = Self::PERSISTENT_BUMP_AMOUNT - Self::DAY_IN_LEDGERS;

    /// One-time setup: records the admin and the initial fee configuration
    /// in instance storage. Must be called before `route_payment`.
    pub fn initialize(
        env: Env,
        admin: Address,
        platform_treasury: Address,
        fee_bps: i128,
        fee_cap: i128,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
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
    pub fn set_platform_treasury(env: Env, new_treasury: Address) -> Result<(), Error> {
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
    pub fn set_fee_config(env: Env, fee_bps: i128, fee_cap: i128) -> Result<(), Error> {
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

    /// Pauses or unpauses the payment router. Admin-only.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &paused);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Returns whether the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Returns the cumulative amount a given sender has routed through the contract.
    pub fn get_user_volume(env: Env, user: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::UserVolume(user))
            .unwrap_or(0)
    }

    /// Set a new admin. Gated by the current admin if one exists.
    pub fn set_admin(env: Env, new_admin: Address) {
        if let Some(admin) = env.storage().instance().get::<DataKey, Address>(&DataKey::Admin) {
            admin.require_auth();
        }
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
    }

    /// Updates the fee basis points. Admin-only. (Provided for backward compatibility).
    pub fn set_fee_bps(env: Env, new_fee_bps: i128) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Transfers admin rights to a new address. Current admin must authorize.
    pub fn transfer_admin(env: Env, new_admin: Address) {
        let current_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        current_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
    }

    /// Returns the contract version.
    pub fn version(_env: Env) -> u32 {
        Self::VERSION
    }

    /// Adds a token address to the supported whitelist. Admin-only.
    /// Once added, the token can be used in `route_payment`.
    pub fn add_supported_token(env: Env, token_address: Address) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::SupportedToken(token_address.clone()), &true);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        log!(&env, "Token added to whitelist: {}", token_address);
        Ok(())
    }

    /// Removes a token address from the supported whitelist. Admin-only.
    /// Once removed, the token can no longer be used in `route_payment`.
    pub fn remove_supported_token(env: Env, token_address: Address) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        env.storage()
            .instance()
            .remove(&DataKey::SupportedToken(token_address.clone()));
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        log!(&env, "Token removed from whitelist: {}", token_address);
        Ok(())
    }

    /// Checks whether a given token address is on the supported whitelist.
    pub fn is_supported_token(env: Env, token_address: Address) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::SupportedToken(token_address))
    }

    /// Routes a payment from a sender to a recipient, deducting a platform fee.
    ///
    /// The fee is calculated as a percentage (`fee_bps` / 10,000) of the `amount`,
    /// capped at `fee_cap`. Both values, along with the treasury address, are
    /// read from instance storage set via `initialize`.
    ///
    /// The platform fee is transferred to the configured treasury, and the
    /// remaining balance is transferred to `recipient`.
    ///
    /// # Errors
    ///
    /// Returns `Error::UnsupportedToken` if `token_address` is not on the
    /// supported whitelist (see `add_supported_token`).
    pub fn route_payment(
        env: Env,
        sender: Address,
        recipient: Address,
        token_address: Address,
        amount: i128,
    ) -> Result<(), Error> {
        // 0. Check if the contract is paused
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }

        // 1. Verify the token is on the supported whitelist
        if !env
            .storage()
            .instance()
            .has(&DataKey::SupportedToken(token_address.clone()))
        {
            return Err(Error::UnsupportedToken);
        }

        // 2. Verify the sender authorized this transaction
        sender.require_auth();

        // 3. Validate the requested payment amount bounds
        if amount <= 0 || amount > Self::MAX_AMOUNT {
            return Err(Error::LimitExceeded);
        }

        // 4. Load fee configuration from instance storage
        let platform_treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::PlatformTreasury)
            .ok_or(Error::NotInitialized)?;
        let fee_bps: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeBps)
            .ok_or(Error::NotInitialized)?;
        let fee_cap: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeCap)
            .ok_or(Error::NotInitialized)?;

        // Extend instance storage TTL after reading config
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        // 5. Check time-based daily spending limits
        let current_time = env.ledger().timestamp();
        let spending_key = DataKey::UserSpending(sender.clone());
        let mut spending = env
            .storage()
            .persistent()
            .get(&spending_key)
            .unwrap_or(UserSpending {
                last_reset_time: current_time,
                accumulated_amount: 0,
            });

        if current_time - spending.last_reset_time >= Self::SECONDS_IN_24H {
            spending.last_reset_time = current_time;
            spending.accumulated_amount = 0;
        }

        spending.accumulated_amount += amount;

        if spending.accumulated_amount > Self::DAILY_MAX_LIMIT {
            return Err(Error::LimitExceeded);
        }

        env.storage()
            .persistent()
            .set(&spending_key, &spending);
        env.storage()
            .persistent()
            .extend_ttl(
                &spending_key,
                Self::PERSISTENT_LIFETIME_THRESHOLD,
                Self::PERSISTENT_BUMP_AMOUNT,
            );

        // 6. Initialize the token client
        let token_client = token::Client::new(&env, &token_address);

        // 7. Verify sender has sufficient balance
        if token_client.balance(&sender) < amount {
            return Err(Error::InsufficientBalance);
        }

        // 8. Calculate the fee split
        let mut fee_amount = (amount * fee_bps) / Self::BPS_DIVISOR;
        if fee_amount > fee_cap {
            fee_amount = fee_cap;
        }
        if fee_amount > amount {
            fee_amount = amount;
        }
        let recipient_amount = amount - fee_amount;

        // 9. Execute token transfers
        token_client.transfer(&sender, &platform_treasury, &fee_amount);
        token_client.transfer(&sender, &recipient, &recipient_amount);

        // 10. Record the sender's cumulative routed volume in persistent storage
        let volume_key = DataKey::UserVolume(sender.clone());
        let prev_volume: i128 = env.storage().persistent().get(&volume_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&volume_key, &(prev_volume + amount));
        env.storage()
            .persistent()
            .extend_ttl(
                &volume_key,
                Self::PERSISTENT_LIFETIME_THRESHOLD,
                Self::PERSISTENT_BUMP_AMOUNT,
            );

        log!(&env, "Platform fee routed to treasury");
        log!(&env, "Remaining balance routed to recipient");

        Ok(())
    }

    fn require_admin(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _, LedgerInfo},
        token::StellarAssetClient,
        Address, Env,
    };

    fn setup_env() -> (Env, PaymentRouterClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);
        (env, client)
    }

    #[test]
    fn test_initialize_and_admin_restrictions() {
        let (env, client) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let new_admin = Address::generate(&env);

        // Initialize contract
        client.initialize(&admin, &treasury, &100, &1000);

        // Trying to initialize again should fail
        let res = client.try_initialize(&admin, &treasury, &100, &1000);
        assert_eq!(res.unwrap_err().unwrap(), Error::AlreadyInitialized);

        // Set admin can be called (by current admin)
        client.set_admin(&new_admin);

        // Modify config by new admin
        client.set_fee_config(&200, &2000);

        // Check if config works with set_platform_treasury
        let new_treasury = Address::generate(&env);
        client.set_platform_treasury(&new_treasury);
    }

    #[test]
    fn test_route_payment_calculates_and_sends_fee() {
        let (env, client) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        // Deploy mock token
        let token_admin = Address::generate(&env);
        let token_address = env.register_stellar_asset_contract(token_admin.clone());
        let token_client = token::Client::new(&env, &token_address);

        // Mint tokens to sender
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        let initial_balance = 10_000;
        sac.mint(&sender, &initial_balance);

        // Initialize router with 1% fee (100 bps) and cap of 50
        client.initialize(&admin, &treasury, &100, &50);

        // Add the token to the supported whitelist
        client.add_supported_token(&token_address);

        // Test normal fee calculation
        let amount_1 = 2000; // 1% of 2000 is 20, which is below cap (50)
        client.route_payment(&sender, &recipient, &token_address, &amount_1);

        assert_eq!(token_client.balance(&treasury), 20);
        assert_eq!(token_client.balance(&recipient), 1980);
        assert_eq!(token_client.balance(&sender), initial_balance - amount_1);
        assert_eq!(client.get_user_volume(&sender), amount_1);

        // Test fee capped at 50
        let amount_2 = 8000; // 1% of 8000 is 80, which is capped at 50
        client.route_payment(&sender, &recipient, &token_address, &amount_2);

        // Total fee should be 20 + 50 = 70
        assert_eq!(token_client.balance(&treasury), 70);
        // Total recipient amount should be 1980 + 7950 = 9930
        assert_eq!(token_client.balance(&recipient), 9930);
        assert_eq!(
            token_client.balance(&sender),
            initial_balance - amount_1 - amount_2
        );
        assert_eq!(client.get_user_volume(&sender), amount_1 + amount_2);
    }

    #[test]
    fn test_insufficient_balance() {
        let (env, client) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_address = env.register_stellar_asset_contract(token_admin.clone());

        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &100);

        client.initialize(&admin, &treasury, &100, &50);
        client.add_supported_token(&token_address);

        // Route payment of 500 when balance is only 100
        let res = client.try_route_payment(&sender, &recipient, &token_address, &500);
        assert_eq!(res.unwrap_err().unwrap(), Error::InsufficientBalance);
    }

    #[test]
    fn test_daily_limit_and_reset() {
        let (env, client) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_address = env.register_stellar_asset_contract(token_admin.clone());
        let token_client = token::Client::new(&env, &token_address);

        // Daily limit is 1,000,000 * 10,000,000 = 10,000,000,000,000
        let limit = 10_000_000_000_000;
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &(limit + 2000));

        client.initialize(&admin, &treasury, &100, &50);
        client.add_supported_token(&token_address);

        // Route amount within limit
        client.route_payment(&sender, &recipient, &token_address, &limit);

        // Exceed daily limit
        let res = client.try_route_payment(&sender, &recipient, &token_address, &2000);
        assert_eq!(res.unwrap_err().unwrap(), Error::LimitExceeded);

        // Warp time by 24 hours (86,400 seconds)
        let current_time = env.ledger().timestamp();
        env.ledger().set(LedgerInfo {
            timestamp: current_time + 86400,
            sequence_number: 1,
            network_id: env.ledger().network_id().into(),
            base_reserve: 100,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6312000,
            protocol_version: 20,
        });

        // Now routing should be successful again
        client.route_payment(&sender, &recipient, &token_address, &2000);
        assert_eq!(
            token_client.balance(&recipient),
            (limit - 50) + (2000 - 20)
        );
    }

    #[test]
    fn test_successful_xlm_routing() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let platform_treasury = Address::generate(&env);

        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        client.initialize(&admin, &platform_treasury, &40, &i128::MAX);

        let token_admin = Address::generate(&env);
        let token_address = env.register_stellar_asset_contract(token_admin.clone());
        let sac = StellarAssetClient::new(&env, &token_address);
        let token_client = token::Client::new(&env, &token_address);

        let initial_balance = 1_000_000_000;
        sac.mint(&sender, &initial_balance);

        // Add token to the whitelist
        client.add_supported_token(&token_address);

        assert_eq!(token_client.balance(&sender), initial_balance);
        assert_eq!(token_client.balance(&recipient), 0);
        assert_eq!(token_client.balance(&platform_treasury), 0);

        let amount = 100_000_000;
        client.route_payment(&sender, &recipient, &token_address, &amount);

        let expected_fee = 400_000;
        let expected_recipient_amount = amount - expected_fee;

        assert_eq!(token_client.balance(&sender), initial_balance - amount);
        assert_eq!(
            token_client.balance(&recipient),
            expected_recipient_amount
        );
        assert_eq!(token_client.balance(&platform_treasury), expected_fee);
    }

    // --- Token Whitelist Tests ---

    #[test]
    fn test_add_supported_token_by_admin() {
        let (env, client) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let token = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &50);

        // Token should not be supported initially
        assert!(!client.is_supported_token(&token));

        // Admin adds the token
        client.add_supported_token(&token);

        // Token should now be supported
        assert!(client.is_supported_token(&token));
    }

    #[test]
    fn test_remove_supported_token_by_admin() {
        let (env, client) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let token = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &50);
        client.add_supported_token(&token);
        assert!(client.is_supported_token(&token));

        // Admin removes the token
        client.remove_supported_token(&token);

        // Token should no longer be supported
        assert!(!client.is_supported_token(&token));
    }

    #[test]
    fn test_route_payment_fails_for_unsupported_token() {
        let (env, client) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_address = env.register_stellar_asset_contract(token_admin.clone());
        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &10_000);

        client.initialize(&admin, &treasury, &100, &50);

        // Token is NOT added to whitelist — route_payment should fail
        let res = client.try_route_payment(&sender, &recipient, &token_address, &1000);
        assert_eq!(res.unwrap_err().unwrap(), Error::UnsupportedToken);
    }

    #[test]
    fn test_route_payment_succeeds_after_token_added_and_fails_after_removed() {
        let (env, client) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_address = env.register_stellar_asset_contract(token_admin.clone());
        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &10_000);

        client.initialize(&admin, &treasury, &100, &50);

        // First, add the token — routing should succeed
        client.add_supported_token(&token_address);
        let res = client.try_route_payment(&sender, &recipient, &token_address, &1000);
        assert!(res.is_ok());

        // Now remove the token — routing should fail
        client.remove_supported_token(&token_address);
        let res = client.try_route_payment(&sender, &recipient, &token_address, &500);
        assert_eq!(res.unwrap_err().unwrap(), Error::UnsupportedToken);
    }

    #[test]
    fn test_multiple_supported_tokens() {
        let (env, client) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &50);

        let token_a = Address::generate(&env);
        let token_b = Address::generate(&env);
        let token_c = Address::generate(&env);

        // Add token_a and token_b
        client.add_supported_token(&token_a);
        client.add_supported_token(&token_b);

        assert!(client.is_supported_token(&token_a));
        assert!(client.is_supported_token(&token_b));
        assert!(!client.is_supported_token(&token_c));

        // Remove token_a
        client.remove_supported_token(&token_a);
        assert!(!client.is_supported_token(&token_a));
        assert!(client.is_supported_token(&token_b));
    }
}
