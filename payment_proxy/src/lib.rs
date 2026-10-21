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
//! | `consume_nonce`      | User (auth)  | Marks one nonce bit consumed in a channel     |
//! | `is_nonce_consumed`  | Anyone       | Reads a single nonce bit (view)               |
//! | `get_nonce_bitmap`   | Anyone       | Returns the raw 256-bit word (view)           |
//!
//! ## Bitmapped nonce management (issue #918)
//!
//! Meta-transactions guarded by a strictly sequential nonce suffer
//! head-of-line blocking: if transaction `#1` stalls in the relayer pool,
//! every later transaction from the same sender (`#2`, `#3`, ...) is blocked
//! behind it indefinitely.
//!
//! The proxy therefore tracks consumed nonces in a two-dimensional bitmap:
//!
//! ```text
//! nonce = (channel_id: u32, word_index: u32, bit_index: u32 in 0..=255)
//!
//! (`bit_index` is carried as a `u32` because the Soroban host has no `u8`
//! type; values above 255 are rejected with `ProxyError::InvalidBitIndex`.)
//!
//!                  channel 0             channel 1
//!   word 0     [ 256-bit word ]     [ 256-bit word ]
//!   word 1     [ 256-bit word ]     [ 256-bit word ]
//!    ...              ...                  ...
//! ```
//!
//! Each word covers 256 consecutive nonces and is stored (as four big-endian
//! `u64` limbs) at `ProxyDataKey::NonceBitmap(user, channel_id, word_index)`
//! in persistent storage. Consuming a nonce validates that its bit is still
//! clear and flips it in the same invocation — a consumed bit can never be
//! set again, so a replayed nonce always reverts with
//! `ProxyError::NonceAlreadyUsed`.
//!
//! Because every `(channel_id, word_index, bit_index)` triple is independent,
//! execution order is unconstrained: `#5` may execute before `#2`, and
//! separate channels stream completely in parallel, so a stalled nonce no
//! longer blocks any other payment.

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
    /// Nonce for meta-transactions with relayer fee compensation.
    MetaNonce(Address),
    /// Replay protection nonce for meta-transactions per account.
    Nonce(Address),
    /// 256-bit bitmap of consumed nonces for `(user, channel_id, word_index)`.
    /// Stored as `BytesN<32>` — four big-endian `u64` limbs ([u64; 4]) — in
    /// persistent storage (issue #918).
    NonceBitmap(Address, u32, u32),
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
    /// Session allowances must be positive and expire in the future.
    InvalidSessionAllowance = 13,
    /// A session key attempted a payment after its expiry.
    SessionExpired = 14,
    /// A payment exceeds the session key's remaining allowance.
    SessionAllowanceExceeded = 15,
    /// Session keys can only call the supported payment-routing methods.
    UnsupportedSessionCall = 16,
    /// The requested nonce bit was already consumed — replay attempt.
    NonceAlreadyUsed = 17,
    /// `bit_index` exceeded 255; a word holds exactly 256 nonce bits.
    InvalidBitIndex = 18,
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
const PERSISTENT_BUMP: u32 = 30 * DAY_IN_LEDGERS;
const PERSISTENT_THRESHOLD: u32 = PERSISTENT_BUMP - DAY_IN_LEDGERS;

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

    /// Returns the contract version string.
    pub fn version(env: Env) -> String {
        String::from_str(&env, CONTRACT_VERSION)
    }

    /// Returns the canonical domain separator for this proxy instance.
    pub fn get_domain_separator(env: Env) -> DomainSeparator {
        DomainSeparator {
            contract_id: env.current_contract_address(),
            network_id: env.ledger().network_id(),
            version: Self::version(env),
        }
    }

    /// Computes the SHA-256 hash of a domain separator.
    pub fn hash_domain_separator(env: Env, domain: DomainSeparator) -> BytesN<32> {
        env.crypto().sha256(&domain.to_xdr(&env))
    }

    /// Returns the hash of this proxy's canonical domain separator.
    pub fn get_domain_separator_hash(env: Env) -> BytesN<32> {
        let domain = Self::get_domain_separator(env.clone());
        Self::hash_domain_separator(env, domain)
    }

    /// Computes the SHA-256 hash of a payment intent.
    pub fn hash_payment_intent(env: Env, intent: PaymentIntent) -> BytesN<32> {
        env.crypto().sha256(&intent.to_xdr(&env))
    }

    /// Computes the typed data hash for an explicit domain and intent.
    pub fn compute_typed_hash_for_domain(
        env: Env,
        domain: DomainSeparator,
        intent: PaymentIntent,
    ) -> BytesN<32> {
        Self::compute_typed_data_hash_internal(&env, &domain, &intent)
    }

    /// Computes the typed data hash using this proxy's domain separator.
    pub fn compute_typed_data_hash(env: Env, intent: PaymentIntent) -> BytesN<32> {
        let domain = Self::get_domain_separator(env.clone());
        Self::compute_typed_data_hash_internal(&env, &domain, &intent)
    }

    /// Returns the next expected EIP-712 payment-intent nonce for an account.
    pub fn get_nonce(env: Env, from: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&ProxyDataKey::Nonce(from))
            .unwrap_or(0)
    }

    /// Verifies an intent signature without consuming its nonce.
    pub fn verify_payment_intent(
        env: Env,
        signer_pubkey: BytesN<32>,
        intent: PaymentIntent,
        signature: BytesN<64>,
    ) -> Result<(), ProxyError> {
        Self::verify_payment_intent_internal(&env, &signer_pubkey, &intent, &signature)
    }

    /// Verifies an intent, consumes its nonce, and emits an execution event.
    pub fn execute_payment_intent(
        env: Env,
        signer_pubkey: BytesN<32>,
        intent: PaymentIntent,
        signature: BytesN<64>,
    ) -> Result<(), ProxyError> {
        Self::verify_payment_intent_internal(&env, &signer_pubkey, &intent, &signature)?;

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
            (intent.to, intent.amount, intent.fee, intent.nonce),
        );
        Ok(())
    }

    /// Verifies and consumes an intent before forwarding its call to the router.
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

    /// Computes a network identifier from a Stellar network passphrase.
    pub fn network_id_from_passphrase(env: Env, passphrase: Bytes) -> BytesN<32> {
        env.crypto().sha256(&passphrase)
    }

    /// Returns the next expected nonce for a relayer-fee meta-payment.
    pub fn get_meta_nonce(env: Env, user: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&ProxyDataKey::MetaNonce(user))
            .unwrap_or(0)
    }

    fn build_meta_message(env: &Env, payload: &MetaPayment, signer_pubkey: &BytesN<32>) -> Bytes {
        let mut message = Bytes::new(env);
        message.append(&env.current_contract_address().to_xdr(env));
        message.append(&payload.clone().to_xdr(env));
        message.append(&Bytes::from_slice(env, &signer_pubkey.to_array()));
        let hash = env.crypto().sha256(&message);
        Bytes::from(&hash)
    }

    /// Executes a signed token payment with optional relayer fee compensation.
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
        if payload.nonce != Self::get_meta_nonce(env.clone(), payload.sender.clone()) {
            return Err(ProxyError::InvalidNonce);
        }

        let message = Self::build_meta_message(&env, &payload, &signer_pubkey);
        env.crypto()
            .ed25519_verify(&signer_pubkey, &message, &signature);

        let token_client = token::Client::new(&env, &payload.token_address);
        if token_client.balance(&payload.sender) < total_needed {
            return Err(ProxyError::InsufficientBalance);
        }
        let proxy_address = env.current_contract_address();
        if token_client.allowance(&payload.sender, &proxy_address) < total_needed {
            return Err(ProxyError::InsufficientAllowance);
        }

        let nonce_key = ProxyDataKey::MetaNonce(payload.sender.clone());
        env.storage()
            .persistent()
            .set(&nonce_key, &(payload.nonce + 1));
        Self::bump_persistent_ttl(&env, &nonce_key);

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
            (Symbol::new(&env, "meta_payment"), payload.sender),
            (
                payload.recipient,
                payload.fee_recipient,
                payload.amount,
                payload.fee,
                payload.nonce,
            ),
        );
        Ok(())
    }

    /// Alias for `execute_meta_payment`.
    pub fn route_payment_meta(
        env: Env,
        payload: MetaPayment,
        signer_pubkey: BytesN<32>,
        signature: BytesN<64>,
    ) -> Result<(), ProxyError> {
        Self::execute_meta_payment(env, payload, signer_pubkey, signature)
    }

    /// Executes one typed meta-transaction for a batch.
    pub fn execute_single_meta_tx(env: Env, call: MetaTxCall) -> Result<(), ProxyError> {
        Self::execute_payment_intent(env, call.signer_pubkey, call.intent, call.signature)
    }

    /// Executes each meta-transaction independently and reports which succeeded.
    pub fn execute_batch_tolerant(env: Env, calls: Vec<MetaTxCall>) -> Vec<bool> {
        let mut results = Vec::new(&env);
        for call in calls.iter() {
            match Self::execute_single_meta_tx(env.clone(), call.clone()) {
                Ok(()) => results.push_back(true),
                Err(error) => {
                    env.events().publish(
                        (
                            Symbol::new(&env, "meta_tx_failed"),
                            call.intent.from.clone(),
                        ),
                        error as u32,
                    );
                    results.push_back(false);
                }
            }
        }
        results
    }

    // ── Bitmapped nonce management (issue #918) ───────────────────────

    /// Consumes the nonce `(channel_id, word_index, bit_index)` for `user`.
    ///
    /// The 256-bit word holding the bit is loaded, validated, flipped, and
    /// written back in this one invocation, so check-and-set is atomic. An
    /// already-set bit — a nonce consumed before — is rejected with
    /// [`ProxyError::NonceAlreadyUsed`], making replay impossible.
    ///
    /// Nonces are independent per bit (and per channel), so execution order
    /// is unconstrained: `#5` may execute before `#2` — no head-of-line
    /// blocking.
    ///
    /// # Parameters
    /// - `user` — Nonce owner; must authorize this call.
    /// - `channel_id` — Independent nonce channel (parallel stream).
    /// - `word_index` — Index of the 256-bit word inside the channel.
    /// - `bit_index` — Bit inside the word (`0..=255`, carried as `u32`).
    ///
    /// # Errors
    /// - [`ProxyError::NonceAlreadyUsed`] if the bit was already consumed.
    /// - [`ProxyError::InvalidBitIndex`] if `bit_index` exceeds 255.
    pub fn consume_nonce(
        env: Env,
        user: Address,
        channel_id: u32,
        word_index: u32,
        bit_index: u32,
    ) -> Result<(), ProxyError> {
        if bit_index > 255 {
            return Err(ProxyError::InvalidBitIndex);
        }

        // Only the nonce owner may burn their own nonces; otherwise anyone
        // could grief a sender by consuming future nonces out from under them.
        user.require_auth();

        let mut word = Self::load_nonce_word(&env, &user, channel_id, word_index);
        let limb = (bit_index / 64) as usize;
        let mask = 1u64 << (bit_index % 64);

        // Revert on reuse: the bit must still be unconsumed.
        if word[limb] & mask != 0 {
            return Err(ProxyError::NonceAlreadyUsed);
        }

        word[limb] |= mask;
        Self::store_nonce_word(&env, &user, channel_id, word_index, &word);

        env.events().publish(
            (symbol_short!("nonce"), user, channel_id),
            (word_index, bit_index),
        );

        Ok(())
    }

    /// Returns `true` when `user` has already consumed
    /// `(channel_id, word_index, bit_index)`. An out-of-range `bit_index`
    /// (`> 255`) always reads as `false`.
    pub fn is_nonce_consumed(
        env: Env,
        user: Address,
        channel_id: u32,
        word_index: u32,
        bit_index: u32,
    ) -> bool {
        if bit_index > 255 {
            return false;
        }
        let word = Self::load_nonce_word(&env, &user, channel_id, word_index);
        let limb = (bit_index / 64) as usize;
        word[limb] & (1u64 << (bit_index % 64)) != 0
    }

    /// Returns the raw 256-bit bitmap word for `(user, channel_id,
    /// word_index)` as 32 bytes (four big-endian `u64` limbs). A word that
    /// was never written reads as all zeroes.
    pub fn get_nonce_bitmap(
        env: Env,
        user: Address,
        channel_id: u32,
        word_index: u32,
    ) -> BytesN<32> {
        let word = Self::load_nonce_word(&env, &user, channel_id, word_index);
        BytesN::from_array(&env, &Self::nonce_word_to_bytes(&word))
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

    fn bump_persistent_ttl(env: &Env, key: &ProxyDataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);
    }

    /// Loads the 256-bit nonce bitmap word ([u64; 4]) for
    /// `(user, channel_id, word_index)`, defaulting to an all-zero word.
    fn load_nonce_word(env: &Env, user: &Address, channel_id: u32, word_index: u32) -> [u64; 4] {
        let key = ProxyDataKey::NonceBitmap(user.clone(), channel_id, word_index);
        match env
            .storage()
            .persistent()
            .get::<ProxyDataKey, BytesN<32>>(&key)
        {
            Some(packed) => Self::nonce_word_from_bytes(&packed.to_array()),
            None => [0u64; 4],
        }
    }

    /// Writes a 256-bit nonce bitmap word back to persistent storage and
    /// extends its TTL so an idle channel cannot expire mid-stream.
    fn store_nonce_word(
        env: &Env,
        user: &Address,
        channel_id: u32,
        word_index: u32,
        word: &[u64; 4],
    ) {
        let key = ProxyDataKey::NonceBitmap(user.clone(), channel_id, word_index);
        env.storage().persistent().set(
            &key,
            &BytesN::from_array(env, &Self::nonce_word_to_bytes(word)),
        );
        env.storage()
            .persistent()
            .extend_ttl(&key, PERSISTENT_THRESHOLD, PERSISTENT_BUMP);
    }

    /// Unpacks a 32-byte bitmap word into its four big-endian `u64` limbs.
    fn nonce_word_from_bytes(bytes: &[u8; 32]) -> [u64; 4] {
        let mut word = [0u64; 4];
        for (i, limb) in word.iter_mut().enumerate() {
            let mut chunk = [0u8; 8];
            chunk.copy_from_slice(&bytes[i * 8..(i + 1) * 8]);
            *limb = u64::from_be_bytes(chunk);
        }
        word
    }

    /// Packs four big-endian `u64` limbs back into a 32-byte bitmap word.
    fn nonce_word_to_bytes(word: &[u64; 4]) -> [u8; 32] {
        let mut bytes = [0u8; 32];
        for (i, limb) in word.iter().enumerate() {
            bytes[i * 8..(i + 1) * 8].copy_from_slice(&limb.to_be_bytes());
        }
        bytes
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Ledger as _, LedgerInfo},
        vec, Env, IntoVal, TryIntoVal,
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

    // ── Bitmapped nonce management (issue #918) ───────────────────────

    /// Convenience: nonce management is self-contained, so a fresh
    /// uninitialized proxy client is enough (auth is mocked for the user
    /// require_auth inside consume_nonce).
    fn make_nonce_client() -> (Env, PaymentProxyClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let proxy_id = env.register_contract(None, PaymentProxy);
        let client = PaymentProxyClient::new(&env, &proxy_id);
        (env, client)
    }

    /// A word that was never written reads back as all zeroes.
    #[test]
    fn untouched_nonce_word_reads_all_zeroes() {
        let (env, client) = make_nonce_client();
        let user = Address::generate(&env);

        assert_eq!(
            client.get_nonce_bitmap(&user, &0, &0),
            BytesN::from_array(&env, &[0u8; 32])
        );
    }

    /// Consuming a nonce flips exactly its bit in the 256-bit word, which is
    /// persisted under NonceBitmap(user, channel_id, word_index).
    #[test]
    fn consume_nonce_flips_bit_in_256_bit_word() {
        let (env, client) = make_nonce_client();
        let user = Address::generate(&env);

        assert!(!client.is_nonce_consumed(&user, &0, &0, &7));

        client.consume_nonce(&user, &0, &0, &7);

        assert!(client.is_nonce_consumed(&user, &0, &0, &7));
        // Neighbouring bits stay unconsumed.
        assert!(!client.is_nonce_consumed(&user, &0, &0, &6));
        assert!(!client.is_nonce_consumed(&user, &0, &0, &8));

        // Bit 7 lives in the first big-endian u64 limb, whose byte 7 holds
        // the low mask 0x80.
        let mut expected = [0u8; 32];
        expected[7] = 0x80;
        assert_eq!(
            client.get_nonce_bitmap(&user, &0, &0),
            BytesN::from_array(&env, &expected)
        );
    }

    /// Out-of-order execution: nonce #5 lands and executes before nonce #2
    /// — the core fix for head-of-line blocking.
    #[test]
    fn out_of_order_execution_succeeds() {
        let (env, client) = make_nonce_client();
        let user = Address::generate(&env);

        // #5 arrives first while #2 is still stalled in the relayer pool.
        client.consume_nonce(&user, &0, &0, &5);
        // #2 finally lands; it must not be blocked by #5 having gone first.
        client.consume_nonce(&user, &0, &0, &2);

        assert!(client.is_nonce_consumed(&user, &0, &0, &5));
        assert!(client.is_nonce_consumed(&user, &0, &0, &2));
        // Nothing between or around them was implicitly consumed.
        assert!(!client.is_nonce_consumed(&user, &0, &0, &3));
        assert!(!client.is_nonce_consumed(&user, &0, &0, &4));
    }

    /// Replaying a consumed nonce reverts with NonceAlreadyUsed and leaves
    /// the bitmap intact — no replay vulnerability.
    #[test]
    fn replay_of_consumed_nonce_reverts() {
        let (env, client) = make_nonce_client();
        let user = Address::generate(&env);

        client.consume_nonce(&user, &0, &0, &5);
        client.consume_nonce(&user, &0, &0, &2);

        assert_eq!(
            client.try_consume_nonce(&user, &0, &0, &5),
            Err(Ok(ProxyError::NonceAlreadyUsed))
        );
        assert_eq!(
            client.try_consume_nonce(&user, &0, &0, &2),
            Err(Ok(ProxyError::NonceAlreadyUsed))
        );

        // The failed replays changed nothing: a fresh nonce in the same
        // word is still usable, and the replayed bits are still consumed.
        client.consume_nonce(&user, &0, &0, &3);
        assert!(client.is_nonce_consumed(&user, &0, &0, &3));
        assert!(client.is_nonce_consumed(&user, &0, &0, &5));
        assert!(client.is_nonce_consumed(&user, &0, &0, &2));
    }

    /// Channels are independent: the same (word, bit) position can be
    /// consumed in each channel without touching the others.
    #[test]
    fn channels_are_independent() {
        let (env, client) = make_nonce_client();
        let user = Address::generate(&env);

        client.consume_nonce(&user, &0, &0, &5);
        client.consume_nonce(&user, &1, &0, &5);
        client.consume_nonce(&user, &2, &0, &2);

        assert!(client.is_nonce_consumed(&user, &0, &0, &5));
        assert!(client.is_nonce_consumed(&user, &1, &0, &5));
        assert!(client.is_nonce_consumed(&user, &2, &0, &2));
        // Channels 0 and 1 did not consume bit 2; channels 0 and 2 did not
        // share state for bit 5.
        assert!(!client.is_nonce_consumed(&user, &0, &0, &2));
        assert!(!client.is_nonce_consumed(&user, &1, &0, &2));

        // #5 is still consumable on a brand-new channel...
        client.consume_nonce(&user, &3, &0, &5);
        // ...but replaying it inside a used channel still reverts.
        assert_eq!(
            client.try_consume_nonce(&user, &1, &0, &5),
            Err(Ok(ProxyError::NonceAlreadyUsed))
        );
    }

    /// Bits on limb boundaries live in different u64 limbs of the same
    /// 256-bit word and never collide with each other.
    #[test]
    fn limb_boundaries_do_not_collide() {
        let (env, client) = make_nonce_client();
        let user = Address::generate(&env);

        let boundary_bits = [0u32, 63, 64, 127, 128, 191, 192, 255];

        for bit in boundary_bits {
            client.consume_nonce(&user, &0, &0, &bit);
        }
        for bit in boundary_bits {
            assert!(client.is_nonce_consumed(&user, &0, &0, &bit));
            assert_eq!(
                client.try_consume_nonce(&user, &0, &0, &bit),
                Err(Ok(ProxyError::NonceAlreadyUsed))
            );
        }

        // Each of the four limbs holds exactly bits 0 and 63 set:
        // 0x8000000000000001, big-endian, repeated four times.
        let limb_value: u64 = (1u64 << 63) | 1;
        let mut expected = [0u8; 32];
        for chunk in expected.chunks_mut(8) {
            chunk.copy_from_slice(&limb_value.to_be_bytes());
        }
        assert_eq!(
            client.get_nonce_bitmap(&user, &0, &0),
            BytesN::from_array(&env, &expected)
        );
    }

    /// A fully consumed 256-bit word rejects replays of every nonce in it,
    /// while the next word in the same channel remains a fresh 256-nonce
    /// space — the stream continues without head-of-line blocking.
    #[test]
    fn full_word_rejects_replays_and_next_word_is_fresh() {
        let (env, client) = make_nonce_client();
        let user = Address::generate(&env);

        for bit in 0..=255u32 {
            client.consume_nonce(&user, &0, &0, &bit);
        }
        for bit in [0u32, 42, 128, 255] {
            assert_eq!(
                client.try_consume_nonce(&user, &0, &0, &bit),
                Err(Ok(ProxyError::NonceAlreadyUsed))
            );
        }

        // Word 1 in the same channel is untouched by word 0's exhaustion.
        client.consume_nonce(&user, &0, &1, &0);
        assert!(client.is_nonce_consumed(&user, &0, &1, &0));
        assert!(!client.is_nonce_consumed(&user, &0, &1, &1));
        assert!(client.is_nonce_consumed(&user, &0, &0, &0));
    }

    /// Nonce bitmaps are scoped per user: one user's consumption never
    /// affects another user's stream.
    #[test]
    fn nonces_are_scoped_per_user() {
        let (env, client) = make_nonce_client();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        client.consume_nonce(&alice, &0, &0, &5);

        assert!(client.is_nonce_consumed(&alice, &0, &0, &5));
        assert!(!client.is_nonce_consumed(&bob, &0, &0, &5));

        client.consume_nonce(&bob, &0, &0, &5);
        assert!(client.is_nonce_consumed(&bob, &0, &0, &5));
    }

    /// An out-of-range bit_index reverts instead of silently aliasing
    /// another bit (256 would wrap into bit 0 of the same limb if unchecked).
    #[test]
    fn out_of_range_bit_index_reverts() {
        let (env, client) = make_nonce_client();
        let user = Address::generate(&env);

        assert_eq!(
            client.try_consume_nonce(&user, &0, &0, &256),
            Err(Ok(ProxyError::InvalidBitIndex))
        );

        // The rejected call consumed nothing, and the view reports
        // out-of-range bits as never consumed.
        assert!(!client.is_nonce_consumed(&user, &0, &0, &0));
        assert!(!client.is_nonce_consumed(&user, &0, &0, &256));
    }
}
