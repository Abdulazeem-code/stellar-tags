//! Two-phase commit protocol for cross-contract timelocked upgrades (issue #887).
//!
//! Upgrades that span several contracts cannot be applied one contract at a
//! time.  If the `payment_router` routing upgrade lands while the
//! `twap_oracle` price-feed upgrade reverts, the protocol is left half
//! upgraded: a broken, desynchronized state that can freeze funds or corrupt
//! price feeds.
//!
//! This module splits a multi-contract upgrade into two phases that the host
//! executes atomically:
//!
//! * **Phase 1 — `prepare_cross_contract_upgrade`.** Validates the upgrade
//!   manifest (`code_hashes` must pair 1:1 with `contract_addresses`) and
//!   registers it on *every* participating contract.  All targets receive the
//!   very same `not_before` timestamp so a single 48-hour timer covers the
//!   whole set.  If any target rejects its manifest, the invocation reverts
//!   and no contract is left holding a dangling registration.
//! * **Phase 2 — `commit_cross_contract_upgrade`.** Re-validates every
//!   manifest entry first (delay elapsed, deadline not passed, ids and hashes
//!   intact) and only then invokes `commit_upgrade` on each target.  Any
//!   failure — local validation or a target rejecting its own manifest —
//!   unwinds the whole invocation, rolling back every contract that was
//!   upgraded earlier in the same call, so the protocol can never end up
//!   half-upgraded.
//!
//! Participating contracts expose two hooks:
//! `prepare_upgrade(upgrade_id, code_hash, not_before) -> u64` (Phase 1, one
//! argument echoed back for synchronization verification) and
//! `commit_upgrade(upgrade_id, code_hash) -> BytesN<32>` (Phase 2, echoing the
//! applied code hash).

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
use soroban_sdk::{contracttype, log, Address, BytesN, Env, IntoVal, Symbol, Vec};

#[cfg(test)]
use soroban_sdk::{contract, contracterror, contractimpl};

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
        ActionType::SetTieredDeadMansSwitch(
            backup,
            tier1_timeout,
            council,
            threshold,
            tier2_timeout,
        ) => {
            PaymentRouter::apply_set_tiered_dead_mans_switch(
                env,
                backup,
                tier1_timeout,
                council,
                threshold,
                tier2_timeout,
            )?;
        }
        ActionType::Upgrade(new_wasm_hash) => {
            apply_upgrade(env, &new_wasm_hash);
        }
        ActionType::SetMultisigConfig(signers, threshold) => {
            store_multisig_config(env, signers, threshold)?;
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

    if nonces.is_empty() {
        return Ok(());
    }

    // Verify all nonces are unique in the batch.
    let mut seen: Vec<u64> = Vec::new(env);
    for nonce in nonces.iter() {
        if seen.contains(nonce) {
            return Err(Error::TimelockNotFound);
        }
        seen.push_back(nonce);
    }

    let now = env.ledger().timestamp();
    let mut entries = Vec::new(env);

    // Phase 1: Verify all actions in the batch are ready and unexpired BEFORE executing the first action.
    for nonce in nonces.iter() {
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
    for (nonce, entry) in nonces.iter().zip(entries.iter()) {
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

// ── Two-phase commit: cross-contract timelocked upgrades ────────────────────

/// Mandatory timelock enforced by Phase 1 across *all* participating
/// contracts: no manifest may be committed before `prepared_at + 48h`.
pub const TIMELOCK_DELAY_SECONDS: u64 = 48 * 60 * 60;

/// How long a prepared manifest stays executable after the delay expires.
/// Miss the window and the upgrade has to be prepared from scratch.
pub const EXECUTION_WINDOW_SECONDS: u64 = 7 * 24 * 60 * 60;

/// Phase 1 hook every participating contract must expose.
const PREPARE_HOOK: &str = "prepare_upgrade";

/// Phase 2 hook every participating contract must expose.
const COMMIT_HOOK: &str = "commit_upgrade";

/// A prepared cross-contract upgrade waiting for its 48-hour timelock to
/// elapse.  Stored under [`DataKey::TwoPhaseCommit`] keyed by `upgrade_id`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TwoPhaseCommit {
    /// Unique identifier of the upgrade; also the storage key of the manifest.
    pub upgrade_id: BytesN<32>,
    /// Every participating contract, in a deterministic order.
    pub contract_addresses: Vec<Address>,
    /// The code hash each contract at the same index must be upgraded to.
    pub code_hashes: Vec<BytesN<32>>,
    /// Ledger timestamp (seconds) at which Phase 1 registered the manifests.
    /// One timestamp is shared by every target, so the 48-hour delay is
    /// synchronized across the whole set.
    pub prepared_at: u64,
    /// Ledger timestamp after which the prepared upgrade may no longer be
    /// committed and must be re-prepared.
    pub execution_deadline: u64,
}

/// Checks a stored manifest before Phase 2 may talk to any contract.
///
/// Every participating entry has to satisfy the delay and deadline checks, so
/// a single stale or freshly-prepared target aborts the commit for the whole
/// set — this is what makes the commit revert atomically instead of upgrading
/// a subset of the contracts.
fn validate_manifest(env: &Env, manifest: &TwoPhaseCommit) -> Result<(), Error> {
    let len = manifest.contract_addresses.len();
    if len == 0 || len != manifest.code_hashes.len() {
        return Err(Error::InvalidUpgradeManifest);
    }

    let now = env.ledger().timestamp();
    if now < manifest.prepared_at.saturating_add(TIMELOCK_DELAY_SECONDS) {
        return Err(Error::TimelockNotReady);
    }
    if now > manifest.execution_deadline {
        return Err(Error::UpgradeManifestExpired);
    }

    Ok(())
}

/// Phase 1: validate an upgrade and register the manifest on every target
/// contract under one synchronized 48-hour timelock.
///
/// # Parameters
/// - `upgrade_id`: unique identifier of the upgrade attempt.
/// - `contract_addresses`: every contract taking part in the upgrade.
/// - `code_hashes`: the code hash to upgrade the contract at the matching
///   index to.  Must have exactly one entry per address.
///
/// # Returns
/// The stored [`TwoPhaseCommit`] manifest on success.  If any target rejects
/// its manifest, or the manifest is malformed, the whole invocation reverts
/// and no contract keeps a registration.
pub fn prepare_cross_contract_upgrade(
    env: &Env,
    upgrade_id: BytesN<32>,
    contract_addresses: Vec<Address>,
    code_hashes: Vec<BytesN<32>>,
) -> Result<TwoPhaseCommit, Error> {
    if is_frozen_internal(env) {
        return Err(Error::ContractFrozen);
    }
    let admin = require_admin(env)?;
    admin.require_auth();

    // Manifest shape: at least one target, exactly one code hash per target
    // and no contract listed twice (a duplicate would be upgraded twice).
    let len = contract_addresses.len();
    if len == 0 || len != code_hashes.len() {
        return Err(Error::InvalidUpgradeManifest);
    }
    for (position, address) in contract_addresses.iter().enumerate() {
        for other in contract_addresses.iter().skip(position + 1) {
            if address == other {
                return Err(Error::InvalidUpgradeManifest);
            }
        }
    }

    let key = DataKey::TwoPhaseCommit(upgrade_id.clone());
    if env.storage().persistent().has(&key) {
        return Err(Error::TimelockPending);
    }

    let prepared_at = env.ledger().timestamp();
    let not_before = prepared_at.saturating_add(TIMELOCK_DELAY_SECONDS);
    let execution_deadline = not_before.saturating_add(EXECUTION_WINDOW_SECONDS);

    // Register the manifest on every participating contract.  Each target
    // gets the identical `not_before`, and each has to echo it back: a target
    // that refuses, or that runs a different timer, reverts the whole phase
    // so the 48-hour delay is guaranteed across the entire set.
    for (address, code_hash) in contract_addresses.iter().zip(code_hashes.iter()) {
        let args = soroban_sdk::vec![
            env,
            upgrade_id.clone().into_val(env),
            code_hash.into_val(env),
            not_before.into_val(env)
        ];
        let confirmed: u64 = match env.try_invoke_contract::<u64, Error>(
            &address,
            &Symbol::new(env, PREPARE_HOOK),
            args,
        ) {
            Ok(Ok(confirmed)) => confirmed,
            _ => return Err(Error::UpgradePrepareFailed),
        };
        if confirmed != not_before {
            return Err(Error::UpgradePrepareFailed);
        }
    }

    let manifest = TwoPhaseCommit {
        upgrade_id,
        contract_addresses,
        code_hashes,
        prepared_at,
        execution_deadline,
    };

    env.storage().persistent().set(&key, &manifest);
    env.storage().persistent().extend_ttl(
        &key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

    env.events().publish(
        (Symbol::new(env, "upgrade_prepared"), admin),
        (manifest.prepared_at, manifest.execution_deadline),
    );

    log!(
        env,
        "Cross-contract upgrade prepared, {} contract(s) commit after {}",
        manifest.contract_addresses.len(),
        not_before
    );

    Ok(manifest)
}

/// Phase 2: commit a prepared upgrade across every participating contract
/// atomically.
///
/// All manifest entries are validated before the first cross-contract call is
/// made, and the commit is applied by invoking `commit_upgrade` on each target
/// in order.  If any target rejects its manifest validation the error
/// unwinds this entire invocation, so contracts upgraded earlier in the same
/// call roll back with it: either every contract lands on its new code hash or
/// none of them do.
///
/// Admin authorization is required and the contract must not be frozen.
pub fn commit_cross_contract_upgrade(env: &Env, upgrade_id: BytesN<32>) -> Result<(), Error> {
    if is_frozen_internal(env) {
        return Err(Error::ContractFrozen);
    }
    let admin = require_admin(env)?;
    admin.require_auth();

    let key = DataKey::TwoPhaseCommit(upgrade_id.clone());
    let manifest: TwoPhaseCommit = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::TimelockNotFound)?;

    // Validate every manifest entry up-front, before touching any contract.
    validate_manifest(env, &manifest)?;

    // Effects before interactions: consume the manifest.  Should a target
    // reject below, the removal and every effect already applied by an
    // earlier target are rolled back with the failing invocation.
    env.storage().persistent().remove(&key);

    for (address, code_hash) in manifest
        .contract_addresses
        .iter()
        .zip(manifest.code_hashes.iter())
    {
        let args = soroban_sdk::vec![
            env,
            upgrade_id.clone().into_val(env),
            code_hash.clone().into_val(env)
        ];
        let applied: BytesN<32> = match env.try_invoke_contract::<BytesN<32>, Error>(
            &address,
            &Symbol::new(env, COMMIT_HOOK),
            args,
        ) {
            Ok(Ok(applied)) => applied,
            _ => return Err(Error::UpgradeCommitFailed),
        };
        if applied != code_hash {
            return Err(Error::UpgradeCommitFailed);
        }
    }

    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

    env.events().publish(
        (
            Symbol::new(env, "upgrade_committed"),
            admin,
            manifest.upgrade_id.clone(),
        ),
        manifest.contract_addresses.clone(),
    );

    log!(
        env,
        "Cross-contract upgrade committed across {} contract(s)",
        manifest.contract_addresses.len()
    );

    Ok(())
}

/// Returns the prepared [`TwoPhaseCommit`] manifest for `upgrade_id`, or
/// [`Error::TimelockNotFound`] if it does not exist (never prepared, already
/// committed, or no longer in the execution window storage).
pub fn get_cross_contract_upgrade(
    env: &Env,
    upgrade_id: BytesN<32>,
) -> Result<TwoPhaseCommit, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::TwoPhaseCommit(upgrade_id))
        .ok_or(Error::TimelockNotFound)
}

// ── Test-only participating contract ────────────────────────────────────────

/// A minimal participating contract used by the tests below.  It behaves like
/// a real target (`twap_oracle` and friends): Phase 1 stores the manifest
/// under the synchronized timer, Phase 2 re-validates it before applying the
/// new code hash, and any mismatch rejects the commit.
#[cfg(test)]
#[contract]
pub struct UpgradeTarget;

/// Storage keys of the test-only [`UpgradeTarget`].
#[cfg(test)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum TargetKey {
    /// The manifest registered in Phase 1, until Phase 2 consumes it.
    Manifest,
    /// The code hash applied by a successful Phase 2.
    Applied,
}

/// The manifest a participating contract stores during Phase 1.
#[cfg(test)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct TargetManifest {
    upgrade_id: BytesN<32>,
    code_hash: BytesN<32>,
    not_before: u64,
}

/// Errors a participating contract can reject Phase 2 with.
#[cfg(test)]
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TargetError {
    ManifestMissing = 1,
    IdMismatch = 2,
    HashMismatch = 3,
    NotReady = 4,
}

#[cfg(test)]
#[contractimpl]
impl UpgradeTarget {
    /// Phase 1 hook: record the manifest under the synchronized timer and
    /// echo `not_before` back so the router can verify every target runs the
    /// same 48-hour delay.
    pub fn prepare_upgrade(
        env: Env,
        upgrade_id: BytesN<32>,
        code_hash: BytesN<32>,
        not_before: u64,
    ) -> u64 {
        let manifest = TargetManifest {
            upgrade_id,
            code_hash,
            not_before,
        };
        env.storage()
            .instance()
            .set(&TargetKey::Manifest, &manifest);
        not_before
    }

    /// Phase 2 hook: re-validate this contract's own manifest and apply the
    /// new code hash only if it still matches.  Rejecting here unwinds the
    /// router's whole commit.
    pub fn commit_upgrade(
        env: Env,
        upgrade_id: BytesN<32>,
        code_hash: BytesN<32>,
    ) -> Result<BytesN<32>, TargetError> {
        let manifest: TargetManifest = env
            .storage()
            .instance()
            .get(&TargetKey::Manifest)
            .ok_or(TargetError::ManifestMissing)?;
        if manifest.upgrade_id != upgrade_id {
            return Err(TargetError::IdMismatch);
        }
        if manifest.code_hash != code_hash {
            return Err(TargetError::HashMismatch);
        }
        if env.ledger().timestamp() < manifest.not_before {
            return Err(TargetError::NotReady);
        }
        env.storage()
            .instance()
            .set(&TargetKey::Applied, &code_hash);
        env.storage().instance().remove(&TargetKey::Manifest);
        Ok(code_hash)
    }

    /// Test helper: simulate this contract's manifest drifting away from the
    /// router's copy between Phase 1 and Phase 2 (e.g. an unrelated upgrade
    /// landed first), so Phase 2 validation fails for this contract only.
    pub fn simulate_manifest_drift(env: Env) {
        let existing: Option<TargetManifest> = env.storage().instance().get(&TargetKey::Manifest);
        let Some(mut manifest) = existing else {
            return;
        };
        manifest.code_hash = BytesN::from_array(&env, &[0xAA; 32]);
        env.storage()
            .instance()
            .set(&TargetKey::Manifest, &manifest);
    }

    /// Whether a successful Phase 2 applied a new code hash to this contract.
    pub fn is_applied(env: Env) -> bool {
        env.storage().instance().has(&TargetKey::Applied)
    }

    /// The code hash this contract applied, or 32 zero bytes if none.
    pub fn applied_code_hash(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&TargetKey::Applied)
            .unwrap_or_else(|| BytesN::from_array(&env, &[0u8; 32]))
    }

    /// The `not_before` registered in Phase 1, or 0 when nothing is prepared.
    pub fn not_before(env: Env) -> u64 {
        env.storage()
            .instance()
            .get::<TargetKey, TargetManifest>(&TargetKey::Manifest)
            .map(|manifest| manifest.not_before)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PaymentRouter, PaymentRouterClient};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        vec,
    };

    /// Deploys and initializes the router with `env.mock_all_auths()` set.
    fn setup() -> (Env, PaymentRouterClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        // Start from a realistic, non-zero ledger clock so timestamp
        // assertions in the tests are meaningful.
        env.ledger().with_mut(|info| info.timestamp = 1_700_000_000);
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100, &1000, &1_000_000_000_000_000);
        (env, client)
    }

    fn hash(env: &Env, byte: u8) -> BytesN<32> {
        BytesN::from_array(env, &[byte; 32])
    }

    fn zero_hash(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[0u8; 32])
    }

    /// Moves the ledger clock forward by `seconds`.
    fn advance(env: &Env, seconds: u64) {
        env.ledger().with_mut(|info| info.timestamp += seconds);
    }

    #[test]
    fn test_prepare_registers_synchronized_manifests_and_starts_48h_timer() {
        let (env, client) = setup();
        let target_a = env.register_contract(None, UpgradeTarget);
        let target_b = env.register_contract(None, UpgradeTarget);
        let id = hash(&env, 0x01);
        let hash_a = hash(&env, 0xA1);
        let hash_b = hash(&env, 0xB2);
        let addresses = vec![&env, target_a.clone(), target_b.clone()];
        let hashes = vec![&env, hash_a.clone(), hash_b.clone()];
        let now = env.ledger().timestamp();

        let manifest = client.prepare_cross_contract_upgrade(&id, &addresses, &hashes);

        // The manifest records everything Phase 2 needs to verify.
        assert_eq!(manifest.upgrade_id, id);
        assert_eq!(manifest.contract_addresses, addresses);
        assert_eq!(manifest.code_hashes, hashes);
        assert_eq!(manifest.prepared_at, now);
        assert_eq!(
            manifest.execution_deadline,
            now + TIMELOCK_DELAY_SECONDS + EXECUTION_WINDOW_SECONDS
        );

        // And it is readable back through the contract.
        assert_eq!(client.get_cross_contract_upgrade(&id), manifest);

        // Both targets echoed the identical timer, so a single 48-hour delay
        // covers every participating contract.
        let a = UpgradeTargetClient::new(&env, &target_a);
        let b = UpgradeTargetClient::new(&env, &target_b);
        assert_eq!(a.not_before(), now + TIMELOCK_DELAY_SECONDS);
        assert_eq!(b.not_before(), now + TIMELOCK_DELAY_SECONDS);

        // Nothing has been upgraded yet.
        assert!(!a.is_applied());
        assert!(!b.is_applied());
    }

    #[test]
    fn test_commit_is_rejected_before_the_48_hour_delay() {
        let (env, client) = setup();
        let target_a = env.register_contract(None, UpgradeTarget);
        let target_b = env.register_contract(None, UpgradeTarget);
        let id = hash(&env, 0x02);
        let addresses = vec![&env, target_a.clone(), target_b.clone()];
        let hashes = vec![&env, hash(&env, 0xA1), hash(&env, 0xB2)];
        client.prepare_cross_contract_upgrade(&id, &addresses, &hashes);
        let a = UpgradeTargetClient::new(&env, &target_a);
        let b = UpgradeTargetClient::new(&env, &target_b);

        // Immediately, and again one second short of the delay: not ready.
        let res = client.try_commit_cross_contract_upgrade(&id);
        assert_eq!(res.unwrap_err().unwrap(), Error::TimelockNotReady);

        advance(&env, TIMELOCK_DELAY_SECONDS - 1);
        let res = client.try_commit_cross_contract_upgrade(&id);
        assert_eq!(res.unwrap_err().unwrap(), Error::TimelockNotReady);

        // No contract was touched and the manifest survives for the retry.
        assert!(!a.is_applied());
        assert!(!b.is_applied());
        assert_eq!(client.get_cross_contract_upgrade(&id).upgrade_id, id);
    }

    #[test]
    fn test_multi_contract_commit_upgrades_every_contract_atomically() {
        let (env, client) = setup();
        let target_a = env.register_contract(None, UpgradeTarget);
        let target_b = env.register_contract(None, UpgradeTarget);
        let id = hash(&env, 0x03);
        let hash_a = hash(&env, 0xA1);
        let hash_b = hash(&env, 0xB2);
        let addresses = vec![&env, target_a.clone(), target_b.clone()];
        let hashes = vec![&env, hash_a.clone(), hash_b.clone()];
        client.prepare_cross_contract_upgrade(&id, &addresses, &hashes);
        advance(&env, TIMELOCK_DELAY_SECONDS + 1);

        client.commit_cross_contract_upgrade(&id);

        let a = UpgradeTargetClient::new(&env, &target_a);
        let b = UpgradeTargetClient::new(&env, &target_b);
        assert!(a.is_applied());
        assert!(b.is_applied());
        assert_eq!(a.applied_code_hash(), hash_a);
        assert_eq!(b.applied_code_hash(), hash_b);

        // The manifest is consumed, so the upgrade is single-use.
        let res = client.try_get_cross_contract_upgrade(&id);
        assert_eq!(res.unwrap_err().unwrap(), Error::TimelockNotFound);
        let res = client.try_commit_cross_contract_upgrade(&id);
        assert_eq!(res.unwrap_err().unwrap(), Error::TimelockNotFound);
    }

    #[test]
    fn test_partial_failure_rolls_back_the_whole_upgrade() {
        let (env, client) = setup();
        let target_a = env.register_contract(None, UpgradeTarget);
        let target_b = env.register_contract(None, UpgradeTarget);
        let id = hash(&env, 0x04);
        let addresses = vec![&env, target_a.clone(), target_b.clone()];
        let hashes = vec![&env, hash(&env, 0xA1), hash(&env, 0xB2)];
        client.prepare_cross_contract_upgrade(&id, &addresses, &hashes);

        // The second contract's manifest no longer matches the router's copy,
        // so its Phase 2 validation fails after the first one already applied.
        let b = UpgradeTargetClient::new(&env, &target_b);
        b.simulate_manifest_drift();
        advance(&env, TIMELOCK_DELAY_SECONDS + 1);

        let res = client.try_commit_cross_contract_upgrade(&id);
        assert_eq!(res.unwrap_err().unwrap(), Error::UpgradeCommitFailed);

        // Contract A was upgraded first, inside the failing call: its upgrade
        // must have rolled back with the invocation. No contract is left on a
        // new code hash, so the protocol is never half-upgraded.
        let a = UpgradeTargetClient::new(&env, &target_a);
        assert!(!a.is_applied());
        assert_eq!(a.applied_code_hash(), zero_hash(&env));
        assert!(!b.is_applied());

        // The manifest removal rolled back too, so the upgrade can be
        // re-attempted once the drifting contract is fixed.
        assert_eq!(
            client.get_cross_contract_upgrade(&id).contract_addresses,
            addresses
        );
    }

    #[test]
    fn test_commit_after_the_execution_deadline_is_rejected() {
        let (env, client) = setup();
        let target_a = env.register_contract(None, UpgradeTarget);
        let target_b = env.register_contract(None, UpgradeTarget);
        let id = hash(&env, 0x05);
        let addresses = vec![&env, target_a.clone(), target_b.clone()];
        let hashes = vec![&env, hash(&env, 0xA1), hash(&env, 0xB2)];
        client.prepare_cross_contract_upgrade(&id, &addresses, &hashes);
        advance(&env, TIMELOCK_DELAY_SECONDS + EXECUTION_WINDOW_SECONDS + 1);

        let res = client.try_commit_cross_contract_upgrade(&id);
        assert_eq!(res.unwrap_err().unwrap(), Error::UpgradeManifestExpired);

        let a = UpgradeTargetClient::new(&env, &target_a);
        let b = UpgradeTargetClient::new(&env, &target_b);
        assert!(!a.is_applied());
        assert!(!b.is_applied());
    }

    #[test]
    fn test_prepare_rejects_malformed_and_duplicate_manifests() {
        let (env, client) = setup();
        let target = env.register_contract(None, UpgradeTarget);
        let id = hash(&env, 0x06);

        // No targets at all.
        let res = client.try_prepare_cross_contract_upgrade(&id, &vec![&env], &vec![&env]);
        assert_eq!(res.unwrap_err().unwrap(), Error::InvalidUpgradeManifest);

        // Two addresses, three code hashes.
        let res = client.try_prepare_cross_contract_upgrade(
            &id,
            &vec![&env, target.clone()],
            &vec![&env, hash(&env, 1), hash(&env, 2)],
        );
        assert_eq!(res.unwrap_err().unwrap(), Error::InvalidUpgradeManifest);

        // The same contract listed twice would be upgraded twice.
        let res = client.try_prepare_cross_contract_upgrade(
            &id,
            &vec![&env, target.clone(), target],
            &vec![&env, hash(&env, 1), hash(&env, 2)],
        );
        assert_eq!(res.unwrap_err().unwrap(), Error::InvalidUpgradeManifest);

        // None of the rejected attempts left state behind.
        let res = client.try_get_cross_contract_upgrade(&id);
        assert_eq!(res.unwrap_err().unwrap(), Error::TimelockNotFound);
        let res = client.try_commit_cross_contract_upgrade(&id);
        assert_eq!(res.unwrap_err().unwrap(), Error::TimelockNotFound);
    }

    #[test]
    fn test_prepare_rejects_a_duplicate_upgrade_id() {
        let (env, client) = setup();
        let target = env.register_contract(None, UpgradeTarget);
        let id = hash(&env, 0x07);
        let addresses = vec![&env, target];
        let hashes = vec![&env, hash(&env, 0xA1)];
        client.prepare_cross_contract_upgrade(&id, &addresses, &hashes);

        let res = client.try_prepare_cross_contract_upgrade(&id, &addresses, &hashes);
        assert_eq!(res.unwrap_err().unwrap(), Error::TimelockPending);
    }
}
