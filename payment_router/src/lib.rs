#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, log, token, Address, Env};

#[contracttype]
#[derive(Clone)]
use soroban_sdk::{contract, contractimpl, log, symbol_short, token, Address, Env};

const ADMIN: soroban_sdk::Symbol = symbol_short!("admin");
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, log, symbol_short, token, Address, Env,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserSpending {
    pub last_reset_time: u64,
    pub accumulated_amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    PlatformTreasury,
    FeeBps,
    FeeCap,
    UserVolume(Address),
    UserSpending(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserSpending {
    pub last_reset_time: u64,
    pub accumulated_amount: i128,
    Paused,
    Treasury,
    FeeRateBps,
}

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
    Paused = 6,
    InvalidFeeRate = 7,
    /// Sender and recipient addresses are the same (self-routing not allowed).
    InvalidRecipient = 8,
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
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserSpending {
    pub last_reset_time: u64,
    pub accumulated_amount: i128,
}

#[contract]
pub struct PaymentRouter;

#[contractimpl]
impl PaymentRouter {
    const BPS_DIVISOR: i128 = 10_000;
    const XLM_DECIMALS: i128 = 10_000_000;
    const MAX_AMOUNT: i128 = 1_000_000_000_000_000; // 100M tokens with 7 decimals
    const DAILY_MAX_LIMIT: i128 = 1_000_000 * Self::XLM_DECIMALS; // 1M tokens limit
    const VOLUME_THRESHOLD: i128 = 10_000 * Self::XLM_DECIMALS; // 10,000 XLM threshold for tiered fee discount
    const SECONDS_IN_24H: u64 = 24 * 3600;
    const VERSION: u32 = 1;

    const DAY_IN_LEDGERS: u32 = 17280;
    const INSTANCE_BUMP_AMOUNT: u32 = 7 * Self::DAY_IN_LEDGERS;
    const INSTANCE_LIFETIME_THRESHOLD: u32 = Self::INSTANCE_BUMP_AMOUNT - Self::DAY_IN_LEDGERS;

    const USER_BUMP_AMOUNT: u32 = 30 * Self::DAY_IN_LEDGERS;
    const USER_LIFETIME_THRESHOLD: u32 = Self::USER_BUMP_AMOUNT - Self::DAY_IN_LEDGERS;
    const PERSISTENT_BUMP_AMOUNT: u32 = Self::USER_BUMP_AMOUNT;
    const PERSISTENT_LIFETIME_THRESHOLD: u32 = Self::USER_LIFETIME_THRESHOLD;

    fn require_admin(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

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
        env.storage().instance().set(&DataKey::Paused, &false);
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
    pub fn set_fee_config_legacy(env: Env, fee_bps: i128, fee_cap: i128) -> Result<(), Error> {
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

    /// Updates the fee basis points. Admin-only.
    pub fn set_fee_bps(env: Env, new_fee_bps: i128) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);
    /// Returns the current protocol fee percentage in basis points (read-only).
    pub fn get_fee(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::FeeBps)
            .unwrap_or(0)
    /// Pauses or unpauses the payment router. Admin-only.
    pub fn set_pause(env: Env, paused: bool) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &paused);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        env.events().publish(
            (symbol_short!("pause"),),
            (paused,),
        );

        Ok(())
    }

    /// Returns the current protocol fee percentage in basis points (bps).
    pub fn get_fee(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::FeeBps)
            .unwrap_or(0)
    /// Pauses or unpauses the payment router. Admin-only. Alias for set_pause.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        Self::set_pause(env, paused)
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

    /// Transfer admin ownership to a new address.
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

    /// Checks if the contract is paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Pauses or unpauses the contract. Admin-only.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &paused);

        env.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Recovers tokens accidentally sent directly to the contract address. Admin-only.
    pub fn recover_tokens(env: Env, token: Address, amount: i128) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        let contract_address = env.current_contract_address();
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&contract_address, &admin, &amount);

        Ok(())
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

    /// Routes a payment from a sender to a recipient, deducting a platform fee.
    ///
    /// The fee is calculated as a percentage (`fee_bps` / 10,000) of the `amount`,
    /// capped at `fee_cap`. Both values, along with the treasury address, are
    /// read from instance storage set via `initialize`.
    /// The platform fee is transferred to the configured treasury, and the
    /// remaining balance is transferred to `recipient`.
    /// Returns the contract version.
    pub fn version(_env: Env) -> u32 {
        Self::VERSION
    }

    /// Routes a payment from `sender` to `recipient`, deducting a platform
    /// fee (`fee_bps` / 10,000 of `amount`, capped at `fee_cap`) sent to the
    /// configured treasury. Config is read from instance storage set via
    /// `initialize`.
    ///
    /// `token_address` is the contract ID of any Stellar asset implementing
    /// the standard token interface — this is not limited to native XLM.
    /// Passing the contract ID of a Stellar Asset Contract (e.g. a USDC
    /// issuer's SAC) routes that asset instead; the same fee and spending
    /// logic applies uniformly regardless of which asset is passed.
    ///
    /// # Errors
    /// `Error::Paused` if paused. `Error::NotInitialized` if not yet
    /// initialized. `Error::LimitExceeded` if `amount` is out of bounds or
    /// the sender's rolling 24h limit is exceeded. `Error::InsufficientBalance`
    /// if the sender's balance is too low. Also fails if `sender` did not
    /// authorize the call, or the token transfer fails.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&ADMIN) {
            panic!("already initialized");
        }
        env.storage().instance().set(&ADMIN, &admin);
    }

    /// Routes a payment from a sender to a recipient, deducting a platform fee.
    pub fn route_payment(
        env: Env,
        sender: Address,
        recipient: Address,
        token_address: Address,
        amount: i128,
    ) -> Result<(), Error> {
        // 0. Check if the contract is paused
        // 1. Reject if the contract is paused
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }

        sender.require_auth();

        // 1. Verify the sender authorized this transaction
        // 2. Verify the sender authorized this transaction
        sender.require_auth();

        // 2.5. Prevent self-routing (sender == recipient)
        if sender == recipient {
            return Err(Error::InvalidRecipient);
        }

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

        // 5. Apply tiered fee discount for high-volume users
        // Read the sender's cumulative volume *before* this payment to determine
        // whether they qualify for a volume-based fee discount.
        let user_volume = Self::get_user_volume(env.clone(), sender.clone());
        let effective_fee_bps = if user_volume > Self::VOLUME_THRESHOLD {
            fee_bps / 2 // 50% discount
        } else {
            fee_bps
        };

        // 6. Check time-based daily spending limits
        // 4. Check spending limits
        // 4. Check time-based daily spending limits
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

        let token_client = token::Client::new(&env, &token_address);

        // 6. Initialize the token client
        let token_client = token::Client::new(&env, &token_address);

        // 7. Verify sender has sufficient balance
        if token_client.balance(&sender) < amount {
            return Err(Error::InsufficientBalance);
        }

        // 9. Calculate the fee split using the (potentially discounted) fee rate
        let mut fee_amount = (amount * effective_fee_bps) / Self::BPS_DIVISOR;
        if fee_amount > fee_cap {
            fee_amount = fee_cap;
        }
        if fee_amount > amount {
            fee_amount = amount;
        }
        let recipient_amount = amount - fee_amount;

        // 8. Execute token transfers
        // Transfer fee to treasury (only if fee > 0)
        if fee_amount > 0 {
            token_client.transfer(&sender, &platform_treasury, &fee_amount);
        }
        // Transfer remainder to destination
        if recipient_amount > 0 {
            token_client.transfer(&sender, &recipient, &recipient_amount);
        }

        // 11. Record the sender's cumulative routed volume in persistent storage
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

        // Log success
        log!(&env, "Platform fee routed to treasury");
        log!(&env, "Remaining balance routed to recipient");

        Ok(())
    }

    /// Returns the contract version.
    pub fn version(_env: Env) -> u32 {
        Self::VERSION
    }

    fn require_admin(env: &Env) -> Result<Address, Error> {
    /// Returns the effective fee_bps for a sender after applying any
    /// volume-based tiered discount.
    pub fn get_effective_fee_bps(env: Env, sender: Address) -> i128 {
        let fee_bps: i128 = env
            .storage()
            .instance()
            .get(&DataKey::FeeBps)
            .unwrap_or(0);
        let user_volume = Self::get_user_volume(env.clone(), sender);
        if user_volume > Self::VOLUME_THRESHOLD {
            fee_bps / 2 // 50% discount
        } else {
            fee_bps
        }
    }

    /// Calculates protocol fee and remainder
    fn calculate_fee(amount: i128, fee_rate_bps: u32) -> (i128, i128) {
        if fee_rate_bps == 0 || amount <= 0 {
            return (0, amount);
        }
        let fee = amount
            .checked_mul(fee_rate_bps as i128)
            .unwrap_or(0)
            .checked_div(10_000)
            .unwrap_or(0);
        let remainder = amount.checked_sub(fee).unwrap_or(amount);
        (fee, remainder)
    }

    /// Sets treasury and fee rate
    pub fn set_fee_config(env: Env, treasury: Address, fee_rate_bps: u32) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();

        if fee_rate_bps > 1_000 {
            return Err(Error::InvalidFeeRate);
        }

        env.storage()
            .instance()
            .set(&DataKey::Treasury, &treasury);
        env.storage()
            .instance()
            .set(&DataKey::FeeRateBps, &fee_rate_bps);
        env.storage().instance().extend_ttl(
            Self::INSTANCE_LIFETIME_THRESHOLD,
            Self::INSTANCE_BUMP_AMOUNT,
        );

        env.events().publish(
            (symbol_short!("fee_cfg"),),
            (treasury, fee_rate_bps),
        );

        Ok(())
    }

    /// Returns current treasury address
    pub fn get_treasury(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Treasury)
    }

    /// Returns current fee rate in basis points
    pub fn get_fee_rate_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::FeeRateBps)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger as _, LedgerInfo},
        token::StellarAssetClient,
        Address, Env, Symbol, TryIntoVal,
    };

    fn setup_env() -> (Env, PaymentRouterClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);
        (env, client, contract_id)
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
    fn test_get_fee() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        assert_eq!(client.get_fee(), 0);

        client.initialize(&admin, &treasury, &150, &5000);
        assert_eq!(client.get_fee(), 150);

        client.set_fee_bps(&250);
        assert_eq!(client.get_fee(), 250);

        client.set_fee_config(&300, &10000);
        assert_eq!(client.get_fee(), 300);
    }

    #[test]
    fn test_admin_restrictions_and_updates() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let new_admin = Address::generate(&env);
        // Initialize contract
        client.initialize(&admin, &treasury, &100, &1000);

        client.initialize(&admin, &treasury, &100, &1000);
        let res = client.try_initialize(&admin, &treasury, &100, &1000);
        assert_eq!(res.unwrap_err().unwrap(), Error::AlreadyInitialized);

        client.set_admin(&new_admin);

        client.set_fee_config(&200, &2000);
        // Modify config by new admin
        client.set_fee_config_legacy(&200, &2000);

        let new_treasury = Address::generate(&env);
        client.set_platform_treasury(&new_treasury);
    }

    #[test]
    fn test_recover_tokens() {
        let (env, client, contract_id) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &1000);

        let token_admin = Address::generate(&env);
        let token_address = env.register_stellar_asset_contract(token_admin.clone());
        let token_client = token::Client::new(&env, &token_address);
        let stellar_asset_client = token::StellarAssetClient::new(&env, &token_address);

        // Simulate tokens accidentally sent directly to the contract address
        let accidental_amount = 5_000;
        stellar_asset_client.mint(&contract_id, &accidental_amount);

        assert_eq!(token_client.balance(&contract_id), accidental_amount);
        assert_eq!(token_client.balance(&admin), 0);

        // Admin recovers tokens
        let recover_amount = 3_000;
        client.recover_tokens(&token_address, &recover_amount);

        assert_eq!(token_client.balance(&admin), recover_amount);
        assert_eq!(token_client.balance(&contract_id), accidental_amount - recover_amount);
    fn test_get_fee() {
        let (env, client) = setup_env();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        // Before initialization, get_fee returns 0
        assert_eq!(client.get_fee(), 0);

        // Initialize with 250 bps (2.5%)
        client.initialize(&admin, &treasury, &250, &1000).unwrap();
        assert_eq!(client.get_fee(), 250);

        // Update fee via set_fee_bps
        client.set_fee_bps(&300).unwrap();
        assert_eq!(client.get_fee(), 300);

        // Update fee via set_fee_config
        client.set_fee_config(&150, &500).unwrap();
        assert_eq!(client.get_fee(), 150);
    }

    #[test]
    fn test_route_payment_calculates_and_sends_fee() {
        let (env, client, _) = setup_env();
    }

    #[test]
    fn test_set_fee_config_emits_event() {
        let (env, client) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let new_treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &1000);

        client.set_fee_config(&new_treasury, &250u32);

        let events = env.events().all();
        assert_eq!(events.len(), 1);
        let (_, topics, _) = events.get(0).unwrap();
        assert_eq!(topics.len(), 1);
        let topic: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
        assert_eq!(topic, symbol_short!("fee_cfg"));
    }

    #[test]
    fn test_admin_pause_functionality() {
        let (env, client) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_address = env.register_stellar_asset_contract(token_admin.clone());
        let token_client = token::Client::new(&env, &token_address);
        let stellar_asset_client = token::StellarAssetClient::new(&env, &token_address);

        let initial_balance = 10_000;
        stellar_asset_client.mint(&sender, &initial_balance);

        client.initialize(&admin, &treasury, &100, &50);

        let amount_1 = 2000;
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &10_000);

        client.initialize(&admin, &treasury, &100, &50);

        // Initially not paused
        assert_eq!(client.is_paused(), false);

        // Pause the contract using set_pause
        client.set_pause(&true);
        assert_eq!(client.is_paused(), true);

        // Route payment should fail when paused
        let res = client.try_route_payment(&sender, &recipient, &token_address, &1000);
        assert_eq!(res.unwrap_err().unwrap(), Error::Paused);

        // Unpause the contract using set_paused alias
        client.set_paused(&false);
        assert_eq!(client.is_paused(), false);

        // Route payment should succeed now
        client.route_payment(&sender, &recipient, &token_address, &1000);
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

        let amount_2 = 8000;
        // Test fee capped at 50
        let amount_2 = 8000; // 1% of 8000 is 80, which is capped at 50
        client.route_payment(&sender, &recipient, &token_address, &amount_2);

        assert_eq!(token_client.balance(&treasury), 70);
        assert_eq!(token_client.balance(&recipient), 9930);
        assert_eq!(
            token_client.balance(&sender),
            initial_balance - amount_1 - amount_2
        );
        assert_eq!(client.get_user_volume(&sender), amount_1 + amount_2);
    }

    #[test]
    fn test_insufficient_balance() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_address = env.register_stellar_asset_contract(token_admin.clone());
        let stellar_asset_client = token::StellarAssetClient::new(&env, &token_address);

        stellar_asset_client.mint(&sender, &100);

        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &100);

        client.initialize(&admin, &treasury, &100, &50);
        client.add_supported_token(&token_address);

        client.initialize(&admin, &treasury, &100, &50);
        let res = client.try_route_payment(&sender, &recipient, &token_address, &500);
        assert_eq!(res.unwrap_err().unwrap(), Error::InsufficientBalance);
    }

    #[test]
    fn test_daily_limit_and_reset() {
        let (env, client, _) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_address = env.register_stellar_asset_contract(token_admin.clone());
        let token_client = token::Client::new(&env, &token_address);
        let stellar_asset_client = token::StellarAssetClient::new(&env, &token_address);
        let (token_address, token_client, token_admin_client) = setup_token(&env);

        let limit = 10_000_000_000_000;
        stellar_asset_client.mint(&sender, &(limit + 2000));

        client.initialize(&admin, &treasury, &100, &50);

        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &(limit + 2000));

        client.initialize(&admin, &treasury, &100, &50);
        client.add_supported_token(&token_address);

        // Route amount within limit
        client.route_payment(&sender, &recipient, &token_address, &limit);

        let res = client.try_route_payment(&sender, &recipient, &token_address, &2000);
        assert_eq!(res.unwrap_err().unwrap(), Error::LimitExceeded);

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
            protocol_version: 21,
        });

        // Now routing should be successful again
        client.route_payment(&sender, &recipient, &token_address, &2000);
        assert_eq!(
            token_client.balance(&recipient),
            (limit - 50) + (2000 - 20)
        );
    }

    #[test]
    fn test_prevent_self_routing() {
        let (env, client) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);

        let (token_address, _token_client, _token_admin_client) = setup_token(&env);

        // Mint tokens to sender
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &10_000);

        // Initialize router
        client.initialize(&admin, &treasury, &100, &50);

        // Attempt to route payment to self should fail
        let res = client.try_route_payment(&sender, &sender, &token_address, &1000);
        assert_eq!(res.unwrap_err().unwrap(), Error::InvalidRecipient);
    }

    #[test]
    fn test_tiered_fee_discount_applied_after_volume_threshold() {
        let (env, client) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, token_client, _token_admin_client) = setup_token(&env);

        // Threshold is 10,000 XLM = 10,000 * 10,000,000 (7 decimals)
        let threshold = 100_000_000_000i128;
        // Mint enough for two payments: one just above threshold, then a small one
        let first_amount = threshold + 1; // 10,000 XLM + 1 (just above threshold)
        let second_amount = 1000;
        let total_mint = first_amount + second_amount + 10_000_000; // extra for fees
        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &total_mint);

        // Initialize router with 1% fee (100 bps) and no cap
        client.initialize(&admin, &treasury, &100, &i128::MAX);

        // First payment: volume is 0 (< threshold), so full fee applies
        client.route_payment(&sender, &recipient, &token_address, &first_amount);

        let full_fee_first = (first_amount * 100) / 10_000;
        assert_eq!(token_client.balance(&treasury), full_fee_first);
        assert_eq!(token_client.balance(&recipient), first_amount - full_fee_first);
        assert_eq!(client.get_user_volume(&sender), first_amount);
        // Effective fee should still be full rate (volume not yet above threshold when fee was calc'd)
        assert_eq!(client.get_effective_fee_bps(&sender), 100);

        // Second payment: existing volume (first_amount) > threshold, so 50% discount applies
        client.route_payment(&sender, &recipient, &token_address, &second_amount);

        // Effective fee_bps should be 100 / 2 = 50
        let discounted_fee = (second_amount * 50) / 10_000; // 1000 * 50 / 10000 = 5
        assert_eq!(token_client.balance(&treasury), full_fee_first + discounted_fee);
        assert_eq!(
            token_client.balance(&recipient),
            (first_amount - full_fee_first) + (second_amount - discounted_fee)
        );
    }

    #[test]
    fn test_get_effective_fee_bps_no_discount_below_threshold() {
        let (env, client) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let (token_address, _token_client, _token_admin_client) = setup_token(&env);

        let sac = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
        sac.mint(&sender, &1_000_000);

        // Initialize router with 1% fee (100 bps)
        client.initialize(&admin, &treasury, &100, &i128::MAX);

        // No volume yet, so effective fee should equal the full fee_bps
        assert_eq!(client.get_effective_fee_bps(&sender), 100);

        // Route a small payment (below threshold)
        client.route_payment(&sender, &recipient, &token_address, &1000);

        // Volume is 1000, far below 10,000 XLM threshold
        assert_eq!(client.get_effective_fee_bps(&sender), 100);
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

    pub fn emergency_withdraw(env: Env, token: Address, amount: i128) {
        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
        admin.require_auth();

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &admin, &amount);

        log!(&env, "Emergency withdraw executed by admin");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn test_initialize_sets_admin() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let contract_addr = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_addr);

        client.initialize(&admin);

        let stored_admin: Option<Address> =
            env.as_contract(&contract_addr, || env.storage().instance().get(&ADMIN));
        assert_eq!(stored_admin, Some(admin));
    }

    #[test]
    fn test_emergency_withdraw_stores_admin() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let contract_addr = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_addr);

        client.initialize(&admin);

        let stored_admin: Option<Address> =
            env.as_contract(&contract_addr, || env.storage().instance().get(&ADMIN));
        assert_eq!(stored_admin, Some(admin.clone()));
        assert_eq!(stored_admin.unwrap(), admin);
    }

    /// Proves route_payment is asset-agnostic: two independently deployed
    /// Stellar Asset Contracts (standing in for e.g. USDC and EURC) are
    /// each routed correctly through the same initialized router, with
    /// balances and fees tracked separately per asset.
    #[test]
    fn test_routes_multiple_distinct_assets() {
        let (env, client) = setup_env();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        client.initialize(&admin, &treasury, &100, &1_000_000);

        // Two separately deployed assets -- distinct contract IDs, distinct balances.
        let (usdc_like_address, usdc_like_client, usdc_like_admin_client) = setup_token(&env);
        let (eurc_like_address, eurc_like_client, eurc_like_admin_client) = setup_token(&env);
        assert_ne!(usdc_like_address, eurc_like_address);

        usdc_like_admin_client.mint(&sender, &10_000);
        eurc_like_admin_client.mint(&sender, &5_000);

        // Route asset #1
        client.route_payment(&sender, &recipient, &usdc_like_address, &2_000);
        // Route asset #2
        client.route_payment(&sender, &recipient, &eurc_like_address, &1_000);

        // Each asset's balances moved independently -- asset #2 was untouched
        // by asset #1's transfer, and vice versa.
        assert_eq!(usdc_like_client.balance(&sender), 8_000);
        assert_eq!(usdc_like_client.balance(&recipient), 1_980); // 2000 - 1% fee (20)
        assert_eq!(eurc_like_client.balance(&sender), 4_000);
        assert_eq!(eurc_like_client.balance(&recipient), 990); // 1000 - 1% fee (10)

        // Cumulative volume is asset-agnostic -- it's a total across whatever
        // was routed, matching the sum of both payments.
        assert_eq!(client.get_user_volume(&sender), 3_000);
    }
}


