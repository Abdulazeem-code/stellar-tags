#![no_std]

use soroban_sdk::token::TokenInterface;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env, String,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Initialized,
    Paused,
    Name,
    Symbol,
    Decimals,
    TotalSupply,
    Balance(Address),
    Frozen(Address),
    Allowance(Address, Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Allowance {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    Paused = 4,
    AccountFrozen = 5,
    InsufficientBalance = 6,
    InsufficientAllowance = 7,
    InvalidAmount = 8,
    InvalidExpiration = 9,
}

#[contract]
pub struct PausableToken;

const DAY_IN_LEDGERS: u32 = 17280;

#[contractimpl]
impl PausableToken {
    const INSTANCE_BUMP: u32 = 7 * DAY_IN_LEDGERS;
    const INSTANCE_THRESHOLD: u32 = Self::INSTANCE_BUMP - DAY_IN_LEDGERS;
    const USER_BUMP: u32 = 30 * DAY_IN_LEDGERS;
    const USER_THRESHOLD: u32 = Self::USER_BUMP - DAY_IN_LEDGERS;

    pub fn initialize(
        env: Env,
        admin: Address,
        name: String,
        symbol: String,
        decimals: u32,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();

        let store = env.storage().instance();
        store.set(&DataKey::Initialized, &true);
        store.set(&DataKey::Admin, &admin);
        store.set(&DataKey::Name, &name);
        store.set(&DataKey::Symbol, &symbol);
        store.set(&DataKey::Decimals, &decimals);
        store.set(&DataKey::TotalSupply, &0i128);
        store.set(&DataKey::Paused, &false);
        Self::bump_instance(&env);

        env.events().publish((symbol_short!("init"), admin), symbol);
        Ok(())
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        Self::require_admin_auth(&env)?;
        if Self::is_frozen_internal(&env, &new_admin) {
            return Err(Error::AccountFrozen);
        }
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("setadmin"),), new_admin);
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        Self::is_paused_internal(&env)
    }

    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        let admin = Self::require_admin_auth(&env)?;
        env.storage().instance().set(&DataKey::Paused, &paused);
        Self::bump_instance(&env);
        let topic = if paused {
            symbol_short!("paused")
        } else {
            symbol_short!("unpause")
        };
        env.events()
            .publish((topic, admin), env.ledger().sequence());
        Ok(())
    }

    pub fn pause(env: Env) -> Result<(), Error> {
        Self::set_paused(env, true)
    }

    pub fn unpause(env: Env) -> Result<(), Error> {
        Self::set_paused(env, false)
    }

    pub fn is_frozen(env: Env, account: Address) -> bool {
        Self::is_frozen_internal(&env, &account)
    }

    pub fn set_frozen(env: Env, account: Address, frozen: bool) -> Result<(), Error> {
        let admin = Self::require_admin_auth(&env)?;
        if frozen {
            let key = DataKey::Frozen(account.clone());
            env.storage().persistent().set(&key, &true);
            Self::bump_user(&env, &key);
        } else {
            env.storage()
                .persistent()
                .remove(&DataKey::Frozen(account.clone()));
        }
        let topic = if frozen {
            symbol_short!("frozen")
        } else {
            symbol_short!("unfreeze")
        };
        env.events()
            .publish((topic, admin, account), env.ledger().sequence());
        Ok(())
    }

    pub fn freeze(env: Env, account: Address) -> Result<(), Error> {
        Self::set_frozen(env, account, true)
    }

    pub fn unfreeze(env: Env, account: Address) -> Result<(), Error> {
        Self::set_frozen(env, account, false)
    }

    pub fn total_supply(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    pub fn transfer_allowed(env: Env, from: Address, to: Address) -> bool {
        Self::assert_settled(&env, &from, &to).is_ok()
    }

    pub fn mint(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        Self::require_admin_auth(&env)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        Self::assert_movable(&env, &to)?;

        let supply = Self::total_supply(env.clone());
        Self::credit(env.clone(), &to, amount);
        Self::set_total_supply(&env, supply + amount);
        env.events().publish((symbol_short!("mint"), to), amount);
        Ok(())
    }

    fn require_admin_auth(env: &Env) -> Result<Address, Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        Ok(admin)
    }

    fn is_paused_internal(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    fn is_frozen_internal(env: &Env, account: &Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Frozen(account.clone()))
            .unwrap_or(false)
    }

    fn assert_movable(env: &Env, account: &Address) -> Result<(), Error> {
        if Self::is_paused_internal(env) {
            return Err(Error::Paused);
        }
        if Self::is_frozen_internal(env, account) {
            return Err(Error::AccountFrozen);
        }
        Ok(())
    }

    fn assert_settled(env: &Env, from: &Address, to: &Address) -> Result<(), Error> {
        Self::assert_movable(env, from)?;
        Self::assert_movable(env, to)
    }

    fn read_balance(env: &Env, account: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(account.clone()))
            .unwrap_or(0)
    }

    fn credit(env: Env, account: &Address, amount: i128) {
        let key = DataKey::Balance(account.clone());
        let current = Self::read_balance(&env, account);
        env.storage().persistent().set(&key, &(current + amount));
        Self::bump_user(&env, &key);
    }

    fn debit(env: &Env, account: &Address, amount: i128) -> Result<(), Error> {
        let current = Self::read_balance(env, account);
        if current < amount {
            return Err(Error::InsufficientBalance);
        }
        let key = DataKey::Balance(account.clone());
        env.storage().persistent().set(&key, &(current - amount));
        Self::bump_user(env, &key);
        Ok(())
    }

    fn read_allowance(env: &Env, from: &Address, spender: &Address) -> Allowance {
        let stored: Allowance = env
            .storage()
            .persistent()
            .get(&DataKey::Allowance(from.clone(), spender.clone()))
            .unwrap_or(Allowance {
                amount: 0,
                expiration_ledger: 0,
            });
        if stored.amount > 0 && stored.expiration_ledger < env.ledger().sequence() {
            return Allowance {
                amount: 0,
                expiration_ledger: stored.expiration_ledger,
            };
        }
        stored
    }

    fn write_allowance(env: &Env, from: &Address, spender: &Address, value: &Allowance) {
        let key = DataKey::Allowance(from.clone(), spender.clone());
        if value.amount == 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, value);
            Self::bump_user(env, &key);
        }
    }

    fn set_total_supply(env: &Env, supply: i128) {
        env.storage().instance().set(&DataKey::TotalSupply, &supply);
        Self::bump_instance(env);
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(Self::INSTANCE_THRESHOLD, Self::INSTANCE_BUMP);
    }

    fn bump_user(env: &Env, key: &DataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, Self::USER_THRESHOLD, Self::USER_BUMP);
    }
}

#[contractimpl]
impl TokenInterface for PausableToken {
    fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        Self::read_allowance(&env, &from, &spender).amount
    }

    fn approve(env: Env, from: Address, spender: Address, amount: i128, expiration_ledger: u32) {
        if amount < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if amount > 0 && expiration_ledger < env.ledger().sequence() {
            panic_with_error!(&env, Error::InvalidExpiration);
        }
        if let Err(err) = Self::assert_movable(&env, &from) {
            panic_with_error!(&env, err);
        }
        from.require_auth();
        Self::write_allowance(
            &env,
            &from,
            &spender,
            &Allowance {
                amount,
                expiration_ledger,
            },
        );
        env.events().publish(
            (symbol_short!("approve"), from, spender),
            (amount, expiration_ledger),
        );
    }

    fn balance(env: Env, id: Address) -> i128 {
        Self::read_balance(&env, &id)
    }

    fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        if amount < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if let Err(err) = Self::assert_settled(&env, &from, &to) {
            panic_with_error!(&env, err);
        }
        from.require_auth();
        if let Err(err) = Self::debit(&env, &from, amount) {
            panic_with_error!(&env, err);
        }
        Self::credit(env.clone(), &to, amount);
        env.events()
            .publish((symbol_short!("transfer"), from, to), amount);
    }

    fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        if amount < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if let Err(err) = Self::assert_settled(&env, &from, &to) {
            panic_with_error!(&env, err);
        }
        if let Err(err) = Self::assert_movable(&env, &spender) {
            panic_with_error!(&env, err);
        }
        spender.require_auth();
        let allowance = Self::read_allowance(&env, &from, &spender);
        if allowance.amount < amount {
            panic_with_error!(&env, Error::InsufficientAllowance);
        }
        Self::write_allowance(
            &env,
            &from,
            &spender,
            &Allowance {
                amount: allowance.amount - amount,
                expiration_ledger: allowance.expiration_ledger,
            },
        );
        if let Err(err) = Self::debit(&env, &from, amount) {
            panic_with_error!(&env, err);
        }
        Self::credit(env.clone(), &to, amount);
        env.events()
            .publish((symbol_short!("transfer"), from, to), amount);
    }

    fn burn(env: Env, from: Address, amount: i128) {
        if amount < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if let Err(err) = Self::assert_movable(&env, &from) {
            panic_with_error!(&env, err);
        }
        from.require_auth();
        if let Err(err) = Self::debit(&env, &from, amount) {
            panic_with_error!(&env, err);
        }
        let supply = Self::total_supply(env.clone());
        Self::set_total_supply(&env, supply - amount);
        env.events().publish((symbol_short!("burn"), from), amount);
    }

    fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        if amount < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if let Err(err) = Self::assert_movable(&env, &from) {
            panic_with_error!(&env, err);
        }
        if let Err(err) = Self::assert_movable(&env, &spender) {
            panic_with_error!(&env, err);
        }
        spender.require_auth();
        let allowance = Self::read_allowance(&env, &from, &spender);
        if allowance.amount < amount {
            panic_with_error!(&env, Error::InsufficientAllowance);
        }
        Self::write_allowance(
            &env,
            &from,
            &spender,
            &Allowance {
                amount: allowance.amount - amount,
                expiration_ledger: allowance.expiration_ledger,
            },
        );
        if let Err(err) = Self::debit(&env, &from, amount) {
            panic_with_error!(&env, err);
        }
        let supply = Self::total_supply(env.clone());
        Self::set_total_supply(&env, supply - amount);
        env.events().publish((symbol_short!("burn"), from), amount);
    }

    fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Decimals)
            .unwrap_or(0)
    }

    fn name(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Name)
            .unwrap_or_else(|| String::from_str(&env, ""))
    }

    fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Symbol)
            .unwrap_or_else(|| String::from_str(&env, ""))
    }
}

#[cfg(test)]
mod test;
