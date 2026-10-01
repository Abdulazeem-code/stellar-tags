# Private payment proofs

The `zk_payment` contract verifies a Groth16 proof before it records a private
payment. The ledger receives only two values:

- `commitment`: a fingerprint of the payment details
- `nullifier`: a one-time value that prevents the same secret from being used
  twice

The amount, recipient identifier, and secret are private circuit inputs. They
are not passed to the contract, written to storage, or included in the event.

This contract records that a payment proof was accepted. It does not move a
token by itself. A pool or settlement contract can use the accepted commitment
as its permission to release funds without adding the private inputs to its
call.

## Circuit

The circuit is implemented in `zk_payment/circuit/src/main.rs`. It uses the
BLS12-381 scalar field and has these inputs:

| Input | Visibility | Requirement |
| --- | --- | --- |
| `amount` | Private | Integer from 1 through `2^64 - 1` |
| `recipient` | Private | UTF-8 Stellar address bytes read as a big-endian integer and reduced into the field |
| `secret` | Private | Fresh random field value for this payment |
| `commitment` | Public | Must match the payment hash below |
| `nullifier` | Public | Must match the one-time hash below |

The payment hash is a MiMC7 sponge with 91 rounds. Each round uses
`(value + round_constant)^7`. Round constants are SHA-256 hashes of
`stellar-tags-zk-payment-mimc-v1` followed by the four-byte, big-endian round
number, reduced into the BLS12-381 scalar field.

The circuit checks:

```text
state_1   = MiMC7(amount + 1)
state_2   = MiMC7(state_1 + recipient)
commitment = MiMC7(state_2 + secret)
nullifier  = MiMC7(secret + 2)
```

It also constrains `amount` to 64 bits and proves that it is not zero.

The order of the public inputs is always `commitment`, then `nullifier`.
Changing the circuit, hash rules, input order, or round count requires a new
Groth16 setup and a new verification key.

## Contract use

Deploy the contract with the verification key for this exact circuit as its
constructor argument. A caller can then use:

- `verify` to check a proof without changing state
- `submit` to verify and record a commitment
- `payment_exists` to check whether a commitment was accepted
- `nullifier_used` to check whether a one-time marker was consumed

`submit` checks the proof before writing either storage entry. A failed proof
leaves both entries unchanged. A valid nullifier cannot be submitted again.

The constructor fixes the key when the contract is deployed. It cannot be
replaced later.

## Development

The contract uses Soroban SDK 27 because native BLS12-381 pairing support is
required for Groth16 verification. It is kept as an isolated workspace while
the older contracts remain on SDK 20.

Run the tests with:

```sh
cargo test --manifest-path zk_payment/Cargo.toml
```

Regenerate the test verification key and proof with:

```sh
cargo run --release --manifest-path zk_payment/circuit/Cargo.toml
```

The generator uses fixed randomness only to make the test files repeatable.
Those setup files are not safe for real funds. A production deployment must
use a securely generated setup, independent review of the circuit, and a new
verification key.
