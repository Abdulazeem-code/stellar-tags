use crate::access::{
    apply_upgrade, is_frozen_internal, require_admin, require_circuit_closed, set_role_internal,
    store_multisig_config, validate_queued_action,
};
use crate::errors::Error;
use crate::storage::{
    DataKey, Role, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT,
    PERSISTENT_LIFETIME_THRESHOLD, SECONDS_IN_24H,
};
use crate::types::{ActionType, TimelockEntry};
use crate::PaymentRouter;
use soroban_sdk::{log, Env, Symbol, Vec};

/// Applies an administrative parameter change to the contract state.
pub fn apply_action(env: &Env, action: ActionType) -> Result<(), Error> {
    match action {
        ActionType::SetPlatformTreasury(new_treasury) => {
            env.storage()
                .instance()
                .set(&DataKey::PlatformTreasury, &new_treasury);
        }
        ActionType::SetFeeConfig(fee_bps, fee_cap) => {
            env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
            env.storage().instance().set(&DataKey::FeeCap, &fee_cap);
        }
        ActionType::SetFeeBps(new_fee_bps) => {
            env.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);
        }
        ActionType::SetGovernance(gov) => {
            env.storage().instance().set(&DataKey::Governance, &gov);
        }
        ActionType::SetMinLimit(min_limit) => {
            env.storage().instance().set(&DataKey::MinLimit, &min_limit);
        }
        ActionType::TransferAdmin(new_admin) => {
            env.storage().instance().set(&DataKey::Admin, &new_admin);
            set_role_internal(env, Role::SuperAdmin, &new_admin);
        }
        ActionType::SetBackupAdmin(backup, timeout_seconds) => {
            PaymentRouter::apply_set_backup_admin(env, backup, timeout_seconds)?;
        }
        ActionType::Upgrade(new_wasm_hash) => {
            apply_upgrade(env, &new_wasm_hash);
        }
        ActionType::SetMultisigConfig(signers, threshold) => {
            store_multisig_config(env, signers, threshold);
        }
        ActionType::RegisterDex(dex) => {
            let key = DataKey::RegisteredDex(dex.clone());
            env.storage().persistent().set(&key, &true);
            env.storage().persistent().extend_ttl(
                &key,
                PERSISTENT_LIFETIME_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
        }
        ActionType::DeregisterDex(dex) => {
            env.storage()
                .persistent()
                .remove(&DataKey::RegisteredDex(dex.clone()));
        }
        ActionType::SetMaxSlippageBps(max_slippage_bps) => {
            env.storage()
                .instance()
                .set(&DataKey::MaxSlippageBps, &max_slippage_bps);
        }
        ActionType::SetPairMaxSlippageBps(token_in, token_out, bps) => {
            let key = DataKey::PairSlippage(token_in, token_out);
            env.storage().persistent().set(&key, &bps);
            env.storage().persistent().extend_ttl(
                &key,
                PERSISTENT_LIFETIME_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
        }
    }

    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

    Ok(())
}

/// Executes a previously queued timelock action identified by `nonce`.
pub fn execute_action(env: &Env, nonce: u64) -> Result<(), Error> {
    if is_frozen_internal(env) {
        return Err(Error::ContractFrozen);
    }
    require_circuit_closed(env)?;

    let admin = require_admin(env)?;
    admin.require_auth();

    let key = DataKey::TimelockEntry(nonce);
    let entry: TimelockEntry = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::TimelockNotFound)?;

    let now = env.ledger().timestamp();
    if now < entry.queued_at + SECONDS_IN_24H {
        return Err(Error::TimelockNotReady);
    }

    validate_queued_action(env, &entry.action)?;

    env.storage().persistent().remove(&key);

    apply_action(env, entry.action)?;

    env.events()
        .publish((Symbol::new(env, "action_executed"), admin), nonce);

    log!(env, "Timelock action executed for nonce {}", nonce);
    Ok(())
}

/// Executes a batch of previously queued timelock actions sequentially within a
/// single atomic invocation.
///
/// Acceptance criteria:
/// - All nonces in the batch are verified ready (delay elapsed, exists, valid)
///   before executing the first action.
/// - Atomic rollback if any action in the batch fails execution.
/// - Emits `batch_actions_executed` event with the list of nonces.
#[allow(clippy::missing_panics_doc)]
pub fn execute_batch_actions(env: &Env, nonces: Vec<u64>) -> Result<(), Error> {
    if is_frozen_internal(env) {
        return Err(Error::ContractFrozen);
    }
    require_circuit_closed(env)?;

    let admin = require_admin(env)?;
    admin.require_auth();

    let len = nonces.len();
    if len == 0 {
        return Ok(());
    }

    // Verify all nonces are unique in the batch.
    for i in 0..len {
        let n_i = nonces.get(i).unwrap();
        for j in (i + 1)..len {
            if n_i == nonces.get(j).unwrap() {
                return Err(Error::TimelockNotFound);
            }
        }
    }

    let now = env.ledger().timestamp();
    let mut entries = Vec::new(env);

    // Phase 1: Verify all actions in the batch are ready and unexpired BEFORE executing the first action.
    for i in 0..len {
        let nonce = nonces.get(i).unwrap();
        let key = DataKey::TimelockEntry(nonce);
        let entry: TimelockEntry = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::TimelockNotFound)?;

        if now < entry.queued_at + SECONDS_IN_24H {
            return Err(Error::TimelockNotReady);
        }

        validate_queued_action(env, &entry.action)?;
        entries.push_back(entry);
    }

    // Phase 2: Execute all actions sequentially within a single atomic invocation.
    for i in 0..len {
        let nonce = nonces.get(i).unwrap();
        let entry = entries.get(i).unwrap();
        let key = DataKey::TimelockEntry(nonce);

        // Remove the entry before applying the action (checks-effects-interactions).
        env.storage().persistent().remove(&key);

        apply_action(env, entry.action)?;

        env.events()
            .publish((Symbol::new(env, "action_executed"), admin.clone()), nonce);

        log!(env, "Timelock action executed for nonce {}", nonce);
    }

    // Phase 3: Emit batch_actions_executed event with list of nonces.
    env.events()
        .publish((Symbol::new(env, "batch_actions_executed"), admin), nonces);

    Ok(())
}
