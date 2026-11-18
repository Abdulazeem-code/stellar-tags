use crate::errors::Error;
use crate::storage::{
    current_window, pack_rate_counter, unpack_rate_counter, DataKey, DEFAULT_RATE_LIMIT,
    PERSISTENT_BUMP_AMOUNT, PERSISTENT_LIFETIME_THRESHOLD,
};
use soroban_sdk::{log, Address, BytesN, Env};

/// Returns the stored per-ledger invocation cap, or `None` when no configuration has been written.
pub fn get_rate_limit_config(env: &Env) -> Option<u32> {
    env.storage().instance().get(&DataKey::RateLimitConfig)
}

/// Returns the effective per-ledger invocation cap. Falls back to `DEFAULT_RATE_LIMIT`.
pub fn rate_limit_raw(env: &Env) -> u32 {
    get_rate_limit_config(env).unwrap_or(DEFAULT_RATE_LIMIT)
}

/// Returns whether `address` is whitelisted (exempt from rate limiting).
pub fn is_whitelisted(env: &Env, address: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::RateLimitWhitelist(address.clone()))
        .unwrap_or(false)
}

/// Returns how many payment invocations `sender` has consumed in the current ledger window.
pub fn rate_limit_used(env: &Env, sender: &Address) -> u32 {
    let packed = env
        .storage()
        .persistent()
        .get::<DataKey, BytesN<8>>(&DataKey::RateLimitCounter(sender.clone()));

    match packed {
        Some(packed) => {
            let (window_ledger, count) = unpack_rate_counter(&packed);
            if window_ledger == current_window(env) {
                count
            } else {
                0
            }
        }
        None => 0,
    }
}

/// Enforces the per-address, per-ledger invocation cap for one payment.
pub fn check_rate_limit(env: &Env, sender: &Address) -> Result<(), Error> {
    let limit = rate_limit_raw(env);
    if limit == 0 || is_whitelisted(env, sender) {
        return Ok(());
    }

    let used = rate_limit_used(env, sender);
    if used >= limit {
        log!(env, "Rate limit exceeded for sender this ledger");
        return Err(Error::RateLimited);
    }

    let key = DataKey::RateLimitCounter(sender.clone());
    let updated = pack_rate_counter(env, current_window(env), used + 1);
    env.storage().persistent().set(&key, &updated);
    env.storage().persistent().extend_ttl(
        &key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );

    Ok(())
}
