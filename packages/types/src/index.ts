import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}
/**
 * Known deployments of the payment_router contract. The WASM-based generator
 * cannot emit these (it has no network context), so scripts/generate-bindings.sh
 * injects them after generation.
 */
export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CDNQ7OMHIFOLZHOKWQLOGDW7CF3DRMKXJC6OULNGNBWF4O4NO2NEIGER",
  },
} as const;






/**
 * A single transfer instruction for use with [`PaymentRouter::route_payments`].
 */
export interface Payment {
  /**
 * Amount to route, denominated in the token's smallest unit. Must be
 * positive and within the contract's configured min/max bounds.
 */
amount: i128;
  /**
 * Address the funds (minus the platform fee) are credited to.
 */
recipient: string;
  /**
 * Address the funds are debited from. Must authorize the call.
 */
sender: string;
  /**
 * Contract ID of the token (or Stellar Asset Contract) being transferred.
 */
token_address: string;
}


/**
 * A single price quote returned by the oracle.
 */
export interface PriceData {
  /**
 * Number of decimal places used in `price`.
 */
decimals: u32;
  /**
 * Fixed-point price value. The true price is `price / 10^decimals`.
 */
price: i128;
  /**
 * Unix timestamp (seconds) when this price was last updated on-chain.
 */
timestamp: u64;
}


/**
 * The result of a DEX quote, returned by [`PaymentRouter::quote_swap`].
 */
export interface SwapQuote {
  /**
 * Amount of `buy_token` the DEX expects to deliver for the quoted input.
 */
amount_out: i128;
  /**
 * Configured maximum slippage, in basis points, that produced
 * `min_amount_out`.
 */
max_slippage_bps: i128;
  /**
 * Tightest `min_amount_out` that still respects the contract's
 * `max_slippage_bps` for this quote.
 */
min_amount_out: i128;
}

/**
 * Describes which administrative parameter change a timelock entry represents.
 * Each variant carries all the arguments needed to apply that change when the
 * delay period is over.
 */
export type ActionType = {tag: "SetPlatformTreasury", values: readonly [string]} | {tag: "SetFeeConfig", values: readonly [i128, i128]} | {tag: "SetFeeBps", values: readonly [i128]} | {tag: "SetGovernance", values: readonly [string]} | {tag: "SetMinLimit", values: readonly [i128]} | {tag: "TransferAdmin", values: readonly [string]} | {tag: "Upgrade", values: readonly [Buffer]} | {tag: "SetBackupAdmin", values: readonly [string, u64]} | {tag: "RegisterDex", values: readonly [string]} | {tag: "DeregisterDex", values: readonly [string]} | {tag: "SetMaxSlippageBps", values: readonly [i128]} | {tag: "SetMultisigConfig", values: readonly [Array<string>, u32]};


/**
 * A user's combined routing stats, unpacked from the packed `BytesN<40>`
 * `UserRecord` ledger value (issue #663).
 *
 * Returned by [`PaymentRouter::get_user_record`] so a client can read both
 * counters in a single view call instead of two.
 */
export interface UserRecord {
  /**
 * Total amount routed by the user in the current 24-hour window.
 */
accumulated_amount: i128;
  /**
 * Unix timestamp (seconds) at which the 24-hour window last reset.
 */
last_reset_time: u64;
  /**
 * Cumulative lifetime amount routed by the user.
 */
volume: i128;
}


/**
 * A fee change proposal weighted by governance-token balances.
 */
export interface FeeProposal {
  created_at: u64;
  executed: boolean;
  fee_bps: i128;
  fee_cap: i128;
  no_votes: i128;
  proposer: string;
  quorum: i128;
  voting_ends_at: u64;
  yes_votes: i128;
}


/**
 * Structured payload for meta-transactions.
 */
export interface MetaPayment {
  amount: i128;
  deadline: u64;
  nonce: u64;
  recipient: string;
  sender: string;
  token_address: string;
}


/**
 * A single swap-routed transfer instruction for use with
 * [`PaymentRouter::route_payment_with_swap`] and
 * [`PaymentRouter::route_payments_with_swap`].
 */
export interface SwapPayment {
  /**
 * Amount of `sell_token` to pull from the sender and swap.
 */
amount_in: i128;
  /**
 * Token the recipient is paid in. Must differ from `sell_token`.
 */
buy_token: string;
  /**
 * Unix timestamp (seconds) after which the swap must not execute. `0`
 * disables the deadline, letting the DEX apply its own.
 */
deadline: u64;
  /**
 * Contract ID of the DEX adapter to invoke. Must be registered by the
 * admin, which keeps the cross-contract call pointed at audited code.
 */
dex: string;
  /**
 * Amount of `buy_token` the caller expected from a prior `quote_swap`
 * call. `0` disables the ceiling check; otherwise the realised output
 * must stay within the contract's `max_slippage_bps` of this figure.
 */
expected_amount_out: i128;
  /**
 * Minimum amount of `buy_token` the swap must deliver. This is the
 * slippage floor: if the DEX returns less, the whole payment reverts.
 */
min_amount_out: i128;
  /**
 * Address the swapped funds (minus the platform fee) are credited to.
 */
recipient: string;
  /**
 * Token the sender pays with, in that token's smallest unit.
 */
sell_token: string;
  /**
 * Address the funds are debited from. Must authorize the call.
 */
sender: string;
}


/**
 * A user's rolling 24-hour spending record.
 *
 * Retained purely so existing test snapshots that reference this type by
 * name keep compiling. Pre-#663 live contract state was stored as a packed
 * `BytesN<24>`; this struct is not read from or written to storage at runtime.
 */
export interface UserSpending {
  /**
 * Total amount routed by the user since `last_reset_time`.
 */
accumulated_amount: i128;
  /**
 * Unix timestamp (seconds) at which the 24-hour window last reset.
 */
last_reset_time: u64;
}


/**
 * A pending timelock entry stored in persistent ledger storage.
 */
export interface TimelockEntry {
  /**
 * The action payload to apply once the delay has elapsed.
 */
action: ActionType;
  /**
 * Ledger timestamp (seconds since epoch) when this action was queued.
 */
queued_at: u64;
}


/**
 * Multi-signature configuration for contract upgrades.
 */
export interface MultisigConfig {
  /**
 * The list of authorized signers.
 */
signers: Array<string>;
  /**
 * The minimum number of signers required to approve an upgrade.
 */
threshold: u32;
}

/**
 * Contract-level errors returned instead of panicking, so callers get a
 * specific, stable error code to branch on rather than an opaque trap.
 */
export const Errors = {
  /**
   * Caller is not authorized to perform this action (e.g. not the admin).
   */
  1: {message:"Unauthorized"},
  /**
   * Sender's token balance is lower than the requested payment amount.
   */
  2: {message:"InsufficientBalance"},
  /**
   * Requested amount is outside allowed bounds, or a spending limit was exceeded.
   */
  3: {message:"LimitExceeded"},
  /**
   * `initialize` was called on a contract that already has an admin set.
   */
  4: {message:"AlreadyInitialized"},
  /**
   * An admin-configured value (treasury, fee, admin) was read before `initialize`.
   */
  5: {message:"NotInitialized"},
  /**
   * The contract is currently paused; routing calls are rejected until unpaused.
   */
  6: {message:"Paused"},
  /**
   * A fee configuration value (basis points or cap) is out of the allowed range.
   */
  7: {message:"InvalidFeeRate"},
  /**
   * Sender and recipient addresses are the same (self-routing not allowed).
   */
  8: {message:"InvalidRecipient"},
  /**
   * Recipient address is blacklisted.
   */
  9: {message:"Blacklisted"},
  /**
   * Requested refund withdrawal amount is zero or exceeds available refund balance.
   */
  10: {message:"NoRefundAvailable"},
  /**
   * An action is already pending in the timelock queue; it must be executed
   * or cancelled before a duplicate can be queued (not currently enforced,
   * but reserved for future deduplication logic).
   */
  11: {message:"TimelockPending"},
  /**
   * The 24-hour delay for the given timelock entry has not elapsed yet.
   */
  12: {message:"TimelockNotReady"},
  /**
   * No timelock entry exists for the supplied nonce ID.
   */
  13: {message:"TimelockNotFound"},
  /**
   * The contract is frozen; all payments and timelock executions are blocked.
   */
  14: {message:"ContractFrozen"},
  /**
   * No prepared cross-contract upgrade manifest exists for the supplied
   * upgrade ID (it was never prepared, or it was already committed).
   */
  15: {message:"UpgradeManifestNotFound"},
  /**
   * The upgrade manifest is malformed: no target contracts, a different
   * number of code hashes than addresses, or a duplicated target.
   */
  16: {message:"InvalidUpgradeManifest"},
  /**
   * A manifest for this upgrade ID is already prepared; commit or wait for
   * its execution window to lapse before preparing it again.
   */
  17: {message:"UpgradeAlreadyPrepared"},
  /**
   * The 48-hour cross-contract timelock delay has not elapsed yet.
   */
  18: {message:"UpgradeNotReady"},
  /**
   * The execution deadline of the prepared upgrade has passed; the upgrade
   * must be prepared again.
   */
  19: {message:"UpgradeManifestExpired"},
  /**
   * A participating contract rejected the manifest during the atomic
   * commit. The entire invocation was rolled back, so no contract was
   * upgraded: the protocol is still fully on its previous version.
   */
  20: {message:"UpgradeCommitFailed"},
  /**
   * A participating contract rejected the manifest during preparation. The
   * entire invocation was rolled back, so no contract was registered.
   */
  21: {message:"UpgradePrepareFailed"}
}

/**
 * Storage keys for all contract instance and persistent data.
 */
export type DataKey = {tag: "Admin", values: void} | {tag: "Governance", values: void} | {tag: "PlatformTreasury", values: void} | {tag: "FeeBps", values: void} | {tag: "FeeCap", values: void} | {tag: "MinLimit", values: void} | {tag: "Paused", values: void} | {tag: "MaxAmount", values: void} | {tag: "UserVolume", values: readonly [string]} | {tag: "UserSpending", values: readonly [string]} | {tag: "Blacklist", values: readonly [string]} | {tag: "RefundBalance", values: readonly [string, string]} | {tag: "TimelockNonce", values: void} | {tag: "TimelockEntry", values: readonly [u64]} | {tag: "Frozen", values: void} | {tag: "TwoPhaseCommit", values: readonly [Buffer]};


/**
 * A single transfer instruction for use with [`PaymentRouter::route_payments`].
 */
export interface Payment {
  /**
 * Amount to route, denominated in the token's smallest unit. Must be
 * positive and within the contract's configured min/max bounds.
 */
amount: i128;
  /**
 * Address the funds (minus the platform fee) are credited to.
 */
recipient: string;
  /**
 * Address the funds are debited from. Must authorize the call.
 */
sender: string;
  /**
 * Contract ID of the token (or Stellar Asset Contract) being transferred.
 */
token_address: string;
}

/**
 * Describes which administrative parameter change a timelock entry represents.
 * Each variant carries all the arguments needed to apply that change when the
 * delay period is over.
 */
export type ActionType = {tag: "SetPlatformTreasury", values: readonly [string]} | {tag: "SetFeeConfig", values: readonly [i128, i128]} | {tag: "SetFeeBps", values: readonly [i128]} | {tag: "SetGovernance", values: readonly [string]} | {tag: "SetMinLimit", values: readonly [i128]} | {tag: "TransferAdmin", values: readonly [string]} | {tag: "Upgrade", values: readonly [Buffer]};


/**
 * A user's rolling 24-hour spending record.
 * 
 * Retained purely so existing test snapshots that reference this type by
 * name keep compiling. Live contract state is stored as a packed
 * `BytesN<24>` (see `pack_spending` / `unpack_spending`); this struct is not
 * read from or written to storage at runtime.
 */
export interface UserSpending {
  /**
 * Total amount routed by the user since `last_reset_time`.
 */
accumulated_amount: i128;
  /**
 * Unix timestamp (seconds) at which the 24-hour window last reset.
 */
last_reset_time: u64;
}


/**
 * A pending timelock entry stored in persistent ledger storage.
 */
export interface TimelockEntry {
  /**
 * The action payload to apply once the delay has elapsed.
 */
action: ActionType;
  /**
 * Ledger timestamp (seconds since epoch) when this action was queued.
 */
queued_at: u64;
}


/**
 * A prepared cross-contract upgrade waiting for its 48-hour timelock to
 * elapse.  Stored under [`DataKey::TwoPhaseCommit`] keyed by `upgrade_id`.
 */
export interface TwoPhaseCommit {
  /**
 * The code hash each contract at the same index must be upgraded to.
 */
code_hashes: Array<Buffer>;
  /**
 * Every participating contract, in a deterministic order.
 */
contract_addresses: Array<string>;
  /**
 * Ledger timestamp after which the prepared upgrade may no longer be
 * committed and must be re-prepared.
 */
execution_deadline: u64;
  /**
 * Ledger timestamp (seconds) at which Phase 1 registered the manifests.
 * One timestamp is shared by every target, so the 48-hour delay is
 * synchronized across the whole set.
 */
prepared_at: u64;
  /**
 * Unique identifier of the upgrade; also the storage key of the manifest.
 */
upgrade_id: Buffer;
}

export interface Client {
  /**
   * Construct and simulate a ping transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Routes a payment from a sender to a recipient, deducting a platform fee.
   *
   * # Parameters
   * - `sender`: Address the funds are debited from; must authorize the call.
   * - `recipient`: Address to receive the funds (minus the platform fee).
   * - `token_address`: Contract ID of the token being transferred.
   * - `amount`: Amount to route, in the token's smallest unit. Must be
   * positive and within the configured min/max and daily-limit bounds.
   *
   * This is the primary way for the admin to reset the timer without
   * changing any contract state. Routing a payment also bumps the
   * heartbeat automatically. A no-op when no backup admin is configured.
   *
   * Admin authorization is required. Works even while the contract is
   * frozen so the legitimate admin can keep the switch alive.
   */
  ping: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_fee transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the current protocol fee percentage in basis points.
   * 
   * # Returns
   * The configured `fee_bps`, or `0` if the contract has not been
   * initialized.
   * 
   * # Panics
   * Does not panic.
   */
  get_fee: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Replaces this contract's WASM with a previously uploaded version. Admin-only.
   * 
   * # Parameters
   * - `new_wasm_hash`: Hash of a WASM blob previously uploaded to the
   * network, to install as this contract's new executable.
   * 
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   * 
   * # Panics
   * Panics if the current admin does not authorize the call, or if
   * `new_wasm_hash` does not reference a previously uploaded WASM blob.
   * 
   * DEPRECATED for direct use.  Queue via `queue_action(ActionType::Upgrade(…))`.
   */
  upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the contract version.
   * 
   * # Returns
   * The contract's version number, currently `1`.
   * 
   * # Panics
   * Does not panic.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a get_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Fetches the current exchange rate for a `(base_asset, quote_asset)`
   * pair from the configured price-feed oracle, validates it, and returns
   * the result.
   *
   * Every failure path below first attempts to serve an admin-configured
   * fallback price for the pair; the oracle error is only surfaced when no
   * fallback exists.
   *
   * ## Validation flow
   *
   * 1. **Oracle configured?** - Otherwise `Err(Error::OracleNotConfigured)`.
   * 2. **Call oracle** - Invoke the oracle's `get_price`; a trapped or
   * unavailable contract yields `Err(Error::OracleCallFailed)`.
   * 3. **Staleness check** - Reject a `price_data.timestamp` older than the
   * configured threshold (default 3 600 s) with
   * `Err(Error::OraclePriceStale)`. A threshold of `0` disables this check.
   * 4. **Validity check** - A price <= 0 is invalid
   * (`Err(Error::OraclePriceInvalid)`).
   * 5. **Return** - The validated `PriceData` is returned to the caller.
   *
   * `base_asset` is typically the XLM native contract and `quote_asset` the
   * USDC contract.
   */
  get_price: ({base_asset, quote_asset}: {base_asset: string, quote_asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<PriceData>>>

  /**
   * Construct and simulate a is_frozen transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns whether the contract is currently frozen.
   */
  is_frozen: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a unfreeze transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Removes the frozen state, restoring normal contract operation.
   * 
   * Like `emergency_freeze`, this takes effect immediately and does not
   * go through the timelock.
   * 
   * Admin authorization is required.
   */
  unfreeze: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a is_frozen transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns whether the contract is currently frozen.
   */
  is_frozen: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a is_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns whether the contract is currently paused.
   * 
   * # Returns
   * `true` if paused, `false` if unpaused or not yet initialized.
   * 
   * # Panics
   * Does not panic.
   */
  is_paused: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Set a new admin. Gated by the current admin if one exists.
   * 
   * # Parameters
   * - `new_admin`: Address to install as the new admin.
   * 
   * # Returns
   * Always `Ok(())`.
   * 
   * # Panics
   * Panics if an admin is already set and it does not authorize the call.
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pauses or unpauses the payment router. Admin-only.
   * 
   * # Parameters
   * - `paused`: `true` to reject `route_payment` / `route_payments`
   * calls, `false` to allow them again.
   * 
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   * 
   * # Panics
   * Panics if the current admin does not authorize the call.
   * 
   * This is NOT timelocked — operational pausing must remain instant.
   */
  set_pause: ({paused}: {paused: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a grant_role transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Grants an operational role to `grantee`.
   *
   * Only an address holding `SuperAdmin` may call this.  The `admin`
   * parameter is the address expected to authorize the transaction, and
   * `admin.require_auth()` is always invoked, so a caller that cannot supply
   * that signature is rejected even if the role would otherwise resolve.
   *
   * # Parameters
   * - `admin`: Address expected to authorize the call; must hold `SuperAdmin`.
   * - `grantee`: Address to receive the role.
   * - `role`: The `Role` variant to grant.
   *
   * # Returns
   * `Ok(())` on success, `Err(Error::RoleNotFound)` if `admin` does not hold
   * `SuperAdmin`, or `Err(Error::NotInitialized)` if the contract has no
   * admin set yet.
   *
   * # Panics
   * Panics if `admin` does not authorize the call.
   *
   * Granting a role the grantee already holds is a no-op that emits
   * `role_assigned` again rather than an error.  Because a role has a single
   * designated holder, granting it to a new address revokes it from the
   * previous one.
   */
  grant_role: ({admin, grantee, role}: {admin: string, grantee: string, role: Role}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Circuit-breaker guard applied to every non-essential operation.
   *
   * While the pause switch is engaged all operational state changes —
   * payments, timelock queue/execute, fee/treasury/governance/min-limit
   * configuration, treasury yield movements and token recovery — are
   * rejected with `Error::Paused`.
   *
   * One-time setup: records the admin and the initial fee configuration
   * in instance storage. Must be called before `route_payment`.
   * 
   * # Parameters
   * - `admin`: Address granted admin rights over the contract; must
   * authorize this call.
   * - `platform_treasury`: Address that receives collected platform fees.
   * - `fee_bps`: Platform fee rate, in basis points.
   * - `fee_cap`: Maximum fee (in the token's smallest unit) taken from a
   * single payment.
   * - `max_amount`: Maximum amount accepted by a single payment.
   * 
   * # Returns
   * `Ok(())` on success, or `Err(Error::AlreadyInitialized)` if the
   * contract already has an admin set.
   * 
   * # Panics
   * Panics if `admin` does not authorize the call.
   */
  initialize: ({admin, platform_treasury, fee_bps, fee_cap, max_amount}: {admin: string, platform_treasury: string, fee_bps: i128, fee_cap: i128, max_amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a quote_swap transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Asks a registered DEX how much `buy_token` a swap would return, and
   * derives the `min_amount_out` the sender should use from the contract's
   * configured slippage ceiling.
   *
   * This is a read-only cross-contract call: it moves no funds and changes no
   * state, so it is safe to call off-chain before building a
   * [`SwapPayment`].
   *
   * # Parameters
   * - `dex`: Contract ID of a registered DEX adapter.
   * - `sell_token`: Token the sender would pay with.
   * - `buy_token`: Token the recipient would be paid in.
   * - `amount_in`: Amount of `sell_token` to price, in its smallest unit.
   *
   * # Returns
   * A [`SwapQuote`] with the quoted output, the slippage-adjusted
   * `min_amount_out`, and the slippage ceiling used. Returns
   * `Err(Error::DexNotRegistered)` if `dex` was never registered or
   * `Err(Error::SwapFailed)` if the DEX quote call reverts.
   *
   * # Panics
   * Does not panic.
   */
  quote_swap: ({dex, sell_token, buy_token, amount_in}: {dex: string, sell_token: string, buy_token: string, amount_in: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<SwapQuote>>>

  /**
   * Construct and simulate a set_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Alias for `set_pause`. Admin-only.
   * 
   * # Parameters
   * - `paused`: `true` to reject routing calls, `false` to allow them.
   * 
   * # Returns
   * See `set_pause`.
   * 
   * # Panics
   * Panics if the current admin does not authorize the call.
   */
  set_paused: ({paused}: {paused: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a assign_role transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Grants an operational role to an account. SuperAdmin-protected.
   *
   * Retained for compatibility with the published bindings; this is
   * [`Self::grant_role`] with the `admin` argument resolved by the contract
   * instead of supplied by the caller.
   *
   * # Parameters
   * - `account`: Target address to receive the role.
   * - `role`: The `Role` variant to grant.
   *
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if uninitialized.
   *
   * # Panics
   * Panics if the current `SuperAdmin` does not authorize the call.
   */
  assign_role: ({account, role}: {account: string, role: Role}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Dead man's switch claim: transfers admin rights to `claimant` if they
   * are the configured backup admin and the admin has not pinged (directly
   * or via routing a payment) for at least the configured timeout.
   *
   * Deliberately NOT timelocked and NOT blocked by a contract freeze: if
   * the primary admin is gone there is nobody left to execute a queued
   * action, and freezing must not be able to brick recovery.
   *
   * # Parameters
   * - `claimant`: Address claiming admin rights. Must be the configured
   * backup admin and must authorize the call.
   *
   * # Returns
   * `Ok(())` on success, `Err(Error::NoBackupAdmin)` if no backup is
   * configured, `Err(Error::Unauthorized)` if `claimant` is not the
   * backup, or `Err(Error::DmsNotReady)` if the timeout has not elapsed.
   */
  claim_admin: ({claimant}: {claimant: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a revoke_role transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Revokes an operational role from `grantee`.
   *
   * Only an address holding `SuperAdmin` may call this.  As with
   * [`Self::grant_role`], `admin.require_auth()` is always invoked.
   *
   * # Parameters
   * - `admin`: Address expected to authorize the call; must hold `SuperAdmin`.
   * - `grantee`: Address from which the role will be revoked.
   * - `role`: The `Role` variant to revoke.
   *
   * # Returns
   * `Ok(())` on success, `Err(Error::RoleNotFound)` if `admin` does not hold
   * `SuperAdmin`, `Err(Error::InvalidRole)` if the call would revoke the
   * acting `SuperAdmin`'s own root role, or `Err(Error::NotInitialized)`.
   *
   * # Panics
   * Panics if `admin` does not authorize the call.
   *
   * Revoking a role the grantee never held is a no-op that emits
   * `role_revoked` rather than an error, so revocations are idempotent and
   * safe to retry.
   */
  revoke_role: ({admin, grantee, role}: {admin: string, grantee: string, role: Role}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_fee_bps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Updates the fee basis points.
   * Requires governance authority if a governance address is set; otherwise admin-only.
   * 
   * # Parameters
   * - `new_fee_bps`: New platform fee rate, in basis points.
   * 
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   * 
   * # Panics
   * Panics if the caller does not authorize the call.
   * 
   * DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetFeeBps(…))`.
   */
  set_fee_bps: ({new_fee_bps}: {new_fee_bps: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a queue_action transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Queues an admin action to be executed after a 24-hour delay.
   * 
   * The admin provides the desired `ActionType` variant and receives a
   * numeric nonce that uniquely identifies this pending entry.  Pass this
   * nonce to `execute_action` after 24 hours, or to `cancel_action` to
   * abort the intent.
   * 
   * Sensitive parameter changes (`set_platform_treasury`, `set_fee_config`,
   * `set_fee_bps`, `set_governance`, `set_min_limit`, `transfer_admin`,
   * `upgrade`) must go through the timelock.  Use the direct setter
   * functions only for actions that are not sensitive (e.g. `set_pause`
   * which can also be called directly for immediate operational pauses).
   * 
   * The contract must not be frozen when queuing, and the admin must
   * authorize the call.
   */
  queue_action: ({action}: {action: ActionType}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a cancel_action transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cancels a pending timelock entry before it can be executed.
   * 
   * This is the primary defence when a compromised admin has queued a
   * malicious action: any other admin (after a key rotation) or a
   * multi-sig governance can cancel it within the 24-hour window.
   * 
   * Admin authorization is required. The contract may be frozen.
   */
  cancel_action: ({nonce}: {nonce: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a route_payment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Routes a payment from a sender to a recipient, deducting a platform fee.
   * 
   * # Parameters
   * - `sender`: Address the funds are debited from; must authorize the call.
   * - `recipient`: Address to receive the funds (minus the platform fee).
   * - `token_address`: Contract ID of the token being transferred.
   * - `amount`: Amount to route, in the token's smallest unit. Must be
   * positive and within the configured min/max and daily-limit bounds.
   * 
   * # Returns
   * `Ok(())` on success. Returns `Err(Error::Paused)` if routing is
   * paused, `Err(Error::NotInitialized)` if the contract has no admin
   * set, `Err(Error::InvalidRecipient)` if `sender == recipient`,
   * `Err(Error::Blacklisted)` if `recipient` is blacklisted,
   * `Err(Error::LimitExceeded)` if `amount` is outside the configured
   * bounds or exceeds the sender's remaining daily limit, or
   * `Err(Error::InsufficientBalance)` if `sender`'s token balance is
   * below `amount`.
   * 
   * # Panics
   * Panics if `sender` does not authorize the call, or if the underlying
   * token transfer to `platform_treasury` fails.
   */
  route_payment: ({sender, recipient, token_address, amount}: {sender: string, recipient: string, token_address: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_min_limit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the minimum allowed routing amount. Admin-only.
   * 
   * # Parameters
   * - `min_limit`: Smallest `amount` that `route_payment` /
   * `route_payments` will accept going forward.
   * 
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   * 
   * # Panics
   * Panics if the current admin does not authorize the call.
   * 
   * DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetMinLimit(…))`.
   */
  set_min_limit: ({min_limit}: {min_limit: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute_action transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Executes a previously queued action identified by `nonce`.
   * 
   * Requirements:
   * - The contract must not be frozen.
   * - The admin must authorize.
   * - The entry identified by `nonce` must exist.
   * - At least 24 hours (`SECONDS_IN_24H`) must have passed since queuing.
   * 
   * On success the entry is removed and the underlying setter is invoked.
   */
  execute_action: ({nonce}: {nonce: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a is_blacklisted transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns whether an address is blacklisted.
   * 
   * # Parameters
   * - `address`: Address to check.
   * 
   * # Returns
   * `true` if `address` is blacklisted, `false` otherwise.
   * 
   * # Panics
   * Does not panic.
   */
  is_blacklisted: ({address}: {address: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a recover_tokens transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Recovers tokens accidentally sent directly to the contract address. Admin-only.
   * 
   * # Parameters
   * - `token`: Contract ID of the token to recover.
   * - `amount`: Amount to transfer from the contract's balance to the admin.
   * 
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   * 
   * # Panics
   * Panics if the current admin does not authorize the call, or if the
   * token transfer fails (e.g. the contract's balance is below `amount`).
   */
  recover_tokens: ({token, amount}: {token: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a route_payments transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Routes multiple payments in a single transaction. If any payment fails,
   * the entire batch is reverted atomically.
   * 
   * # Parameters
   * - `payments`: Batch of transfer instructions to apply in order. See
   * [`Payment`] for per-item constraints.
   * 
   * # Returns
   * `Ok(())` if every payment in the batch succeeds. Returns the first
   * error encountered (see `route_payment` for the possible `Err`
   * variants and their causes) if any payment fails; the Soroban host
   * reverts all storage and balance changes from the batch in that case.
   * 
   * # Panics
   * Panics if any payment's `sender` does not authorize the call, or if
   * a token transfer to `platform_treasury` fails.
   */
  route_payments: ({payments}: {payments: Array<Payment>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_fee_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Alias for `set_fee_config_legacy`. Admin-only.
   * 
   * # Parameters
   * - `fee_bps`: New platform fee rate, in basis points.
   * - `fee_cap`: New maximum fee taken from a single payment.
   * 
   * # Returns
   * See `set_fee_config_legacy`.
   * 
   * # Panics
   * Panics if the current admin does not authorize the call.
   * 
   * DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetFeeConfig(…))`.
   */
  set_fee_config: ({fee_bps, fee_cap}: {fee_bps: i128, fee_cap: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_governance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the governance contract address. After this call, only the governance
   * contract can update fees. Admin-only — can only be set once per governance cycle.
   * 
   * DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetGovernance(…))`.
   */
  set_governance: ({gov}: {gov: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a transfer_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfers admin rights to a new address. Requires the current admin's authorization.
   * 
   * # Parameters
   * - `new_admin`: Address to become the new admin.
   * 
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   * 
   * # Panics
   * Panics if the current admin does not authorize the call.
   * 
   * DEPRECATED for direct use.  Queue via `queue_action(ActionType::TransferAdmin(…))`.
   */
  transfer_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a approve_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Records `signer`'s authorization of an upgrade to `new_wasm_hash`.
   *
   * # Parameters
   * - `signer`: The group member approving; must authorize this call.
   * - `new_wasm_hash`: The WASM hash being approved.
   *
   * # Returns
   * `Ok(())` on success, or appropriate `Error` on failure.
   */
  approve_upgrade: ({signer, new_wasm_hash}: {signer: string, new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_role_member transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the primary designated member address for a role, if one is configured.
   *
   * # Parameters
   * - `role`: The role variant to query.
   *
   * # Returns
   * `Some(Address)` if set, or `None` if unassigned.
   */
  get_role_member: ({role}: {role: Role}, options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a get_user_record transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns a sender's combined routing record: the amount accumulated in
   * the current 24-hour window and their cumulative lifetime volume
   * (issue #663).
   *
   * Reads the single packed `UserRecord` entry. For a sender that only has
   * the legacy pre-#663 split entries, both counters are combined from
   * those without writing anything.
   *
   * # Parameters
   * - `user`: Sender address to look up.
   *
   * # Returns
   * A [`UserRecord`] with zeroed counters if `user` has never routed a
   * payment; `last_reset_time` is then the current ledger timestamp.
   *
   * # Panics
   * Does not panic.
   */
  get_user_record: ({user}: {user: string}, options?: MethodOptions) => Promise<AssembledTransaction<UserRecord>>

  /**
   * Construct and simulate a get_user_volume transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the cumulative amount a given sender has routed through the contract.
   * 
   * # Parameters
   * - `user`: Sender address to look up.
   * 
   * # Returns
   * The lifetime routed volume for `user`, or `0` if they have never
   * routed a payment.
   * 
   * # Panics
   * Does not panic.
   */
  get_user_volume: ({user}: {user: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a withdraw_refund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Withdraws a specific amount from the user's internal refund balance.
   * 
   * A refund balance accrues when a `route_payment` / `route_payments`
   * transfer to the recipient fails (e.g. missing trustline) and the
   * funds are held by the contract on the sender's behalf instead.
   * 
   * # Parameters
   * - `user`: Address withdrawing funds; must authorize the call.
   * - `token`: Contract ID of the token to withdraw.
   * - `amount`: Amount to withdraw. Must be positive and not exceed the
   * current refund balance.
   * 
   * # Returns
   * `Ok(())` on success, or `Err(Error::NoRefundAvailable)` if `amount`
   * is zero, negative, or greater than the available balance.
   * 
   * # Panics
   * Panics if `user` does not authorize the call, or if the underlying
   * token transfer fails.
   */
  withdraw_refund: ({user, token, amount}: {user: string, token: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a emergency_freeze transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Instantly freezes the contract, blocking all payments and timelock
   * executions.  This is the emergency last resort when an admin key is
   * known to be compromised.
   * 
   * Unlike other sensitive admin operations, freeze takes effect immediately
   * — it does NOT go through the timelock — so it is always available as a
   * rapid-response tool.
   * 
   * Admin authorization is required.
   */
  emergency_freeze: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a blacklist_address transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Adds an address to the blacklist. Admin-only.
   * 
   * # Parameters
   * - `address`: Address to blacklist; subsequent payments to it as a
   * recipient will be rejected.
   * 
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   * 
   * # Panics
   * Panics if the current admin does not authorize the call.
   */
  blacklist_address: ({address}: {address: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim_all_refunds transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claims and withdraws the entire available refund balance for a user and token.
   * 
   * # Parameters
   * - `user`: Address withdrawing funds; must authorize the call.
   * - `token`: Contract ID of the token to withdraw.
   * 
   * # Returns
   * `Ok(amount)` with the amount withdrawn, or
   * `Err(Error::NoRefundAvailable)` if the refund balance is zero.
   * 
   * # Panics
   * Panics if `user` does not authorize the call, or if the underlying
   * token transfer fails.
   */
  claim_all_refunds: ({user, token}: {user: string, token: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_queued_action transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the pending `TimelockEntry` for the given nonce, or an error if
   * it does not exist.
   */
  get_queued_action: ({nonce}: {nonce: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TimelockEntry>>>

  /**
   * Construct and simulate a emergency_withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin-only emergency withdrawal of tokens held by this contract.
   * 
   * # Parameters
   * - `token`: Contract ID of the token to withdraw.
   * - `amount`: Amount to transfer from the contract's balance to the admin.
   * 
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   * 
   * # Panics
   * Panics if the current admin does not authorize the call, or if the
   * token transfer fails (e.g. the contract's balance is below `amount`).
   */
  emergency_withdraw: ({token, amount}: {token: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_refund_balance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the available internal refund balance for a user and token.
   * 
   * # Parameters
   * - `user`: Address whose refund balance to look up.
   * - `token`: Contract ID of the token.
   * 
   * # Returns
   * The refundable balance for `(user, token)`, or `0` if none is held.
   * 
   * # Panics
   * Does not panic.
   */
  get_refund_balance: ({user, token}: {user: string, token: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a add_supported_token transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Records a token as supported (no-op; routing accepts any token contract ID).
   * 
   * # Parameters
   * - `_token`: Ignored; present for API compatibility.
   * 
   * # Returns
   * Always `Ok(())`.
   * 
   * # Panics
   * Does not panic.
   */
  add_supported_token: ({_token}: {_token: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a commit_archive_root transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Commits a SHA-256 Merkle root of a batch of payment-record snapshots
   * into persistent storage, opening a new archive epoch.
   *
   * Call this before `prune_archived_entries`. Requires TreasuryManager.
   * Returns the new epoch number.
   *
   * Errors: NotInitialized, ContractFrozen.
   */
  commit_archive_root: ({root, leaves, description}: {root: Buffer, leaves: Array<ArchiveLeaf>, description: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a get_multisig_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the current multi-signature admin group.
   *
   * # Returns
   * The configured signers and threshold, or `Err(Error::MultisigNotInitialized)`
   * if `set_multisig_config` has not been called yet.
   *
   * # Panics
   * Does not panic.
   */
  get_multisig_config: (options?: MethodOptions) => Promise<AssembledTransaction<Result<MultisigConfig>>>

  /**
   * Construct and simulate a migrate_user_record transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless migration of a sender's legacy pre-#663 split entries
   * (`UserSpending` + `UserVolume`) into the single packed `UserRecord`
   * (issue #663).
   *
   * Callable by anyone: it only recombines values that are already on the
   * ledger and never invents or destroys value. When the sender's packed
   * record was already created by a recent payment, this just removes the
   * stale legacy keys and keeps the newer packed values.
   *
   * # Parameters
   * - `user`: The sender whose legacy entries should be migrated.
   *
   * # Returns
   * `true` if legacy state was found and migrated, `false` if `user` has
   * no legacy entries to migrate.
   *
   * # Panics
   * Does not panic.
   */
  migrate_user_record: ({user}: {user: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a remove_backup_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Disables the dead man's switch, removing the backup admin and its
   * claim window. The inactivity timeout is left in storage untouched so
   * a later re-arming (via timelock) can reuse it.
   *
   * Admin authorization is required.
   */
  remove_backup_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_multisig_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Configures the multi-signature admin group that authorizes upgrades.
   *
   * The signer set is replaced wholesale: addresses that are not in
   * `signers` immediately lose the ability to approve, and a threshold
   * already reached for a pending hash is re-evaluated against the new
   * configuration.
   *
   * # Parameters
   * - `signers`: The N addresses whose signatures count. Must be non-empty
   * and free of duplicates.
   * - `threshold`: The M signers required to authorize an upgrade, in
   * `1..=signers.len()`.
   *
   * # Returns
   * `Ok(())` on success, `Err(Error::InvalidMultisigConfig)` if the signer
   * set is empty or holds a duplicate, or the threshold is zero or larger
   * than the set, or `Err(Error::NotInitialized)` if the contract has no
   * admin set yet.
   *
   * # Panics
   * Panics if the current admin does not authorize the call.
   */
  set_multisig_config: ({signers, threshold}: {signers: Array<string>, threshold: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a unblacklist_address transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Removes an address from the blacklist. Admin-only.
   * 
   * # Parameters
   * - `address`: Address to remove from the blacklist.
   * 
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   * 
   * # Panics
   * Panics if the current admin does not authorize the call.
   */
  unblacklist_address: ({address}: {address: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a withdraw_from_yield transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Withdraws treasury principal from the configured lending protocol. TreasuryManager-protected.
   */
  withdraw_from_yield: ({token, amount}: {token: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a configure_governance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Configures the DAO token and minimum voting weight for fee proposals.
   * This administrative bootstrap does not itself change fees; subsequent
   * fee changes can be made through the proposal lifecycle.
   */
  configure_governance: ({governance_token, quorum}: {governance_token: string, quorum: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_dead_mans_switch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the dead man's switch configuration.
   *
   * # Returns
   * `(backup_admin, timeout_seconds, last_heartbeat, seconds_since_heartbeat)`.
   * `backup_admin` is `None` and the timestamps `0` when no backup is
   * configured.
   *
   * # Panics
   * Does not panic.
   */
  get_dead_mans_switch: (options?: MethodOptions) => Promise<AssembledTransaction<readonly [Option<string>, u64, u64, u64]>>

  /**
   * Construct and simulate a get_max_slippage_bps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the maximum tolerated swap slippage in basis points.
   *
   * # Returns
   * The configured `max_slippage_bps`, or the 1 000 bps (10%) default if
   * the contract has not been initialized.
   *
   * # Panics
   * Does not panic.
   */
  get_max_slippage_bps: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a set_max_slippage_bps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the maximum tolerated swap slippage. Admin-only.
   *
   * Applied against the `expected_amount_out` a caller supplies alongside a
   * quote, as a second guard on top of the per-payment `min_amount_out`
   * floor.
   *
   * # Parameters
   * - `max_slippage_bps`: New ceiling in basis points; `0` to `10_000`.
   *
   * # Returns
   * `Ok(())` on success, `Err(Error::InvalidSwapParams)` if the value is
   * outside `0..=10_000`, or `Err(Error::NotInitialized)` if the contract has
   * no admin set yet.
   *
   * # Panics
   * Panics if the current admin does not authorize the call.
   *
   * DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetMaxSlippageBps(…))`
   * and execute after 24 hours.
   */
  set_max_slippage_bps: ({max_slippage_bps}: {max_slippage_bps: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_effective_fee_bps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the effective fee_bps for a sender after applying any
   * volume-based tiered discount.
   * 
   * # Parameters
   * - `sender`: Address whose discounted fee rate to compute.
   * 
   * # Returns
   * The configured `fee_bps`, halved if `sender`'s lifetime volume
   * exceeds the tiered-discount threshold, or `0` if not initialized.
   * 
   * # Panics
   * Does not panic.
   */
  get_effective_fee_bps: ({sender}: {sender: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a get_upgrade_approvals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the signers whose approval of an upgrade to `new_wasm_hash`
   * currently counts.
   *
   * Approvals cast by a signer that has since been rotated out of the group
   * are omitted, so this list always agrees with `is_upgrade_authorized`.
   *
   * # Returns
   * The counted approvals in the order they were recorded, or an empty
   * vector if the hash has none. Empty when no group is configured.
   *
   * # Panics
   * Does not panic.
   */
  get_upgrade_approvals: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Array<string>>>

  /**
   * Construct and simulate a is_upgrade_authorized transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns whether an upgrade to `new_wasm_hash` is already authorized.
   *
   * # Returns
   * `true` once `M` group members have approved that exact hash.
   * `Err(Error::MultisigNotInitialized)` if no group is configured.
   *
   * # Panics
   * Does not panic.
   */
  is_upgrade_authorized: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a set_fee_config_legacy transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Updates the fee basis points and fee cap.
   * Requires governance authority if a governance address is set; otherwise admin-only.
   * 
   * # Parameters
   * - `fee_bps`: New platform fee rate, in basis points.
   * - `fee_cap`: New maximum fee taken from a single payment.
   * 
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   * 
   * # Panics
   * Panics if the caller does not authorize the call.
   * 
   * DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetFeeConfig(…))`.
   */
  set_fee_config_legacy: ({fee_bps, fee_cap}: {fee_bps: i128, fee_cap: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_platform_treasury transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Updates the treasury address that receives the platform fee.
   * 
   * Updates the treasury address that receives the platform fee. Admin-only.
   * 
   * # Parameters
   * - `new_treasury`: Address to receive platform fees going forward.
   * 
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   * 
   * # Panics
   * Panics if the current admin does not authorize the call.
   * 
   * DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetPlatformTreasury(…))`
   * and execute after 24 hours.  This direct path is retained for tooling
   * compatibility only.
   */
  set_platform_treasury: ({new_treasury}: {new_treasury: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_cross_contract_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the prepared [`TwoPhaseCommit`] manifest for `upgrade_id`, or
   * [`Error::UpgradeManifestNotFound`] if there is none.
   */
  get_cross_contract_upgrade: ({upgrade_id}: {upgrade_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TwoPhaseCommit>>>

  /**
   * Construct and simulate a commit_cross_contract_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Phase 2 of a cross-contract upgrade: after the 48-hour delay has
   * elapsed, upgrade every participating contract in one atomic step.
   * 
   * Every manifest entry is validated before the first cross-contract call
   * is made.  If any participating contract rejects its own manifest
   * validation, the error unwinds the entire invocation, so contracts
   * upgraded earlier in the same call roll back with it — the protocol
   * ends up either fully upgraded or not upgraded at all.
   * 
   * # Parameters
   * - `upgrade_id`: the upgrade prepared by `prepare_cross_contract_upgrade`.
   * 
   * # Errors
   * - [`Error::UpgradeManifestNotFound`]: unknown or already committed ID.
   * - [`Error::UpgradeNotReady`]: the 48-hour delay has not elapsed.
   * - [`Error::UpgradeManifestExpired`]: past `execution_deadline`.
   * - [`Error::UpgradeCommitFailed`]: a participating contract rejected its
   * manifest; the whole commit was rolled back.
   */
  commit_cross_contract_upgrade: ({upgrade_id}: {upgrade_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a prepare_cross_contract_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Phase 1 of a cross-contract upgrade: validate the upgrade manifest and
   * register it on every participating contract under one synchronized
   * 48-hour timelock.
   * 
   * See [`timelock`] for the protocol description.  Both entry points
   * require admin authorization and a non-frozen contract, and both are
   * atomic: if any participating contract rejects its manifest, the whole
   * invocation reverts and no contract keeps a registration.
   * 
   * # Parameters
   * - `upgrade_id`: unique identifier of the upgrade attempt.
   * - `contract_addresses`: every contract taking part in the upgrade.
   * - `code_hashes`: code hash for the contract at the matching index;
   * must contain exactly one entry per address.
   * 
   * # Returns
   * The stored [`TwoPhaseCommit`] manifest, including `execution_deadline`.
   */
  prepare_cross_contract_upgrade: ({upgrade_id, contract_addresses, code_hashes}: {upgrade_id: Buffer, contract_addresses: Array<string>, code_hashes: Array<Buffer>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TwoPhaseCommit>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAAKxSZXR1cm5zIHRoZSBjdXJyZW50IHByb3RvY29sIGZlZSBwZXJjZW50YWdlIGluIGJhc2lzIHBvaW50cy4KCiMgUmV0dXJucwpUaGUgY29uZmlndXJlZCBgZmVlX2Jwc2AsIG9yIGAwYCBpZiB0aGUgY29udHJhY3QgaGFzIG5vdCBiZWVuCmluaXRpYWxpemVkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAB2dldF9mZWUAAAAAAAAAAAEAAAAL",
        "AAAAAAAAAhhSZXBsYWNlcyB0aGlzIGNvbnRyYWN0J3MgV0FTTSB3aXRoIGEgcHJldmlvdXNseSB1cGxvYWRlZCB2ZXJzaW9uLiBBZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYG5ld193YXNtX2hhc2hgOiBIYXNoIG9mIGEgV0FTTSBibG9iIHByZXZpb3VzbHkgdXBsb2FkZWQgdG8gdGhlCm5ldHdvcmssIHRvIGluc3RhbGwgYXMgdGhpcyBjb250cmFjdCdzIG5ldyBleGVjdXRhYmxlLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0CmhhcyBubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IGFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYKYG5ld193YXNtX2hhc2hgIGRvZXMgbm90IHJlZmVyZW5jZSBhIHByZXZpb3VzbHkgdXBsb2FkZWQgV0FTTSBibG9iLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlVwZ3JhZGUo4oCmKSlgLgAAAAd1cGdyYWRlAAAAAAEAAAAAAAAADW5ld193YXNtX2hhc2gAAAAAAAPuAAAAIAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAHBSZXR1cm5zIHRoZSBjb250cmFjdCB2ZXJzaW9uLgoKIyBSZXR1cm5zClRoZSBjb250cmFjdCdzIHZlcnNpb24gbnVtYmVyLCBjdXJyZW50bHkgYDFgLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAB3ZlcnNpb24AAAAAAAAAAAEAAAAE",
        "AAAABAAAAIpDb250cmFjdC1sZXZlbCBlcnJvcnMgcmV0dXJuZWQgaW5zdGVhZCBvZiBwYW5pY2tpbmcsIHNvIGNhbGxlcnMgZ2V0IGEKc3BlY2lmaWMsIHN0YWJsZSBlcnJvciBjb2RlIHRvIGJyYW5jaCBvbiByYXRoZXIgdGhhbiBhbiBvcGFxdWUgdHJhcC4AAAAAAAAAAAAFRXJyb3IAAAAAAAAVAAAARUNhbGxlciBpcyBub3QgYXV0aG9yaXplZCB0byBwZXJmb3JtIHRoaXMgYWN0aW9uIChlLmcuIG5vdCB0aGUgYWRtaW4pLgAAAAAAAAxVbmF1dGhvcml6ZWQAAAABAAAAQlNlbmRlcidzIHRva2VuIGJhbGFuY2UgaXMgbG93ZXIgdGhhbiB0aGUgcmVxdWVzdGVkIHBheW1lbnQgYW1vdW50LgAAAAAAE0luc3VmZmljaWVudEJhbGFuY2UAAAAAAgAAAE1SZXF1ZXN0ZWQgYW1vdW50IGlzIG91dHNpZGUgYWxsb3dlZCBib3VuZHMsIG9yIGEgc3BlbmRpbmcgbGltaXQgd2FzIGV4Y2VlZGVkLgAAAAAAAA1MaW1pdEV4Y2VlZGVkAAAAAAAAAwAAAERgaW5pdGlhbGl6ZWAgd2FzIGNhbGxlZCBvbiBhIGNvbnRyYWN0IHRoYXQgYWxyZWFkeSBoYXMgYW4gYWRtaW4gc2V0LgAAABJBbHJlYWR5SW5pdGlhbGl6ZWQAAAAAAAQAAABOQW4gYWRtaW4tY29uZmlndXJlZCB2YWx1ZSAodHJlYXN1cnksIGZlZSwgYWRtaW4pIHdhcyByZWFkIGJlZm9yZSBgaW5pdGlhbGl6ZWAuAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAUAAABMVGhlIGNvbnRyYWN0IGlzIGN1cnJlbnRseSBwYXVzZWQ7IHJvdXRpbmcgY2FsbHMgYXJlIHJlamVjdGVkIHVudGlsIHVucGF1c2VkLgAAAAZQYXVzZWQAAAAAAAYAAABMQSBmZWUgY29uZmlndXJhdGlvbiB2YWx1ZSAoYmFzaXMgcG9pbnRzIG9yIGNhcCkgaXMgb3V0IG9mIHRoZSBhbGxvd2VkIHJhbmdlLgAAAA5JbnZhbGlkRmVlUmF0ZQAAAAAABwAAAEdTZW5kZXIgYW5kIHJlY2lwaWVudCBhZGRyZXNzZXMgYXJlIHRoZSBzYW1lIChzZWxmLXJvdXRpbmcgbm90IGFsbG93ZWQpLgAAAAAQSW52YWxpZFJlY2lwaWVudAAAAAgAAAAhUmVjaXBpZW50IGFkZHJlc3MgaXMgYmxhY2tsaXN0ZWQuAAAAAAAAC0JsYWNrbGlzdGVkAAAAAAkAAABPUmVxdWVzdGVkIHJlZnVuZCB3aXRoZHJhd2FsIGFtb3VudCBpcyB6ZXJvIG9yIGV4Y2VlZHMgYXZhaWxhYmxlIHJlZnVuZCBiYWxhbmNlLgAAAAARTm9SZWZ1bmRBdmFpbGFibGUAAAAAAAAKAAAAvEFuIGFjdGlvbiBpcyBhbHJlYWR5IHBlbmRpbmcgaW4gdGhlIHRpbWVsb2NrIHF1ZXVlOyBpdCBtdXN0IGJlIGV4ZWN1dGVkCm9yIGNhbmNlbGxlZCBiZWZvcmUgYSBkdXBsaWNhdGUgY2FuIGJlIHF1ZXVlZCAobm90IGN1cnJlbnRseSBlbmZvcmNlZCwKYnV0IHJlc2VydmVkIGZvciBmdXR1cmUgZGVkdXBsaWNhdGlvbiBsb2dpYykuAAAAD1RpbWVsb2NrUGVuZGluZwAAAAALAAAAQ1RoZSAyNC1ob3VyIGRlbGF5IGZvciB0aGUgZ2l2ZW4gdGltZWxvY2sgZW50cnkgaGFzIG5vdCBlbGFwc2VkIHlldC4AAAAAEFRpbWVsb2NrTm90UmVhZHkAAAAMAAAAM05vIHRpbWVsb2NrIGVudHJ5IGV4aXN0cyBmb3IgdGhlIHN1cHBsaWVkIG5vbmNlIElELgAAAAAQVGltZWxvY2tOb3RGb3VuZAAAAA0AAABJVGhlIGNvbnRyYWN0IGlzIGZyb3plbjsgYWxsIHBheW1lbnRzIGFuZCB0aW1lbG9jayBleGVjdXRpb25zIGFyZSBibG9ja2VkLgAAAAAAAA5Db250cmFjdEZyb3plbgAAAAAADgAAAIRObyBwcmVwYXJlZCBjcm9zcy1jb250cmFjdCB1cGdyYWRlIG1hbmlmZXN0IGV4aXN0cyBmb3IgdGhlIHN1cHBsaWVkCnVwZ3JhZGUgSUQgKGl0IHdhcyBuZXZlciBwcmVwYXJlZCwgb3IgaXQgd2FzIGFscmVhZHkgY29tbWl0dGVkKS4AAAAXVXBncmFkZU1hbmlmZXN0Tm90Rm91bmQAAAAADwAAAIFUaGUgdXBncmFkZSBtYW5pZmVzdCBpcyBtYWxmb3JtZWQ6IG5vIHRhcmdldCBjb250cmFjdHMsIGEgZGlmZmVyZW50Cm51bWJlciBvZiBjb2RlIGhhc2hlcyB0aGFuIGFkZHJlc3Nlcywgb3IgYSBkdXBsaWNhdGVkIHRhcmdldC4AAAAAAAAWSW52YWxpZFVwZ3JhZGVNYW5pZmVzdAAAAAAAEAAAAH9BIG1hbmlmZXN0IGZvciB0aGlzIHVwZ3JhZGUgSUQgaXMgYWxyZWFkeSBwcmVwYXJlZDsgY29tbWl0IG9yIHdhaXQgZm9yCml0cyBleGVjdXRpb24gd2luZG93IHRvIGxhcHNlIGJlZm9yZSBwcmVwYXJpbmcgaXQgYWdhaW4uAAAAABZVcGdyYWRlQWxyZWFkeVByZXBhcmVkAAAAAAARAAAAPlRoZSA0OC1ob3VyIGNyb3NzLWNvbnRyYWN0IHRpbWVsb2NrIGRlbGF5IGhhcyBub3QgZWxhcHNlZCB5ZXQuAAAAAAAPVXBncmFkZU5vdFJlYWR5AAAAABIAAABeVGhlIGV4ZWN1dGlvbiBkZWFkbGluZSBvZiB0aGUgcHJlcGFyZWQgdXBncmFkZSBoYXMgcGFzc2VkOyB0aGUgdXBncmFkZQptdXN0IGJlIHByZXBhcmVkIGFnYWluLgAAAAAAFlVwZ3JhZGVNYW5pZmVzdEV4cGlyZWQAAAAAABMAAADBQSBwYXJ0aWNpcGF0aW5nIGNvbnRyYWN0IHJlamVjdGVkIHRoZSBtYW5pZmVzdCBkdXJpbmcgdGhlIGF0b21pYwpjb21taXQuIFRoZSBlbnRpcmUgaW52b2NhdGlvbiB3YXMgcm9sbGVkIGJhY2ssIHNvIG5vIGNvbnRyYWN0IHdhcwp1cGdyYWRlZDogdGhlIHByb3RvY29sIGlzIHN0aWxsIGZ1bGx5IG9uIGl0cyBwcmV2aW91cyB2ZXJzaW9uLgAAAAAAABNVcGdyYWRlQ29tbWl0RmFpbGVkAAAAABQAAACIQSBwYXJ0aWNpcGF0aW5nIGNvbnRyYWN0IHJlamVjdGVkIHRoZSBtYW5pZmVzdCBkdXJpbmcgcHJlcGFyYXRpb24uIFRoZQplbnRpcmUgaW52b2NhdGlvbiB3YXMgcm9sbGVkIGJhY2ssIHNvIG5vIGNvbnRyYWN0IHdhcyByZWdpc3RlcmVkLgAAABRVcGdyYWRlUHJlcGFyZUZhaWxlZAAAABU=",
        "AAAAAAAAAL5SZW1vdmVzIHRoZSBmcm96ZW4gc3RhdGUsIHJlc3RvcmluZyBub3JtYWwgY29udHJhY3Qgb3BlcmF0aW9uLgoKTGlrZSBgZW1lcmdlbmN5X2ZyZWV6ZWAsIHRoaXMgdGFrZXMgZWZmZWN0IGltbWVkaWF0ZWx5IGFuZCBkb2VzIG5vdApnbyB0aHJvdWdoIHRoZSB0aW1lbG9jay4KCkFkbWluIGF1dGhvcml6YXRpb24gaXMgcmVxdWlyZWQuAAAAAAAIdW5mcmVlemUAAAAAAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAADFSZXR1cm5zIHdoZXRoZXIgdGhlIGNvbnRyYWN0IGlzIGN1cnJlbnRseSBmcm96ZW4uAAAAAAAACWlzX2Zyb3plbgAAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAJRSZXR1cm5zIHdoZXRoZXIgdGhlIGNvbnRyYWN0IGlzIGN1cnJlbnRseSBwYXVzZWQuCgojIFJldHVybnMKYHRydWVgIGlmIHBhdXNlZCwgYGZhbHNlYCBpZiB1bnBhdXNlZCBvciBub3QgeWV0IGluaXRpYWxpemVkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAACWlzX3BhdXNlZAAAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAOhTZXQgYSBuZXcgYWRtaW4uIEdhdGVkIGJ5IHRoZSBjdXJyZW50IGFkbWluIGlmIG9uZSBleGlzdHMuCgojIFBhcmFtZXRlcnMKLSBgbmV3X2FkbWluYDogQWRkcmVzcyB0byBpbnN0YWxsIGFzIHRoZSBuZXcgYWRtaW4uCgojIFJldHVybnMKQWx3YXlzIGBPaygoKSlgLgoKIyBQYW5pY3MKUGFuaWNzIGlmIGFuIGFkbWluIGlzIGFscmVhZHkgc2V0IGFuZCBpdCBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAACXNldF9hZG1pbgAAAAAAAAEAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAZJQYXVzZXMgb3IgdW5wYXVzZXMgdGhlIHBheW1lbnQgcm91dGVyLiBBZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYHBhdXNlZGA6IGB0cnVlYCB0byByZWplY3QgYHJvdXRlX3BheW1lbnRgIC8gYHJvdXRlX3BheW1lbnRzYApjYWxscywgYGZhbHNlYCB0byBhbGxvdyB0aGVtIGFnYWluLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0CmhhcyBubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IGFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4KClRoaXMgaXMgTk9UIHRpbWVsb2NrZWQg4oCUIG9wZXJhdGlvbmFsIHBhdXNpbmcgbXVzdCByZW1haW4gaW5zdGFudC4AAAAAAAlzZXRfcGF1c2UAAAAAAAABAAAAAAAAAAZwYXVzZWQAAAAAAAEAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAgAAADtTdG9yYWdlIGtleXMgZm9yIGFsbCBjb250cmFjdCBpbnN0YW5jZSBhbmQgcGVyc2lzdGVudCBkYXRhLgAAAAAAAAAAB0RhdGFLZXkAAAAAEAAAAAAAAAAaVGhlIGN1cnJlbnQgYWRtaW4gYWRkcmVzcy4AAAAAAAVBZG1pbgAAAAAAAAAAAABQR292ZXJuYW5jZSBjb250cmFjdCBhZGRyZXNzOyBpZiBzZXQsIGl0IHRha2VzIG92ZXIgZmVlLWF1dGhvcml0eSBmcm9tIHRoZSBhZG1pbi4AAAAKR292ZXJuYW5jZQAAAAAAAAAAAC5BZGRyZXNzIHRoYXQgcmVjZWl2ZXMgY29sbGVjdGVkIHBsYXRmb3JtIGZlZXMuAAAAAAAQUGxhdGZvcm1UcmVhc3VyeQAAAAAAAAA6UGxhdGZvcm0gZmVlIHJhdGUsIGluIGJhc2lzIHBvaW50cyAoMS8xMDB0aCBvZiBhIHBlcmNlbnQpLgAAAAAABkZlZUJwcwAAAAAAAAAAADNVcHBlciBib3VuZCBvbiB0aGUgZmVlIHRha2VuIGZyb20gYSBzaW5nbGUgcGF5bWVudC4AAAAABkZlZUNhcAAAAAAAAAAAAEZNaW5pbXVtIGFtb3VudCBhY2NlcHRlZCBieSBgcm91dGVfcGF5bWVudGAgLyBgcm91dGVfcGF5bWVudHNgLCBpZiBzZXQuAAAAAAAITWluTGltaXQAAAAAAAAAJFdoZXRoZXIgcm91dGluZyBpcyBjdXJyZW50bHkgcGF1c2VkLgAAAAZQYXVzZWQAAAAAAAAAAAAsTWF4aW11bSBhbW91bnQgYWNjZXB0ZWQgYnkgYSBzaW5nbGUgcGF5bWVudC4AAAAJTWF4QW1vdW50AAAAAAAAAQAAADRDdW11bGF0aXZlIGxpZmV0aW1lIGFtb3VudCByb3V0ZWQgYnkgYSBnaXZlbiBzZW5kZXIuAAAAClVzZXJWb2x1bWUAAAAAAAEAAAATAAAAAQAAADJQYWNrZWQgMjQtaG91ciBzcGVuZGluZyB3aW5kb3cgZm9yIGEgZ2l2ZW4gc2VuZGVyLgAAAAAADFVzZXJTcGVuZGluZwAAAAEAAAATAAAAAQAAADFXaGV0aGVyIGEgZ2l2ZW4gcmVjaXBpZW50IGFkZHJlc3MgaXMgYmxhY2tsaXN0ZWQuAAAAAAAACUJsYWNrbGlzdAAAAAAAAAEAAAATAAAAAQAAAGlJbnRlcm5hbCByZWZ1bmQgYmFsYW5jZSBmb3IgYSAodXNlciwgdG9rZW4pIHBhaXIsIGNyZWRpdGVkIHdoZW4gYQpkaXJlY3QgdHJhbnNmZXIgdG8gdGhlIHJlY2lwaWVudCBmYWlscy4AAAAAAAANUmVmdW5kQmFsYW5jZQAAAAAAAAIAAAATAAAAEwAAAAAAAAB+TW9ub3RvbmljYWxseS1pbmNyZWFzaW5nIG5vbmNlIGNvdW50ZXIgdXNlZCB0byBnZW5lcmF0ZSB1bmlxdWUgSURzIGZvcgp0aW1lbG9jayBlbnRyaWVzLiAgU3RvcmVkIGFzIGB1NjRgIGluIGluc3RhbmNlIHN0b3JhZ2UuAAAAAAANVGltZWxvY2tOb25jZQAAAAAAAAEAAABuQSBwZW5kaW5nIHRpbWVsb2NrIGVudHJ5IGtleWVkIGJ5IGl0cyBub25jZSBJRC4KU3RvcmVkIGluIHBlcnNpc3RlbnQgc3RvcmFnZSBzbyBpdCBzdXJ2aXZlcyBpbnN0YW5jZSBldmljdGlvbi4AAAAAAA1UaW1lbG9ja0VudHJ5AAAAAAAAAQAAAAYAAAAAAAAAeFdoZW4gYHRydWVgIHRoZSBjb250cmFjdCBpcyBmcm96ZW46IHBheW1lbnRzIGFuZCB0aW1lbG9jayBleGVjdXRpb25zCmFyZSBibG9ja2VkLiAgU3RvcmVkIGFzIGBib29sYCBpbiBpbnN0YW5jZSBzdG9yYWdlLgAAAAZGcm96ZW4AAAAAAAEAAAClQSBwcmVwYXJlZCB0d28tcGhhc2UgY3Jvc3MtY29udHJhY3QgdXBncmFkZSBtYW5pZmVzdCwga2V5ZWQgYnkgaXRzCnVwZ3JhZGUgSUQuIFN0b3JlZCBpbiBwZXJzaXN0ZW50IHN0b3JhZ2Ugc28gaXQgc3Vydml2ZXMgaW5zdGFuY2UKZXZpY3Rpb24gd2hpbGUgdGhlIHRpbWVsb2NrIHJ1bnMuAAAAAAAADlR3b1BoYXNlQ29tbWl0AAAAAAABAAAD7gAAACA=",
        "AAAAAQAAAE1BIHNpbmdsZSB0cmFuc2ZlciBpbnN0cnVjdGlvbiBmb3IgdXNlIHdpdGggW2BQYXltZW50Um91dGVyOjpyb3V0ZV9wYXltZW50c2BdLgAAAAAAAAAAAAAHUGF5bWVudAAAAAAEAAAAgEFtb3VudCB0byByb3V0ZSwgZGVub21pbmF0ZWQgaW4gdGhlIHRva2VuJ3Mgc21hbGxlc3QgdW5pdC4gTXVzdCBiZQpwb3NpdGl2ZSBhbmQgd2l0aGluIHRoZSBjb250cmFjdCdzIGNvbmZpZ3VyZWQgbWluL21heCBib3VuZHMuAAAABmFtb3VudAAAAAAACwAAADtBZGRyZXNzIHRoZSBmdW5kcyAobWludXMgdGhlIHBsYXRmb3JtIGZlZSkgYXJlIGNyZWRpdGVkIHRvLgAAAAAJcmVjaXBpZW50AAAAAAAAEwAAADxBZGRyZXNzIHRoZSBmdW5kcyBhcmUgZGViaXRlZCBmcm9tLiBNdXN0IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAGc2VuZGVyAAAAAAATAAAAR0NvbnRyYWN0IElEIG9mIHRoZSB0b2tlbiAob3IgU3RlbGxhciBBc3NldCBDb250cmFjdCkgYmVpbmcgdHJhbnNmZXJyZWQuAAAAAA10b2tlbl9hZGRyZXNzAAAAAAAAEw==",
        "AAAAAAAAApJPbmUtdGltZSBzZXR1cDogcmVjb3JkcyB0aGUgYWRtaW4gYW5kIHRoZSBpbml0aWFsIGZlZSBjb25maWd1cmF0aW9uCmluIGluc3RhbmNlIHN0b3JhZ2UuIE11c3QgYmUgY2FsbGVkIGJlZm9yZSBgcm91dGVfcGF5bWVudGAuCgojIFBhcmFtZXRlcnMKLSBgYWRtaW5gOiBBZGRyZXNzIGdyYW50ZWQgYWRtaW4gcmlnaHRzIG92ZXIgdGhlIGNvbnRyYWN0OyBtdXN0CmF1dGhvcml6ZSB0aGlzIGNhbGwuCi0gYHBsYXRmb3JtX3RyZWFzdXJ5YDogQWRkcmVzcyB0aGF0IHJlY2VpdmVzIGNvbGxlY3RlZCBwbGF0Zm9ybSBmZWVzLgotIGBmZWVfYnBzYDogUGxhdGZvcm0gZmVlIHJhdGUsIGluIGJhc2lzIHBvaW50cy4KLSBgZmVlX2NhcGA6IE1heGltdW0gZmVlIChpbiB0aGUgdG9rZW4ncyBzbWFsbGVzdCB1bml0KSB0YWtlbiBmcm9tIGEKc2luZ2xlIHBheW1lbnQuCi0gYG1heF9hbW91bnRgOiBNYXhpbXVtIGFtb3VudCBhY2NlcHRlZCBieSBhIHNpbmdsZSBwYXltZW50LgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6OkFscmVhZHlJbml0aWFsaXplZClgIGlmIHRoZQpjb250cmFjdCBhbHJlYWR5IGhhcyBhbiBhZG1pbiBzZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgYGFkbWluYCBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAKaW5pdGlhbGl6ZQAAAAAABQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAABFwbGF0Zm9ybV90cmVhc3VyeQAAAAAAABMAAAAAAAAAB2ZlZV9icHMAAAAACwAAAAAAAAAHZmVlX2NhcAAAAAALAAAAAAAAAAptYXhfYW1vdW50AAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAANJBbGlhcyBmb3IgYHNldF9wYXVzZWAuIEFkbWluLW9ubHkuCgojIFBhcmFtZXRlcnMKLSBgcGF1c2VkYDogYHRydWVgIHRvIHJlamVjdCByb3V0aW5nIGNhbGxzLCBgZmFsc2VgIHRvIGFsbG93IHRoZW0uCgojIFJldHVybnMKU2VlIGBzZXRfcGF1c2VgLgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IGFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAAAApzZXRfcGF1c2VkAAAAAAABAAAAAAAAAAZwYXVzZWQAAAAAAAEAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAa1VcGRhdGVzIHRoZSBmZWUgYmFzaXMgcG9pbnRzLgpSZXF1aXJlcyBnb3Zlcm5hbmNlIGF1dGhvcml0eSBpZiBhIGdvdmVybmFuY2UgYWRkcmVzcyBpcyBzZXQ7IG90aGVyd2lzZSBhZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYG5ld19mZWVfYnBzYDogTmV3IHBsYXRmb3JtIGZlZSByYXRlLCBpbiBiYXNpcyBwb2ludHMuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGNhbGxlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuCgpERVBSRUNBVEVEIGZvciBkaXJlY3QgdXNlLiAgUXVldWUgdmlhIGBxdWV1ZV9hY3Rpb24oQWN0aW9uVHlwZTo6U2V0RmVlQnBzKOKApikpYC4AAAAAAAALc2V0X2ZlZV9icHMAAAAAAQAAAAAAAAALbmV3X2ZlZV9icHMAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAsdRdWV1ZXMgYW4gYWRtaW4gYWN0aW9uIHRvIGJlIGV4ZWN1dGVkIGFmdGVyIGEgMjQtaG91ciBkZWxheS4KClRoZSBhZG1pbiBwcm92aWRlcyB0aGUgZGVzaXJlZCBgQWN0aW9uVHlwZWAgdmFyaWFudCBhbmQgcmVjZWl2ZXMgYQpudW1lcmljIG5vbmNlIHRoYXQgdW5pcXVlbHkgaWRlbnRpZmllcyB0aGlzIHBlbmRpbmcgZW50cnkuICBQYXNzIHRoaXMKbm9uY2UgdG8gYGV4ZWN1dGVfYWN0aW9uYCBhZnRlciAyNCBob3Vycywgb3IgdG8gYGNhbmNlbF9hY3Rpb25gIHRvCmFib3J0IHRoZSBpbnRlbnQuCgpTZW5zaXRpdmUgcGFyYW1ldGVyIGNoYW5nZXMgKGBzZXRfcGxhdGZvcm1fdHJlYXN1cnlgLCBgc2V0X2ZlZV9jb25maWdgLApgc2V0X2ZlZV9icHNgLCBgc2V0X2dvdmVybmFuY2VgLCBgc2V0X21pbl9saW1pdGAsIGB0cmFuc2Zlcl9hZG1pbmAsCmB1cGdyYWRlYCkgbXVzdCBnbyB0aHJvdWdoIHRoZSB0aW1lbG9jay4gIFVzZSB0aGUgZGlyZWN0IHNldHRlcgpmdW5jdGlvbnMgb25seSBmb3IgYWN0aW9ucyB0aGF0IGFyZSBub3Qgc2Vuc2l0aXZlIChlLmcuIGBzZXRfcGF1c2VgCndoaWNoIGNhbiBhbHNvIGJlIGNhbGxlZCBkaXJlY3RseSBmb3IgaW1tZWRpYXRlIG9wZXJhdGlvbmFsIHBhdXNlcykuCgpUaGUgY29udHJhY3QgbXVzdCBub3QgYmUgZnJvemVuIHdoZW4gcXVldWluZywgYW5kIHRoZSBhZG1pbiBtdXN0CmF1dGhvcml6ZSB0aGUgY2FsbC4AAAAADHF1ZXVlX2FjdGlvbgAAAAEAAAAAAAAABmFjdGlvbgAAAAAH0AAAAApBY3Rpb25UeXBlAAAAAAABAAAD6QAAAAYAAAAD",
        "AAAAAgAAAK5EZXNjcmliZXMgd2hpY2ggYWRtaW5pc3RyYXRpdmUgcGFyYW1ldGVyIGNoYW5nZSBhIHRpbWVsb2NrIGVudHJ5IHJlcHJlc2VudHMuCkVhY2ggdmFyaWFudCBjYXJyaWVzIGFsbCB0aGUgYXJndW1lbnRzIG5lZWRlZCB0byBhcHBseSB0aGF0IGNoYW5nZSB3aGVuIHRoZQpkZWxheSBwZXJpb2QgaXMgb3Zlci4AAAAAAAAAAAAKQWN0aW9uVHlwZQAAAAAABwAAAAEAAAAlQ2hhbmdlIHRoZSBwbGF0Zm9ybSB0cmVhc3VyeSBhZGRyZXNzLgAAAAAAABNTZXRQbGF0Zm9ybVRyZWFzdXJ5AAAAAAEAAAATAAAAAQAAAEhVcGRhdGUgZmVlIGJhc2lzLXBvaW50cyBhbmQgZmVlIGNhcCB0b2dldGhlciAobGVnYWN5IC8gY29tYmluZWQgc2V0dGVyKS4AAAAMU2V0RmVlQ29uZmlnAAAAAgAAAAsAAAALAAAAAQAAAB1VcGRhdGUgZmVlIGJhc2lzLXBvaW50cyBvbmx5LgAAAAAAAAlTZXRGZWVCcHMAAAAAAAABAAAACwAAAAEAAAAkU2V0IHRoZSBnb3Zlcm5hbmNlIGNvbnRyYWN0IGFkZHJlc3MuAAAADVNldEdvdmVybmFuY2UAAAAAAAABAAAAEwAAAAEAAAAhQ2hhbmdlIHRoZSBtaW5pbXVtIHJvdXRpbmcgbGltaXQuAAAAAAAAC1NldE1pbkxpbWl0AAAAAAEAAAALAAAAAQAAACdUcmFuc2ZlciBhZG1pbiByaWdodHMgdG8gYSBuZXcgYWRkcmVzcy4AAAAADVRyYW5zZmVyQWRtaW4AAAAAAAABAAAAEwAAAAEAAAAaVXBncmFkZSB0aGUgY29udHJhY3QgV0FTTS4AAAAAAAdVcGdyYWRlAAAAAAEAAAPuAAAAIA==",
        "AAAAAAAAAThDYW5jZWxzIGEgcGVuZGluZyB0aW1lbG9jayBlbnRyeSBiZWZvcmUgaXQgY2FuIGJlIGV4ZWN1dGVkLgoKVGhpcyBpcyB0aGUgcHJpbWFyeSBkZWZlbmNlIHdoZW4gYSBjb21wcm9taXNlZCBhZG1pbiBoYXMgcXVldWVkIGEKbWFsaWNpb3VzIGFjdGlvbjogYW55IG90aGVyIGFkbWluIChhZnRlciBhIGtleSByb3RhdGlvbikgb3IgYQptdWx0aS1zaWcgZ292ZXJuYW5jZSBjYW4gY2FuY2VsIGl0IHdpdGhpbiB0aGUgMjQtaG91ciB3aW5kb3cuCgpBZG1pbiBhdXRob3JpemF0aW9uIGlzIHJlcXVpcmVkLiBUaGUgY29udHJhY3QgbWF5IGJlIGZyb3plbi4AAAANY2FuY2VsX2FjdGlvbgAAAAAAAAEAAAAAAAAABW5vbmNlAAAAAAAABgAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAA/ZSb3V0ZXMgYSBwYXltZW50IGZyb20gYSBzZW5kZXIgdG8gYSByZWNpcGllbnQsIGRlZHVjdGluZyBhIHBsYXRmb3JtIGZlZS4KCiMgUGFyYW1ldGVycwotIGBzZW5kZXJgOiBBZGRyZXNzIHRoZSBmdW5kcyBhcmUgZGViaXRlZCBmcm9tOyBtdXN0IGF1dGhvcml6ZSB0aGUgY2FsbC4KLSBgcmVjaXBpZW50YDogQWRkcmVzcyB0byByZWNlaXZlIHRoZSBmdW5kcyAobWludXMgdGhlIHBsYXRmb3JtIGZlZSkuCi0gYHRva2VuX2FkZHJlc3NgOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4gYmVpbmcgdHJhbnNmZXJyZWQuCi0gYGFtb3VudGA6IEFtb3VudCB0byByb3V0ZSwgaW4gdGhlIHRva2VuJ3Mgc21hbGxlc3QgdW5pdC4gTXVzdCBiZQpwb3NpdGl2ZSBhbmQgd2l0aGluIHRoZSBjb25maWd1cmVkIG1pbi9tYXggYW5kIGRhaWx5LWxpbWl0IGJvdW5kcy4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLiBSZXR1cm5zIGBFcnIoRXJyb3I6OlBhdXNlZClgIGlmIHJvdXRpbmcgaXMKcGF1c2VkLCBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdCBoYXMgbm8gYWRtaW4Kc2V0LCBgRXJyKEVycm9yOjpJbnZhbGlkUmVjaXBpZW50KWAgaWYgYHNlbmRlciA9PSByZWNpcGllbnRgLApgRXJyKEVycm9yOjpCbGFja2xpc3RlZClgIGlmIGByZWNpcGllbnRgIGlzIGJsYWNrbGlzdGVkLApgRXJyKEVycm9yOjpMaW1pdEV4Y2VlZGVkKWAgaWYgYGFtb3VudGAgaXMgb3V0c2lkZSB0aGUgY29uZmlndXJlZApib3VuZHMgb3IgZXhjZWVkcyB0aGUgc2VuZGVyJ3MgcmVtYWluaW5nIGRhaWx5IGxpbWl0LCBvcgpgRXJyKEVycm9yOjpJbnN1ZmZpY2llbnRCYWxhbmNlKWAgaWYgYHNlbmRlcmAncyB0b2tlbiBiYWxhbmNlIGlzCmJlbG93IGBhbW91bnRgLgoKIyBQYW5pY3MKUGFuaWNzIGlmIGBzZW5kZXJgIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYgdGhlIHVuZGVybHlpbmcKdG9rZW4gdHJhbnNmZXIgdG8gYHBsYXRmb3JtX3RyZWFzdXJ5YCBmYWlscy4AAAAAAA1yb3V0ZV9wYXltZW50AAAAAAAABAAAAAAAAAAGc2VuZGVyAAAAAAATAAAAAAAAAAlyZWNpcGllbnQAAAAAAAATAAAAAAAAAA10b2tlbl9hZGRyZXNzAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAaRTZXRzIHRoZSBtaW5pbXVtIGFsbG93ZWQgcm91dGluZyBhbW91bnQuIEFkbWluLW9ubHkuCgojIFBhcmFtZXRlcnMKLSBgbWluX2xpbWl0YDogU21hbGxlc3QgYGFtb3VudGAgdGhhdCBgcm91dGVfcGF5bWVudGAgLwpgcm91dGVfcGF5bWVudHNgIHdpbGwgYWNjZXB0IGdvaW5nIGZvcndhcmQuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgYWRtaW4gZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlNldE1pbkxpbWl0KOKApikpYC4AAAANc2V0X21pbl9saW1pdAAAAAAAAAEAAAAAAAAACW1pbl9saW1pdAAAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAURFeGVjdXRlcyBhIHByZXZpb3VzbHkgcXVldWVkIGFjdGlvbiBpZGVudGlmaWVkIGJ5IGBub25jZWAuCgpSZXF1aXJlbWVudHM6Ci0gVGhlIGNvbnRyYWN0IG11c3Qgbm90IGJlIGZyb3plbi4KLSBUaGUgYWRtaW4gbXVzdCBhdXRob3JpemUuCi0gVGhlIGVudHJ5IGlkZW50aWZpZWQgYnkgYG5vbmNlYCBtdXN0IGV4aXN0LgotIEF0IGxlYXN0IDI0IGhvdXJzIChgU0VDT05EU19JTl8yNEhgKSBtdXN0IGhhdmUgcGFzc2VkIHNpbmNlIHF1ZXVpbmcuCgpPbiBzdWNjZXNzIHRoZSBlbnRyeSBpcyByZW1vdmVkIGFuZCB0aGUgdW5kZXJseWluZyBzZXR0ZXIgaXMgaW52b2tlZC4AAAAOZXhlY3V0ZV9hY3Rpb24AAAAAAAEAAAAAAAAABW5vbmNlAAAAAAAABgAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAALNSZXR1cm5zIHdoZXRoZXIgYW4gYWRkcmVzcyBpcyBibGFja2xpc3RlZC4KCiMgUGFyYW1ldGVycwotIGBhZGRyZXNzYDogQWRkcmVzcyB0byBjaGVjay4KCiMgUmV0dXJucwpgdHJ1ZWAgaWYgYGFkZHJlc3NgIGlzIGJsYWNrbGlzdGVkLCBgZmFsc2VgIG90aGVyd2lzZS4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAAAOaXNfYmxhY2tsaXN0ZWQAAAAAAAEAAAAAAAAAB2FkZHJlc3MAAAAAEwAAAAEAAAAB",
        "AAAAAAAAAc9SZWNvdmVycyB0b2tlbnMgYWNjaWRlbnRhbGx5IHNlbnQgZGlyZWN0bHkgdG8gdGhlIGNvbnRyYWN0IGFkZHJlc3MuIEFkbWluLW9ubHkuCgojIFBhcmFtZXRlcnMKLSBgdG9rZW5gOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4gdG8gcmVjb3Zlci4KLSBgYW1vdW50YDogQW1vdW50IHRvIHRyYW5zZmVyIGZyb20gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSB0byB0aGUgYWRtaW4uCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgYWRtaW4gZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLCBvciBpZiB0aGUKdG9rZW4gdHJhbnNmZXIgZmFpbHMgKGUuZy4gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSBpcyBiZWxvdyBgYW1vdW50YCkuAAAAAA5yZWNvdmVyX3Rva2VucwAAAAAAAgAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAnhSb3V0ZXMgbXVsdGlwbGUgcGF5bWVudHMgaW4gYSBzaW5nbGUgdHJhbnNhY3Rpb24uIElmIGFueSBwYXltZW50IGZhaWxzLAp0aGUgZW50aXJlIGJhdGNoIGlzIHJldmVydGVkIGF0b21pY2FsbHkuCgojIFBhcmFtZXRlcnMKLSBgcGF5bWVudHNgOiBCYXRjaCBvZiB0cmFuc2ZlciBpbnN0cnVjdGlvbnMgdG8gYXBwbHkgaW4gb3JkZXIuIFNlZQpbYFBheW1lbnRgXSBmb3IgcGVyLWl0ZW0gY29uc3RyYWludHMuCgojIFJldHVybnMKYE9rKCgpKWAgaWYgZXZlcnkgcGF5bWVudCBpbiB0aGUgYmF0Y2ggc3VjY2VlZHMuIFJldHVybnMgdGhlIGZpcnN0CmVycm9yIGVuY291bnRlcmVkIChzZWUgYHJvdXRlX3BheW1lbnRgIGZvciB0aGUgcG9zc2libGUgYEVycmAKdmFyaWFudHMgYW5kIHRoZWlyIGNhdXNlcykgaWYgYW55IHBheW1lbnQgZmFpbHM7IHRoZSBTb3JvYmFuIGhvc3QKcmV2ZXJ0cyBhbGwgc3RvcmFnZSBhbmQgYmFsYW5jZSBjaGFuZ2VzIGZyb20gdGhlIGJhdGNoIGluIHRoYXQgY2FzZS4KCiMgUGFuaWNzClBhbmljcyBpZiBhbnkgcGF5bWVudCdzIGBzZW5kZXJgIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYKYSB0b2tlbiB0cmFuc2ZlciB0byBgcGxhdGZvcm1fdHJlYXN1cnlgIGZhaWxzLgAAAA5yb3V0ZV9wYXltZW50cwAAAAAAAQAAAAAAAAAIcGF5bWVudHMAAAPqAAAH0AAAAAdQYXltZW50AAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAWxBbGlhcyBmb3IgYHNldF9mZWVfY29uZmlnX2xlZ2FjeWAuIEFkbWluLW9ubHkuCgojIFBhcmFtZXRlcnMKLSBgZmVlX2Jwc2A6IE5ldyBwbGF0Zm9ybSBmZWUgcmF0ZSwgaW4gYmFzaXMgcG9pbnRzLgotIGBmZWVfY2FwYDogTmV3IG1heGltdW0gZmVlIHRha2VuIGZyb20gYSBzaW5nbGUgcGF5bWVudC4KCiMgUmV0dXJucwpTZWUgYHNldF9mZWVfY29uZmlnX2xlZ2FjeWAuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgYWRtaW4gZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlNldEZlZUNvbmZpZyjigKYpKWAuAAAADnNldF9mZWVfY29uZmlnAAAAAAACAAAAAAAAAAdmZWVfYnBzAAAAAAsAAAAAAAAAB2ZlZV9jYXAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAPVTZXRzIHRoZSBnb3Zlcm5hbmNlIGNvbnRyYWN0IGFkZHJlc3MuIEFmdGVyIHRoaXMgY2FsbCwgb25seSB0aGUgZ292ZXJuYW5jZQpjb250cmFjdCBjYW4gdXBkYXRlIGZlZXMuIEFkbWluLW9ubHkg4oCUIGNhbiBvbmx5IGJlIHNldCBvbmNlIHBlciBnb3Zlcm5hbmNlIGN5Y2xlLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlNldEdvdmVybmFuY2Uo4oCmKSlgLgAAAAAAAA5zZXRfZ292ZXJuYW5jZQAAAAAAAQAAAAAAAAADZ292AAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAZJUcmFuc2ZlcnMgYWRtaW4gcmlnaHRzIHRvIGEgbmV3IGFkZHJlc3MuIFJlcXVpcmVzIHRoZSBjdXJyZW50IGFkbWluJ3MgYXV0aG9yaXphdGlvbi4KCiMgUGFyYW1ldGVycwotIGBuZXdfYWRtaW5gOiBBZGRyZXNzIHRvIGJlY29tZSB0aGUgbmV3IGFkbWluLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0CmhhcyBubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IGFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4KCkRFUFJFQ0FURUQgZm9yIGRpcmVjdCB1c2UuICBRdWV1ZSB2aWEgYHF1ZXVlX2FjdGlvbihBY3Rpb25UeXBlOjpUcmFuc2ZlckFkbWluKOKApikpYC4AAAAAAA50cmFuc2Zlcl9hZG1pbgAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAQAAASdBIHVzZXIncyByb2xsaW5nIDI0LWhvdXIgc3BlbmRpbmcgcmVjb3JkLgoKUmV0YWluZWQgcHVyZWx5IHNvIGV4aXN0aW5nIHRlc3Qgc25hcHNob3RzIHRoYXQgcmVmZXJlbmNlIHRoaXMgdHlwZSBieQpuYW1lIGtlZXAgY29tcGlsaW5nLiBMaXZlIGNvbnRyYWN0IHN0YXRlIGlzIHN0b3JlZCBhcyBhIHBhY2tlZApgQnl0ZXNOPDI0PmAgKHNlZSBgcGFja19zcGVuZGluZ2AgLyBgdW5wYWNrX3NwZW5kaW5nYCk7IHRoaXMgc3RydWN0IGlzIG5vdApyZWFkIGZyb20gb3Igd3JpdHRlbiB0byBzdG9yYWdlIGF0IHJ1bnRpbWUuAAAAAAAAAAAMVXNlclNwZW5kaW5nAAAAAgAAADhUb3RhbCBhbW91bnQgcm91dGVkIGJ5IHRoZSB1c2VyIHNpbmNlIGBsYXN0X3Jlc2V0X3RpbWVgLgAAABJhY2N1bXVsYXRlZF9hbW91bnQAAAAAAAsAAABAVW5peCB0aW1lc3RhbXAgKHNlY29uZHMpIGF0IHdoaWNoIHRoZSAyNC1ob3VyIHdpbmRvdyBsYXN0IHJlc2V0LgAAAA9sYXN0X3Jlc2V0X3RpbWUAAAAABg==",
        "AAAAAAAAAPhSZXR1cm5zIHRoZSBjdW11bGF0aXZlIGFtb3VudCBhIGdpdmVuIHNlbmRlciBoYXMgcm91dGVkIHRocm91Z2ggdGhlIGNvbnRyYWN0LgoKIyBQYXJhbWV0ZXJzCi0gYHVzZXJgOiBTZW5kZXIgYWRkcmVzcyB0byBsb29rIHVwLgoKIyBSZXR1cm5zClRoZSBsaWZldGltZSByb3V0ZWQgdm9sdW1lIGZvciBgdXNlcmAsIG9yIGAwYCBpZiB0aGV5IGhhdmUgbmV2ZXIKcm91dGVkIGEgcGF5bWVudC4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAA9nZXRfdXNlcl92b2x1bWUAAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAACw==",
        "AAAAAAAAAs1XaXRoZHJhd3MgYSBzcGVjaWZpYyBhbW91bnQgZnJvbSB0aGUgdXNlcidzIGludGVybmFsIHJlZnVuZCBiYWxhbmNlLgoKQSByZWZ1bmQgYmFsYW5jZSBhY2NydWVzIHdoZW4gYSBgcm91dGVfcGF5bWVudGAgLyBgcm91dGVfcGF5bWVudHNgCnRyYW5zZmVyIHRvIHRoZSByZWNpcGllbnQgZmFpbHMgKGUuZy4gbWlzc2luZyB0cnVzdGxpbmUpIGFuZCB0aGUKZnVuZHMgYXJlIGhlbGQgYnkgdGhlIGNvbnRyYWN0IG9uIHRoZSBzZW5kZXIncyBiZWhhbGYgaW5zdGVhZC4KCiMgUGFyYW1ldGVycwotIGB1c2VyYDogQWRkcmVzcyB3aXRoZHJhd2luZyBmdW5kczsgbXVzdCBhdXRob3JpemUgdGhlIGNhbGwuCi0gYHRva2VuYDogQ29udHJhY3QgSUQgb2YgdGhlIHRva2VuIHRvIHdpdGhkcmF3LgotIGBhbW91bnRgOiBBbW91bnQgdG8gd2l0aGRyYXcuIE11c3QgYmUgcG9zaXRpdmUgYW5kIG5vdCBleGNlZWQgdGhlCmN1cnJlbnQgcmVmdW5kIGJhbGFuY2UuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm9SZWZ1bmRBdmFpbGFibGUpYCBpZiBgYW1vdW50YAppcyB6ZXJvLCBuZWdhdGl2ZSwgb3IgZ3JlYXRlciB0aGFuIHRoZSBhdmFpbGFibGUgYmFsYW5jZS4KCiMgUGFuaWNzClBhbmljcyBpZiBgdXNlcmAgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLCBvciBpZiB0aGUgdW5kZXJseWluZwp0b2tlbiB0cmFuc2ZlciBmYWlscy4AAAAAAAAPd2l0aGRyYXdfcmVmdW5kAAAAAAMAAAAAAAAABHVzZXIAAAATAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAQAAAD1BIHBlbmRpbmcgdGltZWxvY2sgZW50cnkgc3RvcmVkIGluIHBlcnNpc3RlbnQgbGVkZ2VyIHN0b3JhZ2UuAAAAAAAAAAAAAA1UaW1lbG9ja0VudHJ5AAAAAAAAAgAAADdUaGUgYWN0aW9uIHBheWxvYWQgdG8gYXBwbHkgb25jZSB0aGUgZGVsYXkgaGFzIGVsYXBzZWQuAAAAAAZhY3Rpb24AAAAAB9AAAAAKQWN0aW9uVHlwZQAAAAAAQ0xlZGdlciB0aW1lc3RhbXAgKHNlY29uZHMgc2luY2UgZXBvY2gpIHdoZW4gdGhpcyBhY3Rpb24gd2FzIHF1ZXVlZC4AAAAACXF1ZXVlZF9hdAAAAAAAAAY=",
        "AAAAAAAAAWtJbnN0YW50bHkgZnJlZXplcyB0aGUgY29udHJhY3QsIGJsb2NraW5nIGFsbCBwYXltZW50cyBhbmQgdGltZWxvY2sKZXhlY3V0aW9ucy4gIFRoaXMgaXMgdGhlIGVtZXJnZW5jeSBsYXN0IHJlc29ydCB3aGVuIGFuIGFkbWluIGtleSBpcwprbm93biB0byBiZSBjb21wcm9taXNlZC4KClVubGlrZSBvdGhlciBzZW5zaXRpdmUgYWRtaW4gb3BlcmF0aW9ucywgZnJlZXplIHRha2VzIGVmZmVjdCBpbW1lZGlhdGVseQrigJQgaXQgZG9lcyBOT1QgZ28gdGhyb3VnaCB0aGUgdGltZWxvY2sg4oCUIHNvIGl0IGlzIGFsd2F5cyBhdmFpbGFibGUgYXMgYQpyYXBpZC1yZXNwb25zZSB0b29sLgoKQWRtaW4gYXV0aG9yaXphdGlvbiBpcyByZXF1aXJlZC4AAAAAEGVtZXJnZW5jeV9mcmVlemUAAAAAAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAUJBZGRzIGFuIGFkZHJlc3MgdG8gdGhlIGJsYWNrbGlzdC4gQWRtaW4tb25seS4KCiMgUGFyYW1ldGVycwotIGBhZGRyZXNzYDogQWRkcmVzcyB0byBibGFja2xpc3Q7IHN1YnNlcXVlbnQgcGF5bWVudHMgdG8gaXQgYXMgYQpyZWNpcGllbnQgd2lsbCBiZSByZWplY3RlZC4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBhZG1pbiBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAARYmxhY2tsaXN0X2FkZHJlc3MAAAAAAAABAAAAAAAAAAdhZGRyZXNzAAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAaNDbGFpbXMgYW5kIHdpdGhkcmF3cyB0aGUgZW50aXJlIGF2YWlsYWJsZSByZWZ1bmQgYmFsYW5jZSBmb3IgYSB1c2VyIGFuZCB0b2tlbi4KCiMgUGFyYW1ldGVycwotIGB1c2VyYDogQWRkcmVzcyB3aXRoZHJhd2luZyBmdW5kczsgbXVzdCBhdXRob3JpemUgdGhlIGNhbGwuCi0gYHRva2VuYDogQ29udHJhY3QgSUQgb2YgdGhlIHRva2VuIHRvIHdpdGhkcmF3LgoKIyBSZXR1cm5zCmBPayhhbW91bnQpYCB3aXRoIHRoZSBhbW91bnQgd2l0aGRyYXduLCBvcgpgRXJyKEVycm9yOjpOb1JlZnVuZEF2YWlsYWJsZSlgIGlmIHRoZSByZWZ1bmQgYmFsYW5jZSBpcyB6ZXJvLgoKIyBQYW5pY3MKUGFuaWNzIGlmIGB1c2VyYCBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwsIG9yIGlmIHRoZSB1bmRlcmx5aW5nCnRva2VuIHRyYW5zZmVyIGZhaWxzLgAAAAARY2xhaW1fYWxsX3JlZnVuZHMAAAAAAAACAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAFpSZXR1cm5zIHRoZSBwZW5kaW5nIGBUaW1lbG9ja0VudHJ5YCBmb3IgdGhlIGdpdmVuIG5vbmNlLCBvciBhbiBlcnJvciBpZgppdCBkb2VzIG5vdCBleGlzdC4AAAAAABFnZXRfcXVldWVkX2FjdGlvbgAAAAAAAAEAAAAAAAAABW5vbmNlAAAAAAAABgAAAAEAAAPpAAAH0AAAAA1UaW1lbG9ja0VudHJ5AAAAAAAAAw==",
        "AAAAAAAAAcFBZG1pbi1vbmx5IGVtZXJnZW5jeSB3aXRoZHJhd2FsIG9mIHRva2VucyBoZWxkIGJ5IHRoaXMgY29udHJhY3QuCgojIFBhcmFtZXRlcnMKLSBgdG9rZW5gOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4gdG8gd2l0aGRyYXcuCi0gYGFtb3VudGA6IEFtb3VudCB0byB0cmFuc2ZlciBmcm9tIHRoZSBjb250cmFjdCdzIGJhbGFuY2UgdG8gdGhlIGFkbWluLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0CmhhcyBubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IGFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYgdGhlCnRva2VuIHRyYW5zZmVyIGZhaWxzIChlLmcuIHRoZSBjb250cmFjdCdzIGJhbGFuY2UgaXMgYmVsb3cgYGFtb3VudGApLgAAAAAAABJlbWVyZ2VuY3lfd2l0aGRyYXcAAAAAAAIAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAARJSZXR1cm5zIHRoZSBhdmFpbGFibGUgaW50ZXJuYWwgcmVmdW5kIGJhbGFuY2UgZm9yIGEgdXNlciBhbmQgdG9rZW4uCgojIFBhcmFtZXRlcnMKLSBgdXNlcmA6IEFkZHJlc3Mgd2hvc2UgcmVmdW5kIGJhbGFuY2UgdG8gbG9vayB1cC4KLSBgdG9rZW5gOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4uCgojIFJldHVybnMKVGhlIHJlZnVuZGFibGUgYmFsYW5jZSBmb3IgYCh1c2VyLCB0b2tlbilgLCBvciBgMGAgaWYgbm9uZSBpcyBoZWxkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAAAASZ2V0X3JlZnVuZF9iYWxhbmNlAAAAAAACAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAAAs=",
        "AAAAAAAAAMRSZWNvcmRzIGEgdG9rZW4gYXMgc3VwcG9ydGVkIChuby1vcDsgcm91dGluZyBhY2NlcHRzIGFueSB0b2tlbiBjb250cmFjdCBJRCkuCgojIFBhcmFtZXRlcnMKLSBgX3Rva2VuYDogSWdub3JlZDsgcHJlc2VudCBmb3IgQVBJIGNvbXBhdGliaWxpdHkuCgojIFJldHVybnMKQWx3YXlzIGBPaygoKSlgLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAE2FkZF9zdXBwb3J0ZWRfdG9rZW4AAAAAAQAAAAAAAAAGX3Rva2VuAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAARxSZW1vdmVzIGFuIGFkZHJlc3MgZnJvbSB0aGUgYmxhY2tsaXN0LiBBZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYGFkZHJlc3NgOiBBZGRyZXNzIHRvIHJlbW92ZSBmcm9tIHRoZSBibGFja2xpc3QuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgYWRtaW4gZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgAAABN1bmJsYWNrbGlzdF9hZGRyZXNzAAAAAAEAAAAAAAAAB2FkZHJlc3MAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAUlSZXR1cm5zIHRoZSBlZmZlY3RpdmUgZmVlX2JwcyBmb3IgYSBzZW5kZXIgYWZ0ZXIgYXBwbHlpbmcgYW55CnZvbHVtZS1iYXNlZCB0aWVyZWQgZGlzY291bnQuCgojIFBhcmFtZXRlcnMKLSBgc2VuZGVyYDogQWRkcmVzcyB3aG9zZSBkaXNjb3VudGVkIGZlZSByYXRlIHRvIGNvbXB1dGUuCgojIFJldHVybnMKVGhlIGNvbmZpZ3VyZWQgYGZlZV9icHNgLCBoYWx2ZWQgaWYgYHNlbmRlcmAncyBsaWZldGltZSB2b2x1bWUKZXhjZWVkcyB0aGUgdGllcmVkLWRpc2NvdW50IHRocmVzaG9sZCwgb3IgYDBgIGlmIG5vdCBpbml0aWFsaXplZC4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAAAAABVnZXRfZWZmZWN0aXZlX2ZlZV9icHMAAAAAAAABAAAAAAAAAAZzZW5kZXIAAAAAABMAAAABAAAACw==",
        "AAAAAAAAAfJVcGRhdGVzIHRoZSBmZWUgYmFzaXMgcG9pbnRzIGFuZCBmZWUgY2FwLgpSZXF1aXJlcyBnb3Zlcm5hbmNlIGF1dGhvcml0eSBpZiBhIGdvdmVybmFuY2UgYWRkcmVzcyBpcyBzZXQ7IG90aGVyd2lzZSBhZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYGZlZV9icHNgOiBOZXcgcGxhdGZvcm0gZmVlIHJhdGUsIGluIGJhc2lzIHBvaW50cy4KLSBgZmVlX2NhcGA6IE5ldyBtYXhpbXVtIGZlZSB0YWtlbiBmcm9tIGEgc2luZ2xlIHBheW1lbnQuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGNhbGxlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuCgpERVBSRUNBVEVEIGZvciBkaXJlY3QgdXNlLiAgUXVldWUgdmlhIGBxdWV1ZV9hY3Rpb24oQWN0aW9uVHlwZTo6U2V0RmVlQ29uZmlnKOKApikpYC4AAAAAABVzZXRfZmVlX2NvbmZpZ19sZWdhY3kAAAAAAAACAAAAAAAAAAdmZWVfYnBzAAAAAAsAAAAAAAAAB2ZlZV9jYXAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAjVVcGRhdGVzIHRoZSB0cmVhc3VyeSBhZGRyZXNzIHRoYXQgcmVjZWl2ZXMgdGhlIHBsYXRmb3JtIGZlZS4KClVwZGF0ZXMgdGhlIHRyZWFzdXJ5IGFkZHJlc3MgdGhhdCByZWNlaXZlcyB0aGUgcGxhdGZvcm0gZmVlLiBBZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYG5ld190cmVhc3VyeWA6IEFkZHJlc3MgdG8gcmVjZWl2ZSBwbGF0Zm9ybSBmZWVzIGdvaW5nIGZvcndhcmQuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgYWRtaW4gZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlNldFBsYXRmb3JtVHJlYXN1cnko4oCmKSlgCmFuZCBleGVjdXRlIGFmdGVyIDI0IGhvdXJzLiAgVGhpcyBkaXJlY3QgcGF0aCBpcyByZXRhaW5lZCBmb3IgdG9vbGluZwpjb21wYXRpYmlsaXR5IG9ubHkuAAAAAAAAFXNldF9wbGF0Zm9ybV90cmVhc3VyeQAAAAAAAAEAAAAAAAAADG5ld190cmVhc3VyeQAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAHpSZXR1cm5zIHRoZSBwcmVwYXJlZCBbYFR3b1BoYXNlQ29tbWl0YF0gbWFuaWZlc3QgZm9yIGB1cGdyYWRlX2lkYCwgb3IKW2BFcnJvcjo6VXBncmFkZU1hbmlmZXN0Tm90Rm91bmRgXSBpZiB0aGVyZSBpcyBub25lLgAAAAAAGmdldF9jcm9zc19jb250cmFjdF91cGdyYWRlAAAAAAABAAAAAAAAAAp1cGdyYWRlX2lkAAAAAAPuAAAAIAAAAAEAAAPpAAAH0AAAAA5Ud29QaGFzZUNvbW1pdAAAAAAAAw==",
        "AAAAAAAAA2ZQaGFzZSAyIG9mIGEgY3Jvc3MtY29udHJhY3QgdXBncmFkZTogYWZ0ZXIgdGhlIDQ4LWhvdXIgZGVsYXkgaGFzCmVsYXBzZWQsIHVwZ3JhZGUgZXZlcnkgcGFydGljaXBhdGluZyBjb250cmFjdCBpbiBvbmUgYXRvbWljIHN0ZXAuCgpFdmVyeSBtYW5pZmVzdCBlbnRyeSBpcyB2YWxpZGF0ZWQgYmVmb3JlIHRoZSBmaXJzdCBjcm9zcy1jb250cmFjdCBjYWxsCmlzIG1hZGUuICBJZiBhbnkgcGFydGljaXBhdGluZyBjb250cmFjdCByZWplY3RzIGl0cyBvd24gbWFuaWZlc3QKdmFsaWRhdGlvbiwgdGhlIGVycm9yIHVud2luZHMgdGhlIGVudGlyZSBpbnZvY2F0aW9uLCBzbyBjb250cmFjdHMKdXBncmFkZWQgZWFybGllciBpbiB0aGUgc2FtZSBjYWxsIHJvbGwgYmFjayB3aXRoIGl0IOKAlCB0aGUgcHJvdG9jb2wKZW5kcyB1cCBlaXRoZXIgZnVsbHkgdXBncmFkZWQgb3Igbm90IHVwZ3JhZGVkIGF0IGFsbC4KCiMgUGFyYW1ldGVycwotIGB1cGdyYWRlX2lkYDogdGhlIHVwZ3JhZGUgcHJlcGFyZWQgYnkgYHByZXBhcmVfY3Jvc3NfY29udHJhY3RfdXBncmFkZWAuCgojIEVycm9ycwotIFtgRXJyb3I6OlVwZ3JhZGVNYW5pZmVzdE5vdEZvdW5kYF06IHVua25vd24gb3IgYWxyZWFkeSBjb21taXR0ZWQgSUQuCi0gW2BFcnJvcjo6VXBncmFkZU5vdFJlYWR5YF06IHRoZSA0OC1ob3VyIGRlbGF5IGhhcyBub3QgZWxhcHNlZC4KLSBbYEVycm9yOjpVcGdyYWRlTWFuaWZlc3RFeHBpcmVkYF06IHBhc3QgYGV4ZWN1dGlvbl9kZWFkbGluZWAuCi0gW2BFcnJvcjo6VXBncmFkZUNvbW1pdEZhaWxlZGBdOiBhIHBhcnRpY2lwYXRpbmcgY29udHJhY3QgcmVqZWN0ZWQgaXRzCm1hbmlmZXN0OyB0aGUgd2hvbGUgY29tbWl0IHdhcyByb2xsZWQgYmFjay4AAAAAAB1jb21taXRfY3Jvc3NfY29udHJhY3RfdXBncmFkZQAAAAAAAAEAAAAAAAAACnVwZ3JhZGVfaWQAAAAAA+4AAAAgAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAu5QaGFzZSAxIG9mIGEgY3Jvc3MtY29udHJhY3QgdXBncmFkZTogdmFsaWRhdGUgdGhlIHVwZ3JhZGUgbWFuaWZlc3QgYW5kCnJlZ2lzdGVyIGl0IG9uIGV2ZXJ5IHBhcnRpY2lwYXRpbmcgY29udHJhY3QgdW5kZXIgb25lIHN5bmNocm9uaXplZAo0OC1ob3VyIHRpbWVsb2NrLgoKU2VlIFtgdGltZWxvY2tgXSBmb3IgdGhlIHByb3RvY29sIGRlc2NyaXB0aW9uLiAgQm90aCBlbnRyeSBwb2ludHMKcmVxdWlyZSBhZG1pbiBhdXRob3JpemF0aW9uIGFuZCBhIG5vbi1mcm96ZW4gY29udHJhY3QsIGFuZCBib3RoIGFyZQphdG9taWM6IGlmIGFueSBwYXJ0aWNpcGF0aW5nIGNvbnRyYWN0IHJlamVjdHMgaXRzIG1hbmlmZXN0LCB0aGUgd2hvbGUKaW52b2NhdGlvbiByZXZlcnRzIGFuZCBubyBjb250cmFjdCBrZWVwcyBhIHJlZ2lzdHJhdGlvbi4KCiMgUGFyYW1ldGVycwotIGB1cGdyYWRlX2lkYDogdW5pcXVlIGlkZW50aWZpZXIgb2YgdGhlIHVwZ3JhZGUgYXR0ZW1wdC4KLSBgY29udHJhY3RfYWRkcmVzc2VzYDogZXZlcnkgY29udHJhY3QgdGFraW5nIHBhcnQgaW4gdGhlIHVwZ3JhZGUuCi0gYGNvZGVfaGFzaGVzYDogY29kZSBoYXNoIGZvciB0aGUgY29udHJhY3QgYXQgdGhlIG1hdGNoaW5nIGluZGV4OwptdXN0IGNvbnRhaW4gZXhhY3RseSBvbmUgZW50cnkgcGVyIGFkZHJlc3MuCgojIFJldHVybnMKVGhlIHN0b3JlZCBbYFR3b1BoYXNlQ29tbWl0YF0gbWFuaWZlc3QsIGluY2x1ZGluZyBgZXhlY3V0aW9uX2RlYWRsaW5lYC4AAAAAAB5wcmVwYXJlX2Nyb3NzX2NvbnRyYWN0X3VwZ3JhZGUAAAAAAAMAAAAAAAAACnVwZ3JhZGVfaWQAAAAAA+4AAAAgAAAAAAAAABJjb250cmFjdF9hZGRyZXNzZXMAAAAAA+oAAAATAAAAAAAAAAtjb2RlX2hhc2hlcwAAAAPqAAAD7gAAACAAAAABAAAD6QAAB9AAAAAOVHdvUGhhc2VDb21taXQAAAAAAAM=",
        "AAAAAQAAAI5BIHByZXBhcmVkIGNyb3NzLWNvbnRyYWN0IHVwZ3JhZGUgd2FpdGluZyBmb3IgaXRzIDQ4LWhvdXIgdGltZWxvY2sgdG8KZWxhcHNlLiAgU3RvcmVkIHVuZGVyIFtgRGF0YUtleTo6VHdvUGhhc2VDb21taXRgXSBrZXllZCBieSBgdXBncmFkZV9pZGAuAAAAAAAAAAAADlR3b1BoYXNlQ29tbWl0AAAAAAAFAAAAQlRoZSBjb2RlIGhhc2ggZWFjaCBjb250cmFjdCBhdCB0aGUgc2FtZSBpbmRleCBtdXN0IGJlIHVwZ3JhZGVkIHRvLgAAAAAAC2NvZGVfaGFzaGVzAAAAA+oAAAPuAAAAIAAAADdFdmVyeSBwYXJ0aWNpcGF0aW5nIGNvbnRyYWN0LCBpbiBhIGRldGVybWluaXN0aWMgb3JkZXIuAAAAABJjb250cmFjdF9hZGRyZXNzZXMAAAAAA+oAAAATAAAAZUxlZGdlciB0aW1lc3RhbXAgYWZ0ZXIgd2hpY2ggdGhlIHByZXBhcmVkIHVwZ3JhZGUgbWF5IG5vIGxvbmdlciBiZQpjb21taXR0ZWQgYW5kIG11c3QgYmUgcmUtcHJlcGFyZWQuAAAAAAAAEmV4ZWN1dGlvbl9kZWFkbGluZQAAAAAABgAAAKlMZWRnZXIgdGltZXN0YW1wIChzZWNvbmRzKSBhdCB3aGljaCBQaGFzZSAxIHJlZ2lzdGVyZWQgdGhlIG1hbmlmZXN0cy4KT25lIHRpbWVzdGFtcCBpcyBzaGFyZWQgYnkgZXZlcnkgdGFyZ2V0LCBzbyB0aGUgNDgtaG91ciBkZWxheSBpcwpzeW5jaHJvbml6ZWQgYWNyb3NzIHRoZSB3aG9sZSBzZXQuAAAAAAAAC3ByZXBhcmVkX2F0AAAAAAYAAABHVW5pcXVlIGlkZW50aWZpZXIgb2YgdGhlIHVwZ3JhZGU7IGFsc28gdGhlIHN0b3JhZ2Uga2V5IG9mIHRoZSBtYW5pZmVzdC4AAAAACnVwZ3JhZGVfaWQAAAAAA+4AAAAg" ]),
      options
    )
  }
  public readonly fromJSON = {
    ping: this.txFromJSON<Result<void>>,
        get_fee: this.txFromJSON<i128>,
        upgrade: this.txFromJSON<Result<void>>,
        version: this.txFromJSON<u32>,
        unfreeze: this.txFromJSON<Result<void>>,
        is_frozen: this.txFromJSON<boolean>,
        is_paused: this.txFromJSON<boolean>,
        set_admin: this.txFromJSON<Result<void>>,
        set_pause: this.txFromJSON<Result<void>>,
        grant_role: this.txFromJSON<Result<void>>,
        initialize: this.txFromJSON<Result<void>>,
        quote_swap: this.txFromJSON<Result<SwapQuote>>,
        set_paused: this.txFromJSON<Result<void>>,
        assign_role: this.txFromJSON<Result<void>>,
        claim_admin: this.txFromJSON<Result<void>>,
        revoke_role: this.txFromJSON<Result<void>>,
        set_fee_bps: this.txFromJSON<Result<void>>,
        queue_action: this.txFromJSON<Result<u64>>,
        cancel_action: this.txFromJSON<Result<void>>,
        route_payment: this.txFromJSON<Result<void>>,
        set_min_limit: this.txFromJSON<Result<void>>,
        execute_action: this.txFromJSON<Result<void>>,
        is_blacklisted: this.txFromJSON<boolean>,
        recover_tokens: this.txFromJSON<Result<void>>,
        route_payments: this.txFromJSON<Result<void>>,
        set_fee_config: this.txFromJSON<Result<void>>,
        set_governance: this.txFromJSON<Result<void>>,
        transfer_admin: this.txFromJSON<Result<void>>,
        approve_upgrade: this.txFromJSON<Result<void>>,
        get_role_member: this.txFromJSON<Option<string>>,
        get_user_record: this.txFromJSON<UserRecord>,
        get_user_volume: this.txFromJSON<i128>,
        withdraw_refund: this.txFromJSON<Result<void>>,
        emergency_freeze: this.txFromJSON<Result<void>>,
        blacklist_address: this.txFromJSON<Result<void>>,
        claim_all_refunds: this.txFromJSON<Result<i128>>,
        get_queued_action: this.txFromJSON<Result<TimelockEntry>>,
        emergency_withdraw: this.txFromJSON<Result<void>>,
        get_refund_balance: this.txFromJSON<i128>,
        add_supported_token: this.txFromJSON<Result<void>>,
        commit_archive_root: this.txFromJSON<Result<u64>>,
        get_multisig_config: this.txFromJSON<Result<MultisigConfig>>,
        migrate_user_record: this.txFromJSON<boolean>,
        remove_backup_admin: this.txFromJSON<Result<void>>,
        set_multisig_config: this.txFromJSON<Result<void>>,
        unblacklist_address: this.txFromJSON<Result<void>>,
        withdraw_from_yield: this.txFromJSON<Result<void>>,
        configure_governance: this.txFromJSON<Result<void>>,
        get_dead_mans_switch: this.txFromJSON<readonly [Option<string>, u64, u64, u64]>,
        get_max_slippage_bps: this.txFromJSON<i128>,
        set_max_slippage_bps: this.txFromJSON<Result<void>>,
        get_effective_fee_bps: this.txFromJSON<i128>,
        get_upgrade_approvals: this.txFromJSON<Array<string>>,
        is_upgrade_authorized: this.txFromJSON<Result<boolean>>,
        set_fee_config_legacy: this.txFromJSON<Result<void>>,
        set_platform_treasury: this.txFromJSON<Result<void>>,
        get_cross_contract_upgrade: this.txFromJSON<Result<TwoPhaseCommit>>,
        commit_cross_contract_upgrade: this.txFromJSON<Result<void>>,
        prepare_cross_contract_upgrade: this.txFromJSON<Result<TwoPhaseCommit>>
  }
}