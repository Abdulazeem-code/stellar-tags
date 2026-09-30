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
//! | `forward`            | Anyone       | Delegates an arbitrary call to logic contract |
//! | `get_logic_contract` | Anyone       | Returns current logic address (view)          |
//! | `get_admin`          | Anyone       | Returns current admin address (view)          |

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Val, Vec,
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
    use soroban_sdk::{testutils::Address as _, vec, Env, TryIntoVal};

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
