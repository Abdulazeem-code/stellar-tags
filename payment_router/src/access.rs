use crate::errors::Error;
use crate::storage::{
    DataKey, PauseLevel, Role, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
    PERSISTENT_BUMP_AMOUNT, PERSISTENT_LIFETIME_THRESHOLD,
};
use crate::types::ActionType;
use core::cmp::Ordering;
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{Address, Bytes, BytesN, Env, Symbol, Vec};
// ── Role-Based Access Control (RBAC) Helpers ─────────────────────────────────

pub fn set_role_internal(env: &Env, role: Role, account: &Address) {
    if let Some(previous) = env
        .storage()
        .instance()
        .get::<DataKey, Address>(&DataKey::Role(role))
    {
        if &previous != account {
            env.storage()
                .persistent()
                .set(&DataKey::UserRole(previous, role), &false);
        }
    }
    env.storage().instance().set(&DataKey::Role(role), account);
    env.storage()
        .persistent()
        .set(&DataKey::UserRole(account.clone(), role), &true);
    env.storage().persistent().extend_ttl(
        &DataKey::UserRole(account.clone(), role),
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

pub fn remove_role_internal(env: &Env, role: Role, account: &Address) {
    if let Some(current) = env
        .storage()
        .instance()
        .get::<DataKey, Address>(&DataKey::Role(role))
    {
        if current == *account {
            env.storage().instance().remove(&DataKey::Role(role));
        }
    }
    env.storage()
        .persistent()
        .set(&DataKey::UserRole(account.clone(), role), &false);
}

pub fn apply_role_grant(env: &Env, grantee: &Address, role: Role) {
    set_role_internal(env, role, grantee);
    env.events().publish(
        (Symbol::new(env, "role_assigned"), role, grantee.clone()),
        env.ledger().timestamp(),
    );
}

pub fn apply_role_revoke(env: &Env, grantee: &Address, role: Role) {
    remove_role_internal(env, role, grantee);
    env.events().publish(
        (Symbol::new(env, "role_revoked"), role, grantee.clone()),
        env.ledger().timestamp(),
    );
}

pub fn require_role(env: &Env, role: Role) -> Result<Address, Error> {
    let addr = if let Some(role_addr) = env
        .storage()
        .instance()
        .get::<DataKey, Address>(&DataKey::Role(role))
    {
        role_addr
    } else {
        require_admin(env)?
    };
    addr.require_auth();
    Ok(addr)
}

pub fn require_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)
}

pub fn has_role_internal(env: &Env, account: &Address, role: Role) -> bool {
    let granted: bool = env
        .storage()
        .persistent()
        .get(&DataKey::UserRole(account.clone(), role))
        .unwrap_or(false);
    if granted {
        return true;
    }
    let designated: Option<Address> = env.storage().instance().get(&DataKey::Role(role));
    match designated {
        Some(primary) => &primary == account,
        None => {
            env.storage()
                .instance()
                .get::<DataKey, Address>(&DataKey::Admin)
                .as_ref()
                == Some(account)
        }
    }
}

pub fn require_role_of(env: &Env, caller: &Address, role: Role) -> Result<(), Error> {
    if !has_role_internal(env, caller, role) {
        return Err(Error::RoleNotFound);
    }
    caller.require_auth();
    Ok(())
}

pub fn require_security_officer(env: &Env) -> Result<(), Error> {
    require_role(env, Role::SecurityOfficer)?;
    Ok(())
}

pub fn require_fee_manager(env: &Env) -> Result<(), Error> {
    require_role(env, Role::FeeManager)?;
    Ok(())
}

pub fn require_upgrade_manager(env: &Env) -> Result<(), Error> {
    require_role(env, Role::UpgradeManager)?;
    Ok(())
}

pub fn require_fee_authority(env: &Env) -> Result<(), Error> {
    if let Some(gov) = env
        .storage()
        .instance()
        .get::<DataKey, Address>(&DataKey::Governance)
    {
        gov.require_auth();
        Ok(())
    } else {
        require_fee_manager(env)?;
        Ok(())
    }
}

// ── Circuit Breaker & Emergency Checks ───────────────────────────────────────

/// Returns the current tiered pause level (issue #890).
///
/// Migration note: if only the legacy `DataKey::Paused` boolean is present
/// (from a contract deployed before this change), it is promoted to
/// `PauseLevel::FullHalt` so existing paused state is preserved.
pub fn get_pause_level(env: &Env) -> PauseLevel {
    // Primary source: the new tiered key.
    if let Some(level) = env
        .storage()
        .instance()
        .get::<DataKey, PauseLevel>(&DataKey::PauseLevel)
    {
        return level;
    }
    // Migration fallback: honour the legacy boolean.
    let legacy: bool = env
        .storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if legacy {
        PauseLevel::FullHalt
    } else {
        PauseLevel::None
    }
}

/// Persists `level` to `DataKey::PauseLevel`.
/// Also keeps the legacy `DataKey::Paused` in sync so contracts that still
/// read the old key see a consistent value.
pub fn set_pause_level(env: &Env, level: PauseLevel) {
    env.storage().instance().set(&DataKey::PauseLevel, &level);
    // Keep legacy key consistent so any external tooling that reads
    // DataKey::Paused still gets a sensible answer.
    let legacy_paused = level != PauseLevel::None;
    env.storage()
        .instance()
        .set(&DataKey::Paused, &legacy_paused);
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Returns `true` when the contract is at `PauseLevel::FullHalt` **or** the
/// legacy `DataKey::Paused` boolean is `true`.  Used by the legacy
/// `is_paused()` public function so external clients that predated the tiered
/// API still get the correct answer.
pub fn is_paused_internal(env: &Env) -> bool {
    get_pause_level(env) >= PauseLevel::FullHalt
}

/// Rejects the call with `Error::Paused` when the pause level is
/// `PauseLevel::FullHalt`.  Used by `route_payments` (direct payments).
///
/// Under `PauseLevel::SwapsOnly`, direct payments continue to flow, so this
/// function succeeds.
pub fn require_not_fully_halted(env: &Env) -> Result<(), Error> {
    if get_pause_level(env) >= PauseLevel::FullHalt {
        return Err(Error::Paused);
    }
    Ok(())
}

/// Rejects the call with `Error::Paused` when the pause level is **anything
/// other than** `PauseLevel::None`.  Used by swap-routed entrypoints
/// (`route_payment_with_swap`, `route_payments_with_swap`).
///
/// Under `PauseLevel::SwapsOnly`, swap operations revert while direct payments
/// continue unaffected.
pub fn require_swaps_not_paused(env: &Env) -> Result<(), Error> {
    if get_pause_level(env) != PauseLevel::None {
        return Err(Error::Paused);
    }
    Ok(())
}

/// Legacy circuit-breaker check kept for backward-compat internal callers
/// (e.g. non-essential admin state changes that should block on any pause).
/// Delegates to `require_not_fully_halted` so non-essential changes are only
/// blocked under a full halt.
pub fn require_circuit_closed(env: &Env) -> Result<(), Error> {
    require_not_fully_halted(env)
}

pub fn is_frozen_internal(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Frozen)
        .unwrap_or(false)
}

// ── Multi-signature (M-of-N) Upgrade Helpers ─────────────────────────────────

pub fn load_multisig_config(env: &Env) -> Result<(Vec<Address>, u32), Error> {
    let threshold: u32 = env
        .storage()
        .instance()
        .get(&DataKey::MultisigThreshold)
        .ok_or(Error::MultisigNotInitialized)?;
    let signers: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::MultisigSigners)
        .ok_or(Error::MultisigNotInitialized)?;
    Ok((signers, threshold))
}

pub fn validate_multisig_config(signers: &Vec<Address>, threshold: u32) -> Result<u32, Error> {
    let min_threshold = if signers.len() >= 2 { 2 } else { 1 };
    if signers.is_empty() || threshold < min_threshold || threshold > signers.len() {
        return Err(Error::InvalidThreshold);
    }
    for i in 0..signers.len() {
        for j in (i + 1)..signers.len() {
            if signers.get(i) == signers.get(j) {
                return Err(Error::DuplicateSigner);
            }
        }
    }
    Ok(threshold)
}

fn compare_bytes(left: &Bytes, right: &Bytes) -> Ordering {
    let common = core::cmp::min(left.len(), right.len());
    let mut index = 0u32;
    while index < common {
        match left.get(index).cmp(&right.get(index)) {
            Ordering::Equal => index += 1,
            ordering => return ordering,
        }
    }
    left.len().cmp(&right.len())
}

/// Returns the signer addresses in lexicographic XDR order.
///
/// # Panics
///
/// Panics if a signer address cannot be read from the supplied vector.
pub fn sorted_multisig_signers(env: &Env, signers: &Vec<Address>) -> Vec<Address> {
    let mut sorted: Vec<Address> = Vec::new(env);
    let mut index = 0u32;
    while index < signers.len() {
        let signer = signers.get(index).unwrap();
        let signer_xdr = signer.clone().to_xdr(env);
        let mut insert_at = sorted.len();
        let mut current = 0u32;
        while current < sorted.len() {
            let existing_xdr = sorted.get(current).unwrap().to_xdr(env);
            if compare_bytes(&signer_xdr, &existing_xdr) == Ordering::Less {
                insert_at = current;
                break;
            }
            current += 1;
        }
        sorted.insert(insert_at, signer);
        index += 1;
    }
    sorted
}

fn multisig_config_hash(env: &Env, signers: &Vec<Address>, threshold: u32) -> BytesN<32> {
    env.crypto()
        .sha256(&(signers.clone(), threshold).to_xdr(env))
}

pub fn approve_multisig_config(
    env: &Env,
    signers: &Vec<Address>,
    threshold: u32,
    signer: Address,
) -> Result<u32, Error> {
    validate_multisig_config(signers, threshold)?;
    let (current_signers, _) = load_multisig_config(env)?;
    if !current_signers.contains(&signer) {
        return Err(Error::NotMultisigSigner);
    }
    signer.require_auth();

    let sorted_signers = sorted_multisig_signers(env, signers);
    let key =
        DataKey::MultisigConfigApproval(multisig_config_hash(env, &sorted_signers, threshold));
    let mut approvals: Vec<Address> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    if approvals.contains(&signer) {
        return Err(Error::AlreadyApproved);
    }
    approvals.push_back(signer);
    env.storage().persistent().set(&key, &approvals);
    env.storage().persistent().extend_ttl(
        &key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
    Ok(approvals.len())
}

pub fn load_upgrade_approvals(env: &Env, new_wasm_hash: &BytesN<32>) -> Vec<Address> {
    env.storage()
        .persistent()
        .get(&DataKey::UpgradeApproval(new_wasm_hash.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

pub fn load_effective_approvals(
    env: &Env,
    signers: &Vec<Address>,
    new_wasm_hash: &BytesN<32>,
) -> Vec<Address> {
    let stored = load_upgrade_approvals(env, new_wasm_hash);
    let mut effective = Vec::new(env);
    for i in 0..stored.len() {
        if let Some(approver) = stored.get(i) {
            if signers.contains(&approver) {
                effective.push_back(approver);
            }
        }
    }
    effective
}

pub fn check_upgrade_authorized(env: &Env, new_wasm_hash: &BytesN<32>) -> Result<bool, Error> {
    let (signers, threshold) = load_multisig_config(env)?;
    Ok(load_effective_approvals(env, &signers, new_wasm_hash).len() >= threshold)
}

pub fn require_upgrade_authorized(env: &Env, new_wasm_hash: &BytesN<32>) -> Result<u32, Error> {
    let (signers, threshold) = load_multisig_config(env)?;
    let approvals = load_effective_approvals(env, &signers, new_wasm_hash);
    if approvals.len() < threshold {
        return Err(Error::InsufficientApprovals);
    }
    Ok(approvals.len())
}

pub fn apply_upgrade(env: &Env, new_wasm_hash: &BytesN<32>) {
    env.deployer()
        .update_current_contract_wasm(new_wasm_hash.clone());
    env.storage()
        .persistent()
        .remove(&DataKey::UpgradeApproval(new_wasm_hash.clone()));
}

pub fn store_multisig_config(
    env: &Env,
    signers: Vec<Address>,
    threshold: u32,
) -> Result<(), Error> {
    validate_multisig_config(&signers, threshold)?;
    let has_signers = env.storage().instance().has(&DataKey::MultisigSigners);
    let has_threshold = env.storage().instance().has(&DataKey::MultisigThreshold);
    if has_signers || has_threshold {
        let (current_signers, current_threshold) = load_multisig_config(env)?;
        let sorted_signers = sorted_multisig_signers(env, &signers);
        let key =
            DataKey::MultisigConfigApproval(multisig_config_hash(env, &sorted_signers, threshold));
        let stored: Vec<Address> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(env));
        let mut approvals = 0u32;
        for i in 0..stored.len() {
            if let Some(approver) = stored.get(i) {
                if current_signers.contains(&approver) {
                    approvals += 1;
                }
            }
        }
        if approvals < current_threshold {
            return Err(Error::InsufficientApprovals);
        }
        env.storage().persistent().remove(&key);
    }
    env.storage().instance().set(
        &DataKey::MultisigSigners,
        &sorted_multisig_signers(env, &signers),
    );
    env.storage()
        .instance()
        .set(&DataKey::MultisigThreshold, &threshold);
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    Ok(())
}

pub fn validate_queued_action(env: &Env, action: &ActionType) -> Result<(), Error> {
    match action {
        ActionType::Upgrade(new_wasm_hash) => {
            require_upgrade_authorized(env, new_wasm_hash)?;
        }
        ActionType::SetMultisigConfig(signers, threshold) => {
            validate_multisig_config(signers, *threshold)?;
        }
        ActionType::SetPairMaxSlippageBps(_, _, bps)
            if !(0..=crate::storage::MAX_PAIR_SLIPPAGE_BPS).contains(bps) =>
        {
            return Err(Error::InvalidSlippageConfig);
        }
        _ => {}
    }
    Ok(())
}
