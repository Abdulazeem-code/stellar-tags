//! passkey_wallet tests.
//!
//! Most tests call `__check_auth` directly with the WebAuthn vectors in
//! tests/fixtures/webauthn_vectors.json (regenerate with
//! `node scripts/generate-webauthn-vectors.js`). The end-to-end tests sign a
//! real Soroban authorization payload with a passkey key generated at run time
//! and let the host drive `__check_auth` through `require_auth`.

use p256::ecdsa::{signature::Signer as _, Signature as P256Signature, SigningKey};
use passkey_wallet::{
    Ed25519Signature, Error, PasskeySignature, PasskeySigner, PasskeyWallet, PasskeyWalletClient,
    Signature, Signer, SignerKey, RECOVERY_DELAY_LEDGERS, SECONDS_PER_DAY,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use soroban_sdk::{
    auth::{Context, ContractContext},
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    xdr::{
        self, HashIdPreimage, HashIdPreimageSorobanAuthorization, InvokeContractArgs, Limits,
        ScVal, SorobanAddressCredentials, SorobanAuthorizationEntry, SorobanAuthorizedFunction,
        SorobanAuthorizedInvocation, SorobanCredentials, WriteXdr,
    },
    Address, Bytes, BytesN, Env, IntoVal, InvokeError, Symbol, TryFromVal, Val, Vec,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn vectors() -> Value {
    serde_json::from_str(include_str!("fixtures/webauthn_vectors.json")).unwrap()
}

fn unhex(s: &Value) -> std::vec::Vec<u8> {
    hex::decode(s.as_str().unwrap()).unwrap()
}

fn bytes(env: &Env, v: &[u8]) -> Bytes {
    Bytes::from_slice(env, v)
}

fn bytes_n<const N: usize>(env: &Env, v: &[u8]) -> BytesN<N> {
    BytesN::from_array(env, &v.try_into().unwrap())
}

fn payload(env: &Env) -> BytesN<32> {
    bytes_n(env, &unhex(&vectors()["payload"]))
}

fn other_payload(env: &Env) -> BytesN<32> {
    bytes_n(env, &unhex(&vectors()["other_payload"]))
}

fn passkey(env: &Env, name: &str) -> Signer {
    let v = vectors();
    let p = v["passkeys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == name)
        .unwrap();
    Signer::Passkey(PasskeySigner {
        id: bytes(env, &unhex(&p["id"])),
        public_key: bytes_n(env, &unhex(&p["public_key"])),
    })
}

fn ed25519(env: &Env, name: &str) -> Signer {
    let v = vectors();
    let k = v["ed25519_keys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["name"] == name)
        .unwrap();
    Signer::Ed25519(bytes_n(env, &unhex(&k["public_key"])))
}

fn key_of(signer: &Signer) -> SignerKey {
    match signer {
        Signer::Passkey(p) => SignerKey::Passkey(p.id.clone()),
        Signer::Ed25519(k) => SignerKey::Ed25519(k.clone()),
    }
}

/// The raw parts of a passkey assertion vector, for tampering.
struct Assertion {
    id: std::vec::Vec<u8>,
    authenticator_data: std::vec::Vec<u8>,
    client_data_json: std::vec::Vec<u8>,
    signature: std::vec::Vec<u8>,
}

fn assertion(name: &str) -> Assertion {
    let v = &vectors()["assertions"][name];
    Assertion {
        id: unhex(&v["id"]),
        authenticator_data: unhex(&v["authenticator_data"]),
        client_data_json: unhex(&v["client_data_json"]),
        signature: unhex(&v["signature"]),
    }
}

impl Assertion {
    fn to_signature(&self, env: &Env) -> Signature {
        Signature::Passkey(PasskeySignature {
            id: bytes(env, &self.id),
            authenticator_data: bytes(env, &self.authenticator_data),
            client_data_json: bytes(env, &self.client_data_json),
            signature: bytes_n(env, &self.signature),
        })
    }
}

fn passkey_sig(env: &Env, name: &str) -> Signature {
    assertion(name).to_signature(env)
}

fn ed_sig(env: &Env, name: &str) -> Signature {
    let v = &vectors()["ed25519_signatures"][name];
    Signature::Ed25519(Ed25519Signature {
        public_key: bytes_n(env, &unhex(&v["public_key"])),
        signature: bytes_n(env, &unhex(&v["signature"])),
    })
}

/// n - s for the secp256r1 order n: turns a low-S signature into its valid
/// high-S twin.
fn to_high_s(signature: &[u8]) -> std::vec::Vec<u8> {
    const N: [u8; 32] = [
        0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63,
        0x25, 0x51,
    ];
    let mut out = signature.to_vec();
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut d = i16::from(N[i]) - i16::from(signature[32 + i]) - borrow;
        borrow = if d < 0 {
            d += 256;
            1
        } else {
            0
        };
        out[32 + i] = u8::try_from(d).unwrap();
    }
    out
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct Wallet<'a> {
    env: Env,
    address: Address,
    client: PasskeyWalletClient<'a>,
}

/// A wallet whose first signer is passkey_a.
fn wallet() -> Wallet<'static> {
    wallet_with(|env| passkey(env, "passkey_a"))
}

fn wallet_with(first: impl FnOnce(&Env) -> Signer) -> Wallet<'static> {
    let env = Env::default();
    let first = first(&env);
    let address = env.register(PasskeyWallet, (first,));
    let client = PasskeyWalletClient::new(&env, &address);
    Wallet {
        env,
        address,
        client,
    }
}

impl Wallet<'_> {
    /// Runs an admin call as the wallet itself, without signatures.
    fn admin<R>(&self, f: impl FnOnce(&PasskeyWalletClient) -> R) -> R {
        self.env.mock_all_auths();
        let r = f(&self.client);
        self.env.set_auths(&[]);
        r
    }

    fn add(&self, signer: Signer) {
        self.admin(|c| c.add_signer(&signer));
    }

    fn check(
        &self,
        payload: &BytesN<32>,
        signatures: std::vec::Vec<Signature>,
        contexts: Vec<Context>,
    ) -> Result<(), Result<Error, InvokeError>> {
        let mut sigs = Vec::new(&self.env);
        for s in signatures {
            sigs.push_back(s);
        }
        self.env.try_invoke_contract_check_auth::<Error>(
            &self.address,
            payload,
            sigs.into_val(&self.env),
            &contexts,
        )
    }

    fn check_payload(
        &self,
        signatures: std::vec::Vec<Signature>,
    ) -> Result<(), Result<Error, InvokeError>> {
        self.check(&payload(&self.env), signatures, Vec::new(&self.env))
    }

    fn call_ctx(&self, contract: &Address, fn_name: &str, args: Vec<Val>) -> Context {
        Context::Contract(ContractContext {
            contract: contract.clone(),
            fn_name: Symbol::new(&self.env, fn_name),
            args,
        })
    }
}

fn contract_err(e: Error) -> Result<(), Result<Error, InvokeError>> {
    Err(Ok(e))
}

/// The host trapped (for example a signature that does not verify).
fn assert_host_rejected(r: Result<(), Result<Error, InvokeError>>) {
    assert!(
        matches!(r, Err(Err(_))),
        "expected a host-level rejection, got {r:?}"
    );
}

// ---------------------------------------------------------------------------
// WebAuthn verification
// ---------------------------------------------------------------------------

#[test]
fn valid_passkey_signature() {
    let w = wallet();
    assert_eq!(
        w.check_payload(vec![passkey_sig(&w.env, "a_valid")]),
        Ok(())
    );
}

#[test]
fn client_data_key_order_and_extra_keys_do_not_matter() {
    let w = wallet();
    assert_eq!(
        w.check_payload(vec![passkey_sig(&w.env, "a_reordered")]),
        Ok(())
    );
}

#[test]
fn wrong_challenge_is_rejected() {
    let w = wallet();
    // Signed by the right key, but the challenge is a different payload.
    assert_eq!(
        w.check_payload(vec![passkey_sig(&w.env, "a_wrong_challenge")]),
        contract_err(Error::WrongChallenge)
    );
    // A valid assertion replayed against another payload.
    assert_eq!(
        w.check(
            &other_payload(&w.env),
            vec![passkey_sig(&w.env, "a_valid")],
            Vec::new(&w.env)
        ),
        contract_err(Error::WrongChallenge)
    );
}

#[test]
fn tampered_authenticator_data_is_rejected() {
    let w = wallet();
    for index in [0usize, 33, 36] {
        // rpIdHash, signCount
        let mut a = assertion("a_valid");
        a.authenticator_data[index] ^= 0x01;
        assert_host_rejected(w.check_payload(vec![a.to_signature(&w.env)]));
    }
    // Extra bytes appended (as if extensions were injected).
    let mut a = assertion("a_valid");
    a.authenticator_data.push(0);
    assert_host_rejected(w.check_payload(vec![a.to_signature(&w.env)]));
    // Truncated below the 37-byte minimum.
    let mut a = assertion("a_valid");
    a.authenticator_data.truncate(36);
    assert_eq!(
        w.check_payload(vec![a.to_signature(&w.env)]),
        contract_err(Error::InvalidAuthenticatorData)
    );
}

#[test]
fn tampered_client_data_json_is_rejected() {
    let w = wallet();
    // Change the origin, leaving type and challenge intact.
    let mut a = assertion("a_valid");
    let json = String::from_utf8(a.client_data_json.clone()).unwrap();
    a.client_data_json = json
        .replace("stellartags.xyz", "stellartags.xyy")
        .into_bytes();
    assert_host_rejected(w.check_payload(vec![a.to_signature(&w.env)]));

    // Not JSON at all.
    let mut a = assertion("a_valid");
    a.client_data_json.truncate(10);
    assert_eq!(
        w.check_payload(vec![a.to_signature(&w.env)]),
        contract_err(Error::InvalidClientData)
    );

    // A second challenge key cannot shadow the first.
    let mut a = assertion("a_valid");
    let json = String::from_utf8(a.client_data_json.clone()).unwrap();
    let challenge = json
        .split("\"challenge\":\"")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap()
        .to_string();
    a.client_data_json = json
        .replacen('}', &format!(",\"challenge\":\"{challenge}\"}}"), 1)
        .into_bytes();
    assert_eq!(
        w.check_payload(vec![a.to_signature(&w.env)]),
        contract_err(Error::InvalidClientData)
    );

    // Oversized client data.
    let mut a = assertion("a_valid");
    a.client_data_json = vec![b' '; 1025];
    assert_eq!(
        w.check_payload(vec![a.to_signature(&w.env)]),
        contract_err(Error::InvalidClientData)
    );
}

#[test]
fn wrong_type_is_rejected() {
    let w = wallet();
    assert_eq!(
        w.check_payload(vec![passkey_sig(&w.env, "a_wrong_type")]),
        contract_err(Error::WrongType)
    );
}

#[test]
fn user_present_flag_is_required() {
    let w = wallet();
    assert_eq!(
        w.check_payload(vec![passkey_sig(&w.env, "a_no_up")]),
        contract_err(Error::UserNotPresent)
    );
}

#[test]
fn user_verified_flag_is_enforced_when_required() {
    let w = wallet();
    // Off by default: User Present alone is enough.
    assert!(!w.client.require_uv());
    assert_eq!(
        w.check_payload(vec![passkey_sig(&w.env, "a_up_only")]),
        Ok(())
    );

    w.admin(|c| c.set_require_uv(&true));
    assert_eq!(
        w.check_payload(vec![passkey_sig(&w.env, "a_up_only")]),
        contract_err(Error::UserNotVerified)
    );
    assert_eq!(
        w.check_payload(vec![passkey_sig(&w.env, "a_valid")]),
        Ok(())
    );
}

#[test]
fn high_s_signature_is_rejected() {
    let w = wallet();
    let mut a = assertion("a_valid");
    a.signature = to_high_s(&a.signature);
    assert_eq!(
        w.check_payload(vec![a.to_signature(&w.env)]),
        contract_err(Error::SignatureNotNormalized)
    );
}

#[test]
fn bad_signature_bytes_are_rejected() {
    let w = wallet();
    let mut a = assertion("a_valid");
    a.signature[5] ^= 0x01;
    assert_host_rejected(w.check_payload(vec![a.to_signature(&w.env)]));
}

#[test]
fn unknown_signer_is_rejected() {
    let w = wallet();
    // passkey_c signed correctly but is not registered.
    assert_eq!(
        w.check_payload(vec![passkey_sig(&w.env, "c_valid")]),
        contract_err(Error::UnknownSigner)
    );
    assert_eq!(
        w.check_payload(vec![ed_sig(&w.env, "ed_a_valid")]),
        contract_err(Error::UnknownSigner)
    );
    // A registered id with another key's assertion fails verification.
    w.add(passkey(&w.env, "passkey_b"));
    let mut b = assertion("b_valid");
    b.id = assertion("a_valid").id;
    assert_host_rejected(w.check_payload(vec![b.to_signature(&w.env)]));
}

#[test]
fn duplicate_signer_is_rejected() {
    let w = wallet();
    w.add(passkey(&w.env, "passkey_b"));
    w.admin(|c| c.set_threshold(&2));
    assert_eq!(
        w.check_payload(vec![
            passkey_sig(&w.env, "a_valid"),
            passkey_sig(&w.env, "a_valid")
        ]),
        contract_err(Error::DuplicateSignature)
    );
    // The same passkey with two different valid assertions is still one signer.
    assert_eq!(
        w.check_payload(vec![
            passkey_sig(&w.env, "a_valid"),
            passkey_sig(&w.env, "a_reordered")
        ]),
        contract_err(Error::DuplicateSignature)
    );
}

#[test]
fn below_threshold_is_rejected() {
    let w = wallet();
    w.add(passkey(&w.env, "passkey_b"));
    w.add(passkey(&w.env, "passkey_c"));
    w.admin(|c| c.set_threshold(&2));
    assert_eq!(
        w.check_payload(vec![passkey_sig(&w.env, "a_valid")]),
        contract_err(Error::ThresholdNotMet)
    );
    assert_eq!(
        w.check_payload(vec![
            passkey_sig(&w.env, "a_valid"),
            passkey_sig(&w.env, "c_valid")
        ]),
        Ok(())
    );
    assert_eq!(w.check_payload(vec![]), contract_err(Error::NoSignatures));
}

#[test]
fn ed25519_signer() {
    let w = wallet();
    w.add(ed25519(&w.env, "ed25519_a"));
    assert_eq!(w.check_payload(vec![ed_sig(&w.env, "ed_a_valid")]), Ok(()));

    let Signature::Ed25519(mut bad) = ed_sig(&w.env, "ed_a_valid") else {
        unreachable!()
    };
    let mut raw = bad.signature.to_array();
    raw[0] ^= 1;
    bad.signature = BytesN::from_array(&w.env, &raw);
    assert_host_rejected(w.check_payload(vec![Signature::Ed25519(bad)]));
}

#[test]
fn mixed_passkey_and_ed25519_multisig() {
    let w = wallet();
    w.add(ed25519(&w.env, "ed25519_a"));
    w.admin(|c| c.set_threshold(&2));
    assert_eq!(
        w.check_payload(vec![
            passkey_sig(&w.env, "a_valid"),
            ed_sig(&w.env, "ed_a_valid")
        ]),
        Ok(())
    );
    assert_eq!(
        w.check_payload(vec![ed_sig(&w.env, "ed_a_valid")]),
        contract_err(Error::ThresholdNotMet)
    );
    // One bad signature fails the whole authorization, even if enough others verify.
    w.add(passkey(&w.env, "passkey_b"));
    assert_eq!(
        w.check_payload(vec![
            passkey_sig(&w.env, "a_valid"),
            ed_sig(&w.env, "ed_a_valid"),
            passkey_sig(&w.env, "c_valid"),
        ]),
        contract_err(Error::UnknownSigner)
    );
}

// ---------------------------------------------------------------------------
// Signer management
// ---------------------------------------------------------------------------

#[test]
fn constructor_requires_a_passkey() {
    let env = Env::default();
    let k = ed25519(&env, "ed25519_a");
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(PasskeyWallet, (k,));
    }))
    .is_err());

    let w = wallet();
    assert_eq!(w.client.signers().len(), 1);
    assert_eq!(w.client.threshold(), 1);
}

#[test]
fn admin_calls_need_the_wallets_own_authorisation() {
    let w = wallet();
    let b = passkey(&w.env, "passkey_b");

    // No authorisation at all.
    assert!(w.client.try_add_signer(&b).is_err());
    assert!(w.client.try_set_threshold(&1).is_err());
    assert!(w
        .client
        .try_remove_signer(&key_of(&passkey(&w.env, "passkey_a")))
        .is_err());

    // Authorised by some other address, not the wallet.
    let outsider = Address::generate(&w.env);
    let args: Vec<Val> = (b.clone(),).into_val(&w.env);
    w.env.mock_auths(&[MockAuth {
        address: &outsider,
        invoke: &MockAuthInvoke {
            contract: &w.address,
            fn_name: "add_signer",
            args,
            sub_invokes: &[],
        },
    }]);
    assert!(w.client.try_add_signer(&b).is_err());
    assert_eq!(w.client.signers().len(), 1);

    // Authorised by the wallet.
    w.add(b.clone());
    assert_eq!(w.client.signers().len(), 2);
    w.admin(|c| c.remove_signer(&key_of(&b)));
    assert_eq!(w.client.signers().len(), 1);
}

#[test]
fn signer_rules() {
    let w = wallet();
    let a = passkey(&w.env, "passkey_a");

    // Last signer can never be removed.
    assert_eq!(
        w.admin(|c| c.try_remove_signer(&key_of(&a))),
        Err(Ok(Error::LastSigner))
    );
    // Duplicates.
    assert_eq!(
        w.admin(|c| c.try_add_signer(&a)),
        Err(Ok(Error::SignerExists))
    );
    // Threshold bounds.
    assert_eq!(
        w.admin(|c| c.try_set_threshold(&0)),
        Err(Ok(Error::InvalidThreshold))
    );
    assert_eq!(
        w.admin(|c| c.try_set_threshold(&2)),
        Err(Ok(Error::InvalidThreshold))
    );
    // Removing a signer may not leave the threshold above the signer count.
    w.add(passkey(&w.env, "passkey_b"));
    w.admin(|c| c.set_threshold(&2));
    assert_eq!(
        w.admin(|c| c.try_remove_signer(&key_of(&a))),
        Err(Ok(Error::InvalidThreshold))
    );
    // Unknown signer.
    assert_eq!(
        w.admin(|c| c.try_remove_signer(&key_of(&passkey(&w.env, "passkey_c")))),
        Err(Ok(Error::SignerNotFound))
    );
    // Malformed passkey (compressed key prefix).
    let mut pk = [0u8; 65];
    pk[0] = 0x02;
    let bad = Signer::Passkey(PasskeySigner {
        id: bytes(&w.env, b"x"),
        public_key: BytesN::from_array(&w.env, &pk),
    });
    assert_eq!(
        w.admin(|c| c.try_add_signer(&bad)),
        Err(Ok(Error::InvalidSigner))
    );
    // At most 10 signers.
    for i in 0..8u8 {
        w.add(Signer::Ed25519(BytesN::from_array(&w.env, &[i + 1; 32])));
    }
    assert_eq!(w.client.signers().len(), 10);
    assert_eq!(
        w.admin(|c| c.try_add_signer(&Signer::Ed25519(BytesN::from_array(&w.env, &[99; 32])))),
        Err(Ok(Error::TooManySigners))
    );
}

// ---------------------------------------------------------------------------
// Spending limits
// ---------------------------------------------------------------------------

fn transfer_ctx(w: &Wallet, token: &Address, amount: i128) -> Context {
    let to = Address::generate(&w.env);
    w.call_ctx(
        token,
        "transfer",
        (w.address.clone(), to, amount).into_val(&w.env),
    )
}

#[test]
fn spending_limit_within_and_above() {
    let w = wallet();
    w.add(passkey(&w.env, "passkey_b"));
    let token = Address::generate(&w.env);
    w.admin(|c| c.set_spend_limit(&token, &1_000));
    let one = || vec![passkey_sig(&w.env, "a_valid")];
    let two = || {
        vec![
            passkey_sig(&w.env, "a_valid"),
            passkey_sig(&w.env, "b_valid"),
        ]
    };
    let p = payload(&w.env);

    // Within the limit: threshold (1) is enough.
    assert_eq!(
        w.check(
            &p,
            one(),
            soroban_sdk::vec![&w.env, transfer_ctx(&w, &token, 400)]
        ),
        Ok(())
    );
    assert_eq!(w.client.spent_today(&token), 400);

    // 400 + 700 crosses 1000: needs threshold + 1.
    assert_eq!(
        w.check(
            &p,
            one(),
            soroban_sdk::vec![&w.env, transfer_ctx(&w, &token, 700)]
        ),
        contract_err(Error::ThresholdNotMet)
    );
    assert_eq!(
        w.client.spent_today(&token),
        400,
        "rejected spend is not recorded"
    );
    assert_eq!(
        w.check(
            &p,
            two(),
            soroban_sdk::vec![&w.env, transfer_ctx(&w, &token, 700)]
        ),
        Ok(())
    );
    assert_eq!(w.client.spent_today(&token), 1_100);

    // Several transfers in one authorization are added together.
    w.env.ledger().with_mut(|l| l.timestamp += SECONDS_PER_DAY);
    assert_eq!(w.client.spent_today(&token), 0, "limit resets the next day");
    assert_eq!(
        w.check(
            &p,
            one(),
            soroban_sdk::vec![
                &w.env,
                transfer_ctx(&w, &token, 600),
                transfer_ctx(&w, &token, 600)
            ]
        ),
        contract_err(Error::ThresholdNotMet)
    );

    // Tokens without a limit are not affected.
    let other = Address::generate(&w.env);
    assert_eq!(
        w.check(
            &p,
            one(),
            soroban_sdk::vec![&w.env, transfer_ctx(&w, &other, 1_000_000)]
        ),
        Ok(())
    );

    // Granting an allowance on a limited token always needs the higher bar.
    let spender = Address::generate(&w.env);
    let approve = w.call_ctx(
        &token,
        "approve",
        (w.address.clone(), spender, 1i128, 100u32).into_val(&w.env),
    );
    assert_eq!(
        w.check(&p, one(), soroban_sdk::vec![&w.env, approve.clone()]),
        contract_err(Error::ThresholdNotMet)
    );
    assert_eq!(
        w.check(&p, two(), soroban_sdk::vec![&w.env, approve]),
        Ok(())
    );
}

#[test]
fn spending_limit_with_a_single_signer_requires_all_signers() {
    // threshold + 1 would exceed the signer count, so "all signers" (1) applies.
    let w = wallet();
    let token = Address::generate(&w.env);
    w.admin(|c| c.set_spend_limit(&token, &10));
    assert_eq!(
        w.check(
            &payload(&w.env),
            vec![passkey_sig(&w.env, "a_valid")],
            soroban_sdk::vec![&w.env, transfer_ctx(&w, &token, 50)]
        ),
        Ok(())
    );
}

#[test]
fn spending_limit_admin() {
    let w = wallet();
    let token = Address::generate(&w.env);
    assert_eq!(
        w.admin(|c| c.try_set_spend_limit(&token, &0)),
        Err(Ok(Error::InvalidLimit))
    );
    assert!(
        w.client.try_set_spend_limit(&token, &5).is_err(),
        "needs wallet auth"
    );
    w.admin(|c| c.set_spend_limit(&token, &5));
    assert_eq!(w.client.spend_limit(&token), Some(5));
    w.admin(|c| c.remove_spend_limit(&token));
    assert_eq!(w.client.spend_limit(&token), None);
}

#[test]
fn negative_amounts_are_rejected() {
    let w = wallet();
    let token = Address::generate(&w.env);
    w.admin(|c| c.set_spend_limit(&token, &1_000));
    assert_eq!(
        w.check(
            &payload(&w.env),
            vec![passkey_sig(&w.env, "a_valid")],
            soroban_sdk::vec![&w.env, transfer_ctx(&w, &token, -5)]
        ),
        contract_err(Error::InvalidAmount)
    );
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/// passkey_a + ed25519_a with threshold 2, so the special recovery rules are
/// what let a single signer through.
fn recovery_wallet() -> Wallet<'static> {
    let w = wallet();
    w.add(ed25519(&w.env, "ed25519_a"));
    w.admin(|c| c.set_threshold(&2));
    w
}

#[test]
fn single_recovery_key_may_start_recovery_and_single_passkey_may_cancel() {
    let w = recovery_wallet();
    let p = payload(&w.env);
    let new = passkey(&w.env, "passkey_b");
    let start = w.call_ctx(
        &w.address,
        "start_recovery",
        (new.clone(),).into_val(&w.env),
    );
    let cancel = w.call_ctx(&w.address, "cancel_recovery", Vec::new(&w.env));

    assert_eq!(
        w.check(
            &p,
            vec![ed_sig(&w.env, "ed_a_valid")],
            soroban_sdk::vec![&w.env, start.clone()]
        ),
        Ok(())
    );
    // A passkey alone cannot start it (normal threshold applies).
    assert_eq!(
        w.check(
            &p,
            vec![passkey_sig(&w.env, "a_valid")],
            soroban_sdk::vec![&w.env, start.clone()]
        ),
        contract_err(Error::ThresholdNotMet)
    );
    assert_eq!(
        w.check(
            &p,
            vec![passkey_sig(&w.env, "a_valid")],
            soroban_sdk::vec![&w.env, cancel.clone()]
        ),
        Ok(())
    );
    // The recovery key alone cannot cancel.
    assert_eq!(
        w.check(
            &p,
            vec![ed_sig(&w.env, "ed_a_valid")],
            soroban_sdk::vec![&w.env, cancel]
        ),
        contract_err(Error::ThresholdNotMet)
    );
    // The recovery key cannot piggyback other calls on start_recovery.
    w.add(passkey(&w.env, "passkey_c"));
    let add = w.call_ctx(
        &w.address,
        "add_signer",
        (passkey(&w.env, "passkey_c"),).into_val(&w.env),
    );
    assert_eq!(
        w.check(
            &p,
            vec![ed_sig(&w.env, "ed_a_valid")],
            soroban_sdk::vec![&w.env, start, add]
        ),
        contract_err(Error::ThresholdNotMet)
    );
}

#[test]
fn recovery_completes_after_the_delay() {
    let w = recovery_wallet();
    let new = passkey(&w.env, "passkey_b");
    let unlock = w.admin(|c| c.start_recovery(&new));
    assert_eq!(unlock, w.env.ledger().sequence() + RECOVERY_DELAY_LEDGERS);
    assert_eq!(
        w.admin(|c| c.try_start_recovery(&new)),
        Err(Ok(Error::RecoveryPending))
    );

    // Before the delay: rejected.
    w.env.ledger().with_mut(|l| l.sequence_number = unlock - 1);
    assert_eq!(
        w.client.try_complete_recovery(),
        Err(Ok(Error::RecoveryNotReady))
    );

    // After the delay: anyone can complete it, without authorisation.
    w.env.ledger().with_mut(|l| l.sequence_number = unlock);
    w.client.complete_recovery();
    let signers = w.client.signers();
    assert_eq!(signers.len(), 2);
    assert!(signers.contains(ed25519(&w.env, "ed25519_a")));
    assert!(signers.contains(&new));
    assert!(
        !signers.contains(passkey(&w.env, "passkey_a")),
        "old passkey is replaced"
    );
    assert_eq!(w.client.recovery(), None);

    // The new passkey works.
    assert_eq!(
        w.check_payload(vec![
            passkey_sig(&w.env, "b_valid"),
            ed_sig(&w.env, "ed_a_valid")
        ]),
        Ok(())
    );
    assert_eq!(
        w.check_payload(vec![
            passkey_sig(&w.env, "a_valid"),
            ed_sig(&w.env, "ed_a_valid")
        ]),
        contract_err(Error::UnknownSigner)
    );
}

#[test]
fn recovery_lowers_threshold_if_needed() {
    let w = wallet();
    w.add(passkey(&w.env, "passkey_b"));
    w.add(ed25519(&w.env, "ed25519_a"));
    w.admin(|c| c.set_threshold(&3));
    let unlock = w.admin(|c| c.start_recovery(&passkey(&w.env, "passkey_c")));
    w.env.ledger().with_mut(|l| l.sequence_number = unlock);
    w.client.complete_recovery();
    assert_eq!(w.client.signers().len(), 2);
    assert_eq!(w.client.threshold(), 2);
}

#[test]
fn recovery_cancelled() {
    let w = recovery_wallet();
    let unlock = w.admin(|c| c.start_recovery(&passkey(&w.env, "passkey_b")));
    w.env.mock_all_auths();
    w.client.cancel_recovery();
    w.env.set_auths(&[]);
    assert_eq!(w.client.recovery(), None);
    w.env.ledger().with_mut(|l| l.sequence_number = unlock + 1);
    assert_eq!(w.client.try_complete_recovery(), Err(Ok(Error::NoRecovery)));
    assert_eq!(
        {
            w.env.mock_all_auths();
            w.client.try_cancel_recovery()
        },
        Err(Ok(Error::NoRecovery))
    );
    assert!(w.client.signers().contains(passkey(&w.env, "passkey_a")));
}

#[test]
fn recovery_rules() {
    let w = recovery_wallet();
    // Needs wallet auth.
    assert!(w
        .client
        .try_start_recovery(&passkey(&w.env, "passkey_b"))
        .is_err());
    // New signer must be a passkey.
    assert_eq!(
        w.admin(|c| c.try_start_recovery(&ed25519(&w.env, "ed25519_b"))),
        Err(Ok(Error::InvalidSigner))
    );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[test]
fn admin_actions_emit_events() {
    use soroban_sdk::testutils::Events as _;

    // Topic names of the events the wallet emitted in the last invocation.
    fn topics(w: &Wallet) -> std::vec::Vec<String> {
        w.env
            .events()
            .all()
            .filter_by_contract(&w.address)
            .events()
            .iter()
            .map(|e| {
                let xdr::ContractEventBody::V0(body) = &e.body;
                match body.topics.first() {
                    Some(ScVal::Symbol(s)) => s.to_utf8_string_lossy(),
                    other => format!("{other:?}"),
                }
            })
            .collect()
    }

    let w = wallet();
    let b = passkey(&w.env, "passkey_b");
    w.add(b.clone());
    assert_eq!(topics(&w), ["signer_added"]);
    w.admin(|c| c.set_threshold(&2));
    assert_eq!(topics(&w), ["threshold_changed"]);
    w.admin(|c| c.set_threshold(&1));
    w.admin(|c| c.remove_signer(&key_of(&b)));
    assert_eq!(topics(&w), ["signer_removed"]);
    let token = Address::generate(&w.env);
    w.admin(|c| c.set_spend_limit(&token, &7));
    assert_eq!(topics(&w), ["limit_changed"]);
    w.admin(|c| c.set_require_uv(&true));
    assert_eq!(topics(&w), ["require_uv_changed"]);

    w.admin(|c| c.start_recovery(&passkey(&w.env, "passkey_c")));
    assert_eq!(topics(&w), ["recovery_started"]);
    w.env.mock_all_auths();
    w.client.cancel_recovery();
    w.env.set_auths(&[]);
    assert_eq!(topics(&w), ["recovery_cancelled"]);
    let unlock = w.admin(|c| c.start_recovery(&passkey(&w.env, "passkey_c")));
    w.env.ledger().with_mut(|l| l.sequence_number = unlock);
    w.client.complete_recovery();
    assert_eq!(topics(&w), ["recovery_completed"]);
}

// ---------------------------------------------------------------------------
// End to end: a real Soroban authorization signed with a passkey
// ---------------------------------------------------------------------------

/// A passkey created at run time. Nothing secret is stored in the repo.
struct LivePasskey {
    id: [u8; 16],
    key: SigningKey,
}

impl LivePasskey {
    fn new() -> Self {
        let key = SigningKey::random(&mut rand_core::OsRng);
        let mut id = [0u8; 16];
        rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut id);
        LivePasskey { id, key }
    }

    fn signer(&self, env: &Env) -> Signer {
        let point = self.key.verifying_key().to_encoded_point(false);
        Signer::Passkey(PasskeySigner {
            id: bytes(env, &self.id),
            public_key: bytes_n(env, point.as_bytes()),
        })
    }

    /// Builds the assertion a browser would return for `payload`.
    fn sign(&self, env: &Env, payload: &[u8; 32]) -> Signature {
        use base64ish::encode;
        let mut auth_data = Sha256::digest(b"stellartags.xyz").to_vec();
        auth_data.push(0x05); // UP | UV
        auth_data.extend_from_slice(&7u32.to_be_bytes());
        let cdj = format!(
            r#"{{"type":"webauthn.get","challenge":"{}","origin":"https://stellartags.xyz","crossOrigin":false}}"#,
            encode(payload)
        );
        let mut signed = auth_data.clone();
        signed.extend_from_slice(&Sha256::digest(cdj.as_bytes()));
        let sig: P256Signature = self.key.sign(&signed);
        let sig = sig.normalize_s().unwrap_or(sig);
        Signature::Passkey(PasskeySignature {
            id: bytes(env, &self.id),
            authenticator_data: bytes(env, &auth_data),
            client_data_json: bytes(env, cdj.as_bytes()),
            signature: bytes_n(env, &sig.to_bytes()),
        })
    }
}

/// Minimal base64url (no padding) for the test's own challenge.
mod base64ish {
    pub fn encode(input: &[u8]) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in input.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for i in 0..=chunk.len() {
                out.push(T[(n >> (18 - 6 * i)) as usize & 63] as char);
            }
        }
        out
    }
}

/// Signs one root invocation for `wallet` and installs it with set_auths.
fn authorize(
    env: &Env,
    wallet: &Address,
    contract: &Address,
    fn_name: &str,
    args: Vec<Val>,
    sign: impl Fn(&[u8; 32]) -> std::vec::Vec<Signature>,
) {
    let nonce = 4_242i64;
    let expiration = env.ledger().sequence() + 100;
    let xdr_args: std::vec::Vec<ScVal> = args
        .iter()
        .map(|v| ScVal::try_from_val(env, &v).unwrap())
        .collect();
    let invocation = SorobanAuthorizedInvocation {
        function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
            contract_address: contract.into(),
            function_name: fn_name.try_into().unwrap(),
            args: xdr_args.try_into().unwrap(),
        }),
        sub_invocations: xdr::VecM::default(),
    };
    let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
        network_id: xdr::Hash(env.ledger().network_id().to_array()),
        nonce,
        signature_expiration_ledger: expiration,
        invocation: invocation.clone(),
    });
    let payload: [u8; 32] = Sha256::digest(preimage.to_xdr(Limits::none()).unwrap()).into();

    let mut sigs = Vec::new(env);
    for s in sign(&payload) {
        sigs.push_back(s);
    }
    let signature = ScVal::try_from_val(env, &sigs.to_val()).unwrap();
    env.set_auths(&[SorobanAuthorizationEntry {
        credentials: SorobanCredentials::Address(SorobanAddressCredentials {
            address: wallet.into(),
            nonce,
            signature_expiration_ledger: expiration,
            signature,
        }),
        root_invocation: invocation,
    }]);
}

struct TokenSetup<'a> {
    token: TokenClient<'a>,
    recipient: Address,
}

fn fund(w: &Wallet, amount: i128) -> TokenSetup<'static> {
    let admin = Address::generate(&w.env);
    let sac = w.env.register_stellar_asset_contract_v2(admin);
    w.env.mock_all_auths();
    StellarAssetClient::new(&w.env, &sac.address()).mint(&w.address, &amount);
    w.env.set_auths(&[]);
    TokenSetup {
        token: TokenClient::new(&w.env, &sac.address()),
        recipient: Address::generate(&w.env),
    }
}

#[test]
fn end_to_end_transfer_authorised_by_a_passkey() {
    let live = LivePasskey::new();
    let w = wallet_with(|env| live.signer(env));
    let t = fund(&w, 1_000);
    let amount = 250i128;

    let args: Vec<Val> = (w.address.clone(), t.recipient.clone(), amount).into_val(&w.env);
    authorize(
        &w.env,
        &w.address,
        &t.token.address,
        "transfer",
        args,
        |p| vec![live.sign(&w.env, p)],
    );
    t.token.transfer(&w.address, &t.recipient, &amount);

    assert_eq!(t.token.balance(&w.address), 750);
    assert_eq!(t.token.balance(&t.recipient), 250);
}

#[test]
fn end_to_end_transfer_with_a_wrong_key_fails() {
    let live = LivePasskey::new();
    let impostor = LivePasskey {
        id: live.id,
        key: SigningKey::random(&mut rand_core::OsRng),
    };
    let w = wallet_with(|env| live.signer(env));
    let t = fund(&w, 1_000);

    let args: Vec<Val> = (w.address.clone(), t.recipient.clone(), 1i128).into_val(&w.env);
    authorize(
        &w.env,
        &w.address,
        &t.token.address,
        "transfer",
        args,
        |p| vec![impostor.sign(&w.env, p)],
    );
    assert!(t.token.try_transfer(&w.address, &t.recipient, &1).is_err());
    assert_eq!(t.token.balance(&w.address), 1_000);
}

#[test]
fn end_to_end_spending_limit() {
    let live = LivePasskey::new();
    let w = wallet_with(|env| live.signer(env));
    let t = fund(&w, 1_000);
    w.admin(|c| c.add_signer(&Signer::Ed25519(BytesN::from_array(&w.env, &[7; 32]))));
    w.admin(|c| c.set_spend_limit(&t.token.address, &100));

    // 50 is within the daily limit: one passkey is enough.
    let args: Vec<Val> = (w.address.clone(), t.recipient.clone(), 50i128).into_val(&w.env);
    authorize(
        &w.env,
        &w.address,
        &t.token.address,
        "transfer",
        args,
        |p| vec![live.sign(&w.env, p)],
    );
    t.token.transfer(&w.address, &t.recipient, &50);

    // 50 + 60 is above it: one passkey is no longer enough.
    let args: Vec<Val> = (w.address.clone(), t.recipient.clone(), 60i128).into_val(&w.env);
    authorize(
        &w.env,
        &w.address,
        &t.token.address,
        "transfer",
        args,
        |p| vec![live.sign(&w.env, p)],
    );
    assert!(t.token.try_transfer(&w.address, &t.recipient, &60).is_err());
    assert_eq!(t.token.balance(&t.recipient), 50);
}

#[test]
fn end_to_end_add_signer_through_check_auth() {
    let live = LivePasskey::new();
    let w = wallet_with(|env| live.signer(env));
    let new = passkey(&w.env, "passkey_b");
    let args: Vec<Val> = (new.clone(),).into_val(&w.env);
    authorize(&w.env, &w.address, &w.address, "add_signer", args, |p| {
        vec![live.sign(&w.env, p)]
    });
    w.client.add_signer(&new);
    assert!(w.client.signers().contains(&new));
}
