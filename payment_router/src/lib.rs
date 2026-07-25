#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, log, token, Address, Env, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    Unauthorized = 1,
    InsufficientBalance = 2,
    LimitExceeded = 3,
    Paused = 4,
    NotInitialized = 5,
    AlreadyInitialized = 6,
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
    const MAX_AMOUNT: i128 = 1_000_000_000_000_000; // 100k tokens with 7 decimals
    const DAILY_MAX_LIMIT: i128 = 1_000_000 * Self::XLM_DECIMALS;
    const SECONDS_IN_24H: u64 = 24 * 3600;
    const VERSION: u32 = 1;

    const DAY_IN_LEDGERS: u32 = 17280;
    const INSTANCE_BUMP_AMOUNT: u32 = 7 * Self::DAY_IN_LEDGERS;
    const INSTANCE_LIFETIME_THRESHOLD: u32 = Self::INSTANCE_BUMP_AMOUNT - Self::DAY_IN_LEDGERS;

    const USER_BUMP_AMOUNT: u32 = 30 * Self::DAY_IN_LEDGERS;
    const USER_LIFETIME_THRESHOLD: u32 = Self::USER_BUMP_AMOUNT - Self::DAY_IN_LEDGERS;

    /// One-time setup: records the admin and initial fee configuration.
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

    /// Helper method to execute a single payment transfer.
    fn execute_transfer(
        env: &Env,
        sender: &Address,
        recipient: &Address,
        token_address: &Address,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 || amount > Self::MAX_AMOUNT {
            return Err(Error::LimitExceeded);
        }

        // Daily spending limit check
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

        if spending.accumulated_amount + amount > Self::DAILY_MAX_LIMIT {
            return Err(Error::LimitExceeded);
        }

        spending.accumulated_amount += amount;
        env.storage()
            .instance()
            .set(&DataKey::UserSpending(sender.clone()), &spending);

        // Load fee config
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

        let mut fee_amount = (amount * fee_bps) / Self::BPS_DIVISOR;
        if fee_amount > fee_cap {
            fee_amount = fee_cap;
        }
        if fee_amount > amount {
            fee_amount = amount;
        }
        let recipient_amount = amount - fee_amount;

        let token_client = token::Client::new(env, token_address);
        if token_client.balance(sender) < amount {
            return Err(Error::InsufficientBalance);
        }

        if fee_amount > 0 {
            token_client.transfer(sender, &platform_treasury, &fee_amount);
        }
        if recipient_amount > 0 {
            token_client.transfer(sender, recipient, &recipient_amount);
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

        log!(env, "Platform fee routed to treasury");
        log!(env, "Remaining balance routed to recipient");

        Ok(())
    }

    /// Routes a payment from sender to recipient, deducting platform fee.
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
        Self::execute_transfer(&env, &sender, &recipient, &token_address, amount)
    }

    /// Accepts a vector of destinations and amounts, iterating and routing funds to each.
    pub fn route_batch(
        env: Env,
        sender: Address,
        token_address: Address,
        destinations: Vec<(Address, i128)>,
    ) -> Result<(), Error> {
        if Self::is_paused(env.clone()) {
            return Err(Error::Paused);
        }

        sender.require_auth();

        for dest in destinations.iter() {
            let (recipient, amount) = dest;
            Self::execute_transfer(&env, &sender, &recipient, &token_address, amount)?;
        }

        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, vec, Env};
    use soroban_sdk::token::StellarAssetClient as TokenAdminClient;

    fn create_token_contract<'a>(
        e: &Env,
        admin: &Address,
    ) -> (token::Client<'a>, TokenAdminClient<'a>) {
        let contract_id = e.register_stellar_asset_contract(admin.clone());
        (
            token::Client::new(e, &contract_id),
            TokenAdminClient::new(e, &contract_id),
        )
    }

    #[test]
    fn test_route_batch_success() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let platform_treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient1 = Address::generate(&env);
        let recipient2 = Address::generate(&env);

        let (token_client, token_admin) = create_token_contract(&env, &admin);
        token_admin.mint(&sender, &10_000);

        let router_id = env.register_contract(None, PaymentRouter);
        let router_client = PaymentRouterClient::new(&env, &router_id);

        router_client.initialize(&admin, &platform_treasury, &100, &50); // 1% fee, cap 50

        let destinations = vec![
            &env,
            (recipient1.clone(), 1000i128),
            (recipient2.clone(), 2000i128),
        ];

        let result = router_client.route_batch(&sender, &token_client.address, &destinations);
        assert_eq!(result, ());

        assert_eq!(token_client.balance(&recipient1), 990);
        assert_eq!(token_client.balance(&recipient2), 1980);
        assert_eq!(token_client.balance(&platform_treasury), 30);
        assert_eq!(token_client.balance(&sender), 7000);

        assert_eq!(router_client.get_user_volume(&sender), 3000);
    }

    #[test]
    fn test_route_batch_paused() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let platform_treasury = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient1 = Address::generate(&env);

        let (token_client, token_admin) = create_token_contract(&env, &admin);
        token_admin.mint(&sender, &10_000);

        let router_id = env.register_contract(None, PaymentRouter);
        let router_client = PaymentRouterClient::new(&env, &router_id);

        router_client.initialize(&admin, &platform_treasury, &100, &50);
        router_client.set_paused(&true);

        let destinations = vec![&env, (recipient1.clone(), 1000i128)];

        let res = router_client.try_route_batch(&sender, &token_client.address, &destinations);
        assert_eq!(res, Err(Ok(Error::Paused)));
    }
}
