use crate::errors::Error;
use crate::storage::{
    current_window, pack_rate_counter, unpack_rate_counter, DataKey, DEFAULT_RATE_LIMIT,
};
use soroban_sdk::{log, Address, BytesN, Env};

// TTL configuration for rate limit counters in temporary storage.
// 1000 ledgers ≈ 85 minutes (assuming ~5 seconds per ledger), which comfortably
// covers the hourly sliding window while allowing automatic expiration.
const RATE_LIMIT_TTL_LEDGERS: u32 = 1000;

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
    let key = DataKey::RateLimitCounter(sender.clone());

    // First check temporary storage (new location).
    let packed = env
        .storage()
        .temporary()
        .get::<DataKey, BytesN<8>>(&key);

    match packed {
        Some(packed) => {
            let (window_ledger, count) = unpack_rate_counter(&packed);
            if window_ledger == current_window(env) {
                count
            } else {
                0
            }
        }
        None => {
            // Fallback: check legacy persistent storage and migrate if found.
            // This ensures backwards compatibility for counters written before the migration.
            if let Some(legacy_packed) = env
                .storage()
                .persistent()
                .get::<DataKey, BytesN<8>>(&key)
            {
                let (window_ledger, count) = unpack_rate_counter(&legacy_packed);
                
                // Clean up the legacy persistent entry to recover rent.
                env.storage().persistent().remove(&key);
                
                // Return the count if it's still valid for the current window.
                if window_ledger == current_window(env) {
                    return count;
                }
            }
            0
        }
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
    
    // Write to temporary storage instead of persistent.
    env.storage().temporary().set(&key, &updated);
    
    // Extend TTL to 1000 ledgers from now. This ensures the counter stays alive
    // for the current rate-limiting window plus a comfortable margin, then
    // automatically expires to save ledger rent.
    env.storage()
        .temporary()
        .extend_ttl(&key, RATE_LIMIT_TTL_LEDGERS, RATE_LIMIT_TTL_LEDGERS);

    Ok(())
}
