#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, log, token, Address, Env};

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

    const DAY_IN_LEDGERS: u32 = 17280;
    const INSTANCE_BUMP_AMOUNT: u32 = 7 * Self::DAY_IN_LEDGERS;
    const INSTANCE_LIFETIME_THRESHOLD: u32 = Self::INSTANCE_BUMP_AMOUNT - Self::DAY_IN_LEDGERS;

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

    /// Updates the fee basis points. Admin-only.
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

    /// Returns the current protocol fee percentage in basis points (bps).
    pub fn get_fee(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::FeeBps)
            .unwrap_or(0)
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
    }

    /// Routes a payment from a sender to a recipient, deducting a platform fee.
    pub fn route_payment(
        env: Env,
        sender: Address,
        recipient: Address,
        token_address: Address,
        amount: i128,
    ) -> Result<(), Error> {
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }

        sender.require_auth();

        if amount <= 0 || amount > Self::MAX_AMOUNT {
            return Err(Error::LimitExceeded);
        }

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

        if token_client.balance(&sender) < amount {
            return Err(Error::InsufficientBalance);
        }

        let mut fee_amount = (amount * fee_bps) / Self::BPS_DIVISOR;
        if fee_amount > fee_cap {
            fee_amount = fee_cap;
        }
        if fee_amount > amount {
            fee_amount = amount;
        }
        let recipient_amount = amount - fee_amount;

        if fee_amount > 0 {
            token_client.transfer(&sender, &platform_treasury, &fee_amount);
        }
        if recipient_amount > 0 {
            token_client.transfer(&sender, &recipient, &recipient_amount);
        }

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

        log!(&env, "Platform fee routed to treasury");
        log!(&env, "Remaining balance routed to recipient");

        Ok(())
    }

    /// Returns the contract version.
    pub fn version(_env: Env) -> u32 {
        Self::VERSION
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

    fn setup_env() -> (Env, PaymentRouterClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);
        (env, client, contract_id)
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

        client.initialize(&admin, &treasury, &100, &1000);
        let res = client.try_initialize(&admin, &treasury, &100, &1000);
        assert_eq!(res.unwrap_err().unwrap(), Error::AlreadyInitialized);

        client.set_admin(&new_admin);

        client.set_fee_config(&200, &2000);

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
    }

    #[test]
    fn test_route_payment_calculates_and_sends_fee() {
        let (env, client, _) = setup_env();

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
        client.route_payment(&sender, &recipient, &token_address, &amount_1);

        assert_eq!(token_client.balance(&treasury), 20);
        assert_eq!(token_client.balance(&recipient), 1980);
        assert_eq!(token_client.balance(&sender), initial_balance - amount_1);
        assert_eq!(client.get_user_volume(&sender), amount_1);

        let amount_2 = 8000;
        client.route_payment(&sender, &recipient, &token_address, &amount_2);

        assert_eq!(token_client.balance(&treasury), 70);
        assert_eq!(token_client.balance(&recipient), 9930);
        assert_eq!(token_client.balance(&sender), initial_balance - amount_1 - amount_2);
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

        let limit = 10_000_000_000_000;
        stellar_asset_client.mint(&sender, &(limit + 2000));

        client.initialize(&admin, &treasury, &100, &50);

        client.route_payment(&sender, &recipient, &token_address, &limit);

        let res = client.try_route_payment(&sender, &recipient, &token_address, &2000);
        assert_eq!(res.unwrap_err().unwrap(), Error::LimitExceeded);

        let current_time = env.ledger().timestamp();
        env.ledger().set(LedgerInfo {
            timestamp: current_time + 86400,
            sequence_number: 1,
            network_id: env.ledger().network_id().into(),
            base_reserve: 100,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6312000,
            protocol_version: 21,
        });

        client.route_payment(&sender, &recipient, &token_address, &2000);
        assert_eq!(token_client.balance(&recipient), (limit - 50) + (2000 - 20));
    }
}
