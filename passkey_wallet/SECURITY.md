# Security notes

This contract has **not been audited**. Do not hold significant value in it
until it has been.

## Threat model

### Protected against

- **Forged or replayed assertions.** Every passkey signature must:
  - sign `sha256(authenticatorData || sha256(clientDataJSON))`;
  - carry a challenge equal to base64url of this exact Soroban payload.

  The payload covers the network, the nonce, the signature expiration ledger
  and the full invocation tree. An assertion for one transaction cannot be
  reused for another, or on another network.
- **Registration responses used as assertions.** `type` must be exactly
  `webauthn.get`.
- **Signatures made without the user.** User Present is always required.
  User Verified (biometric or PIN) is required when `require_uv` is on.
- **Signature malleability.** High-S signatures are rejected, both by the
  contract and by the host.
- **Client data tricks.** These are rejected: duplicate top-level keys (a
  second `challenge`), keys hidden inside strings or nested objects,
  malformed JSON, and input over 1024 bytes.
- **Threshold bypass.** Distinct signers are counted by credential id or
  public key. The same signer twice is rejected, and so are unknown signers.
  One invalid signature fails the whole authorization.
- **Locking the wallet by mistake.** The last signer cannot be removed. The
  threshold can never exceed the signer count. Recovery is limited to
  replacing passkeys.
- **A stolen recovery key.** It can only start recovery. Any passkey holder
  then has 72 hours to cancel it, and the recovery key alone cannot cancel,
  add signers, or bundle other calls with `start_recovery`.
- **Large outflows from a single compromised passkey,** for tokens with a
  daily limit. Above the limit, one more signature than the threshold is
  needed. Granting an allowance on a limited token always needs that higher
  bar.

### Not protected against

- **Origin and RP ID binding.** The contract does not check `origin` in
  client data, or the `rpIdHash` in authenticator data. Binding a passkey to
  a site is done by the browser at signing time. If one passkey is
  registered with several wallets or sites, any of them can ask it to sign.
  A future version could store the expected `rpIdHash` per signer.
- **Sign counter.** The authenticator's signature counter is ignored. Synced
  passkeys (iCloud, Google) always report 0, so it cannot detect cloned
  authenticators for them anyway.
- **Compromised devices or accounts.** Anyone who controls an unlocked
  device, or the cloud account a synced passkey lives in, can sign.
- **Threshold-wide compromise.** If enough signers to meet the threshold are
  compromised, they can do anything, including removing the other signers.
- **Outflows the limit does not see.** Only `transfer`, `transfer_from`,
  `burn` and `approve` calls on a limited token are counted. A token with
  other ways to move funds, or a call through another contract that the
  wallet authorizes, is not limited. Tokens without a limit are not limited
  at all.
- **Day boundaries.** Limits reset at the UTC day boundary of the ledger
  timestamp, so close to midnight up to twice the limit can be spent within
  a short window.
- **Recovery when every passkey holder is unavailable.** If the recovery key
  is stolen and no passkey holder cancels within 72 hours, recovery
  completes and the attacker's passkey replaces the user's passkeys.
- **Storage expiry.** Wallet state lives in instance storage, which is
  extended on every write and every successful `__check_auth`. A wallet
  unused for a long time can still expire and need restoring.

## Known limitations

- The client data parser is a small strict scanner, not a general JSON
  parser. It compares `type` and `challenge` byte for byte, so values with
  JSON escapes never match, even if they would decode to the right string.
  No browser emits escapes in these fields.
- `secp256r1_verify` and `ed25519_verify` trap on an invalid signature
  instead of returning an error code. Clients see a host error, not
  `Error::*`.
- Credential ids are limited to 1023 bytes, and `clientDataJSON` to 1024
  bytes.
- The contract is built for `wasm32v1-none`, not `wasm32-unknown-unknown`;
  see the README.

## Suggested audit focus

1. `webauthn::parse_client_data`: any input where the `type` or `challenge`
   it returns is not the one a spec-compliant JSON parser would see.
2. `verify_passkey`: the order of checks, the exact bytes hashed, and that
   every failure path returns an error.
3. The threshold rules in `__check_auth`, especially the recovery shortcuts:
   can a single signer reach any call other than `start_recovery` or
   `cancel_recovery` through them?
4. `apply_spending_limits`: argument positions for `transfer`,
   `transfer_from`, `burn` and `approve`, overflow handling, negative
   amounts, and how several contexts in one authorization add up.
5. `complete_recovery`: the resulting signer set and threshold in every
   starting configuration.
6. Storage TTL handling and the behaviour after instance storage is
   restored.
