# Timelock Escrow Smart Contract

This Soroban smart contract provides a secure, robust escrow mechanism with timelocking capabilities. It was implemented to resolve Backend/Contract Hard Issue #35.

## Architecture & Features

The `timelock_escrow` contract allows a depositor to lock tokens for a recipient until a specified `release_time`. 
- **Scale:** Utilizes Soroban's persistent storage to securely handle thousands of escrows without high memory overhead.
- **Security:** Requires robust authentication (`depositor.require_auth()`) for creating an escrow. Enforces strict timestamp checks using ledger time.
- **Testing:** 100% test coverage including successful lifecycles and all failing edge cases (early claims, double claims, zero amounts).

## Methods

- `deposit(env, depositor, recipient, token, amount, release_time) -> u64`: Locks `amount` of `token` for `recipient` until `release_time`.
- `claim(env, id)`: Releases the escrowed funds to the `recipient` if the `release_time` has passed.

## Usage

Build and run tests using:
```sh
cargo test --package timelock_escrow
```
