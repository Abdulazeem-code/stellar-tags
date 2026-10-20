//! Dead man's switch operator heartbeat module (issue #889).
//!
//! Allows the admin to appoint a dedicated "heartbeat operator" address that
//! can renew the dead man's switch heartbeat timestamp without holding any
//! other administrative privileges.  This avoids requiring the cold-storage
//! primary admin key for routine monthly renewal operations.
//!
//! # Design invariants
//! - The operator can **only** reset `DataKey::LastHeartbeat`.  It cannot
//!   change the backup admin address, the DMS timeout, or any other contract
//!   parameter.
//! - The operator address is stored under `DataKey::HeartbeatOperator` in
//!   instance storage.
//! - There is at most one operator at a time; setting a new one overwrites
//!   the previous one.
//! - Removing the operator (by the admin) clears the key entirely.

use crate::errors::Error;
use crate::storage::{
    DataKey, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
};
use soroban_sdk::{Address, Env, Symbol};

// ── Operator storage helpers ─────────────────────────────────────────────────

/// Stores `operator` as the designated heartbeat renewal address.
///
/// No authorization is performed here — callers must verify admin auth before
/// calling this function.
pub fn set_heartbeat_operator_internal(env: &Env, operator: &Address) {
    env.storage()
        .instance()
        .set(&DataKey::HeartbeatOperator, operator);
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Removes the designated heartbeat renewal address.
///
/// No authorization is performed here — callers must verify admin auth before
/// calling this function.
pub fn remove_heartbeat_operator_internal(env: &Env) {
    env.storage()
        .instance()
        .remove(&DataKey::HeartbeatOperator);
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Returns the current heartbeat operator, or `None` if none is configured.
pub fn get_heartbeat_operator_internal(env: &Env) -> Option<Address> {
    env.storage()
        .instance()
        .get(&DataKey::HeartbeatOperator)
}

// ── Heartbeat renewal ────────────────────────────────────────────────────────

/// Renews the dead man's switch heartbeat on behalf of `operator`.
///
/// # Authorization
/// `operator` must match the stored `DataKey::HeartbeatOperator` value and
/// must have signed the transaction (i.e. `operator.require_auth()` is called
/// internally).
///
/// # Restrictions
/// The operator may **only** reset the heartbeat timestamp.  It cannot modify
/// the backup admin address, the DMS timeout, or any other contract
/// parameter.  Those operations remain exclusive to the primary admin.
///
/// # Errors
/// - `Error::Unauthorized` — if `operator` does not match the stored operator
///   or if no operator has been configured.
/// - `Error::InvalidDmsConfig` — if the dead man's switch is not armed (no
///   `DataKey::LastHeartbeat` entry exists), because resetting a switch that
///   was never started would be misleading.
pub fn renew_heartbeat(env: &Env, operator: &Address) -> Result<(), Error> {
    // Verify the stored operator matches the caller.
    let stored_operator: Address = env
        .storage()
        .instance()
        .get(&DataKey::HeartbeatOperator)
        .ok_or(Error::Unauthorized)?;

    if *operator != stored_operator {
        return Err(Error::Unauthorized);
    }

    // Require the operator to have authorized this call.
    operator.require_auth();

    // The switch must be armed; renewal on an unarmed switch is an error.
    if !env.storage().instance().has(&DataKey::LastHeartbeat) {
        return Err(Error::InvalidDmsConfig);
    }

    // Reset only the heartbeat timestamp — nothing else.
    let now = env.ledger().timestamp();
    env.storage()
        .instance()
        .set(&DataKey::LastHeartbeat, &now);
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

    env.events().publish(
        (Symbol::new(env, "heartbeat_renewed"), operator.clone()),
        now,
    );

    Ok(())
}
