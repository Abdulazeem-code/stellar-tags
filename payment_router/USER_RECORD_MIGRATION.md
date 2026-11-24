# User record migration

`migrate_user_record(user)` is a permissionless Soroban entrypoint for converting the router's legacy per-user statistics into the packed `DataKey::UserRecord` storage entry.

## Stored fields

The legacy format uses `UserSpending(user)` (`BytesN<24>`, containing `last_reset_time` and `accumulated_amount`) and `UserVolume(user)` (`i128`, cumulative lifetime volume). The packed format is `BytesN<40>` containing those same three values: an 8-byte timestamp followed by two 16-byte signed amounts. The public `UserRecord` return type exposes `accumulated_amount`, `volume`, and `last_reset_time`.

The legacy volume already includes amounts routed during the current window, so migration copies it directly rather than adding the spending amount. If just one legacy entry exists, the missing field defaults to zero; a missing spending entry uses the current ledger timestamp as the window start.

## Behavior

- Successful calls write and TTL-extend the packed record, remove both legacy entries, publish `user_record_migrated`, and return `Ok(())`.
- The event topics are `(user_record_migrated, user)` and its data is the migrated lifetime volume.
- A user who already has `UserRecord` returns `UserRecordAlreadyMigrated` (48), even if stale legacy keys remain.
- A user with neither legacy entry returns `LegacyUserRecordNotFound` (49).
- The migration is permissionless and does not change token balances or payment settings. Failed calls do not partially migrate storage.

The operation performs a fixed number of storage reads/writes and handles only the two legacy entries; it does not iterate over users or records.
