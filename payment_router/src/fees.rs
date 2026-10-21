use crate::errors::Error;
use crate::storage::{DataKey, BPS_DIVISOR, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD};
use soroban_sdk::{Address, Env};

/// Splits `amount` into the platform fee and the amount forwarded to the
/// recipient, applying the fee cap and the volume-based discount.
pub fn calculate_fee(amount: i128, effective_fee_bps: i128, fee_cap: i128) -> (i128, i128) {
    let mut fee_amount = (amount * effective_fee_bps) / BPS_DIVISOR;
    if fee_amount > fee_cap {
        fee_amount = fee_cap;
    }
    if fee_amount > amount {
        fee_amount = amount;
    }
    (fee_amount, amount - fee_amount)
}

/// Loads the platform treasury address, fee bps, and fee cap from instance storage.
pub fn load_fee_config(env: &Env) -> Result<(Address, i128, i128), Error> {
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

    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

    Ok((platform_treasury, fee_bps, fee_cap))
}
