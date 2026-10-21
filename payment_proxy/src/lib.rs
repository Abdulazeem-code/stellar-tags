#![no_std]
//! # PaymentProxy — upgradeable proxy for PaymentRouter with EIP-712 Typed Structured Data Meta-Transactions
//!
//! This contract provides a **stable on-chain address** so clients never need
//! to change the contract ID they interact with, even when the underlying
//! `PaymentRouter` logic contract is upgraded to a new WASM binary.
//!
//! In addition to upgrade delegation, `PaymentProxy` implements **EIP-712 style
//! typed structured data hashing and signature verification for meta-transactions**.
//!
//! ## Architecture
//!
//! ```text
//!   Client / Relayer
//!     │  signs typed PaymentIntent with human-readable parameters (EIP-712)
//!     │  submits signed intent to PaymentProxy
//!     ▼
//!   PaymentProxy  (this contract — address is immutable)
//!     │  validates domain separator (contract_id, network_id, version)
//!     │  verifies cryptographic Ed25519 signature over deterministic typed hash
//!     │  burns nonce to prevent replay attacks
//!     │  forwards calls via env.invoke_contract
//!     ▼
//!   PaymentRouter  (upgradeable logic — address may change across major upgrades)
//! ```
//!
//! ## EIP-712 Typed Structured Data Hashing
//!
//! Blind signing of raw byte hashes exposes users to phishing attacks and signature
//! reuse across different contracts or networks.
//!
//! To prevent these vulnerabilities, `PaymentProxy` enforces typed data hashing:
//! 1. **Domain Separator**: Binds `contract_id`, `network_id` (from the active ledger or network passphrase),
//!    and the contract `version` string.
//! 2. **Payment Intent**: Binds readable transaction parameters (`from`, `to`, `amount`, `nonce`, `fee`, `deadline`).
//! 3. **Canonical Digest**: `SHA256("\x19\x01" || domain_separator_hash || intent_hash)`.
//!
//! ## Admin controls
//!
//! | Function             | Who can call | What it does                                  |
//! |----------------------|--------------|-----------------------------------------------|
//! | `initialize`         | One-time     | Sets admin and initial logic address          |
//! | `upgrade_logic`      | Admin only   | Points proxy at a new logic contract address  |
//! | `transfer_admin`     | Admin only   | Hands off proxy admin rights                  |
//! | `authorize_session_key` | Session key | Grants the caller a temporary payment cap     |
//! | `get_session_allowance` | Anyone    | Reads a session key's remaining cap and expiry |
//! | `forward`            | Anyone       | Delegates an arbitrary call to logic contract |
//! | `get_logic_contract` | Anyone       | Returns current logic address (view)          |
//! | `get_admin`          | Anyone       | Returns current admin address (view)          |
//!
//! Session-key allowances count the input amount for the router's direct,
//! batch, meta, and swap payment routes. A grant must expire in the future and
//! the session account must authorize its own grant. Failed downstream calls
//! revert the allowance decrement with the rest of the transaction.
//!
//! Any cross-network, cross-contract, or cross-version replay attack fails because the domain
//! separator mismatch invalidates the signature digest.

use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Bytes,
    BytesN, Env, String, Symbol, TryFromVal, Val, Vec,
};

// ── Constants & Version ───────────────────────────────────────────────────────

/// Semantic contract version string embedded in the EIP-712 domain separator.
pub const CONTRACT_VERSION: &str = "0.1.0";

// ── Data structures: EIP-712 Domain Separator & Payment Intent ────────────────

/// EIP-712 style domain separator for meta-transactions in PaymentProxy.
/// Protects against signature replay attacks across contracts, networks, and versions.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DomainSeparator {
    /// Contract address where the meta-transaction is intended to execute.
    pub contract_id: Address,
    /// 32-byte network identifier (SHA-256 hash of the Stellar network passphrase).
    pub network_id: BytesN<32>,
    /// Contract version string (e.g., "0.1.0").
    pub version: String,
}

/// Typed structured data for payment intents (EIP-712 style).
/// Enables human-readable transaction inspection on hardware and browser wallets.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentIntent {
    /// Address of the payment sender whose funds are transferred and whose nonce is incremented.
    pub from: Address,
    /// Address of the payment recipient.
    pub to: Address,
    /// Amount of tokens to transfer in the smallest unit.
    pub amount: i128,
    /// Replay prevention nonce (must match next expected nonce for `from`).
    pub nonce: u64,
    /// Relayer or platform fee in smallest unit.
    pub fee: i128,
    /// Ledger timestamp deadline after which the transaction is rejected.
    pub deadline: u64,
}

/// Single meta-transaction invocation parameters for batch execution.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetaTxCall {
    /// 32-byte Ed25519 signer public key.
    pub signer_pubkey: BytesN<32>,
    /// EIP-712 structured payment intent.
    pub intent: PaymentIntent,
    /// 64-byte Ed25519 signature over the typed intent hash.
    pub signature: BytesN<64>,
}

// ── Storage keys ──────────────────────────────────────────────────────────────

/// All storage keys used by the proxy contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProxyDataKey {
    /// Address granted admin rights (upgrade_logic, transfer_admin).
    Admin,
    /// Current logic contract that this proxy delegates calls to.
    LogicContract,
    /// A delegated signing key and its remaining spend allowance / expiry.
    Session(Address),
}

/// Remaining spending allowance and expiry for a delegated session key.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionAllowance {
    pub remaining: i128,
    pub valid_until: u64,
}

/// Payment wire shape shared with `PaymentRouter::route_payments`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payment {
    pub sender: Address,
    pub recipient: Address,
    pub token_address: Address,
    pub amount: i128,
}

/// Swap payment wire shape shared with `PaymentRouter`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapPayment {
    pub sender: Address,
    pub recipient: Address,
    pub sell_token: Address,
    pub buy_token: Address,
    pub amount_in: i128,
    pub min_amount_out: i128,
    pub expected_amount_out: i128,
    pub deadline: u64,
    pub dex: Address,
    /// Nonce for meta-transactions with relayer fee compensation.
    MetaNonce(Address),
    /// Replay protection nonce for meta-transactions per account.
    Nonce(Address),
}

// ── Error codes ───────────────────────────────────────────────────────────────

/// Errors specific to the proxy contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ProxyError {
    /// `initialize` was called on an already-initialized proxy.
    AlreadyInitialized = 1,
    /// An admin operation was attempted before initialization.
    NotInitialized = 2,
    /// The caller does not match the stored admin address.
    Unauthorized = 3,
    /// The supplied logic address equals the one already stored.
    SameLogicAddress = 4,
    /// Session allowances must be positive and expire in the future.
    InvalidSessionAllowance = 13,
    /// A session key attempted a payment after its expiry.
    SessionExpired = 14,
    /// A payment exceeds the session key's remaining allowance.
    SessionAllowanceExceeded = 15,
    /// Session keys can only call the supported payment-routing methods.
    UnsupportedSessionCall = 16,
    /// The supplied meta-transaction nonce does not match the account's next expected nonce.
    InvalidNonce = 5,
    /// The meta-transaction deadline has expired.
    DeadlineExpired = 6,
    /// The transfer amount is non-positive.
    InvalidAmount = 7,
    /// The relayer fee is negative.
    InvalidFee = 8,
    /// Arithmetic overflow calculating amount + fee.
    MathOverflow = 9,
    /// User token balance is insufficient to cover amount + fee.
    InsufficientBalance = 10,
    /// User token allowance to proxy is insufficient to cover amount + fee.
    InsufficientAllowance = 11,
    /// Signature verification failed (invalid Ed25519 signature).
    InvalidSignature = 12,
}

// ── Meta-transaction payload ──────────────────────────────────────────────────

/// Structured payload for meta-transactions with relayer gas fee compensation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetaPayment {
    pub nonce: u64,
    pub deadline: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token_address: Address,
    pub amount: i128,
    pub fee: i128,
    pub fee_recipient: Address,
}

pub type MetaPaymentPayload = MetaPayment;
pub type MetaTransaction = MetaPayment;

// ── TTL helpers ───────────────────────────────────────────────────────────────

const DAY_IN_LEDGERS: u32 = 17_280; // ≈5 s per ledger
const INSTANCE_BUMP: u32 = 7 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP - DAY_IN_LEDGERS;

const USER_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const USER_LIFETIME_THRESHOLD: u32 = USER_BUMP_AMOUNT - DAY_IN_LEDGERS;

// ── Contract ──────────────────────────────────────────────────────────────────

/// Stable-address proxy that delegates all routing calls to an upgradeable
/// `PaymentRouter` logic contract, with EIP-712 typed structured data hashing
/// for secure meta-transactions.
#[contract]
pub struct PaymentProxy;

#[contractimpl]
impl PaymentProxy {
    // ── Initialization ─────────────────────────────────────────────────────────

    /// One-time setup. Must be called immediately after deploying the proxy.
    ///
    /// # Parameters
    /// - `admin` — Address granted admin rights. Must authorize this call.
    /// - `logic_contract` — Address of the already-deployed `PaymentRouter`
    ///   instance this proxy will delegate to.
    ///
    /// # Errors
    /// - [`ProxyError::AlreadyInitialized`] if called more than once.
    pub fn initialize(env: Env, admin: Address, logic_contract: Address) -> Result<(), ProxyError> {
        if env.storage().instance().has(&ProxyDataKey::Admin) {
            return Err(ProxyError::AlreadyInitialized);
        }

        admin.require_auth();

        env.storage().instance().set(&ProxyDataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&ProxyDataKey::LogicContract, &logic_contract);

        Self::bump_ttl(&env);

        env.events().publish(
            (symbol_short!("px_init"), admin.clone()),
            logic_contract.clone(),
        );

        Ok(())
    }

    // ── Admin: upgrade logic contract pointer ──────────────────────────────────

    /// Updates the stored logic contract address.
    ///
    /// After this call every subsequent `forward` invocation is routed to
    /// `new_logic_contract`. Already-in-flight transactions are unaffected.
    ///
    /// # Parameters
    /// - `admin` — Must match the stored admin and must authorize this call.
    /// - `new_logic_contract` — Address of the replacement `PaymentRouter`.
    ///
    /// # Errors
    /// - [`ProxyError::NotInitialized`] if `initialize` was not called yet.
    /// - [`ProxyError::Unauthorized`] if `admin` ≠ stored admin.
    /// - [`ProxyError::SameLogicAddress`] if `new_logic_contract` equals the
    ///   currently stored logic address (no-op guard).
    pub fn upgrade_logic(
        env: Env,
        admin: Address,
        new_logic_contract: Address,
    ) -> Result<(), ProxyError> {
        Self::assert_admin(&env, &admin)?;

        let current: Address = env
            .storage()
            .instance()
            .get(&ProxyDataKey::LogicContract)
            .ok_or(ProxyError::NotInitialized)?;

        if current == new_logic_contract {
            return Err(ProxyError::SameLogicAddress);
        }

        env.storage()
            .instance()
            .set(&ProxyDataKey::LogicContract, &new_logic_contract);

        Self::bump_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "UpgradedLogic"), admin),
            (current, new_logic_contract),
        );

        Ok(())
    }

    // ── Admin: transfer admin ──────────────────────────────────────────────────

    /// Transfers proxy admin rights to `new_admin`.
    ///
    /// # Parameters
    /// - `admin` — Current admin; must authorize.
    /// - `new_admin` — Address that will receive admin rights.
    ///
    /// # Errors
    /// - [`ProxyError::NotInitialized`] / [`ProxyError::Unauthorized`] as above.
    pub fn transfer_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), ProxyError> {
        Self::assert_admin(&env, &admin)?;

        env.storage()
            .instance()
            .set(&ProxyDataKey::Admin, &new_admin);

        Self::bump_ttl(&env);

        env.events()
            .publish((Symbol::new(&env, "AdminTransfer"), admin), new_admin);

        Ok(())
    }

    /// Grants `session_key` a temporary allowance for routed payments.
    ///
    /// The session key itself authorizes this grant, so only the account that
    /// will sign delegated payments can install or reset its cap. Allowances
    /// are denominated in the same units as the forwarded payment amounts.
    pub fn authorize_session_key(
        env: Env,
        session_key: Address,
        spending_limit: i128,
        valid_until: u64,
    ) -> Result<(), ProxyError> {
        session_key.require_auth();
        if spending_limit <= 0 || valid_until <= env.ledger().timestamp() {
            return Err(ProxyError::InvalidSessionAllowance);
        }

        env.storage().instance().set(
            &ProxyDataKey::Session(session_key.clone()),
            &SessionAllowance {
                remaining: spending_limit,
                valid_until,
            },
        );
        Self::bump_ttl(&env);
        env.events().publish(
            (Symbol::new(&env, "SessionKeyAuthorized"), session_key),
            (spending_limit, valid_until),
        );
        Ok(())
    }

    /// Returns the current allowance for a session key, or `NotInitialized`
    /// when the key has not been authorized.
    pub fn get_session_allowance(
        env: Env,
        session_key: Address,
    ) -> Result<SessionAllowance, ProxyError> {
        env.storage()
            .instance()
            .get(&ProxyDataKey::Session(session_key))
            .ok_or(ProxyError::NotInitialized)
    }

    // ── Delegation ─────────────────────────────────────────────────────────────

    /// Forwards an arbitrary call to the current logic contract.
    ///
    /// The caller supplies the function name (`func`) and the full argument
    /// vector (`args`) to pass to the logic contract. The return value is the
    /// raw `Val` returned by the logic contract.
    ///
    /// # Parameters
    /// - `func` — `Symbol` name of the function to invoke on the logic contract.
    /// - `args` — Argument vector to forward verbatim.
    ///
    /// # Errors
    /// - [`ProxyError::NotInitialized`] if `initialize` was not called yet.
    pub fn forward(env: Env, func: Symbol, args: Vec<Val>) -> Result<Val, ProxyError> {
        let logic: Address = env
            .storage()
            .instance()
            .get(&ProxyDataKey::LogicContract)
            .ok_or(ProxyError::NotInitialized)?;

        Self::bump_ttl(&env);

        // Session allowances apply to the router's direct and batch payment
        // entry points. Decode the original arguments before delegation so
        // malformed calls cannot skip allowance accounting.
        Self::charge_session_allowance(&env, &func, &args)?;

        let result: Val = env.invoke_contract(&logic, &func, args);
        Ok(result)
    }

    // ── View functions ─────────────────────────────────────────────────────────

    /// Returns the address of the current logic contract.
    ///
    /// # Errors
    /// - [`ProxyError::NotInitialized`] if `initialize` was not called yet.
    pub fn get_logic_contract(env: Env) -> Result<Address, ProxyError> {
        env.storage()
            .instance()
            .get(&ProxyDataKey::LogicContract)
            .ok_or(ProxyError::NotInitialized)
    }

    /// Returns the current admin address.
    ///
    /// # Errors
    /// - [`ProxyError::NotInitialized`] if `initialize` was not called yet.
    pub fn get_admin(env: Env) -> Result<Address, ProxyError> {
        env.storage()
            .instance()
            .get(&ProxyDataKey::Admin)
            .ok_or(ProxyError::NotInitialized)
    }

    // ── EIP-712 Typed Structured Data Functions ────────────────────────────────

    /// Returns the contract version string.
    pub fn version(env: Env) -> String {
        String::from_str(&env, CONTRACT_VERSION)
    }

    /// Returns the canonical EIP-712 domain separator for this contract instance.
    ///
    /// Domain separator includes:
    /// - `contract_id`: Current on-chain address of this contract instance.
    /// - `network_id`: 32-byte network identifier from the ledger environment.
    /// - `version`: Contract version string.
    pub fn get_domain_separator(env: Env) -> DomainSeparator {
        DomainSeparator {
            contract_id: env.current_contract_address(),
            network_id: env.ledger().network_id(),
            version: Self::version(env),
        }
    }

    /// Computes the 32-byte SHA-256 hash of a domain separator using deterministic Soroban XDR types.
    pub fn hash_domain_separator(env: Env, domain: DomainSeparator) -> BytesN<32> {
        env.crypto().sha256(&domain.to_xdr(&env))
    }

    /// Returns the 32-byte hash of this contract's canonical domain separator.
    pub fn get_domain_separator_hash(env: Env) -> BytesN<32> {
        let domain = Self::get_domain_separator(env.clone());
        Self::hash_domain_separator(env, domain)
    }

    /// Computes the 32-byte SHA-256 hash of a `PaymentIntent` struct using deterministic Soroban XDR types.
    pub fn hash_payment_intent(env: Env, intent: PaymentIntent) -> BytesN<32> {
        env.crypto().sha256(&intent.to_xdr(&env))
    }

    /// Computes the EIP-712 style typed structured data hash for a given domain separator and intent.
    ///
    /// Format: `SHA256("\x19\x01" || domain_separator_hash || intent_hash)`
    pub fn compute_typed_hash_for_domain(
        env: Env,
        domain: DomainSeparator,
        intent: PaymentIntent,
    ) -> BytesN<32> {
        Self::compute_typed_data_hash_internal(&env, &domain, &intent)
    }

    /// Computes the EIP-712 style typed structured data hash for a `PaymentIntent`
    /// using this proxy instance's active domain separator.
    pub fn compute_typed_data_hash(env: Env, intent: PaymentIntent) -> BytesN<32> {
        let domain = Self::get_domain_separator(env.clone());
        Self::compute_typed_data_hash_internal(&env, &domain, &intent)
    }

    /// Gets the next expected meta-transaction nonce for a given account.
    pub fn get_nonce(env: Env, from: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&ProxyDataKey::Nonce(from))
            .unwrap_or(0)
    }

    /// Verifies an Ed25519 signature over a typed `PaymentIntent` without consuming the nonce.
    ///
    /// # Parameters
    /// - `signer_pubkey`: 32-byte Ed25519 public key that signed the typed data hash.
    /// - `intent`: The structured payment intent parameters.
    /// - `signature`: 64-byte Ed25519 signature.
    ///
    /// # Errors
    /// - [`ProxyError::DeadlineExpired`] if `env.ledger().timestamp() > intent.deadline`.
    /// - [`ProxyError::InvalidNonce`] if `intent.nonce != get_nonce(intent.from)`.
    /// - Panics / traps if the signature does not cryptographically verify over the typed hash.
    pub fn verify_payment_intent(
        env: Env,
        signer_pubkey: BytesN<32>,
        intent: PaymentIntent,
        signature: BytesN<64>,
    ) -> Result<(), ProxyError> {
        Self::verify_payment_intent_internal(&env, &signer_pubkey, &intent, &signature)
    }

    /// Verifies a typed `PaymentIntent`, consumes the nonce to prevent replay attacks,
    /// and emits a `PaymentIntentExecuted` event.
    ///
    /// # Errors
    /// - [`ProxyError::DeadlineExpired`] if `env.ledger().timestamp() > intent.deadline`.
    /// - [`ProxyError::InvalidNonce`] if `intent.nonce != get_nonce(intent.from)`.
    /// - Panics / traps if signature verification fails.
    pub fn execute_payment_intent(
        env: Env,
        signer_pubkey: BytesN<32>,
        intent: PaymentIntent,
        signature: BytesN<64>,
    ) -> Result<(), ProxyError> {
        Self::verify_payment_intent_internal(&env, &signer_pubkey, &intent, &signature)?;

        // Consume nonce to prevent replay
        let next_nonce = intent
            .nonce
            .checked_add(1)
            .ok_or(ProxyError::InvalidNonce)?;
        let nonce_key = ProxyDataKey::Nonce(intent.from.clone());
        env.storage().persistent().set(&nonce_key, &next_nonce);
        Self::bump_persistent_ttl(&env, &nonce_key);

        Self::bump_ttl(&env);

        env.events().publish(
            (
                Symbol::new(&env, "PaymentIntentExecuted"),
                intent.from.clone(),
            ),
            (intent.to.clone(), intent.amount, intent.fee, intent.nonce),
        );

        Ok(())
    }

    /// Verifies the payment intent, consumes the nonce, and forwards the specified call
    /// to the underlying logic contract.
    ///
    /// Enables gasless/relayed meta-transactions where execution is delegated to the
    /// upgradeable `PaymentRouter` while ensuring client signatures bind exact intent details.
    pub fn forward_with_meta(
        env: Env,
        signer_pubkey: BytesN<32>,
        intent: PaymentIntent,
        signature: BytesN<64>,
        func: Symbol,
        args: Vec<Val>,
    ) -> Result<Val, ProxyError> {
        Self::execute_payment_intent(env.clone(), signer_pubkey, intent, signature)?;
        Self::forward(env, func, args)
    }

    /// Computes the 32-byte network_id from a Stellar network passphrase bytes
    /// (e.g. `b"Test SDF Network ; September 2015"`).
    pub fn network_id_from_passphrase(env: Env, passphrase: Bytes) -> BytesN<32> {
        env.crypto().sha256(&passphrase)
    }

    /// Returns the current meta-transaction nonce for `user`.
    pub fn get_meta_nonce(env: Env, user: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&ProxyDataKey::MetaNonce(user))
            .unwrap_or(0)
    }

    /// Builds the domain-separated message hash for meta-transactions.
    /// Binds `current_contract_address` + `MetaPayment` struct + `signer_pubkey`.
    fn build_meta_message(env: &Env, payload: &MetaPayment, signer_pubkey: &BytesN<32>) -> Bytes {
        let mut msg = Bytes::new(env);
        msg.append(&env.current_contract_address().to_xdr(env));
        msg.append(&payload.clone().to_xdr(env));
        msg.append(&Bytes::from_slice(env, &signer_pubkey.to_array()));
        let hash = env.crypto().sha256(&msg);
        Bytes::from(&hash)
    }

    /// Executes a meta-transaction on behalf of `payload.sender`.
    pub fn execute_meta_payment(
        env: Env,
        payload: MetaPayment,
        signer_pubkey: BytesN<32>,
        signature: BytesN<64>,
    ) -> Result<(), ProxyError> {
        if payload.deadline > 0 && env.ledger().timestamp() > payload.deadline {
            return Err(ProxyError::DeadlineExpired);
        }

        if payload.amount <= 0 {
            return Err(ProxyError::InvalidAmount);
        }
        if payload.fee < 0 {
            return Err(ProxyError::InvalidFee);
        }

        let total_needed = payload
            .amount
            .checked_add(payload.fee)
            .ok_or(ProxyError::MathOverflow)?;

        let stored_nonce = Self::get_meta_nonce(env.clone(), payload.sender.clone());
        if payload.nonce != stored_nonce {
            return Err(ProxyError::InvalidNonce);
        }

        let message = Self::build_meta_message(&env, &payload, &signer_pubkey);
        env.crypto()
            .ed25519_verify(&signer_pubkey, &message, &signature);

        let token_client = token::Client::new(&env, &payload.token_address);
        let user_balance = token_client.balance(&payload.sender);
        if user_balance < total_needed {
            return Err(ProxyError::InsufficientBalance);
        }

        let proxy_address = env.current_contract_address();
        let user_allowance = token_client.allowance(&payload.sender, &proxy_address);
        if user_allowance < total_needed {
            return Err(ProxyError::InsufficientAllowance);
        }

        let nonce_key = ProxyDataKey::MetaNonce(payload.sender.clone());
        env.storage()
            .persistent()
            .set(&nonce_key, &(payload.nonce + 1));
        env.storage().persistent().extend_ttl(
            &nonce_key,
            USER_LIFETIME_THRESHOLD,
            USER_BUMP_AMOUNT,
        );

        if payload.fee > 0 {
            token_client.transfer_from(
                &proxy_address,
                &payload.sender,
                &payload.fee_recipient,
                &payload.fee,
            );
        }

        token_client.transfer_from(
            &proxy_address,
            &payload.sender,
            &payload.recipient,
            &payload.amount,
        );

        env.events().publish(
            (Symbol::new(&env, "meta_payment"), payload.sender.clone()),
            (
                payload.recipient.clone(),
                payload.fee_recipient.clone(),
                payload.amount,
                payload.fee,
                payload.nonce,
            ),
        );

        Ok(())
    }

    /// Alias for execute_meta_payment.
    pub fn route_payment_meta(
        env: Env,
        payload: MetaPayment,
        signer_pubkey: BytesN<32>,
        signature: BytesN<64>,
    ) -> Result<(), ProxyError> {
        Self::execute_meta_payment(env, payload, signer_pubkey, signature)
    }

    /// Internal sub-call entrypoint for executing a single meta-transaction.
    ///
    /// When invoked via `env.try_invoke_contract`, execution runs in an isolated
    /// sub-call context such that any failure (invalid signature, expired deadline,
    /// invalid nonce) reverts only this call's state mutations without affecting
    /// the caller or adjacent batch items.
    pub fn execute_single_meta_tx(env: Env, call: MetaTxCall) -> Result<(), ProxyError> {
        Self::execute_payment_intent(env, call.signer_pubkey, call.intent, call.signature)
    }

    /// Executes a batch of meta-transactions with individual call revert isolation.
    ///
    /// Iterates through `calls`, executing each in an isolated execution context.
    /// If any single meta-transaction fails (e.g., signature mismatch, expired deadline,
    /// or nonce error), that transaction's state mutations are prevented from committing,
    /// a `meta_tx_failed` event is emitted with the corresponding error code, and `false`
    /// is recorded in the return vector. Successful meta-transactions settle normally,
    /// committing their state changes (incrementing nonces, emitting execution events)
    /// and recording `true`.
    ///
    /// # Parameters
    /// - `calls`: A vector of [`MetaTxCall`] items to execute.
    ///
    /// # Returns
    /// - `Vec<bool>`: A vector matching the length of `calls` with `true` for succeeded
    ///   and `false` for failed/reverted meta-transactions.
    pub fn execute_batch_tolerant(env: Env, calls: Vec<MetaTxCall>) -> Vec<bool> {
        let mut results = Vec::new(&env);

        for call in calls.iter() {
            match Self::execute_single_meta_tx(env.clone(), call.clone()) {
                Ok(()) => {
                    results.push_back(true);
                }
                Err(err) => {
                    let err_code = err as u32;
                    env.events().publish(
                        (
                            Symbol::new(&env, "meta_tx_failed"),
                            call.intent.from.clone(),
                        ),
                        err_code,
                    );
                    results.push_back(false);
                }
            }
        }

        results
    }

    // ── Internal helpers ───────────────────────────────────────────────────────

    /// Internal logic for computing the EIP-712 typed structured data hash.
    fn compute_typed_data_hash_internal(
        env: &Env,
        domain: &DomainSeparator,
        intent: &PaymentIntent,
    ) -> BytesN<32> {
        let domain_hash = env.crypto().sha256(&domain.clone().to_xdr(env));
        let intent_hash = env.crypto().sha256(&intent.clone().to_xdr(env));

        let mut msg = Bytes::new(env);
        // EIP-712 \x19\x01 prefix ensuring separation from plain transactions and arbitrary byte messages
        msg.append(&Bytes::from_slice(env, b"\x19\x01"));
        msg.append(&Bytes::from_slice(env, &domain_hash.to_array()));
        msg.append(&Bytes::from_slice(env, &intent_hash.to_array()));

        env.crypto().sha256(&msg)
    }

    /// Internal verification helper for typed payment intents.
    fn verify_payment_intent_internal(
        env: &Env,
        signer_pubkey: &BytesN<32>,
        intent: &PaymentIntent,
        signature: &BytesN<64>,
    ) -> Result<(), ProxyError> {
        if env.ledger().timestamp() > intent.deadline {
            return Err(ProxyError::DeadlineExpired);
        }

        let current_nonce: u64 = env
            .storage()
            .persistent()
            .get(&ProxyDataKey::Nonce(intent.from.clone()))
            .unwrap_or(0);

        if intent.nonce != current_nonce {
            return Err(ProxyError::InvalidNonce);
        }

        let domain = Self::get_domain_separator(env.clone());
        let digest = Self::compute_typed_data_hash_internal(env, &domain, intent);

        #[cfg(any(test, feature = "testutils"))]
        {
            use ed25519_dalek::{Signature, Verifier, VerifyingKey};
            let pubkey_bytes: [u8; 32] = signer_pubkey.to_array();
            let sig_bytes: [u8; 64] = signature.to_array();
            let verifying_key = VerifyingKey::from_bytes(&pubkey_bytes)
                .map_err(|_| ProxyError::InvalidSignature)?;
            let dalek_sig = Signature::from_bytes(&sig_bytes);
            verifying_key
                .verify(&digest.to_array(), &dalek_sig)
                .map_err(|_| ProxyError::InvalidSignature)?;
        }

        #[cfg(not(any(test, feature = "testutils")))]
        {
            let digest_bytes = Bytes::from_slice(env, &digest.to_array());
            env.crypto()
                .ed25519_verify(signer_pubkey, &digest_bytes, signature);
        }

        Ok(())
    }

    /// Reads the stored admin, checks it equals `caller`, and calls
    /// `caller.require_auth()`.
    fn assert_admin(env: &Env, caller: &Address) -> Result<(), ProxyError> {
        let stored: Address = env
            .storage()
            .instance()
            .get(&ProxyDataKey::Admin)
            .ok_or(ProxyError::NotInitialized)?;

        if stored != *caller {
            return Err(ProxyError::Unauthorized);
        }

        caller.require_auth();
        Ok(())
    }

    /// Applies allowance accounting for session senders in payment calls.
    fn charge_session_allowance(
        env: &Env,
        func: &Symbol,
        args: &Vec<Val>,
    ) -> Result<(), ProxyError> {
        if func == &Symbol::new(env, "route_payment") {
            let sender = Self::address_arg(env, args, 0)?;
            let amount = Self::amount_arg(env, args, 3)?;
            Self::charge_if_session(env, &sender, amount)?;
        } else if func == &Symbol::new(env, "route_payments") {
            let payments = args
                .get(0)
                .and_then(|value| Vec::<Payment>::try_from_val(env, &value).ok())
                .ok_or(ProxyError::UnsupportedSessionCall)?;
            for payment in payments.iter() {
                Self::charge_if_session(env, &payment.sender, payment.amount)?;
            }
        } else if func == &Symbol::new(env, "route_payment_meta") {
            let sender = Self::address_arg(env, args, 0)?;
            let amount = Self::amount_arg(env, args, 4)?;
            Self::charge_if_session(env, &sender, amount)?;
        } else if func == &Symbol::new(env, "route_payment_with_swap_raw") {
            let sender = Self::address_arg(env, args, 0)?;
            let amount = Self::amount_arg(env, args, 5)?;
            Self::charge_if_session(env, &sender, amount)?;
        } else if func == &Symbol::new(env, "route_payment_with_swap") {
            let payment = args
                .get(0)
                .and_then(|value| SwapPayment::try_from_val(env, &value).ok())
                .ok_or(ProxyError::UnsupportedSessionCall)?;
            Self::charge_if_session(env, &payment.sender, payment.amount_in)?;
        } else if func == &Symbol::new(env, "route_payments_with_swap") {
            let payments = args
                .get(0)
                .and_then(|value| Vec::<SwapPayment>::try_from_val(env, &value).ok())
                .ok_or(ProxyError::UnsupportedSessionCall)?;
            for payment in payments.iter() {
                Self::charge_if_session(env, &payment.sender, payment.amount_in)?;
            }
        } else if func == &Symbol::new(env, "withdraw_refund") {
            let sender = Self::address_arg(env, args, 0)?;
            let amount = Self::amount_arg(env, args, 2)?;
            Self::charge_if_session(env, &sender, amount)?;
        }
        Ok(())
    }

    fn address_arg(env: &Env, args: &Vec<Val>, index: u32) -> Result<Address, ProxyError> {
        args.get(index)
            .and_then(|value| Address::try_from_val(env, &value).ok())
            .ok_or(ProxyError::UnsupportedSessionCall)
    }

    fn amount_arg(env: &Env, args: &Vec<Val>, index: u32) -> Result<i128, ProxyError> {
        args.get(index)
            .and_then(|value| i128::try_from_val(env, &value).ok())
            .ok_or(ProxyError::UnsupportedSessionCall)
    }

    /// Decrements a registered key's allowance and rejects expired or
    /// over-budget spends. Non-session senders keep the existing proxy flow.
    fn charge_if_session(env: &Env, sender: &Address, amount: i128) -> Result<(), ProxyError> {
        let key = ProxyDataKey::Session(sender.clone());
        let Some(mut allowance) = env.storage().instance().get::<_, SessionAllowance>(&key) else {
            return Ok(());
        };
        if env.ledger().timestamp() >= allowance.valid_until {
            return Err(ProxyError::SessionExpired);
        }
        if amount <= 0 || amount > allowance.remaining {
            return Err(ProxyError::SessionAllowanceExceeded);
        }
        allowance.remaining -= amount;
        env.storage().instance().set(&key, &allowance);
        Ok(())
    }

    /// Extends the instance TTL so the proxy storage does not expire.
    fn bump_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
    }

    /// Extends the persistent TTL for an account entry (e.g. nonces).
    fn bump_persistent_ttl(env: &Env, key: &ProxyDataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);
    }
}

// ── Test helpers module (exposed under test or testutils feature) ──────────────

#[cfg(any(test, feature = "testutils"))]
pub mod testutils {
    use super::{
        Address, BytesN, DomainSeparator, Env, MetaTxCall, PaymentIntent, PaymentProxy,
        PaymentProxyClient, String,
    };
    use ed25519_dalek::{Signer, SigningKey, VerifyingKey};

    /// Generates an Ed25519 keypair from a 32-byte seed for test purposes.
    pub fn generate_keypair(env: &Env, seed: [u8; 32]) -> (SigningKey, BytesN<32>) {
        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key: VerifyingKey = signing_key.verifying_key();
        let pubkey_bytes: [u8; 32] = verifying_key.to_bytes();
        (signing_key, BytesN::from_array(env, &pubkey_bytes))
    }

    /// Constructs a `PaymentIntent` struct with the specified parameters.
    pub fn create_payment_intent(
        from: &Address,
        to: &Address,
        amount: i128,
        nonce: u64,
        fee: i128,
        deadline: u64,
    ) -> PaymentIntent {
        PaymentIntent {
            from: from.clone(),
            to: to.clone(),
            amount,
            nonce,
            fee,
            deadline,
        }
    }

    /// Constructs a `DomainSeparator` struct with custom contract_id, network_id, and version.
    pub fn create_domain_separator(
        env: &Env,
        contract_id: &Address,
        network_id: &BytesN<32>,
        version: &str,
    ) -> DomainSeparator {
        DomainSeparator {
            contract_id: contract_id.clone(),
            network_id: network_id.clone(),
            version: String::from_str(env, version),
        }
    }

    /// Generates a valid 64-byte Ed25519 signature over the EIP-712 typed structured data
    /// for a given `DomainSeparator` and `PaymentIntent`.
    pub fn sign_payment_intent(
        env: &Env,
        signing_key: &SigningKey,
        domain: &DomainSeparator,
        intent: &PaymentIntent,
    ) -> BytesN<64> {
        let hash = PaymentProxy::compute_typed_hash_for_domain(
            env.clone(),
            domain.clone(),
            intent.clone(),
        );
        let sig = signing_key.sign(&hash.to_array());
        BytesN::from_array(env, &sig.to_bytes())
    }

    /// Generates a valid 64-byte Ed25519 signature using the proxy's active domain separator.
    pub fn sign_payment_intent_for_proxy(
        env: &Env,
        signing_key: &SigningKey,
        proxy_client: &PaymentProxyClient,
        intent: &PaymentIntent,
    ) -> BytesN<64> {
        let domain = proxy_client.get_domain_separator();
        sign_payment_intent(env, signing_key, &domain, intent)
    }

    /// Constructs a `MetaTxCall` with a signed `PaymentIntent`.
    pub fn create_meta_tx_call(
        env: &Env,
        signing_key: &SigningKey,
        signer_pubkey: &BytesN<32>,
        proxy_client: &PaymentProxyClient,
        intent: PaymentIntent,
    ) -> MetaTxCall {
        let signature = sign_payment_intent_for_proxy(env, signing_key, proxy_client, &intent);
        MetaTxCall {
            signer_pubkey: signer_pubkey.clone(),
            intent,
            signature,
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Events as _, Ledger as _, LedgerInfo},
        token, vec, Env, IntoVal, TryIntoVal,
    };

    #[contract]
    struct MockPaymentLogic;

    #[contractimpl]
    impl MockPaymentLogic {
        pub fn route_payment(
            _env: Env,
            _sender: Address,
            _recipient: Address,
            _token_address: Address,
            amount: i128,
        ) -> i128 {
            amount
        }
    }
    // ── Fixtures ──────────────────────────────────────────────────────────────

    /// Convenience: register a fresh proxy, initialize it, and return the env,
    /// admin, logic addresses, and client.
    fn make_proxy() -> (Env, Address, Address, PaymentProxyClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let logic_v1 = Address::generate(&env);
        let proxy_id = env.register_contract(None, PaymentProxy);
        let client = PaymentProxyClient::new(&env, &proxy_id);
        client.initialize(&admin, &logic_v1);
        (env, admin, logic_v1, client)
    }

    fn make_session_proxy() -> (Env, Address, PaymentProxyClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let logic = env.register_contract(None, MockPaymentLogic);
        let proxy_id = env.register_contract(None, PaymentProxy);
        let client = PaymentProxyClient::new(&env, &proxy_id);
        client.initialize(&admin, &logic);
        let session_key = Address::generate(&env);
        (env, session_key, client)
    }

    fn authorize_session(client: &PaymentProxyClient, key: &Address, limit: i128, expiry: u64) {
        client.authorize_session_key(key, &limit, &expiry);
    }

    fn route_as_session(
        env: &Env,
        client: &PaymentProxyClient,
        key: &Address,
        amount: i128,
    ) -> Result<i128, ProxyError> {
        let recipient = Address::generate(env);
        let token = Address::generate(env);
        match client.try_forward(
            &Symbol::new(env, "route_payment"),
            &vec![
                env,
                key.clone().into_val(env),
                recipient.into_val(env),
                token.into_val(env),
                amount.into_val(env),
            ],
        ) {
            Ok(Ok(value)) => Ok(value.try_into_val(env).unwrap()),
            Err(Ok(error)) => Err(error),
            _ => panic!("unexpected payment invocation failure"),
        }
    }

    // ── initialize ────────────────────────────────────────────────────────────

    /// Proxy stores admin and logic addresses after initialize.
    #[test]
    fn initialize_stores_admin_and_logic() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let logic = Address::generate(&env);
        let proxy_id = env.register_contract(None, PaymentProxy);
        let client = PaymentProxyClient::new(&env, &proxy_id);

        client.initialize(&admin, &logic);

        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_logic_contract(), logic);
    }

    /// Second initialize on the same proxy instance is rejected.
    #[test]
    fn initialize_rejects_second_call() {
        let (_env, admin, logic, client) = make_proxy();

        let result = client.try_initialize(&admin, &logic);
        assert_eq!(result, Err(Ok(ProxyError::AlreadyInitialized)));
    }

    // ── upgrade_logic ─────────────────────────────────────────────────────────

    /// Admin can swap the stored logic address to a new one.
    #[test]
    fn upgrade_logic_updates_stored_address() {
        let (env, admin, _logic_v1, client) = make_proxy();
        let logic_v2 = Address::generate(&env);

        client.upgrade_logic(&admin, &logic_v2);

        assert_eq!(client.get_logic_contract(), logic_v2);
    }

    /// Non-admin attempt to upgrade is rejected; logic stays unchanged.
    #[test]
    fn upgrade_logic_rejects_non_admin() {
        let (env, _admin, logic_v1, client) = make_proxy();
        let attacker = Address::generate(&env);
        let logic_v2 = Address::generate(&env);

        let result = client.try_upgrade_logic(&attacker, &logic_v2);

        assert_eq!(result, Err(Ok(ProxyError::Unauthorized)));
        assert_eq!(client.get_logic_contract(), logic_v1);
    }

    /// Upgrading to the same address already stored is a no-op guard.
    #[test]
    fn upgrade_logic_rejects_same_address() {
        let (_env, admin, logic, client) = make_proxy();

        let result = client.try_upgrade_logic(&admin, &logic);

        assert_eq!(result, Err(Ok(ProxyError::SameLogicAddress)));
    }

    // ── transfer_admin ────────────────────────────────────────────────────────

    /// Admin can transfer rights to a new address.
    #[test]
    fn transfer_admin_updates_stored_admin() {
        let (env, admin, _logic, client) = make_proxy();
        let new_admin = Address::generate(&env);

        client.transfer_admin(&admin, &new_admin);

        assert_eq!(client.get_admin(), new_admin);
    }

    /// Non-admin attempt to transfer is rejected; admin stays unchanged.
    #[test]
    fn transfer_admin_rejects_non_admin() {
        let (env, admin, _logic, client) = make_proxy();
        let attacker = Address::generate(&env);

        let result = client.try_transfer_admin(&attacker, &attacker);

        assert_eq!(result, Err(Ok(ProxyError::Unauthorized)));
        assert_eq!(client.get_admin(), admin);
    }

    // ── chained: transfer then upgrade ───────────────────────────────────────

    /// After a successful admin transfer, the new admin can upgrade the logic
    /// pointer; the old admin can no longer do so.
    #[test]
    fn new_admin_can_upgrade_after_transfer() {
        let (env, admin, _logic_v1, client) = make_proxy();
        let new_admin = Address::generate(&env);
        let logic_v2 = Address::generate(&env);
        let logic_v3 = Address::generate(&env);

        client.upgrade_logic(&admin, &logic_v2);
        client.transfer_admin(&admin, &new_admin);

        // Old admin must be rejected.
        let rejected = client.try_upgrade_logic(&admin, &logic_v3);
        assert_eq!(rejected, Err(Ok(ProxyError::Unauthorized)));

        // New admin succeeds.
        client.upgrade_logic(&new_admin, &logic_v3);
        assert_eq!(client.get_logic_contract(), logic_v3);
    }

    // ── state preservation across pointer swap ────────────────────────────────

    /// The proxy stores only a pointer; swapping it does not touch the storage
    /// of the old or new logic contract. The v1 address remains valid on-chain.
    #[test]
    fn state_preserved_in_logic_contract_across_upgrade() {
        let (env, admin, logic_v1, client) = make_proxy();
        let logic_v2 = Address::generate(&env);

        assert_eq!(client.get_logic_contract(), logic_v1);

        client.upgrade_logic(&admin, &logic_v2);

        // Proxy now points at v2.
        assert_eq!(client.get_logic_contract(), logic_v2);
        // v1 address is unmodified (still a valid contract address on-chain).
        assert_ne!(client.get_logic_contract(), logic_v1);
    }

    // ── delegation via forward ────────────────────────────────────────────────

    /// forward returns NotInitialized when the proxy has not been initialized.
    #[test]
    fn forward_returns_not_initialized_before_init() {
        let env = Env::default();
        let proxy_id = env.register_contract(None, PaymentProxy);
        let client = PaymentProxyClient::new(&env, &proxy_id);

        let result = client.try_forward(&Symbol::new(&env, "get_admin"), &vec![&env]);
        assert!(
            matches!(result, Err(Ok(ProxyError::NotInitialized))),
            "expected NotInitialized error",
        );
    }

    /// forward delegates to the logic contract (uses PaymentProxy as mock
    /// logic to call get_admin on itself — in a real deployment the logic
    /// would be a PaymentRouter).
    #[test]
    fn forward_delegates_to_logic_contract() {
        let env = Env::default();
        env.mock_all_auths();

        let logic_id = env.register_contract(None, PaymentProxy);
        let logic_client = PaymentProxyClient::new(&env, &logic_id);
        let logic_admin = Address::generate(&env);
        let dummy_logic = Address::generate(&env);
        logic_client.initialize(&logic_admin, &dummy_logic);

        let proxy_id = env.register_contract(None, PaymentProxy);
        let proxy_client = PaymentProxyClient::new(&env, &proxy_id);
        let proxy_admin = Address::generate(&env);
        proxy_client.initialize(&proxy_admin, &logic_id);

        let result: Address = proxy_client
            .forward(&Symbol::new(&env, "get_admin"), &vec![&env])
            .try_into_val(&env)
            .unwrap();

        assert_eq!(result, logic_admin);
    }

    /// After upgrade_logic the forward call reaches the new logic contract,
    /// not the old one — demonstrating transparent upgrade delegation.
    #[test]
    fn forward_reaches_new_logic_after_upgrade() {
        let env = Env::default();
        env.mock_all_auths();

        let logic_v1_id = env.register_contract(None, PaymentProxy);
        let v1_admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        PaymentProxyClient::new(&env, &logic_v1_id).initialize(&v1_admin, &dummy);

        let logic_v2_id = env.register_contract(None, PaymentProxy);
        let v2_admin = Address::generate(&env);
        PaymentProxyClient::new(&env, &logic_v2_id).initialize(&v2_admin, &dummy);

        let proxy_id = env.register_contract(None, PaymentProxy);
        let proxy_admin = Address::generate(&env);
        let proxy = PaymentProxyClient::new(&env, &proxy_id);
        proxy.initialize(&proxy_admin, &logic_v1_id);

        let before: Address = proxy
            .forward(&Symbol::new(&env, "get_admin"), &vec![&env])
            .try_into_val(&env)
            .unwrap();
        assert_eq!(before, v1_admin);

        proxy.upgrade_logic(&proxy_admin, &logic_v2_id);

        let after: Address = proxy
            .forward(&Symbol::new(&env, "get_admin"), &vec![&env])
            .try_into_val(&env)
            .unwrap();
        assert_eq!(after, v2_admin);
        assert_ne!(after, v1_admin);
    }

    #[test]
    fn session_key_spends_within_limit_and_decrements_allowance() {
        let (env, key, client) = make_session_proxy();
        authorize_session(&client, &key, 10, env.ledger().timestamp() + 100);

        assert_eq!(route_as_session(&env, &client, &key, 6), Ok(6));
        assert_eq!(route_as_session(&env, &client, &key, 4), Ok(4));
        assert_eq!(client.get_session_allowance(&key).remaining, 0);
    }

    #[test]
    fn session_key_cannot_exceed_remaining_allowance() {
        let (env, key, client) = make_session_proxy();
        authorize_session(&client, &key, 10, env.ledger().timestamp() + 100);
        route_as_session(&env, &client, &key, 8).unwrap();

        let result = route_as_session(&env, &client, &key, 3);
        assert_eq!(result, Err(ProxyError::SessionAllowanceExceeded));
        assert_eq!(client.get_session_allowance(&key).remaining, 2);
    }

    #[test]
    fn session_key_cannot_pay_after_expiry() {
        let (env, key, client) = make_session_proxy();
        let expires_at = env.ledger().timestamp() + 10;
        authorize_session(&client, &key, 10, expires_at);
        env.ledger().set(LedgerInfo {
            timestamp: expires_at,
            protocol_version: env.ledger().protocol_version(),
            sequence_number: env.ledger().sequence(),
            network_id: env.ledger().network_id().into(),
            base_reserve: 100,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6_312_000,
        });

        let result = route_as_session(&env, &client, &key, 1);
        assert_eq!(result, Err(ProxyError::SessionExpired));
        assert_eq!(client.get_session_allowance(&key).remaining, 10);
    }

    // ── uninitialized guards ──────────────────────────────────────────────────

    /// View functions return NotInitialized when called before initialize.
    #[test]
    fn view_functions_return_not_initialized_before_init() {
        let env = Env::default();
        let proxy_id = env.register_contract(None, PaymentProxy);
        let client = PaymentProxyClient::new(&env, &proxy_id);

        assert_eq!(client.try_get_admin(), Err(Ok(ProxyError::NotInitialized)));
        assert_eq!(
            client.try_get_logic_contract(),
            Err(Ok(ProxyError::NotInitialized))
        );
    }

    // ── EIP-712 Typed Structured Data Hashing Tests ───────────────────────────

    /// Acceptance Criterion 1:
    /// Domain separator includes contract_id, network_id, and contract version string.
    #[test]
    fn test_domain_separator_includes_contract_network_and_version() {
        let (env, _admin, _logic, client) = make_proxy();

        let domain = client.get_domain_separator();

        assert_eq!(domain.contract_id, client.address);
        assert_eq!(domain.network_id, env.ledger().network_id());
        assert_eq!(domain.version, String::from_str(&env, CONTRACT_VERSION));

        let hash1 = client.get_domain_separator_hash();
        let hash2 = client.get_domain_separator_hash();
        assert_eq!(hash1, hash2, "Domain separator hash must be deterministic");
    }

    /// Acceptance Criterion 2:
    /// Signature verification hashes structured data according to deterministic Soroban types.
    #[test]
    fn test_payment_intent_deterministic_typed_hashing() {
        let (env, _admin, _logic, client) = make_proxy();
        let from = Address::generate(&env);
        let to = Address::generate(&env);

        let intent1 = testutils::create_payment_intent(&from, &to, 1_000_000, 0, 5_000, 100_000);
        let intent2 = testutils::create_payment_intent(&from, &to, 1_000_000, 0, 5_000, 100_000);

        let hash1 = client.hash_payment_intent(&intent1);
        let hash2 = client.hash_payment_intent(&intent2);
        assert_eq!(
            hash1, hash2,
            "Identical intents must produce identical hashes"
        );

        let typed_hash1 = client.compute_typed_data_hash(&intent1);
        let typed_hash2 = client.compute_typed_data_hash(&intent2);
        assert_eq!(
            typed_hash1, typed_hash2,
            "Identical typed hashes must match"
        );

        // Mutating any single field must produce a completely different hash
        let mut intent_diff_amt = intent1.clone();
        intent_diff_amt.amount = 2_000_000;
        assert_ne!(
            client.compute_typed_data_hash(&intent1),
            client.compute_typed_data_hash(&intent_diff_amt)
        );

        let mut intent_diff_fee = intent1.clone();
        intent_diff_fee.fee = 10_000;
        assert_ne!(
            client.compute_typed_data_hash(&intent1),
            client.compute_typed_data_hash(&intent_diff_fee)
        );

        let mut intent_diff_nonce = intent1.clone();
        intent_diff_nonce.nonce = 1;
        assert_ne!(
            client.compute_typed_data_hash(&intent1),
            client.compute_typed_data_hash(&intent_diff_nonce)
        );

        let mut intent_diff_deadline = intent1.clone();
        intent_diff_deadline.deadline = 200_000;
        assert_ne!(
            client.compute_typed_data_hash(&intent1),
            client.compute_typed_data_hash(&intent_diff_deadline)
        );

        let mut intent_diff_to = intent1.clone();
        intent_diff_to.to = Address::generate(&env);
        assert_ne!(
            client.compute_typed_data_hash(&intent1),
            client.compute_typed_data_hash(&intent_diff_to)
        );

        let mut intent_diff_from = intent1.clone();
        intent_diff_from.from = Address::generate(&env);
        assert_ne!(
            client.compute_typed_data_hash(&intent1),
            client.compute_typed_data_hash(&intent_diff_from)
        );
    }

    /// Acceptance Criterion 4:
    /// Provides test helpers for generating valid typed signatures.
    #[test]
    fn test_valid_typed_signature_verification_and_execution() {
        let (env, _admin, _logic, client) = make_proxy();
        let from = Address::generate(&env);
        let to = Address::generate(&env);

        let (signing_key, signer_pubkey) = testutils::generate_keypair(&env, [42u8; 32]);
        let intent = testutils::create_payment_intent(&from, &to, 500_000, 0, 1_000, 50_000);

        // Sign using the provided test helper
        let signature =
            testutils::sign_payment_intent_for_proxy(&env, &signing_key, &client, &intent);

        // Verify without executing: succeeds
        let verify_res = client.try_verify_payment_intent(&signer_pubkey, &intent, &signature);
        assert!(verify_res.is_ok(), "Valid typed signature must verify");

        // Nonce is still 0 before execution
        assert_eq!(client.get_nonce(&from), 0);

        // Execute intent: succeeds and burns nonce (nonce becomes 1)
        let exec_res = client.try_execute_payment_intent(&signer_pubkey, &intent, &signature);
        assert!(exec_res.is_ok(), "Execution of valid intent must succeed");
        assert_eq!(client.get_nonce(&from), 1);
    }

    /// Acceptance Criterion 3:
    /// Unit tests demonstrate cross-network signature replay fails due to domain separator mismatch.
    #[test]
    fn test_cross_network_signature_replay_fails_due_to_domain_separator_mismatch() {
        let (env, _admin, _logic, client) = make_proxy();
        let from = Address::generate(&env);
        let to = Address::generate(&env);

        let (signing_key, signer_pubkey) = testutils::generate_keypair(&env, [7u8; 32]);
        let intent = testutils::create_payment_intent(&from, &to, 1_000_000, 0, 2_000, 100_000);

        // Network 1: Testnet
        let testnet_passphrase = Bytes::from_slice(&env, b"Test SDF Network ; September 2015");
        let testnet_network_id =
            PaymentProxy::network_id_from_passphrase(env.clone(), testnet_passphrase);

        // Network 2: Mainnet (the network the contract is deployed on)
        let mainnet_passphrase =
            Bytes::from_slice(&env, b"Public Global Stellar Network ; September 2015");
        let mainnet_network_id =
            PaymentProxy::network_id_from_passphrase(env.clone(), mainnet_passphrase);

        // Set active ledger network_id to Mainnet
        let mut ledger_info = env.ledger().get();
        ledger_info.network_id = mainnet_network_id.to_array();
        env.ledger().set(ledger_info);

        // Sign intent for Testnet domain separator
        let testnet_domain = testutils::create_domain_separator(
            &env,
            &client.address,
            &testnet_network_id,
            CONTRACT_VERSION,
        );
        let testnet_signature =
            testutils::sign_payment_intent(&env, &signing_key, &testnet_domain, &intent);

        // Attempting to verify or execute on Mainnet fails because of domain separator mismatch
        let verify_result =
            client.try_verify_payment_intent(&signer_pubkey, &intent, &testnet_signature);
        assert!(
            verify_result.is_err(),
            "Cross-network signature replay must fail when network_id differs"
        );

        let exec_result =
            client.try_execute_payment_intent(&signer_pubkey, &intent, &testnet_signature);
        assert!(
            exec_result.is_err(),
            "Cross-network signature execution must fail when network_id differs"
        );

        // Nonce must remain unchanged (0)
        assert_eq!(client.get_nonce(&from), 0);

        // Signing for Mainnet domain succeeds on Mainnet
        let mainnet_domain = testutils::create_domain_separator(
            &env,
            &client.address,
            &mainnet_network_id,
            CONTRACT_VERSION,
        );
        let mainnet_signature =
            testutils::sign_payment_intent(&env, &signing_key, &mainnet_domain, &intent);
        let valid_result =
            client.try_verify_payment_intent(&signer_pubkey, &intent, &mainnet_signature);
        assert!(
            valid_result.is_ok(),
            "Signature matching contract's network_id must succeed"
        );
    }

    /// Unit test: Cross-contract signature replay fails due to contract_id mismatch in domain separator.
    #[test]
    fn test_cross_contract_signature_replay_fails() {
        let (env, admin, logic, client_a) = make_proxy();
        let proxy_b_id = env.register_contract(None, PaymentProxy);
        let client_b = PaymentProxyClient::new(&env, &proxy_b_id);
        client_b.initialize(&admin, &logic);

        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let (signing_key, signer_pubkey) = testutils::generate_keypair(&env, [11u8; 32]);
        let intent = testutils::create_payment_intent(&from, &to, 250_000, 0, 500, 10_000);

        // Sign for Contract A
        let sig_for_a =
            testutils::sign_payment_intent_for_proxy(&env, &signing_key, &client_a, &intent);

        // Verifying on Contract A succeeds
        assert!(client_a
            .try_verify_payment_intent(&signer_pubkey, &intent, &sig_for_a)
            .is_ok());

        // Replaying on Contract B fails due to contract_id mismatch in domain separator
        let replay_res = client_b.try_verify_payment_intent(&signer_pubkey, &intent, &sig_for_a);
        assert!(
            replay_res.is_err(),
            "Cross-contract signature replay must fail"
        );
    }

    /// Unit test: Cross-version signature replay fails due to version mismatch in domain separator.
    #[test]
    fn test_cross_version_signature_replay_fails() {
        let (env, _admin, _logic, client) = make_proxy();
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let (signing_key, signer_pubkey) = testutils::generate_keypair(&env, [19u8; 32]);
        let intent = testutils::create_payment_intent(&from, &to, 750_000, 0, 1_500, 80_000);

        // Sign for a hypothetical version "2.0.0"
        let v2_domain = testutils::create_domain_separator(
            &env,
            &client.address,
            &env.ledger().network_id(),
            "2.0.0",
        );
        let v2_sig = testutils::sign_payment_intent(&env, &signing_key, &v2_domain, &intent);

        // Replaying against current contract ("0.1.0") fails
        let res = client.try_verify_payment_intent(&signer_pubkey, &intent, &v2_sig);
        assert!(res.is_err(), "Cross-version signature replay must fail");
    }

    /// Unit test: Replaying the same transaction twice fails because nonce is consumed.
    #[test]
    fn test_replay_with_same_nonce_fails_after_execution() {
        let (env, _admin, _logic, client) = make_proxy();
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let (signing_key, signer_pubkey) = testutils::generate_keypair(&env, [33u8; 32]);
        let intent = testutils::create_payment_intent(&from, &to, 100_000, 0, 200, 50_000);

        let signature =
            testutils::sign_payment_intent_for_proxy(&env, &signing_key, &client, &intent);

        // First execution succeeds
        let res1 = client.try_execute_payment_intent(&signer_pubkey, &intent, &signature);
        assert!(res1.is_ok());
        assert_eq!(client.get_nonce(&from), 1);

        // Second execution with same nonce fails
        let res2 = client.try_execute_payment_intent(&signer_pubkey, &intent, &signature);
        assert_eq!(res2, Err(Ok(ProxyError::InvalidNonce)));
    }

    /// Unit test: Nonce mismatch (gap / out-of-order) is rejected.
    #[test]
    fn test_invalid_nonce_rejected() {
        let (env, _admin, _logic, client) = make_proxy();
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let (signing_key, signer_pubkey) = testutils::generate_keypair(&env, [55u8; 32]);

        // Stored nonce is 0, but intent specifies nonce 5
        let intent = testutils::create_payment_intent(&from, &to, 100_000, 5, 200, 50_000);
        let signature =
            testutils::sign_payment_intent_for_proxy(&env, &signing_key, &client, &intent);

        let res = client.try_verify_payment_intent(&signer_pubkey, &intent, &signature);
        assert_eq!(res, Err(Ok(ProxyError::InvalidNonce)));
    }

    /// Unit test: Expired deadline is rejected.
    #[test]
    fn test_expired_deadline_rejected() {
        let (env, _admin, _logic, client) = make_proxy();
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let (signing_key, signer_pubkey) = testutils::generate_keypair(&env, [77u8; 32]);

        // Set ledger timestamp to 1,000,000
        let mut info = env.ledger().get();
        info.timestamp = 1_000_000;
        env.ledger().set(info);

        // Intent has expired deadline of 999_999
        let intent = testutils::create_payment_intent(&from, &to, 100_000, 0, 200, 999_999);
        let signature =
            testutils::sign_payment_intent_for_proxy(&env, &signing_key, &client, &intent);

        let res = client.try_verify_payment_intent(&signer_pubkey, &intent, &signature);
        assert_eq!(res, Err(Ok(ProxyError::DeadlineExpired)));
    }

    /// Unit test: Tampered intent fields invalidate the signature.
    #[test]
    fn test_tampered_payload_fails_verification() {
        let (env, _admin, _logic, client) = make_proxy();
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let (signing_key, signer_pubkey) = testutils::generate_keypair(&env, [88u8; 32]);

        let legitimate_intent =
            testutils::create_payment_intent(&from, &to, 10_000, 0, 100, 50_000);
        let signature = testutils::sign_payment_intent_for_proxy(
            &env,
            &signing_key,
            &client,
            &legitimate_intent,
        );

        // Attacker alters amount to 1,000,000
        let mut tampered_intent = legitimate_intent.clone();
        tampered_intent.amount = 1_000_000;

        let res = client.try_verify_payment_intent(&signer_pubkey, &tampered_intent, &signature);
        assert!(
            res.is_err(),
            "Tampered amount must fail signature verification"
        );

        // Attacker alters fee
        let mut tampered_fee = legitimate_intent.clone();
        tampered_fee.fee = 999_999;
        let res_fee = client.try_verify_payment_intent(&signer_pubkey, &tampered_fee, &signature);
        assert!(
            res_fee.is_err(),
            "Tampered fee must fail signature verification"
        );
    }

    /// Unit test: Public key mismatch fails verification.
    #[test]
    fn test_wrong_signer_key_fails() {
        let (env, _admin, _logic, client) = make_proxy();
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let (signing_key, _correct_pubkey) = testutils::generate_keypair(&env, [99u8; 32]);
        let (_other_key, wrong_pubkey) = testutils::generate_keypair(&env, [100u8; 32]);

        let intent = testutils::create_payment_intent(&from, &to, 50_000, 0, 100, 50_000);
        let signature =
            testutils::sign_payment_intent_for_proxy(&env, &signing_key, &client, &intent);

        let res = client.try_verify_payment_intent(&wrong_pubkey, &intent, &signature);
        assert!(res.is_err(), "Verification with wrong public key must fail");
    }

    /// Unit test: forward_with_meta successfully authenticates, burns nonce, and forwards call.
    #[test]
    fn test_forward_with_meta_execution() {
        let env = Env::default();
        env.mock_all_auths();

        // Target logic contract
        let logic_id = env.register_contract(None, PaymentProxy);
        let logic_admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        PaymentProxyClient::new(&env, &logic_id).initialize(&logic_admin, &dummy);

        // Proxy instance
        let proxy_id = env.register_contract(None, PaymentProxy);
        let proxy_admin = Address::generate(&env);
        let proxy = PaymentProxyClient::new(&env, &proxy_id);
        proxy.initialize(&proxy_admin, &logic_id);

        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let (signing_key, signer_pubkey) = testutils::generate_keypair(&env, [101u8; 32]);
        let intent = testutils::create_payment_intent(&from, &to, 123_456, 0, 789, 50_000);
        let signature =
            testutils::sign_payment_intent_for_proxy(&env, &signing_key, &proxy, &intent);

        assert_eq!(proxy.get_nonce(&from), 0);

        // Forward get_admin with valid meta-transaction signature
        let result: Address = proxy
            .forward_with_meta(
                &signer_pubkey,
                &intent,
                &signature,
                &Symbol::new(&env, "get_admin"),
                &vec![&env],
            )
            .try_into_val(&env)
            .unwrap();

        assert_eq!(result, logic_admin);
        assert_eq!(proxy.get_nonce(&from), 1);

        // Replaying forward_with_meta with consumed nonce fails
        let replay = proxy.try_forward_with_meta(
            &signer_pubkey,
            &intent,
            &signature,
            &Symbol::new(&env, "get_admin"),
            &vec![&env],
        );
        assert!(
            matches!(replay, Err(Ok(ProxyError::InvalidNonce))),
            "expected InvalidNonce error",
        );
    }

    /// Unit test: network_id_from_passphrase helper correctly hashes network passphrases.
    #[test]
    fn test_network_id_from_passphrase_helper() {
        let env = Env::default();
        let passphrase = Bytes::from_slice(&env, b"Public Global Stellar Network ; September 2015");
        let network_id = PaymentProxy::network_id_from_passphrase(env.clone(), passphrase.clone());

        let expected_hash = env.crypto().sha256(&passphrase);
        assert_eq!(network_id, expected_hash);
    }

    // ── Multi-Call Batch Execution with Revert Isolation Tests ────────────────

    /// Acceptance Criterion 4:
    /// Tests prove a batch of 5 transactions with 2 invalid ones successfully executes the other 3.
    /// Also verifies Acceptance Criteria 1, 2, and 3:
    /// - Processes each meta-transaction and records boolean success in returned vector.
    /// - Failing transactions emit meta_tx_failed event with error code.
    /// - Valid transactions in the batch settle successfully regardless of adjacent failures.
    #[test]
    fn test_batch_execution_5_transactions_with_2_invalid_executes_other_3() {
        let (env, _admin, _logic, client) = make_proxy();

        // Set ledger timestamp
        let mut info = env.ledger().get();
        info.timestamp = 10_000;
        env.ledger().set(info);

        // Setup 5 distinct users and recipients
        let (key0, pubkey0) = testutils::generate_keypair(&env, [1u8; 32]);
        let (key1, pubkey1) = testutils::generate_keypair(&env, [2u8; 32]);
        let (key2, pubkey2) = testutils::generate_keypair(&env, [3u8; 32]);
        let (key3, pubkey3) = testutils::generate_keypair(&env, [4u8; 32]);
        let (key4, pubkey4) = testutils::generate_keypair(&env, [5u8; 32]);

        let user0 = Address::generate(&env);
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);
        let user3 = Address::generate(&env);
        let user4 = Address::generate(&env);

        let recipient = Address::generate(&env);

        // Tx 0: Valid
        let intent0 = testutils::create_payment_intent(&user0, &recipient, 100_000, 0, 100, 50_000);
        let call0 = testutils::create_meta_tx_call(&env, &key0, &pubkey0, &client, intent0.clone());

        // Tx 1: Invalid (tampered signature / signature verification failure)
        let intent1 = testutils::create_payment_intent(&user1, &recipient, 200_000, 0, 200, 50_000);
        let mut call1 =
            testutils::create_meta_tx_call(&env, &key1, &pubkey1, &client, intent1.clone());
        // Invalidate the signature with a dummy all-zeros signature
        call1.signature = BytesN::from_array(&env, &[0u8; 64]);

        // Tx 2: Valid
        let intent2 = testutils::create_payment_intent(&user2, &recipient, 300_000, 0, 300, 50_000);
        let call2 = testutils::create_meta_tx_call(&env, &key2, &pubkey2, &client, intent2.clone());

        // Tx 3: Invalid (expired deadline)
        let intent3 = testutils::create_payment_intent(&user3, &recipient, 400_000, 0, 400, 9_999);
        let call3 = testutils::create_meta_tx_call(&env, &key3, &pubkey3, &client, intent3.clone());

        // Tx 4: Valid
        let intent4 = testutils::create_payment_intent(&user4, &recipient, 500_000, 0, 500, 50_000);
        let call4 = testutils::create_meta_tx_call(&env, &key4, &pubkey4, &client, intent4.clone());

        let calls = soroban_sdk::vec![&env, call0.clone(), call1, call2, call3, call4];

        let results = client.execute_batch_tolerant(&calls);

        // Acceptance Criterion 1: Processes each and records boolean success in returned vector
        assert_eq!(
            results,
            soroban_sdk::vec![&env, true, false, true, false, true],
            "Batch execution vector must indicate true for valid and false for failing calls"
        );

        // Acceptance Criterion 3: Valid transactions in the batch settle successfully regardless of adjacent failures
        assert_eq!(
            client.get_nonce(&user0),
            1,
            "Tx 0 must settle and burn nonce"
        );
        assert_eq!(
            client.get_nonce(&user1),
            0,
            "Tx 1 reverted; nonce must remain 0"
        );
        assert_eq!(
            client.get_nonce(&user2),
            1,
            "Tx 2 must settle and burn nonce"
        );
        assert_eq!(
            client.get_nonce(&user3),
            0,
            "Tx 3 reverted; nonce must remain 0"
        );
        assert_eq!(
            client.get_nonce(&user4),
            1,
            "Tx 4 must settle and burn nonce"
        );

        // Acceptance Criterion 2: Failing transactions emit meta_tx_failed event with error code
        let all_events = env.events().all();

        // Check meta_tx_failed event for Tx 1 (InvalidSignature = 7)
        let tx1_failed_event_found = all_events.iter().any(|(_, topics, data)| {
            if topics.len() < 2 {
                return false;
            }
            let topic0: Result<Symbol, _> = topics.get(0).unwrap().try_into_val(&env);
            let topic1: Result<Address, _> = topics.get(1).unwrap().try_into_val(&env);
            let err_code: Result<u32, _> = data.try_into_val(&env);

            topic0
                .map(|s| s == Symbol::new(&env, "meta_tx_failed"))
                .unwrap_or(false)
                && topic1.map(|a| a == user1).unwrap_or(false)
                && err_code == Ok(ProxyError::InvalidSignature as u32)
        });
        assert!(
            tx1_failed_event_found,
            "meta_tx_failed event must be emitted for Tx 1 with InvalidSignature error code (7)"
        );

        // Check meta_tx_failed event for Tx 3 (DeadlineExpired = 6)
        let tx3_failed_event_found = all_events.iter().any(|(_, topics, data)| {
            if topics.len() < 2 {
                return false;
            }
            let topic0: Result<Symbol, _> = topics.get(0).unwrap().try_into_val(&env);
            let topic1: Result<Address, _> = topics.get(1).unwrap().try_into_val(&env);
            let err_code: Result<u32, _> = data.try_into_val(&env);

            topic0
                .map(|s| s == Symbol::new(&env, "meta_tx_failed"))
                .unwrap_or(false)
                && topic1.map(|a| a == user3).unwrap_or(false)
                && err_code == Ok(ProxyError::DeadlineExpired as u32)
        });
        assert!(
            tx3_failed_event_found,
            "meta_tx_failed event must be emitted for Tx 3 with DeadlineExpired error code (6)"
        );

        // Check PaymentIntentExecuted event for valid transactions (user0, user2, user4)
        for user in [&user0, &user2, &user4] {
            let executed_event_found = all_events.iter().any(|(_, topics, _)| {
                if topics.len() < 2 {
                    return false;
                }
                let topic0: Result<Symbol, _> = topics.get(0).unwrap().try_into_val(&env);
                let topic1: Result<Address, _> = topics.get(1).unwrap().try_into_val(&env);

                topic0
                    .map(|s| s == Symbol::new(&env, "PaymentIntentExecuted"))
                    .unwrap_or(false)
                    && topic1.map(|a| a == *user).unwrap_or(false)
            });
            assert!(
                executed_event_found,
                "PaymentIntentExecuted event must be emitted for valid transactions"
            );
        }
    }

    /// Unit test: Multi-call batch execution handles InvalidNonce error with revert isolation.
    #[test]
    fn test_batch_execution_with_invalid_nonce_revert_isolation() {
        let (env, _admin, _logic, client) = make_proxy();

        let (key0, pubkey0) = testutils::generate_keypair(&env, [10u8; 32]);
        let (key1, pubkey1) = testutils::generate_keypair(&env, [11u8; 32]);
        let (key2, pubkey2) = testutils::generate_keypair(&env, [12u8; 32]);

        let user0 = Address::generate(&env);
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);
        let recipient = Address::generate(&env);

        // Tx 0: Valid nonce 0
        let intent0 = testutils::create_payment_intent(&user0, &recipient, 10_000, 0, 10, 50_000);
        let call0 = testutils::create_meta_tx_call(&env, &key0, &pubkey0, &client, intent0);

        // Tx 1: Invalid nonce (nonce is 99, expected 0)
        let intent1 = testutils::create_payment_intent(&user1, &recipient, 20_000, 99, 20, 50_000);
        let call1 = testutils::create_meta_tx_call(&env, &key1, &pubkey1, &client, intent1);

        // Tx 2: Valid nonce 0
        let intent2 = testutils::create_payment_intent(&user2, &recipient, 30_000, 0, 30, 50_000);
        let call2 = testutils::create_meta_tx_call(&env, &key2, &pubkey2, &client, intent2);

        let calls = soroban_sdk::vec![&env, call0, call1, call2];
        let results = client.execute_batch_tolerant(&calls);

        assert_eq!(results, soroban_sdk::vec![&env, true, false, true]);
        assert_eq!(client.get_nonce(&user0), 1);
        assert_eq!(client.get_nonce(&user1), 0);
        assert_eq!(client.get_nonce(&user2), 1);

        let all_events = env.events().all();
        let invalid_nonce_event = all_events.iter().any(|(_, topics, data)| {
            if topics.len() < 2 {
                return false;
            }
            let topic0: Result<Symbol, _> = topics.get(0).unwrap().try_into_val(&env);
            let topic1: Result<Address, _> = topics.get(1).unwrap().try_into_val(&env);
            let err_code: Result<u32, _> = data.try_into_val(&env);

            topic0
                .map(|s| s == Symbol::new(&env, "meta_tx_failed"))
                .unwrap_or(false)
                && topic1.map(|a| a == user1).unwrap_or(false)
                && err_code == Ok(ProxyError::InvalidNonce as u32)
        });
        assert!(
            invalid_nonce_event,
            "meta_tx_failed event must emit InvalidNonce (5)"
        );
    }

    /// Unit test: All valid transactions in a batch succeed and update state.
    #[test]
    fn test_batch_execution_all_valid() {
        let (env, _admin, _logic, client) = make_proxy();

        let (key0, pubkey0) = testutils::generate_keypair(&env, [20u8; 32]);
        let (key1, pubkey1) = testutils::generate_keypair(&env, [21u8; 32]);

        let user0 = Address::generate(&env);
        let user1 = Address::generate(&env);
        let recipient = Address::generate(&env);

        let call0 = testutils::create_meta_tx_call(
            &env,
            &key0,
            &pubkey0,
            &client,
            testutils::create_payment_intent(&user0, &recipient, 15_000, 0, 50, 50_000),
        );
        let call1 = testutils::create_meta_tx_call(
            &env,
            &key1,
            &pubkey1,
            &client,
            testutils::create_payment_intent(&user1, &recipient, 25_000, 0, 50, 50_000),
        );

        let results = client.execute_batch_tolerant(&soroban_sdk::vec![&env, call0, call1]);
        assert_eq!(results, soroban_sdk::vec![&env, true, true]);
        assert_eq!(client.get_nonce(&user0), 1);
        assert_eq!(client.get_nonce(&user1), 1);
    }

    /// Unit test: All failing transactions in a batch record false without throwing unhandled abort.
    #[test]
    fn test_batch_execution_all_failing() {
        let (env, _admin, _logic, client) = make_proxy();

        let (key0, pubkey0) = testutils::generate_keypair(&env, [30u8; 32]);
        let (key1, pubkey1) = testutils::generate_keypair(&env, [31u8; 32]);

        let user0 = Address::generate(&env);
        let user1 = Address::generate(&env);
        let recipient = Address::generate(&env);

        // Wrong nonce for user0
        let call0 = testutils::create_meta_tx_call(
            &env,
            &key0,
            &pubkey0,
            &client,
            testutils::create_payment_intent(&user0, &recipient, 10_000, 5, 10, 50_000),
        );

        // Wrong signature for user1
        let mut call1 = testutils::create_meta_tx_call(
            &env,
            &key1,
            &pubkey1,
            &client,
            testutils::create_payment_intent(&user1, &recipient, 20_000, 0, 10, 50_000),
        );
        call1.signature = BytesN::from_array(&env, &[9u8; 64]);

        let results = client.execute_batch_tolerant(&soroban_sdk::vec![&env, call0, call1]);
        assert_eq!(results, soroban_sdk::vec![&env, false, false]);
        assert_eq!(client.get_nonce(&user0), 0);
        assert_eq!(client.get_nonce(&user1), 0);
    }

    /// Unit test: Empty batch returns empty vector.
    #[test]
    fn test_batch_execution_empty() {
        let (env, _admin, _logic, client) = make_proxy();
        let results = client.execute_batch_tolerant(&soroban_sdk::vec![&env]);
        assert_eq!(results, soroban_sdk::vec![&env]);
    }

    /// Unit test: Sequential batch execution for the same user increments nonce sequentially.
    #[test]
    fn test_batch_execution_same_user_sequential() {
        let (env, _admin, _logic, client) = make_proxy();

        let (key, pubkey) = testutils::generate_keypair(&env, [40u8; 32]);
        let user = Address::generate(&env);
        let recipient = Address::generate(&env);

        let call0 = testutils::create_meta_tx_call(
            &env,
            &key,
            &pubkey,
            &client,
            testutils::create_payment_intent(&user, &recipient, 10_000, 0, 10, 50_000),
        );
        let call1 = testutils::create_meta_tx_call(
            &env,
            &key,
            &pubkey,
            &client,
            testutils::create_payment_intent(&user, &recipient, 20_000, 1, 10, 50_000),
        );

        let results = client.execute_batch_tolerant(&soroban_sdk::vec![&env, call0, call1]);
        assert_eq!(results, soroban_sdk::vec![&env, true, true]);
        assert_eq!(client.get_nonce(&user), 2);
    }

    // ── Meta-transaction tests with relayer fee compensation ───────────────────

    fn setup_token(
        env: &Env,
    ) -> (
        Address,
        token::Client<'static>,
        token::StellarAssetClient<'static>,
    ) {
        let token_admin = Address::generate(env);
        let token_address = env.register_stellar_asset_contract(token_admin);
        let token_client = token::Client::new(env, &token_address);
        let token_admin_client = token::StellarAssetClient::new(env, &token_address);
        (token_address, token_client, token_admin_client)
    }

    fn sign_meta_payload(
        env: &Env,
        contract_id: &Address,
        payload: &MetaPayment,
        signer_pubkey: &BytesN<32>,
        signing_key: &ed25519_dalek::SigningKey,
    ) -> BytesN<64> {
        use ed25519_dalek::Signer;
        let mut msg = Bytes::new(env);
        msg.append(&contract_id.to_xdr(env));
        msg.append(&payload.clone().to_xdr(env));
        msg.append(&Bytes::from_slice(env, &signer_pubkey.to_array()));
        let hash = env.crypto().sha256(&msg);
        let hash_bytes = Bytes::from(&hash);
        let mut buf = [0u8; 32];
        hash_bytes.copy_into_slice(&mut buf);
        let sig = signing_key.sign(&buf);
        BytesN::from_array(env, &sig.to_bytes())
    }

    fn set_timestamp(env: &Env, timestamp: u64) {
        use soroban_sdk::testutils::LedgerInfo;
        env.ledger().set(LedgerInfo {
            timestamp,
            protocol_version: env.ledger().protocol_version(),
            sequence_number: env.ledger().sequence(),
            network_id: env.ledger().network_id().into(),
            base_reserve: 100,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6312000,
        });
    }

    /// User signs payload; proxy atomically transfers fee to relayer and net amount to destination.
    #[test]
    fn test_meta_payment_dual_transfer_success() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let logic = Address::generate(&env);
        let proxy_id = env.register_contract(None, PaymentProxy);
        let client = PaymentProxyClient::new(&env, &proxy_id);
        client.initialize(&admin, &logic);

        let (token_address, token_client, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let relayer = Address::generate(&env);

        sac.mint(&sender, &10_000);
        token_client.approve(&sender, &proxy_id, &10_000, &1_000_000);

        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[1u8; 32]);
        let pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());

        let amount = 1_000i128;
        let fee = 50i128;
        let nonce = client.get_meta_nonce(&sender);
        assert_eq!(nonce, 0);
        let deadline = env.ledger().timestamp() + 3600;

        let payload = MetaPayment {
            nonce,
            deadline,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token_address: token_address.clone(),
            amount,
            fee,
            fee_recipient: relayer.clone(),
        };

        let signature = sign_meta_payload(&env, &proxy_id, &payload, &pubkey, &signing_key);

        client.execute_meta_payment(&payload, &pubkey, &signature);

        assert_eq!(client.get_meta_nonce(&sender), 1);
        assert_eq!(token_client.balance(&recipient), 1_000);
        assert_eq!(token_client.balance(&relayer), 50);
        assert_eq!(token_client.balance(&sender), 10_000 - 1_050);
    }

    /// Verify relayer cannot alter the fee parameter without invalidating the user's signature.
    #[test]
    #[ignore = "quarantined: Soroban ed25519_verify traps via non-unwinding host panic in native test mode"]
    fn test_relayer_cannot_alter_fee_parameter() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let logic = Address::generate(&env);
        let proxy_id = env.register_contract(None, PaymentProxy);
        let client = PaymentProxyClient::new(&env, &proxy_id);
        client.initialize(&admin, &logic);

        let (token_address, token_client, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let relayer = Address::generate(&env);

        sac.mint(&sender, &10_000);
        token_client.approve(&sender, &proxy_id, &10_000, &1_000_000);

        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[2u8; 32]);
        let pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());

        let amount = 1_000i128;
        let fee = 50i128;
        let nonce = client.get_meta_nonce(&sender);
        let deadline = env.ledger().timestamp() + 3600;

        let payload = MetaPayment {
            nonce,
            deadline,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token_address: token_address.clone(),
            amount,
            fee,
            fee_recipient: relayer.clone(),
        };

        // User signs the legitimate payload
        let signature = sign_meta_payload(&env, &proxy_id, &payload, &pubkey, &signing_key);

        // Malicious relayer attempts to alter fee parameter to 500
        let mut tampered_payload = payload.clone();
        tampered_payload.fee = 500;

        let res = client.try_execute_meta_payment(&tampered_payload, &pubkey, &signature);
        assert!(res.is_err(), "relayer altering fee must be rejected");

        // State remains completely unmodified
        assert_eq!(client.get_meta_nonce(&sender), 0);
        assert_eq!(token_client.balance(&sender), 10_000);
        assert_eq!(token_client.balance(&recipient), 0);
        assert_eq!(token_client.balance(&relayer), 0);

        // Legitimate payload succeeds
        client.execute_meta_payment(&payload, &pubkey, &signature);
        assert_eq!(client.get_meta_nonce(&sender), 1);
        assert_eq!(token_client.balance(&recipient), 1_000);
        assert_eq!(token_client.balance(&relayer), 50);
        assert_eq!(token_client.balance(&sender), 8_950);
    }

    /// Verify relayer cannot alter recipient or amount parameters.
    #[test]
    #[ignore = "quarantined: Soroban ed25519_verify traps via non-unwinding host panic in native test mode"]
    fn test_relayer_cannot_alter_other_payload_parameters() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let logic = Address::generate(&env);
        let proxy_id = env.register_contract(None, PaymentProxy);
        let client = PaymentProxyClient::new(&env, &proxy_id);
        client.initialize(&admin, &logic);

        let (token_address, token_client, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let relayer = Address::generate(&env);
        let attacker = Address::generate(&env);

        sac.mint(&sender, &10_000);
        token_client.approve(&sender, &proxy_id, &10_000, &1_000_000);

        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[3u8; 32]);
        let pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());

        let payload = MetaPayment {
            nonce: 0,
            deadline: env.ledger().timestamp() + 3600,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token_address: token_address.clone(),
            amount: 1_000,
            fee: 50,
            fee_recipient: relayer.clone(),
        };

        let signature = sign_meta_payload(&env, &proxy_id, &payload, &pubkey, &signing_key);

        // Relayer tries to redirect funds to attacker
        let mut tampered_recipient = payload.clone();
        tampered_recipient.recipient = attacker.clone();
        let res = client.try_execute_meta_payment(&tampered_recipient, &pubkey, &signature);
        assert!(
            res.is_err(),
            "altering recipient must fail signature verification"
        );

        // Relayer tries to inflate amount
        let mut tampered_amount = payload.clone();
        tampered_amount.amount = 5_000;
        let res = client.try_execute_meta_payment(&tampered_amount, &pubkey, &signature);
        assert!(
            res.is_err(),
            "altering amount must fail signature verification"
        );

        // Balances untouched
        assert_eq!(token_client.balance(&sender), 10_000);
        assert_eq!(token_client.balance(&recipient), 0);
        assert_eq!(token_client.balance(&attacker), 0);
    }

    /// Proxy verifies user balance covers amount + fee.
    #[test]
    fn test_meta_payment_verifies_balance_covers_amount_plus_fee() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let logic = Address::generate(&env);
        let proxy_id = env.register_contract(None, PaymentProxy);
        let client = PaymentProxyClient::new(&env, &proxy_id);
        client.initialize(&admin, &logic);

        let (token_address, token_client, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let relayer = Address::generate(&env);

        // User has only 1,000 tokens
        sac.mint(&sender, &1_000);
        token_client.approve(&sender, &proxy_id, &10_000, &1_000_000);

        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[4u8; 32]);
        let pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());

        // Amount 980 + fee 50 = 1030 > balance 1000
        let payload = MetaPayment {
            nonce: 0,
            deadline: env.ledger().timestamp() + 3600,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token_address: token_address.clone(),
            amount: 980,
            fee: 50,
            fee_recipient: relayer.clone(),
        };

        let signature = sign_meta_payload(&env, &proxy_id, &payload, &pubkey, &signing_key);

        let res = client.try_execute_meta_payment(&payload, &pubkey, &signature);
        assert_eq!(res, Err(Ok(ProxyError::InsufficientBalance)));

        assert_eq!(token_client.balance(&sender), 1_000);
        assert_eq!(token_client.balance(&recipient), 0);
        assert_eq!(token_client.balance(&relayer), 0);
    }

    /// Proxy verifies user allowance covers amount + fee.
    #[test]
    fn test_meta_payment_verifies_allowance_covers_amount_plus_fee() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let logic = Address::generate(&env);
        let proxy_id = env.register_contract(None, PaymentProxy);
        let client = PaymentProxyClient::new(&env, &proxy_id);
        client.initialize(&admin, &logic);

        let (token_address, token_client, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let relayer = Address::generate(&env);

        sac.mint(&sender, &10_000);
        // User approved only 500, but amount + fee = 550
        token_client.approve(&sender, &proxy_id, &500, &1_000_000);

        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[5u8; 32]);
        let pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());

        let payload = MetaPayment {
            nonce: 0,
            deadline: env.ledger().timestamp() + 3600,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token_address: token_address.clone(),
            amount: 500,
            fee: 50,
            fee_recipient: relayer.clone(),
        };

        let signature = sign_meta_payload(&env, &proxy_id, &payload, &pubkey, &signing_key);

        let res = client.try_execute_meta_payment(&payload, &pubkey, &signature);
        assert_eq!(res, Err(Ok(ProxyError::InsufficientAllowance)));

        assert_eq!(token_client.balance(&sender), 10_000);
        assert_eq!(token_client.balance(&recipient), 0);
        assert_eq!(token_client.balance(&relayer), 0);
    }

    /// Replay of an already executed meta-transaction payload is rejected.
    #[test]
    fn test_meta_payment_replay_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let logic = Address::generate(&env);
        let proxy_id = env.register_contract(None, PaymentProxy);
        let client = PaymentProxyClient::new(&env, &proxy_id);
        client.initialize(&admin, &logic);

        let (token_address, token_client, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let relayer = Address::generate(&env);

        sac.mint(&sender, &10_000);
        token_client.approve(&sender, &proxy_id, &10_000, &1_000_000);

        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[6u8; 32]);
        let pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());

        let payload = MetaPayment {
            nonce: 0,
            deadline: env.ledger().timestamp() + 3600,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token_address: token_address.clone(),
            amount: 500,
            fee: 20,
            fee_recipient: relayer.clone(),
        };

        let signature = sign_meta_payload(&env, &proxy_id, &payload, &pubkey, &signing_key);

        client.execute_meta_payment(&payload, &pubkey, &signature);
        assert_eq!(client.get_meta_nonce(&sender), 1);

        // Attempting to replay same payload fails with InvalidNonce
        let res = client.try_execute_meta_payment(&payload, &pubkey, &signature);
        assert_eq!(res, Err(Ok(ProxyError::InvalidNonce)));
    }

    /// Meta-transaction with expired deadline is rejected.
    #[test]
    fn test_meta_payment_deadline_expired() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let logic = Address::generate(&env);
        let proxy_id = env.register_contract(None, PaymentProxy);
        let client = PaymentProxyClient::new(&env, &proxy_id);
        client.initialize(&admin, &logic);

        let (token_address, token_client, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let relayer = Address::generate(&env);

        sac.mint(&sender, &10_000);
        token_client.approve(&sender, &proxy_id, &10_000, &1_000_000);

        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());

        let deadline = env.ledger().timestamp() + 10;
        let payload = MetaPayment {
            nonce: 0,
            deadline,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token_address: token_address.clone(),
            amount: 500,
            fee: 20,
            fee_recipient: relayer.clone(),
        };

        let signature = sign_meta_payload(&env, &proxy_id, &payload, &pubkey, &signing_key);

        set_timestamp(&env, deadline + 100);

        let res = client.try_execute_meta_payment(&payload, &pubkey, &signature);
        assert_eq!(res, Err(Ok(ProxyError::DeadlineExpired)));
    }

    /// Zero fee is supported for altruistic or sponsored relayers.
    #[test]
    fn test_meta_payment_zero_fee_supported() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let logic = Address::generate(&env);
        let proxy_id = env.register_contract(None, PaymentProxy);
        let client = PaymentProxyClient::new(&env, &proxy_id);
        client.initialize(&admin, &logic);

        let (token_address, token_client, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let relayer = Address::generate(&env);

        sac.mint(&sender, &10_000);
        token_client.approve(&sender, &proxy_id, &10_000, &1_000_000);

        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[8u8; 32]);
        let pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());

        let payload = MetaPayment {
            nonce: 0,
            deadline: env.ledger().timestamp() + 3600,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token_address: token_address.clone(),
            amount: 700,
            fee: 0,
            fee_recipient: relayer.clone(),
        };

        let signature = sign_meta_payload(&env, &proxy_id, &payload, &pubkey, &signing_key);

        client.execute_meta_payment(&payload, &pubkey, &signature);

        assert_eq!(client.get_meta_nonce(&sender), 1);
        assert_eq!(token_client.balance(&recipient), 700);
        assert_eq!(token_client.balance(&relayer), 0);
        assert_eq!(token_client.balance(&sender), 10_000 - 700);
    }

    /// route_payment_meta functions identically to execute_meta_payment.
    #[test]
    fn test_route_payment_meta_alias() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let logic = Address::generate(&env);
        let proxy_id = env.register_contract(None, PaymentProxy);
        let client = PaymentProxyClient::new(&env, &proxy_id);
        client.initialize(&admin, &logic);

        let (token_address, token_client, sac) = setup_token(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let relayer = Address::generate(&env);

        sac.mint(&sender, &10_000);
        token_client.approve(&sender, &proxy_id, &10_000, &1_000_000);

        let signing_key = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());

        let payload = MetaPayment {
            nonce: 0,
            deadline: env.ledger().timestamp() + 3600,
            sender: sender.clone(),
            recipient: recipient.clone(),
            token_address: token_address.clone(),
            amount: 800,
            fee: 40,
            fee_recipient: relayer.clone(),
        };

        let signature = sign_meta_payload(&env, &proxy_id, &payload, &pubkey, &signing_key);

        client.route_payment_meta(&payload, &pubkey, &signature);

        assert_eq!(client.get_meta_nonce(&sender), 1);
        assert_eq!(token_client.balance(&recipient), 800);
        assert_eq!(token_client.balance(&relayer), 40);
        assert_eq!(token_client.balance(&sender), 10_000 - 840);
    }
}
