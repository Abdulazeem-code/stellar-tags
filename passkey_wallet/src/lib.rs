#![no_std]

//! Passkey smart wallet: a Soroban custom account controlled by WebAuthn
//! (secp256r1) passkeys and optional ed25519 keys.
//!
//! See README.md for the design and the signature format clients must send,
//! and SECURITY.md for the threat model and known limitations.

pub mod webauthn;

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractevent, contractimpl, contracttype,
    crypto::Hash,
    symbol_short, Address, Bytes, BytesN, Env, Map, Symbol, TryFromVal, Vec,
};

use webauthn::{
    base64url_32, is_high_s, parse_client_data, CHALLENGE_LEN, FLAGS_INDEX, FLAG_USER_PRESENT,
    FLAG_USER_VERIFIED, MAX_CLIENT_DATA_LEN, MIN_AUTHENTICATOR_DATA_LEN,
};

/// Most signers a wallet can hold.
pub const MAX_SIGNERS: u32 = 10;
/// Longest accepted WebAuthn credential id.
pub const MAX_CREDENTIAL_ID_LEN: u32 = 1023;
/// Recovery delay: 72 hours at 5 seconds per ledger.
pub const RECOVERY_DELAY_LEDGERS: u32 = 72 * 60 * 60 / 5;
/// Spending limits reset on UTC day boundaries of the ledger timestamp.
pub const SECONDS_PER_DAY: u64 = 86_400;

const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_TTL_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_TTL_EXTEND_TO: u32 = 120 * DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Adding the signer would exceed MAX_SIGNERS.
    TooManySigners = 1,
    /// A signer with the same id or public key is already registered.
    SignerExists = 2,
    /// remove_signer was given a key that is not registered.
    SignerNotFound = 3,
    /// The last signer can never be removed.
    LastSigner = 4,
    /// Threshold must be between 1 and the number of signers.
    InvalidThreshold = 5,
    /// A signature names a signer that is not registered.
    UnknownSigner = 6,
    /// The same signer signed twice.
    DuplicateSignature = 7,
    /// Fewer valid distinct signers than required.
    ThresholdNotMet = 8,
    /// clientDataJSON is too long, not valid JSON, or has duplicate keys.
    InvalidClientData = 9,
    /// clientDataJSON `type` is not "webauthn.get".
    WrongType = 10,
    /// clientDataJSON `challenge` is not base64url(signature_payload).
    WrongChallenge = 11,
    /// Authenticator data does not have the User Present flag.
    UserNotPresent = 12,
    /// require_uv is on and the User Verified flag is missing.
    UserNotVerified = 13,
    /// Authenticator data is shorter than 37 bytes.
    InvalidAuthenticatorData = 14,
    /// ECDSA signature is not normalised to low-S.
    SignatureNotNormalized = 15,
    /// __check_auth was called with no signatures.
    NoSignatures = 16,
    /// A recovery is already pending.
    RecoveryPending = 17,
    /// There is no pending recovery.
    NoRecovery = 18,
    /// The recovery delay has not passed yet.
    RecoveryNotReady = 19,
    /// Passkey public key or credential id is malformed, or a recovery signer
    /// is not a passkey, or the first signer is not a passkey.
    InvalidSigner = 20,
    /// Spending limits must be positive.
    InvalidLimit = 21,
    /// A token call in the auth contexts has an amount that cannot be read or
    /// is negative.
    InvalidAmount = 22,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PasskeySigner {
    /// WebAuthn credential id (rawId).
    pub id: Bytes,
    /// Uncompressed SEC-1 secp256r1 public key: 0x04 || x || y.
    pub public_key: BytesN<65>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Signer {
    Passkey(PasskeySigner),
    Ed25519(BytesN<32>),
}

/// How a signer is named in remove_signer and in signatures.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SignerKey {
    Passkey(Bytes),
    Ed25519(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PasskeySignature {
    /// Credential id of the passkey that signed.
    pub id: Bytes,
    pub authenticator_data: Bytes,
    pub client_data_json: Bytes,
    /// ECDSA P-256 signature as r || s (not DER), with low s.
    pub signature: BytesN<64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Ed25519Signature {
    pub public_key: BytesN<32>,
    /// ed25519 signature over the 32-byte signature payload.
    pub signature: BytesN<64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Signature {
    Passkey(PasskeySignature),
    Ed25519(Ed25519Signature),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRecovery {
    pub new_signer: Signer,
    /// Ledger sequence from which complete_recovery may run.
    pub unlock_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DailySpend {
    pub day: u64,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Signers,
    Threshold,
    RequireUv,
    Limit(Address),
    Spent(Address),
    Recovery,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerAdded {
    pub signer: Signer,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerRemoved {
    pub signer: SignerKey,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThresholdChanged {
    pub threshold: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LimitChanged {
    #[topic]
    pub token: Address,
    /// None when the limit was removed.
    pub limit: Option<i128>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequireUvChanged {
    pub require_uv: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryStarted {
    pub new_signer: Signer,
    pub unlock_ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryCancelled {
    pub new_signer: Signer,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryCompleted {
    pub new_signer: Signer,
}

#[contract]
pub struct PasskeyWallet;

fn signer_key(signer: &Signer) -> SignerKey {
    match signer {
        Signer::Passkey(p) => SignerKey::Passkey(p.id.clone()),
        Signer::Ed25519(k) => SignerKey::Ed25519(k.clone()),
    }
}

fn validate_signer(signer: &Signer) -> Result<(), Error> {
    if let Signer::Passkey(p) = signer {
        let id_len = p.id.len();
        if id_len == 0 || id_len > MAX_CREDENTIAL_ID_LEN || p.public_key.get(0) != Some(0x04) {
            return Err(Error::InvalidSigner);
        }
    }
    Ok(())
}

fn load_signers(env: &Env) -> Vec<Signer> {
    env.storage()
        .instance()
        .get(&DataKey::Signers)
        .unwrap_or_else(|| Vec::new(env))
}

fn store_signers(env: &Env, signers: &Vec<Signer>) {
    env.storage().instance().set(&DataKey::Signers, signers);
}

fn load_threshold(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::Threshold)
        .unwrap_or(1)
}

fn find_signer(signers: &Vec<Signer>, key: &SignerKey) -> Option<u32> {
    (0..signers.len()).find(|&i| &signer_key(&signers.get_unchecked(i)) == key)
}

fn bump(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
}

/// Checks one WebAuthn assertion against `signature_payload`.
fn verify_passkey(
    env: &Env,
    signature_payload: &Hash<32>,
    public_key: &BytesN<65>,
    sig: &PasskeySignature,
    require_uv: bool,
) -> Result<(), Error> {
    // Step 1: clientDataJSON type and challenge.
    let cdj_len = sig.client_data_json.len() as usize;
    if cdj_len > MAX_CLIENT_DATA_LEN {
        return Err(Error::InvalidClientData);
    }
    let mut buf = [0u8; MAX_CLIENT_DATA_LEN];
    let json = &mut buf[..cdj_len];
    sig.client_data_json.copy_into_slice(json);
    let parsed = parse_client_data(json).map_err(|_| Error::InvalidClientData)?;

    let (ts, te) = parsed.type_.ok_or(Error::WrongType)?;
    if &json[ts..te] != b"webauthn.get" {
        return Err(Error::WrongType);
    }
    let (cs, ce) = parsed.challenge.ok_or(Error::WrongChallenge)?;
    let expected = base64url_32(&signature_payload.to_array());
    if ce - cs != CHALLENGE_LEN || json[cs..ce] != expected {
        return Err(Error::WrongChallenge);
    }

    // Step 2: authenticator data flags.
    let ad = &sig.authenticator_data;
    if ad.len() < MIN_AUTHENTICATOR_DATA_LEN {
        return Err(Error::InvalidAuthenticatorData);
    }
    let flags = ad.get(FLAGS_INDEX).unwrap_or(0);
    if flags & FLAG_USER_PRESENT == 0 {
        return Err(Error::UserNotPresent);
    }
    if require_uv && flags & FLAG_USER_VERIFIED == 0 {
        return Err(Error::UserNotVerified);
    }

    // Step 4 (checked before the host call so it fails with a clear error;
    // the host rejects high-S too).
    if is_high_s(&sig.signature.to_array()) {
        return Err(Error::SignatureNotNormalized);
    }

    // Step 3: secp256r1 over sha256(authenticatorData || sha256(clientDataJSON)).
    // The host traps if the signature does not verify.
    let crypto = env.crypto();
    let mut signed = ad.clone();
    signed.append(&Bytes::from(
        crypto.sha256(&sig.client_data_json).to_bytes(),
    ));
    let digest = crypto.sha256(&signed);
    crypto.secp256r1_verify(public_key, &digest, &sig.signature);
    Ok(())
}

fn is_self_call(env: &Env, ctx: &Context, fn_name: &Symbol) -> bool {
    match ctx {
        Context::Contract(c) => {
            c.contract == env.current_contract_address() && &c.fn_name == fn_name
        }
        _ => false,
    }
}

fn amount_arg(env: &Env, args: &Vec<soroban_sdk::Val>, index: u32) -> Result<i128, Error> {
    let val = args.get(index).ok_or(Error::InvalidAmount)?;
    let amount = i128::try_from_val(env, &val).map_err(|_| Error::InvalidAmount)?;
    if amount < 0 {
        return Err(Error::InvalidAmount);
    }
    Ok(amount)
}

/// Adds up token outflows in `contexts` for tokens that have a daily limit,
/// records them, and returns true when any limit is exceeded (or an
/// allowance is granted on a limited token), meaning more signatures are
/// needed.
fn apply_spending_limits(env: &Env, contexts: &Vec<Context>) -> Result<bool, Error> {
    let transfer = symbol_short!("transfer");
    let transfer_from = Symbol::new(env, "transfer_from");
    let burn = symbol_short!("burn");
    let approve = symbol_short!("approve");

    let mut totals: Map<Address, i128> = Map::new(env);
    let mut elevated = false;
    for ctx in contexts.iter() {
        let Context::Contract(c) = ctx else { continue };
        if !env
            .storage()
            .instance()
            .has(&DataKey::Limit(c.contract.clone()))
        {
            continue;
        }
        let amount = if c.fn_name == transfer {
            amount_arg(env, &c.args, 2)?
        } else if c.fn_name == burn {
            amount_arg(env, &c.args, 1)?
        } else if c.fn_name == transfer_from {
            amount_arg(env, &c.args, 3)?
        } else if c.fn_name == approve {
            // An allowance lets someone else move funds later without this
            // wallet's signature, so granting one always needs the higher bar.
            if amount_arg(env, &c.args, 2)? > 0 {
                elevated = true;
            }
            continue;
        } else {
            continue;
        };
        let current = totals.get(c.contract.clone()).unwrap_or(0);
        totals.set(
            c.contract.clone(),
            current.checked_add(amount).ok_or(Error::InvalidAmount)?,
        );
    }

    let today = env.ledger().timestamp() / SECONDS_PER_DAY;
    for (token, amount) in totals.iter() {
        let limit: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Limit(token.clone()))
            .unwrap_or(0);
        let spent: DailySpend = env
            .storage()
            .instance()
            .get(&DataKey::Spent(token.clone()))
            .filter(|s: &DailySpend| s.day == today)
            .unwrap_or(DailySpend {
                day: today,
                amount: 0,
            });
        let new_total = spent
            .amount
            .checked_add(amount)
            .ok_or(Error::InvalidAmount)?;
        if new_total > limit {
            elevated = true;
        }
        env.storage().instance().set(
            &DataKey::Spent(token),
            &DailySpend {
                day: today,
                amount: new_total,
            },
        );
    }
    Ok(elevated)
}

#[contractimpl]
impl PasskeyWallet {
    /// Creates the wallet with one passkey signer and a threshold of 1.
    pub fn __constructor(env: Env, signer: Signer) -> Result<(), Error> {
        if !matches!(signer, Signer::Passkey(_)) {
            return Err(Error::InvalidSigner);
        }
        validate_signer(&signer)?;
        let mut signers = Vec::new(&env);
        signers.push_back(signer.clone());
        store_signers(&env, &signers);
        env.storage().instance().set(&DataKey::Threshold, &1u32);
        env.storage().instance().set(&DataKey::RequireUv, &false);
        SignerAdded { signer }.publish(&env);
        bump(&env);
        Ok(())
    }

    // ---- wallet-authorised administration --------------------------------

    pub fn add_signer(env: Env, signer: Signer) -> Result<(), Error> {
        env.current_contract_address().require_auth();
        validate_signer(&signer)?;
        let mut signers = load_signers(&env);
        if find_signer(&signers, &signer_key(&signer)).is_some() {
            return Err(Error::SignerExists);
        }
        if signers.len() >= MAX_SIGNERS {
            return Err(Error::TooManySigners);
        }
        signers.push_back(signer.clone());
        store_signers(&env, &signers);
        SignerAdded { signer }.publish(&env);
        bump(&env);
        Ok(())
    }

    pub fn remove_signer(env: Env, signer: SignerKey) -> Result<(), Error> {
        env.current_contract_address().require_auth();
        let mut signers = load_signers(&env);
        let index = find_signer(&signers, &signer).ok_or(Error::SignerNotFound)?;
        if signers.len() == 1 {
            return Err(Error::LastSigner);
        }
        if load_threshold(&env) > signers.len() - 1 {
            // Lower the threshold first; it may never exceed the signer count.
            return Err(Error::InvalidThreshold);
        }
        signers.remove(index);
        store_signers(&env, &signers);
        SignerRemoved { signer }.publish(&env);
        bump(&env);
        Ok(())
    }

    pub fn set_threshold(env: Env, threshold: u32) -> Result<(), Error> {
        env.current_contract_address().require_auth();
        if threshold == 0 || threshold > load_signers(&env).len() {
            return Err(Error::InvalidThreshold);
        }
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        ThresholdChanged { threshold }.publish(&env);
        bump(&env);
        Ok(())
    }

    /// Requires the User Verified flag on every passkey assertion when on.
    pub fn set_require_uv(env: Env, require_uv: bool) {
        env.current_contract_address().require_auth();
        env.storage()
            .instance()
            .set(&DataKey::RequireUv, &require_uv);
        RequireUvChanged { require_uv }.publish(&env);
        bump(&env);
    }

    /// Sets a daily outflow limit for `token`, in the token's base units.
    pub fn set_spend_limit(env: Env, token: Address, limit: i128) -> Result<(), Error> {
        env.current_contract_address().require_auth();
        if limit <= 0 {
            return Err(Error::InvalidLimit);
        }
        env.storage()
            .instance()
            .set(&DataKey::Limit(token.clone()), &limit);
        LimitChanged {
            token,
            limit: Some(limit),
        }
        .publish(&env);
        bump(&env);
        Ok(())
    }

    pub fn remove_spend_limit(env: Env, token: Address) {
        env.current_contract_address().require_auth();
        env.storage()
            .instance()
            .remove(&DataKey::Limit(token.clone()));
        env.storage()
            .instance()
            .remove(&DataKey::Spent(token.clone()));
        LimitChanged { token, limit: None }.publish(&env);
        bump(&env);
    }

    // ---- recovery --------------------------------------------------------

    /// Starts replacing the wallet's passkeys with `new_signer`. Needs the
    /// wallet's authorisation, which a single ed25519 signer is enough for
    /// (see __check_auth). Takes effect after RECOVERY_DELAY_LEDGERS.
    pub fn start_recovery(env: Env, new_signer: Signer) -> Result<u32, Error> {
        env.current_contract_address().require_auth();
        if !matches!(new_signer, Signer::Passkey(_)) {
            return Err(Error::InvalidSigner);
        }
        validate_signer(&new_signer)?;
        if env.storage().instance().has(&DataKey::Recovery) {
            return Err(Error::RecoveryPending);
        }
        let unlock_ledger = env.ledger().sequence() + RECOVERY_DELAY_LEDGERS;
        env.storage().instance().set(
            &DataKey::Recovery,
            &PendingRecovery {
                new_signer: new_signer.clone(),
                unlock_ledger,
            },
        );
        RecoveryStarted {
            new_signer,
            unlock_ledger,
        }
        .publish(&env);
        bump(&env);
        Ok(unlock_ledger)
    }

    /// Cancels a pending recovery. Needs the wallet's authorisation, which a
    /// single passkey signer is enough for (see __check_auth).
    pub fn cancel_recovery(env: Env) -> Result<(), Error> {
        env.current_contract_address().require_auth();
        let pending: PendingRecovery = env
            .storage()
            .instance()
            .get(&DataKey::Recovery)
            .ok_or(Error::NoRecovery)?;
        env.storage().instance().remove(&DataKey::Recovery);
        RecoveryCancelled {
            new_signer: pending.new_signer,
        }
        .publish(&env);
        bump(&env);
        Ok(())
    }

    /// Applies a pending recovery once its delay has passed. Anyone may call
    /// it. All passkey signers are replaced by the new passkey; ed25519
    /// signers stay, and the threshold is lowered if it would exceed the new
    /// signer count.
    pub fn complete_recovery(env: Env) -> Result<(), Error> {
        let pending: PendingRecovery = env
            .storage()
            .instance()
            .get(&DataKey::Recovery)
            .ok_or(Error::NoRecovery)?;
        if env.ledger().sequence() < pending.unlock_ledger {
            return Err(Error::RecoveryNotReady);
        }
        let mut signers = Vec::new(&env);
        for s in load_signers(&env).iter() {
            if let Signer::Ed25519(_) = s {
                signers.push_back(s);
            }
        }
        signers.push_back(pending.new_signer.clone());
        store_signers(&env, &signers);
        if load_threshold(&env) > signers.len() {
            env.storage()
                .instance()
                .set(&DataKey::Threshold, &signers.len());
            ThresholdChanged {
                threshold: signers.len(),
            }
            .publish(&env);
        }
        env.storage().instance().remove(&DataKey::Recovery);
        RecoveryCompleted {
            new_signer: pending.new_signer,
        }
        .publish(&env);
        bump(&env);
        Ok(())
    }

    // ---- reads -----------------------------------------------------------

    pub fn signers(env: Env) -> Vec<Signer> {
        load_signers(&env)
    }

    pub fn threshold(env: Env) -> u32 {
        load_threshold(&env)
    }

    pub fn require_uv(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::RequireUv)
            .unwrap_or(false)
    }

    pub fn spend_limit(env: Env, token: Address) -> Option<i128> {
        env.storage().instance().get(&DataKey::Limit(token))
    }

    pub fn spent_today(env: Env, token: Address) -> i128 {
        let today = env.ledger().timestamp() / SECONDS_PER_DAY;
        env.storage()
            .instance()
            .get(&DataKey::Spent(token))
            .filter(|s: &DailySpend| s.day == today)
            .map(|s| s.amount)
            .unwrap_or(0)
    }

    pub fn recovery(env: Env) -> Option<PendingRecovery> {
        env.storage().instance().get(&DataKey::Recovery)
    }
}

#[contractimpl]
impl CustomAccountInterface for PasskeyWallet {
    type Signature = Vec<Signature>;
    type Error = Error;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signatures: Vec<Signature>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Error> {
        if signatures.is_empty() {
            return Err(Error::NoSignatures);
        }
        let signers = load_signers(&env);
        let threshold = load_threshold(&env);
        let require_uv: bool = env
            .storage()
            .instance()
            .get(&DataKey::RequireUv)
            .unwrap_or(false);
        let payload_bytes = Bytes::from(signature_payload.to_bytes());

        let mut seen: Vec<SignerKey> = Vec::new(&env);
        let mut passkeys = 0u32;
        let mut ed25519s = 0u32;
        for sig in signatures.iter() {
            let key = match &sig {
                Signature::Passkey(p) => SignerKey::Passkey(p.id.clone()),
                Signature::Ed25519(e) => SignerKey::Ed25519(e.public_key.clone()),
            };
            if seen.contains(&key) {
                return Err(Error::DuplicateSignature);
            }
            let index = find_signer(&signers, &key).ok_or(Error::UnknownSigner)?;
            match (&sig, signers.get_unchecked(index)) {
                (Signature::Passkey(p), Signer::Passkey(registered)) => {
                    verify_passkey(
                        &env,
                        &signature_payload,
                        &registered.public_key,
                        p,
                        require_uv,
                    )?;
                    passkeys += 1;
                }
                (Signature::Ed25519(e), Signer::Ed25519(public_key)) => {
                    env.crypto()
                        .ed25519_verify(&public_key, &payload_bytes, &e.signature);
                    ed25519s += 1;
                }
                _ => return Err(Error::UnknownSigner),
            }
            seen.push_back(key);
        }
        let valid = passkeys + ed25519s;

        let mut required = threshold;
        if !auth_contexts.is_empty() {
            let start = Symbol::new(&env, "start_recovery");
            let cancel = Symbol::new(&env, "cancel_recovery");
            if ed25519s >= 1 && auth_contexts.iter().all(|c| is_self_call(&env, &c, &start)) {
                // Any single recovery key may start the (delayed) recovery.
                required = 1;
            } else if passkeys >= 1
                && auth_contexts
                    .iter()
                    .all(|c| is_self_call(&env, &c, &cancel))
            {
                // Any single passkey may cancel it.
                required = 1;
            }
        }
        if apply_spending_limits(&env, &auth_contexts)? {
            required = required.max((threshold + 1).min(signers.len()));
        }

        if valid < required {
            return Err(Error::ThresholdNotMet);
        }
        bump(&env);
        Ok(())
    }
}
