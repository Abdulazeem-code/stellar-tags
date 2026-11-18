# Research spike: ZK-SNARKs for anonymous tag routing

Status: research spike for [issue #668](https://github.com/Abdulazeem-code/stellar-tags/issues/668).
Scope: study how a payment could be routed to a tag without revealing the source
account on the public ledger, and validate the primitive with the existing
`zk_payment` proof of concept.

Companion documents:

- [docs/zk-private-payments.md](zk-private-payments.md) — usage guide for the
  `zk_payment` contract and circuit.
- [zk_payment/README.md](../zk_payment/README.md) — crate overview.

> This is a research document. Nothing here is production-ready cryptography.
> See [Security assumptions and limitations](#7-security-assumptions-and-limitations).

## 1. Problem statement

Stellar Tags lets a payer send funds to a human-readable tag. On a public ledger
the transaction is fully linkable: the transaction source account (the fee
payer), the destination account, and the amount are all visible. A privacy
conscious user wants to pay a tag *without* the ledger revealing which source
account funded the payment.

The acceptance criteria for issue #668 are a research spike document plus a
proof-of-concept contract that demonstrates anonymous routing. The PoC
(`zk_payment/`) already existed at the base of this branch and is retained; this
document is the research spike, and this branch adds focused tests around the
PoC's failure paths.

### The primitive the PoC proves

The circuit in `zk_payment/circuit/src/main.rs` (`PaymentCircuit`) takes private
witnesses `amount`, `recipient`, `secret` and public inputs `commitment`,
`nullifier`, and proves:

```text
commitment = MiMC7(MiMC7(MiMC7(amount + 1) + recipient) + secret)
nullifier  = MiMC7(secret + 2)
amount     ∈ [1, 2^64)
```

The contract `ZkPayment` (`zk_payment/src/lib.rs`) verifies that proof with
Groth16 over BLS12-381 and, on success, records the `commitment` and the
`nullifier`. It never receives `amount`, `recipient`, or `secret`. Double spends
are blocked because `nullifier` is one-time and checked before state is written
(`ZkPayment::submit`).

What this gives: proof that the caller knows a payment whose commitment is the
public value, without revealing the payment details, and a one-time marker that
prevents replay. What it does **not** give (on its own): delivery of funds, a
destination mapping, or sender/receiver unlinkability across the whole system.
Those are integration questions, discussed in
[Integration with tag routing](#6-integration-with-tag-routing).

## 2. Threat model

### Actors

- **Ledger observer** — anyone reading the public chain, history, and events.
- **Other users** — can submit their own proofs and probe contract state.
- **Settlement/router operator** — the party that releases funds once a proof is
  accepted. Non-goal: hiding payment details from an operator that is trusted to
  settle (see non-goals).
- **Payer** — holds `amount`, `recipient`, `secret`; produces the proof.
- **Recipient** — the tag owner who should receive value.

### Privacy goals

1. The on-chain record of an accepted payment must not reveal the payer's
   account, the amount, or the recipient identity.
2. The same payment intent must not be replayable (one normalized payment per
   `secret`).
3. Verification must not require the private inputs to touch the ledger, storage,
   or events.

### Non-goals

- **Hiding that a payment happened.** The existence and timing of a submission
  are public; the `PaymentVerified` event (`zk_payment/src/lib.rs`) is emitted on
  every accepted proof.
- **Hiding the fee payer.** On Stellar the transaction source account pays the
  fee and is visible. The circuit does not bind `recipient`/`amount` to the
  transaction signer, so the *logical* payer is hidden, but the *transaction*
  submitter is not unless a relayer is used. This is the single biggest caveat.
- **Network-level anonymity.** IP addresses, RPC providers, and submission
  patterns are out of scope.
- **Hiding low-entropy data by itself.** The commitment binds a random `secret`,
  so it is computationally hiding, but any layer that publishes a mapping from
  commitment to recipient defeats the privacy goal.
- **Production soundness.** The checked-in setup is insecure by construction
  (see trusted setup below).

### Threat: forged proofs from the test setup

The circuit generator (`zk_payment/circuit/src/main.rs::main`) derives Groth16
parameters from a fixed RNG seed (`ChaCha20Rng::from_seed([7u8; 32])`). Anyone
who reads the repo knows the toxic waste, so they can mint proofs for arbitrary
public inputs. This is fine for reproducible test fixtures and fatal for real
funds. A production deployment needs a multi-party trusted setup (or a universal
setup with a different proof system), an audited circuit, and a verification key
that no single party could have back-doored.

## 3. Design space

### 3.1 Proof system

| Option | Proof size | Verify cost | Setup | Verdict |
| --- | --- | --- | --- | --- |
| **Groth16** | Smallest (3 group elements) | Cheapest (constant pairings) | Per-circuit trusted setup | Chosen for the PoC |
| PLONK / Halo2 | Larger | Higher | Universal / transparent | Rejected for this spike |
| STARKs | Much larger | Much higher | Transparent | Rejected for on-chain cost |
| Bulletproofs | Logarithmic | Higher | None for range proofs | Rejected (general circuits verify expensively) |

Groth16 has the smallest proof and the cheapest constant-time verification,
which matters because Soroban meters CPU and memory. The cost is a per-circuit
trusted setup, which is acceptable for a spike but is the main operational
burden for production.

### 3.2 Curve and on-chain availability

Soroban SDK 27 exposes native BLS12-381 group operations through
`Env::crypto().bls12_381()`: `g1_add`, `g1_mul`, and `pairing_check`
(`zk_payment/src/lib.rs::ZkPayment::verify_proof`). BN254 is also available on
current hosts, but BLS12-381 was chosen because:

- It is a 128-bit-security curve, versus roughly 100-bit for BN254.
- The circuit is written against `ark-bls12-381` (`zk_payment/circuit/src/main.rs`),
  so the on-chain verifier and the off-chain prover share one field and one
  serialization format with no curve translation.

No custom host function or bespoke pairing implementation is required; the PoC
relies entirely on the SDK's audited crypto primitives.

### 3.3 Commitments and nullifiers

- **Commitment** binds `amount`, `recipient`, and a fresh random `secret`. It is
  the public "ticket" for a payment.
- **Nullifier** is derived from `secret` only (`MiMC7(secret + 2)`). It is
  published once and stored; a replay with the same `secret` produces the same
  nullifier and is rejected before verification state is written.

This is the standard commitment/nullifier pattern used by shielded pools. The
PoC stores the nullifier and the commitment in persistent storage with TTL
extended to the maximum (`ZkPayment::submit`), so double-spend protection lives
as long as the entry is live. A production system needs a policy for nullifier
expiry/archival, since losing nullifier state would allow a replay.

### 3.4 Hash function: MiMC7 versus Poseidon

| Property | MiMC7 (chosen) | Poseidon |
| --- | --- | --- |
| R1CS cost | Low, simple `x^7` rounds | Higher per permutation, but fewer rounds |
| Multiplicative depth | Deep (91 rounds) | Shallow |
| Audit maturity | Older, well studied | Modern, widely used in ZK apps |
| Constant generation | `SHA-256` domain-separated per round | Requires parameter generation |

The PoC uses MiMC7 because it is trivial to implement correctly and keeps the
circuit reviewable. Each round is `(value + c_i)^7`, computed as three squarings
and one multiplication (`permute_var`), which is cheap in R1CS at the cost of a
deep circuit (91 rounds). For production, Poseidon is the more common choice:
fewer constraints at the same security level and far more ecosystem tooling.
Switching hash, round count, or input order requires a **new trusted setup and
a new verification key**, because the R1CS changes
(`zk_payment/src/lib.rs::ZkPayment::verify_proof`,
`zk_payment/circuit/src/main.rs::PaymentCircuit::generate_constraints`).

### 3.5 On-chain versus off-chain proving

Proving is done off-chain by the Rust circuit binary using `ark-groth16`; only
verification runs on-chain. This is not optional: Groth16 proving performs large
multi-exponentiations that are impractical within Soroban's resource limits,
while verification is small and constant. The design therefore splits cleanly into an
off-chain prover (the payer's machine) and an on-chain verifier (the contract).

## 4. Chosen approach

The PoC keeps the smallest possible on-chain surface:

1. A `ZkPayment` contract that verifies a Groth16/BLS12-381 proof against a
   verification key fixed at construction (`ZkPayment::__constructor`), and
   rejects keys whose `ic` length is not 3 (`Error::MalformedVerifyingKey`).
2. A commitment and nullifier as the only public inputs, so the amount,
   recipient, and secret never reach the contract.
3. State changes only after a successful verification: `submit` returns
   `Error::InvalidProof` and writes nothing on failure, and rejects a reused
   nullifier with `Error::NullifierUsed`.
4. Verification is exposed separately as a read-only `verify`, so integrators
   can check a proof without mutating state.

The verification equation is the standard Groth16 check rewritten as a single
`pairing_check` over `[-A, alpha, vk_x, C]` and `[B, beta, gamma, delta]`, where
`vk_x = ic[0] + ic[1]·commitment + ic[2]·nullifier`
(`ZkPayment::verify_proof`). The public input order is fixed: commitment, then
nullifier.

## 5. Alternatives considered and rejected

- **Signed payments without ZK.** A normal signed transaction already proves
  authorization, but the signature (or the transaction source) reveals the
  payer. Rejected: it does not meet the privacy goal.
- **BN254 + Groth16.** Viable on Soroban and slightly cheaper to verify, but a
  lower security margin and an extra curve-translation step from the circuit's
  BLS12-381 field. Rejected for this spike.
- **PLONK/Halo2 with a universal or transparent setup.** Removes the per-circuit
  trusted setup, but larger proofs and heavier verification. Rejected to keep
  the PoC's gas and code size small.
- **On-chain proving.** Infeasible within Soroban resource limits. Rejected.
- **Pedersen commitments for hidden amounts.** Would enable homomorphic balance
  checks, but needs additional setup and does not replace the nullifier for
  replay protection. Deferred.
- **Poseidon instead of MiMC7.** Better production choice, but more moving parts
  in a spike. Deferred (see 3.4).

## 6. Integration with tag routing

The PoC is deliberately a standalone crate (`zk_payment/` has its own
`[workspace]` and is not a member of the root workspace). It is a verification
primitive, not a full router. A realistic integration looks like this:

1. **Resolution (off-chain).** The payer resolves the tag to the recipient's
   address/key material and chooses a fresh random `secret`.
2. **Proving (off-chain, payer).** The payer runs the circuit binary to compute
   `commitment` and `nullifier` and to produce the Groth16 proof from
   `amount`, `recipient`, `secret`.
3. **Submission (on-chain).** The payer submits a transaction that calls
   `ZkPayment::submit(proof, commitment, nullifier)`. To achieve sender
   anonymity the transaction should be relayed by a third party (a relayer or a
   fee-bump service) so the payer's account is not the transaction source.
   Without a relayer, the source account is public and "anonymous" only means
   the circuit does not bind the logical payer.
4. **Settlement (on-chain).** A pool or router contract treats an accepted
   `commitment` as authorization to release funds. It can query
   `ZkPayment::payment_exists(commitment)` and `ZkPayment::nullifier_used(nullifier)`.
   The recipient's identity must be delivered out of band (for example an
   encrypted note the recipient can open), otherwise the settlement layer itself
   becomes the link between commitment and recipient.
5. **Double-spend check.** The router should verify a nullifier is unused before
   releasing value; the contract already guarantees this on `submit`.

**Who holds the secret.** In this model the payer holds `amount`, `recipient`,
and `secret`; the nullifier is public and the secret is never revealed. In a
note-based shielded-pool design the recipient would instead hold the secret and
redeem the note. Both fit the same contract, which only ever sees the
commitment and nullifier.

The current `payment_router` contract is not wired to `zk_payment`; doing so is
follow-up work, not part of this spike.

## 7. Security assumptions and limitations

- **Trusted setup / toxic waste.** The test verifier key is generated from a
  fixed seed (`zk_payment/circuit/src/main.rs::main`). It is insecure for real
  value and must be replaced with a real multi-party setup before any production
  use. The verification key is fixed at deploy time and cannot be rotated
  (`ZkPayment::__constructor`); a circuit change forces a redeploy.
- **No amount hiding beyond the commitment.** The amount is hidden only because
  a random `secret` is folded into the commitment. If the secret is reused or
  predictable, or if the settlement layer publishes the commitment→recipient
  mapping, privacy is lost.
- **Linkability caveats.** The `PaymentVerified` event publishes `commitment`
  and `nullifier` and the submission timestamp is public, so observers can count
  payments and correlate timing. The transaction source account is public unless
  a relayer is used.
- **Nullifier lifetime.** Double-spend protection depends on persistent storage
  retaining the nullifier for as long as the commitment is meaningful. The PoC
  extends TTL to the maximum, but archival policy is an operational decision.
- **Verification cost.** On-chain verification uses a BLS12-381
  `pairing_check` (four pairings), two G1 scalar multiplications, two G1
  additions, plus the `verify`/`submit` storage reads. Pairings dominate the gas
  and must be benchmarked on the target network; this spike does not include a
  resource benchmark.
- **No production audit.** The circuit, the verification equation, and the
  contract have not been independently reviewed.
- **Recipient binding is off-circuit.** The contract cannot tell *which* tag a
  commitment is for; that binding lives in the encrypted note or the settlement
  layer.

## 8. Building and testing the PoC

The crate is standalone. Run everything from inside `zk_payment/`:

```sh
cd zk_payment
cargo test
```

Optional Wasm build. Soroban SDK 27 rejects `wasm32-unknown-unknown` on Rust
1.82+ and requires the `wasm32v1-none` target instead:

```sh
cd zk_payment
cargo build --target wasm32v1-none --release
```

Regenerate the test verification key and proof fixtures (insecure, test only):

```sh
cargo run --release --manifest-path zk_payment/circuit/Cargo.toml
```

The fixtures consumed by the tests live in `zk_payment/tests/fixtures/`
(`proof.bin`, `public_inputs.bin`, `verification_key.bin`). The test module
(`zk_payment/src/lib.rs::test`) decodes the key, proof, and public inputs and
exercises the verification, state-write, and replay paths.
