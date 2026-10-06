#![no_std]

use soroban_sdk::token::TokenInterface;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, String,
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

// ── Packed Allowance helpers (issue #714) ────────────────────────────────────
//
// Issue #714: the per-(owner, spender) allowance was stored as a two-field
// `#[contracttype]` struct. Soroban encodes every contracttype value as an XDR
// map, so each entry carried a struct discriminant plus a key/value pair per
// field on top of the payload itself.
//
// Packing the two fields into one `BytesN<20>` removes that overhead entirely.
//
// Layout (big-endian):
//   bytes  0..16 — amount            : i128 (16 bytes)
//   bytes 16..20 — expiration_ledger : u32  (4 bytes)
//
// Both fields are already minimal width — an allowance is an `i128` because
// token amounts are, and a ledger sequence is a `u32` — so 20 bytes is the
// floor for this record. The saving is the eliminated XDR framing: one
// persistent entry per (owner, spender) pair instead of a struct-encoded one.

/// Pack an allowance amount and its expiry ledger into a 20-byte big-endian
/// buffer.
fn pack_allowance(env: &Env, amount: i128, expiration_ledger: u32) -> BytesN<20> {
    let mut buf = [0u8; 20];

    // Bytes 0..16 — amount (i128 big-endian, two's complement)
    let a = amount.to_be_bytes();
    let mut i = 0;
    while i < 16 {
        buf[i] = a[i];
        i += 1;
    }

    // Bytes 16..20 — expiration_ledger (u32 big-endian)
    let e = expiration_ledger.to_be_bytes();
    buf[16] = e[0];
    buf[17] = e[1];
    buf[18] = e[2];
    buf[19] = e[3];

    BytesN::from_array(env, &buf)
}

/// Unpack a 20-byte buffer into `(amount, expiration_ledger)`.
fn unpack_allowance(packed: &BytesN<20>) -> (i128, u32) {
    let buf: [u8; 20] = packed.to_array();

    let mut a = [0u8; 16];
    let mut i = 0;
    while i < 16 {
        a[i] = buf[i];
        i += 1;
    }
    let amount = i128::from_be_bytes(a);

    let expiration_ledger = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]);

    (amount, expiration_ledger)
}

/// Public-facing allowance record.
///
/// This remains a `#[contracttype]` because `allowance()` returns it to callers
/// and it appears in the generated TS bindings. It is no longer what gets
/// written to storage: `read_allowance` / `write_allowance` convert to and from
/// the packed `BytesN<20>` form above.
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

    /// Reads the packed allowance for `(from, spender)`.
    ///
    /// An entry whose amount is non-zero but whose expiry has already passed
    /// reads back as a zeroed amount, preserving the original expiration so a
    /// later `approve` diff still sees the right baseline.
    fn read_allowance(env: &Env, from: &Address, spender: &Address) -> Allowance {
        let stored: Option<BytesN<20>> = env
            .storage()
            .persistent()
            .get(&DataKey::Allowance(from.clone(), spender.clone()));
        let (amount, expiration_ledger) = match stored {
            Some(packed) => unpack_allowance(&packed),
            None => (0, 0),
        };
        if amount > 0 && expiration_ledger < env.ledger().sequence() {
            return Allowance {
                amount: 0,
                expiration_ledger,
            };
        }
        Allowance {
            amount,
            expiration_ledger,
        }
    }

    fn write_allowance(env: &Env, from: &Address, spender: &Address, value: &Allowance) {
        let key = DataKey::Allowance(from.clone(), spender.clone());
        if value.amount == 0 {
            env.storage().persistent().remove(&key);
        } else {
            let packed = pack_allowance(env, value.amount, value.expiration_ledger);
            env.storage().persistent().set(&key, &packed);
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
