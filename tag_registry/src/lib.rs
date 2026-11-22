#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String, Vec,
};

const MAX_TAGS_PER_OWNER: u32 = 5;
const MAX_ENTRY_TTL: u32 = 6_311_520;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidTag = 3,
    InvalidPeriod = 4,
    AlreadyRegistered = 5,
    Reserved = 6,
    NotFound = 7,
    Expired = 8,
    OwnerTagLimit = 9,
    AlreadyReserved = 10,
    NotReserved = 11,
    ArithmeticOverflow = 12,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Config,
    Tag(String),
    Reserved(String),
    OwnerTags(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct Config {
    admin: Address,
    registration_period_ledgers: u32,
    grace_period_ledgers: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct TagRecord {
    owner: Address,
    expiry_ledger: u32,
}

#[contract]
pub struct TagRegistry;

#[contractimpl]
impl TagRegistry {
    pub fn initialize(
        env: Env,
        admin: Address,
        registration_period_ledgers: u32,
        grace_period_ledgers: u32,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        if registration_period_ledgers == 0
            || registration_period_ledgers
                .checked_add(grace_period_ledgers)
                .is_none_or(|period| period >= MAX_ENTRY_TTL)
        {
            return Err(Error::InvalidPeriod);
        }

        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                admin,
                registration_period_ledgers,
                grace_period_ledgers,
            },
        );
        extend_instance_ttl(&env);
        Ok(())
    }

    pub fn register(env: Env, owner: Address, tag: String) -> Result<(), Error> {
        owner.require_auth();
        validate_tag(&tag)?;
        let config = get_config(&env)?;
        let tag_key = DataKey::Tag(tag.clone());

        if env
            .storage()
            .persistent()
            .has(&DataKey::Reserved(tag.clone()))
        {
            extend_persistent_ttl(&env, &DataKey::Reserved(tag.clone()));
            return Err(Error::Reserved);
        }

        let now = env.ledger().sequence();
        let previous = env.storage().persistent().get::<_, TagRecord>(&tag_key);
        if let Some(record) = previous.clone() {
            if is_held(&record, &config, now) {
                return Err(Error::AlreadyRegistered);
            }
            remove_owner_tag(&env, &record.owner, &tag, &config, now);
        }

        let owner_tags = live_owner_tags(&env, &owner, &config, now);
        if !owner_tags.contains(&tag) && owner_tags.len() >= MAX_TAGS_PER_OWNER {
            return Err(Error::OwnerTagLimit);
        }
        let expiry_ledger = now
            .checked_add(config.registration_period_ledgers)
            .ok_or(Error::ArithmeticOverflow)?;
        expiry_ledger
            .checked_add(config.grace_period_ledgers)
            .ok_or(Error::ArithmeticOverflow)?;
        let record = TagRecord {
            owner: owner.clone(),
            expiry_ledger,
        };
        env.storage().persistent().set(&tag_key, &record);
        extend_persistent_ttl(&env, &tag_key);
        add_owner_tag(&env, &owner, &tag, &config, now);
        extend_instance_ttl(&env);

        env.events()
            .publish((symbol_short!("register"), tag), (owner, expiry_ledger));
        Ok(())
    }

    pub fn resolve(env: Env, tag: String) -> Option<Address> {
        let config = get_config(&env).ok()?;
        if validate_tag(&tag).is_err()
            || env
                .storage()
                .persistent()
                .has(&DataKey::Reserved(tag.clone()))
        {
            return None;
        }
        let record = env
            .storage()
            .persistent()
            .get::<_, TagRecord>(&DataKey::Tag(tag))?;
        if is_held(&record, &config, env.ledger().sequence()) {
            Some(record.owner)
        } else {
            None
        }
    }

    pub fn reverse(env: Env, owner: Address) -> Vec<String> {
        let Ok(config) = get_config(&env) else {
            return Vec::new(&env);
        };
        live_owner_tags(&env, &owner, &config, env.ledger().sequence())
    }

    pub fn transfer(env: Env, tag: String, new_owner: Address) -> Result<(), Error> {
        validate_tag(&tag)?;
        let config = get_config(&env)?;
        let key = DataKey::Tag(tag.clone());
        let mut record = env
            .storage()
            .persistent()
            .get::<_, TagRecord>(&key)
            .ok_or(Error::NotFound)?;
        record.owner.require_auth();

        let now = env.ledger().sequence();
        if !is_held(&record, &config, now) {
            return Err(Error::Expired);
        }
        if record.owner == new_owner {
            return Ok(());
        }
        let new_owner_tags = live_owner_tags(&env, &new_owner, &config, now);
        if !new_owner_tags.contains(&tag) && new_owner_tags.len() >= MAX_TAGS_PER_OWNER {
            return Err(Error::OwnerTagLimit);
        }

        let previous_owner = record.owner.clone();
        remove_owner_tag(&env, &previous_owner, &tag, &config, now);
        record.owner = new_owner.clone();
        env.storage().persistent().set(&key, &record);
        extend_persistent_ttl(&env, &key);
        add_owner_tag(&env, &new_owner, &tag, &config, now);
        extend_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("transfer"), tag),
            (previous_owner, new_owner),
        );
        Ok(())
    }

    pub fn renew(env: Env, tag: String) -> Result<(), Error> {
        validate_tag(&tag)?;
        let config = get_config(&env)?;
        let key = DataKey::Tag(tag.clone());
        let mut record = env
            .storage()
            .persistent()
            .get::<_, TagRecord>(&key)
            .ok_or(Error::NotFound)?;
        record.owner.require_auth();

        let now = env.ledger().sequence();
        if !is_held(&record, &config, now) {
            return Err(Error::Expired);
        }
        record.expiry_ledger = record
            .expiry_ledger
            .max(now)
            .checked_add(config.registration_period_ledgers)
            .ok_or(Error::ArithmeticOverflow)?;
        record
            .expiry_ledger
            .checked_add(config.grace_period_ledgers)
            .ok_or(Error::ArithmeticOverflow)?;
        env.storage().persistent().set(&key, &record);
        extend_persistent_ttl(&env, &key);
        extend_instance_ttl(&env);

        env.events()
            .publish((symbol_short!("renew"), tag), record.expiry_ledger);
        Ok(())
    }

    pub fn release(env: Env, tag: String) -> Result<(), Error> {
        validate_tag(&tag)?;
        let config = get_config(&env)?;
        let key = DataKey::Tag(tag.clone());
        let record = env
            .storage()
            .persistent()
            .get::<_, TagRecord>(&key)
            .ok_or(Error::NotFound)?;
        record.owner.require_auth();
        let now = env.ledger().sequence();
        if !is_held(&record, &config, now) {
            return Err(Error::Expired);
        }

        env.storage().persistent().remove(&key);
        remove_owner_tag(&env, &record.owner, &tag, &config, now);
        extend_instance_ttl(&env);
        env.events()
            .publish((symbol_short!("release"), tag), record.owner);
        Ok(())
    }

    pub fn reserve(env: Env, tag: String) -> Result<(), Error> {
        validate_tag(&tag)?;
        let config = get_config(&env)?;
        config.admin.require_auth();
        let reserved_key = DataKey::Reserved(tag.clone());
        if env.storage().persistent().has(&reserved_key) {
            return Err(Error::AlreadyReserved);
        }
        let now = env.ledger().sequence();
        if let Some(record) = env
            .storage()
            .persistent()
            .get::<_, TagRecord>(&DataKey::Tag(tag.clone()))
        {
            if is_held(&record, &config, now) {
                return Err(Error::AlreadyRegistered);
            }
            remove_owner_tag(&env, &record.owner, &tag, &config, now);
            env.storage()
                .persistent()
                .remove(&DataKey::Tag(tag.clone()));
        }

        env.storage().persistent().set(&reserved_key, &true);
        extend_persistent_ttl(&env, &reserved_key);
        extend_instance_ttl(&env);
        Ok(())
    }

    pub fn unreserve(env: Env, tag: String) -> Result<(), Error> {
        validate_tag(&tag)?;
        let config = get_config(&env)?;
        config.admin.require_auth();
        let key = DataKey::Reserved(tag);
        if !env.storage().persistent().has(&key) {
            return Err(Error::NotReserved);
        }
        env.storage().persistent().remove(&key);
        extend_instance_ttl(&env);
        Ok(())
    }
}

fn get_config(env: &Env) -> Result<Config, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(Error::NotInitialized)
}

fn validate_tag(tag: &String) -> Result<(), Error> {
    let len = tag.len();
    if !(3..=32).contains(&len) {
        return Err(Error::InvalidTag);
    }
    let mut bytes = [0u8; 32];
    tag.copy_into_slice(&mut bytes[..len as usize]);
    for byte in &bytes[..len as usize] {
        if !matches!(*byte, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-') {
            return Err(Error::InvalidTag);
        }
    }
    Ok(())
}

fn is_held(record: &TagRecord, config: &Config, now: u32) -> bool {
    record
        .expiry_ledger
        .checked_add(config.grace_period_ledgers)
        .map(|last_held_ledger| now <= last_held_ledger)
        .unwrap_or(false)
}

fn live_owner_tags(env: &Env, owner: &Address, config: &Config, now: u32) -> Vec<String> {
    let stored = env
        .storage()
        .persistent()
        .get::<_, Vec<String>>(&DataKey::OwnerTags(owner.clone()))
        .unwrap_or(Vec::new(env));
    let mut live = Vec::new(env);
    for tag in stored.iter() {
        if let Some(record) = env
            .storage()
            .persistent()
            .get::<_, TagRecord>(&DataKey::Tag(tag.clone()))
        {
            if record.owner == *owner && is_held(&record, config, now) && !live.contains(&tag) {
                live.push_back(tag);
            }
        }
    }
    live
}

fn add_owner_tag(env: &Env, owner: &Address, tag: &String, config: &Config, now: u32) {
    let mut tags = live_owner_tags(env, owner, config, now);
    if !tags.contains(tag) {
        tags.push_back(tag.clone());
    }
    let key = DataKey::OwnerTags(owner.clone());
    env.storage().persistent().set(&key, &tags);
    extend_persistent_ttl(env, &key);
}

fn remove_owner_tag(env: &Env, owner: &Address, tag: &String, config: &Config, now: u32) {
    let current = live_owner_tags(env, owner, config, now);
    let mut remaining = Vec::new(env);
    for existing in current.iter() {
        if existing != *tag {
            remaining.push_back(existing);
        }
    }
    let key = DataKey::OwnerTags(owner.clone());
    if remaining.is_empty() {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &remaining);
        extend_persistent_ttl(env, &key);
    }
}

fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage().persistent().extend_ttl(key, 0, MAX_ENTRY_TTL);
}

fn extend_instance_ttl(env: &Env) {
    env.storage().instance().extend_ttl(0, MAX_ENTRY_TTL);
}

#[cfg(test)]
mod test;
