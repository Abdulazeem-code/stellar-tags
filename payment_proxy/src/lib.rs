#![no_std]
//! # PaymentProxy — upgradeable proxy for PaymentRouter
//!
//! This contract provides a **stable on-chain address** so clients never need
//! to change the contract ID they interact with, even when the underlying
//! `PaymentRouter` logic contract is upgraded to a new WASM binary.
//!
//! ## Architecture
//!
//! ```text
//!   Client
//!     │  calls PaymentProxy at a stable, permanent address
//!     ▼
//!   PaymentProxy  (this contract — address is immutable)
//!     │  reads LogicContract storage key
//!     │  forwards calls via env.invoke_contract
//!     ▼
//!   PaymentRouter  (upgradeable logic — address may change across major upgrades)
//! ```
//!
//! ## Upgrade scenarios
//!
//! ### Scenario A — in-place WASM upgrade (no address change)
//! Use the existing `PaymentRouter` timelock: `queue_action(Upgrade(hash))` then
//! `execute_action(nonce)` after 24 h. The proxy's stored address remains valid;
//! state is fully preserved because the contract instance does not change.
//!
//! ### Scenario B — logic contract replacement (new deployment)
//! 1. Deploy a fresh `PaymentRouter` instance and initialize it.
//! 2. Call `PaymentProxy::upgrade_logic(admin, new_logic_address)`.
//! 3. All subsequent forwarded calls reach the new contract.
//!    State migration, if required, must be handled in the new contract's
//!    initializer or via a separate migration transaction.
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

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol, TryFromVal, Val, Vec,
};

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
}

// ── Error codes ───────────────────────────────────────────────────────────────

/// Errors specific to the proxy contract.
#[soroban_sdk::contracterror]
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
    InvalidSessionAllowance = 5,
    /// A session key attempted a payment after its expiry.
    SessionExpired = 6,
    /// A payment exceeds the session key's remaining allowance.
    SessionAllowanceExceeded = 7,
    /// Session keys can only call the supported payment-routing methods.
    UnsupportedSessionCall = 8,
}

// ── TTL helpers ───────────────────────────────────────────────────────────────

const DAY_IN_LEDGERS: u32 = 17_280; // ≈5 s per ledger
const INSTANCE_BUMP: u32 = 7 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP - DAY_IN_LEDGERS;

// ── Contract ──────────────────────────────────────────────────────────────────

/// Stable-address proxy that delegates all routing calls to an upgradeable
/// `PaymentRouter` logic contract.
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
    /// This keeps the proxy interface stable: as the logic contract's function
    /// signatures evolve, callers continue to use `forward` with the updated
    /// function name and argument shapes.
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

    // ── Internal helpers ───────────────────────────────────────────────────────

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
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(all(test, feature = "testutils"))]
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
        // Val does not implement PartialEq, so we cannot use assert_eq! on the
        // full return type.  Match on only the error branch instead.
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

        // Deploy a second proxy instance that will act as the "logic contract"
        // so we can call one of its functions (get_admin) through the forwarder.
        let logic_id = env.register_contract(None, PaymentProxy);
        let logic_client = PaymentProxyClient::new(&env, &logic_id);
        let logic_admin = Address::generate(&env);
        let dummy_logic = Address::generate(&env);
        logic_client.initialize(&logic_admin, &dummy_logic);

        // Deployer proxy: will forward calls to logic_id.
        let proxy_id = env.register_contract(None, PaymentProxy);
        let proxy_client = PaymentProxyClient::new(&env, &proxy_id);
        let proxy_admin = Address::generate(&env);
        proxy_client.initialize(&proxy_admin, &logic_id);

        // forward get_admin to the logic contract — expects logic_admin back.
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

        // v1 logic
        let logic_v1_id = env.register_contract(None, PaymentProxy);
        let v1_admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        PaymentProxyClient::new(&env, &logic_v1_id).initialize(&v1_admin, &dummy);

        // v2 logic
        let logic_v2_id = env.register_contract(None, PaymentProxy);
        let v2_admin = Address::generate(&env);
        PaymentProxyClient::new(&env, &logic_v2_id).initialize(&v2_admin, &dummy);

        // Proxy starts pointing at v1.
        let proxy_id = env.register_contract(None, PaymentProxy);
        let proxy_admin = Address::generate(&env);
        let proxy = PaymentProxyClient::new(&env, &proxy_id);
        proxy.initialize(&proxy_admin, &logic_v1_id);

        // Before upgrade: forward resolves v1_admin.
        let before: Address = proxy
            .forward(&Symbol::new(&env, "get_admin"), &vec![&env])
            .try_into_val(&env)
            .unwrap();
        assert_eq!(before, v1_admin);

        // Upgrade logic pointer to v2.
        proxy.upgrade_logic(&proxy_admin, &logic_v2_id);

        // After upgrade: forward resolves v2_admin.
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
}
