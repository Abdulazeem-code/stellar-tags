#![no_std]

use soroban_sdk::{contract, contractimpl, Env, String};

/// Semantic version of the PaymentRouter contract.
///
/// Bump this constant and redeploy whenever the contract interface changes.
/// The UI reads this value via [`PaymentRouter::version`] before sending any
/// transactions so it can detect incompatible deployments and warn users.
///
/// Versioning convention: MAJOR.MINOR.PATCH
///   MAJOR — breaking change to the public interface
///   MINOR — backwards-compatible new function or behaviour
///   PATCH — internal fix with no interface change
const CONTRACT_VERSION: &str = "1.0.0";

#[contract]
pub struct PaymentRouter;

#[contractimpl]
impl PaymentRouter {
    /// Returns the deployed contract version string.
    ///
    /// This is a read-only view function: it does not write to ledger storage
    /// and costs only the base invocation fee.  The UI calls this before
    /// submitting transactions to confirm it is compatible with the deployed
    /// contract.
    ///
    /// # Returns
    /// A [`String`] in the form `"MAJOR.MINOR.PATCH"` (e.g. `"1.0.0"`).
    pub fn version(env: Env) -> String {
        String::from_str(&env, CONTRACT_VERSION)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::Env;

    /// Verifies that `version()` returns the expected version string and that
    /// the returned value matches the compile-time `CONTRACT_VERSION` constant,
    /// so the two can never drift apart.
    #[test]
    fn test_version_returns_expected_string() {
        let env = Env::default();
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        let returned = client.version();
        let expected = String::from_str(&env, CONTRACT_VERSION);

        assert_eq!(returned, expected);
    }

    /// Verifies the version string is non-empty.
    #[test]
    fn test_version_is_non_empty() {
        let env = Env::default();
        let contract_id = env.register_contract(None, PaymentRouter);
        let client = PaymentRouterClient::new(&env, &contract_id);

        let v = client.version();

        // A Soroban String's byte length is accessible via .len()
        assert!(v.len() > 0, "version must not be empty");
    }
}
