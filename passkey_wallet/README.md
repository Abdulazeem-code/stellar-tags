# Passkey wallet

A Soroban **custom account** (contract account) controlled by WebAuthn
passkeys: Face ID, Touch ID, Android, Windows Hello or a hardware key. Users
can hold a Stellar Tag and pay with a fingerprint, with no seed phrase.

The contract verifies WebAuthn assertions on-chain with Soroban's native
secp256r1 support ([CAP-0051](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0051.md)).
It also supports ed25519 keys (useful as a recovery key), M-of-N
multisig, per-token daily spending limits, and time-delayed recovery.

This crate is standalone: it has its own `[workspace]` and is not part of the
repository's root workspace.

See [SECURITY.md](SECURITY.md) for the threat model, known limitations and
audit focus.

## Design

| Piece | Behaviour |
|---|---|
| Signers | Up to 10. Each is a **passkey** `{ id, public_key }` (credential id and uncompressed secp256r1 key, `0x04 \|\| x \|\| y`) or an **ed25519** public key. |
| Constructor | `__constructor(signer)`: the first signer must be a passkey. Threshold starts at 1. |
| Threshold | `set_threshold(n)`, `1 <= n <= signers`. |
| Admin calls | `add_signer`, `remove_signer`, `set_threshold`, `set_require_uv`, `set_spend_limit`, `remove_spend_limit` call `require_auth` on the wallet itself, so they go through `__check_auth` with the current threshold. The last signer can never be removed, and a signer cannot be removed while that would leave the threshold above the signer count. |
| `require_uv` | Off by default. When on, every passkey assertion must have the User Verified flag (biometric or PIN), not just User Present. |
| Spending limits | `set_spend_limit(token, amount)` sets a daily limit (UTC day of the ledger timestamp) in the token's base units. Within the limit the normal threshold applies. Above it, `threshold + 1` signatures are needed, or all signers if there are fewer. |
| Recovery | `start_recovery(new_passkey)` needs a single ed25519 signer (or the normal threshold). After 72 hours (`RECOVERY_DELAY_LEDGERS` = 51,840 ledgers) anyone can call `complete_recovery`, which replaces **all passkey signers** with the new passkey. ed25519 signers stay, and the threshold is lowered if it would exceed the new signer count. Until then, any single passkey can `cancel_recovery`. |
| Events | `signer_added`, `signer_removed`, `threshold_changed`, `require_uv_changed`, `limit_changed`, `recovery_started`, `recovery_cancelled`, `recovery_completed`. |

### What `__check_auth` does

`__check_auth(signature_payload, signatures: Vec<Signature>, auth_contexts)`:

1. Rejects an empty signature list.
2. For each signature, looks up the signer by credential id (passkey) or
   public key (ed25519). It rejects unknown signers and the same signer twice,
   then verifies the signature (below). Any invalid signature fails the whole
   authorization, even if enough others are valid.
3. Works out how many signers are required:
   - normally the threshold;
   - 1, if every auth context is this wallet's `start_recovery` and at least
     one ed25519 signer signed;
   - 1, if every auth context is this wallet's `cancel_recovery` and at least
     one passkey signed;
   - raised to `min(threshold + 1, signers)` if the token outflows in the auth
     contexts push today's total for a limited token above its limit. Granting
     an allowance (`approve`) on a limited token also counts.
4. Fails if fewer distinct valid signers signed than required.

Outflows counted against a limit are `transfer(from, to, amount)`,
`transfer_from(spender, from, to, amount)` and `burn(from, amount)` calls on
that token. The spend is recorded during `__check_auth`, and it rolls back with
the transaction if anything later fails.

### Passkey assertion verification

For a passkey signature the contract follows
[WebAuthn Level 3 section 7.2](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion):

1. Parses `client_data_json` (at most 1024 bytes). The top-level `type` must be
   exactly `webauthn.get`. `challenge` must be exactly the **base64url (no
   padding)** encoding of the 32-byte `signature_payload`. Key order and extra
   keys do not matter. Duplicate keys and malformed JSON are rejected.
2. `authenticator_data` must be at least 37 bytes. Its flags byte must have
   **User Present** (`0x01`), and **User Verified** (`0x04`) when
   `require_uv` is on.
3. Rejects a signature whose `s` is above n/2 (**high-S**).
4. Verifies `secp256r1_verify(public_key, sha256(authenticator_data || sha256(client_data_json)), signature)`
   with `env.crypto()`.

ed25519 signatures are verified with `env.crypto().ed25519_verify` over the
32-byte payload.

## Signature format the client sends

The signature passed to the wallet's `SorobanAddressCredentials` is an
`ScVal` encoding of `Vec<Signature>`:

```rust
enum Signature {
    Passkey(PasskeySignature),
    Ed25519(Ed25519Signature),
}

struct PasskeySignature {
    id: Bytes,                  // credential rawId
    authenticator_data: Bytes,  // response.authenticatorData
    client_data_json: Bytes,    // response.clientDataJSON, unchanged bytes
    signature: BytesN<64>,      // r || s, low-S (convert from DER)
}

struct Ed25519Signature {
    public_key: BytesN<32>,
    signature: BytesN<64>,      // ed25519 over the 32-byte payload
}
```

Browser flow for one passkey:

1. Build the transaction and simulate it to get the wallet's
   `SorobanAuthorizationEntry`.
2. Compute the payload. It is the sha256 of the XDR `HashIdPreimage::SorobanAuthorization`
   (network id, nonce, signature expiration ledger, root invocation), the same
   value that `@stellar/stellar-sdk`'s `authorizeEntry` signs.
3. Call `navigator.credentials.get({ publicKey: { challenge: payload,
   allowCredentials: [{ id, type: 'public-key' }], userVerification:
   'preferred' } })`. The browser base64url-encodes the challenge into
   `clientDataJSON` itself.
4. The browser returns the signature DER-encoded. Convert it to 64 bytes
   `r || s`, then if `s > n/2` replace it with `n - s`.
5. Put `vec![Signature::Passkey(..)]` in the entry's `signature`, then
   submit.

Registering: `navigator.credentials.create` with `pubKeyCredParams:
[{ type: 'public-key', alg: -7 }]` (ES256). Store `rawId` as `id`. Store the
public key from `response.getPublicKey()` as uncompressed SEC-1: the last 65
bytes of the SPKI encoding.

## Building and testing

```bash
cd passkey_wallet
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo build --target wasm32v1-none --release
```

soroban-sdk 27 refuses to build for `wasm32-unknown-unknown` with Rust 1.82
or later, because that target turns on wasm features the Soroban VM does not
support. It requires `wasm32v1-none` (`rustup target add wasm32v1-none`),
which is also what `stellar contract build` uses. The release build is about
46 KB.

### Test vectors

`tests/fixtures/webauthn_vectors.json` holds real WebAuthn assertions:

- three P-256 passkeys signing a fixed payload (UP+UV);
- variants with User Present only, User Verified only, `type` set to
  `webauthn.create`, a challenge for a different payload, and reordered
  client data keys;
- two ed25519 keys signing the same payload.

Only public keys and signatures are stored. To regenerate them:

```bash
node passkey_wallet/scripts/generate-webauthn-vectors.js
```

The script uses only Node's built-in `crypto` (Node 16+). It creates new keys
on every run and checks every vector with an independent verifier before
writing the file. Tampered vectors (flipped authenticator data, edited
client data, high-S) are derived from these in the tests.

The end-to-end tests generate a passkey key at run time. They sign the real
Soroban authorization payload for a token `transfer` (and an `add_signer`),
and let the host call `__check_auth` through `require_auth`.

## Deploying to testnet

You need the [`stellar` CLI](https://developers.stellar.org/docs/tools/cli)
and a funded deployer identity:

```bash
stellar keys generate deployer --network testnet --fund

cd passkey_wallet
stellar contract build    # writes target/wasm32v1-none/release/passkey_wallet.wasm
```

Deploy with the first passkey. `id` is the credential rawId and `public_key`
the uncompressed P-256 key, both hex:

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/passkey_wallet.wasm \
  --source deployer --network testnet \
  -- \
  --signer '{"Passkey":{"id":"<credential-id-hex>","public_key":"04<x-hex><y-hex>"}}'
```

The command prints the wallet's contract address (`C...`). Fund it by sending
XLM or any token to that address. To spend, the client builds a transaction
invoking, for example, the native asset contract's `transfer` with the wallet
as `from`, then signs the wallet's auth entry with the passkey as described
above.

Read the state at any time:

```bash
stellar contract invoke --id <wallet-C-address> --network testnet --source deployer -- signers
stellar contract invoke --id <wallet-C-address> --network testnet --source deployer -- threshold
```

Admin calls such as `add_signer` need the wallet's own authorization, so they
must be signed with the passkey through the same flow, not with `--source`.
