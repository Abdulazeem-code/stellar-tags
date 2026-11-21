# Tag Registry

The `tag_registry` Soroban contract provides on-chain tag ownership, resolution, and reverse lookup. It requires Soroban SDK 20.0.0.

## Build

From the repository root:

```sh
rustup target add wasm32-unknown-unknown
cargo build -p tag_registry --target wasm32-unknown-unknown --release
```

## Deploy to Stellar testnet

Install the Stellar CLI and configure a funded testnet identity named `alice` (for example, generate it with `stellar keys generate alice --network testnet` and fund it using the testnet Friendbot). From the repository root:

```sh
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/tag_registry.wasm --source-account alice --network testnet
```

Save the returned contract ID, then initialize the registry. The period values are ledger counts; with a five-second ledger, these examples provide roughly 30 days of registration and 7 days of grace:

```sh
stellar contract invoke --id <CONTRACT_ID> --source-account alice --network testnet -- initialize --admin <ADMIN_ADDRESS> --registration_period_ledgers 518400 --grace_period_ledgers 120960
```

Replace `<CONTRACT_ID>` and `<ADMIN_ADDRESS>` with the deployed contract ID and the admin's Stellar address. Registering and modifying tags requires the relevant owner or admin to authorize the invocation.

## Contract functions

- `initialize(admin, registration_period_ledgers, grace_period_ledgers)`: one-time setup; requires admin authorization. Registration period must be positive, and the sum of registration and grace periods must fit within the contract's supported storage TTL.
- `register(owner, tag)`: requires owner authorization. Tags must be 3 to 32 lowercase ASCII characters from `a-z`, `0-9`, `_`, and `-`. A tag can have at most one owner until its expiry and grace period have both elapsed. An owner may hold at most five tags.
- `resolve(tag) -> Option<Address>`: returns the tag owner through the grace period, or `None` for missing, invalid, reserved, or fully expired tags.
- `reverse(owner) -> Vec<String>`: returns the owner's currently held tags, including tags in their grace period, up to five.
- `transfer(tag, new_owner)`: requires current-owner authorization and transfers a held tag to the new owner. The new owner must have fewer than five other held tags.
- `renew(tag)`: requires current-owner authorization and extends the expiry by one registration period. Renewal is permitted through the grace period.
- `release(tag)`: requires current-owner authorization and immediately releases a held tag, including one in its grace period.
- `reserve(tag)`: requires admin authorization and reserves a valid, unclaimed tag.
- `unreserve(tag)`: requires admin authorization and removes an existing reservation.

Register, transfer, renew, and release publish events with the tag as the first topic. Their event data contains the owner and expiry, previous and new owners, expiry, and released owner respectively.

## Errors

Contract errors are `AlreadyInitialized`, `NotInitialized`, `InvalidTag`, `InvalidPeriod`, `AlreadyRegistered`, `Reserved`, `NotFound`, `Expired`, `OwnerTagLimit`, `AlreadyReserved`, `NotReserved`, and `ArithmeticOverflow`. Soroban authorization failures are raised by `require_auth` when the required owner or admin has not authorized the call.
