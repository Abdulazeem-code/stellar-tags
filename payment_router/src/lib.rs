#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, log, token, Address, Env,
};

/// Contract-level errors returned instead of panicking, so callers get a
/// specific, stable error code to branch on rather than an opaque trap.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Caller is not authorized to perform this action (e.g. not the admin).
    Unauthorized = 1,
    /// Sender's token balance is lower than the requested payment amount.
    InsufficientBalance = 2,
    /// Requested amount is outside allowed bounds, or a spending limit was exceeded.
    LimitExceeded = 3,
    /// `initialize` was called on a contract that already has an admin set.
    AlreadyInitialized = 4,
    /// An admin-configured value (treasury, fee, admin) was read before `initialize`.
    NotInitialized = 5,
    /// The contract is currently paused and is not accepting payments.
    Paused = 6,
}

#[contract]
pub struct PaymentRouter;

/// Storage keys for contract configuration and per-user state.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    PlatformTreasury,
    FeeBps,
    FeeCap,
    /// Whether payments are currently paused. Absent means not paused.
    Paused,
    /// Lifetime cumulative amount routed by a given sender.
    UserVolume(Address),
    /// Rolling 24h spending window for a given sender.
    UserSpending(Address),
}

/// Tracks a sender's spending within the current 24h rolling window.
#[contracttype]
#[derive(Clone)]
pub struct UserSpending {
    /// Timestamp (unix seconds) the current window started.
    pub last_reset_time: u64,
    /// Amount accumulated so far within the current window.
    pub accumulated_amount: i128,
}

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

    const XLM_DECIMALS: i128 = 10_000_000;
    const MAX_AMOUNT: i128 = 1_000_000_000_000_000; // 100M tokens with 7 decimals
    const DAILY_MAX_LIMIT: i128 = 1_000_000 * Self::XLM_DECIMALS; // 1M tokens limit
    const SECONDS_IN_24H: u64 = 24 * 3600;
    const VERSION: u32 = 1;

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

    /// Returns the cumulative amount a given sender has routed through the contract.
    pub fn get_user_volume(env: Env, user: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::UserVolume(user))
            .unwrap_or(0)
    }

    /// Set a new admin. Gated by the current admin if one exists (first call
    /// bootstraps the admin with no auth check required).
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        if let Some(admin) = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::Admin)
        {
            admin.require_auth();
        }
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
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

    /// Transfers admin rights to a new address. Requires the current admin's
    /// authorization. Returns `Error::NotInitialized` instead of panicking
    /// if no admin has been set yet.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let current_admin = Self::require_admin(&env)?;
        current_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Pauses the contract, causing `route_payment` to return `Error::Paused`
    /// until `unpause` is called. Admin-only.
    pub fn pause(env: Env) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &true);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Resumes payments after a `pause`. Admin-only.
    pub fn unpause(env: Env) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Returns whether the contract is currently paused. Defaults to `false`
    /// (not paused) if `pause` has never been called.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Returns the contract version.
    pub fn version(_env: Env) -> u32 {
        Self::VERSION
    }

    /// Routes a payment from `sender` to `recipient`, deducting a platform
    /// fee (`fee_bps` / 10,000 of `amount`, capped at `fee_cap`) sent to the
    /// configured treasury. Config is read from instance storage set via
    /// `initialize`.
    ///
    /// # Errors
    /// `Error::Paused` if paused. `Error::NotInitialized` if not yet
    /// initialized. `Error::LimitExceeded` if `amount` is out of bounds or
    /// the sender's rolling 24h limit is exceeded. `Error::InsufficientBalance`
    /// if the sender's balance is too low. Also fails if `sender` did not
    /// authorize the call, or the token transfer fails.
    pub fn route_payment(
        env: Env,
        sender: Address,
        recipient: Address,
        token_address: Address,
        amount: i128,
    ) -> Result<(), Error> {
        // 1. Reject if the contract is paused
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
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

        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        // 5. Check and update the sender's rolling 24h spending window
        let current_time = env.ledger().timestamp();
        let mut spending = env
            .storage()
            .instance()
            .get(&DataKey::UserSpending(sender.clone()))
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
            .instance()
            .set(&DataKey::UserSpending(sender.clone()), &spending);

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
        if fee_amount > 0 {
            token_client.transfer(&sender, &platform_treasury, &fee_amount);
        }
        if recipient_amount > 0 {
            token_client.transfer(&sender, &recipient, &recipient_amount);
        }

        // 10. Record the sender's cumulative routed volume in persistent storage
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

        // Log success for testing
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
        Address, Env,
    };

    fn setup_env() -> (Env, PaymentRouterClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);
        (env, client)
    }

    /// Deploys a Stellar Asset Contract test token and returns both the
    /// standard token client (balance/transfer) and the asset admin client
    /// (mint), since `token::Client` alone has no `mint`.
    fn setup_token(env: &Env) -> (Address, token::Client<'static>, token::StellarAssetClient<'static>) {
        let token_admin = Address::generate(env);
        let token_address = env.register_stellar_asset_contract(token_admin);
        let token_client = token::Client::new(env, &token_address);
        let token_admin_client = token::StellarAssetClient::new(env, &token_address);
        (token_address, token_client, token_admin_client)
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

        let (token_address, token_client, token_admin_client) = setup_token(&env);

        // Mint tokens to sender
        let initial_balance = 10_000;
        token_admin_client.mint(&sender, &initial_balance);

        // Initialize router with 1% fee (100 bps) and cap of 50
        client.initialize(&admin, &treasury, &100, &50);

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
        assert_eq!(token_client.balance(&sender), initial_balance - amount_1 - amount_2);
        assert_eq!(client.get_user_volume(&sender), amount_1 + amount_2);
    }

    #[test]
    fn test_insufficient_balance() {
        let (env, client) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, _token_client, token_admin_client) = setup_token(&env);
        token_admin_client.mint(&sender, &100);

        client.initialize(&admin, &treasury, &100, &50);

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

        let (token_address, token_client, token_admin_client) = setup_token(&env);

        // Daily limit is 1,000,000 * 10,000,000 = 10,000,000,000,000
        let limit: i128 = 10_000_000_000_000;
        token_admin_client.mint(&sender, &(limit + 2000));

        client.initialize(&admin, &treasury, &100, &50);

        // Route amount within limit
        client.route_payment(&sender, &recipient, &token_address, &limit);

        // Exceed daily limit
        let res = client.try_route_payment(&sender, &recipient, &token_address, &2000);
        assert_eq!(res.unwrap_err().unwrap(), Error::LimitExceeded);

        // Warp time by 24 hours (86,400 seconds)
        let current_time = env.ledger().timestamp();
        let current_protocol_version = env.ledger().protocol_version();
        env.ledger().set(LedgerInfo {
            timestamp: current_time + 86400,
            protocol_version: current_protocol_version,
            sequence_number: 1,
            network_id: env.ledger().network_id().into(),
            base_reserve: 100,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6312000,
        });

        // Now routing should be successful again
        client.route_payment(&sender, &recipient, &token_address, &2000);
        assert_eq!(token_client.balance(&recipient), (limit - 50) + (2000 - 20));
    }

    #[test]
    fn test_pause_blocks_payments() {
        let (env, client) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, _token_client, token_admin_client) = setup_token(&env);
        token_admin_client.mint(&sender, &10_000);

        client.initialize(&admin, &treasury, &100, &50);
        assert!(!client.is_paused());

        client.pause();
        assert!(client.is_paused());

        let res = client.try_route_payment(&sender, &recipient, &token_address, &1000);
        assert_eq!(res.unwrap_err().unwrap(), Error::Paused);

        client.unpause();
        assert!(!client.is_paused());

        client.route_payment(&sender, &recipient, &token_address, &1000);
    }

    #[test]
    fn test_transfer_admin_before_initialize_returns_error() {
        let (env, client) = setup_env();

        let placeholder_new_admin = Address::generate(&env);
        let res = client.try_transfer_admin(&placeholder_new_admin);
        assert_eq!(res.unwrap_err().unwrap(), Error::NotInitialized);
    }
}
