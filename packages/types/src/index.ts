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
 * Role definitions for the Role-Based Access Control (RBAC) system.
 *
 * Segregates operational privileges across dedicated role boundaries:
 * SuperAdmin, TreasuryManager, ComplianceOfficer, FeeManager.
 */
export enum Role {
  SuperAdmin = 1,
  TreasuryManager = 2,
  ComplianceOfficer = 3,
  FeeManager = 4,
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
   * The swap named a DEX router that the admin has not registered.
   */
  15: {message:"DexNotRegistered"},
  /**
   * The DEX cross-contract call reverted or returned an unusable value.
   */
  16: {message:"SwapFailed"},
  /**
   * The swap delivered less than `min_amount_out`, or moved the output
   * further than `max_slippage_bps` away from the caller's quote.
   */
  17: {message:"SlippageExceeded"},
  /**
   * The swap was submitted after its `deadline` had already passed.
   */
  18: {message:"SwapDeadlineExpired"},
  /**
   * The supplied role is not one the contract recognises.
   */
  20: {message:"InvalidRole"},
  /**
   * A governance proposal id is unknown or no longer votable.
   */
  21: {message:"InvalidProposal"},
  /**
   * A governance operation was attempted before governance was configured.
   */
  22: {message:"GovernanceNotConfigured"},
  /**
   * The caller has already voted on this proposal.
   */
  23: {message:"AlreadyVoted"},
  /**
   * The configured KYC threshold is negative.
   */
  24: {message:"InvalidKycThreshold"},
  /**
   * A yield operation was attempted before the yield protocol was configured.
   */
  25: {message:"YieldProtocolNotConfigured"},
  /**
   * The yield amount is not positive or exceeds the available principal.
   */
  26: {message:"InvalidYieldAmount"},
  /**
   * No price-feed oracle is configured for this contract.
   */
  27: {message:"OracleNotConfigured"},
  /**
   * The oracle cross-contract call reverted or returned an unusable value.
   */
  28: {message:"OracleCallFailed"},
  /**
   * The oracle quote is older than the configured staleness threshold.
   */
  29: {message:"OraclePriceStale"},
  /**
   * The oracle quote is not a usable price (zero or negative).
   */
  30: {message:"OraclePriceInvalid"},
  /**
   * A meta-transaction was submitted after its `deadline` had passed.
   */
  31: {message:"DeadlineExpired"},
  /**
   * The meta-transaction nonce does not match the sender's stored nonce.
   */
  32: {message:"InvalidNonce"},
  /**
   * The meta-transaction signature did not verify against the payload.
   */
  33: {message:"InvalidSignature"},
  /**
   * Swap parameters are self-contradictory or unusable (for example
   * `sell_token == buy_token`, or a non-positive `min_amount_out`).
   */
  19: {message:"InvalidSwapParams"},
  /**
   * A payment above the configured KYC threshold was made by a sender the
   * configured oracle does not recognise.
   */
  34: {message:"KycRequired"}
}

/**
 * Storage keys for all contract instance and persistent data.
 */
export type DataKey = {tag: "Admin", values: void} | {tag: "Governance", values: void} | {tag: "PlatformTreasury", values: void} | {tag: "FeeBps", values: void} | {tag: "FeeCap", values: void} | {tag: "MinLimit", values: void} | {tag: "Paused", values: void} | {tag: "MaxAmount", values: void} | {tag: "UserRecord", values: readonly [string]} | {tag: "UserSpending", values: readonly [string]} | {tag: "UserVolume", values: readonly [string]} | {tag: "Blacklist", values: readonly [string]} | {tag: "RefundBalance", values: readonly [string, string]} | {tag: "TimelockNonce", values: void} | {tag: "TimelockEntry", values: readonly [u64]} | {tag: "Frozen", values: void} | {tag: "UserRole", values: readonly [string, Role]} | {tag: "Role", values: readonly [Role]} | {tag: "MetaNonce", values: readonly [string]} | {tag: "KycOracle", values: void} | {tag: "KycThreshold", values: void} | {tag: "OracleAddress", values: void} | {tag: "StalenessThreshold", values: void} | {tag: "FallbackPrice", values: readonly [string, string]} | {tag: "GovernanceToken", values: void} | {tag: "GovernanceQuorum", values: void} | {tag: "GovernanceNonce", values: void} | {tag: "GovernanceProposal", values: readonly [u64]} | {tag: "GovernanceVote", values: readonly [u64, string]} | {tag: "ArchiveEpoch", values: void} | {tag: "ArchiveRoot", values: readonly [u64]} | {tag: "ArchiveMeta", values: readonly [u64]} | {tag: "YieldProtocol", values: void} | {tag: "YieldPrincipal", values: readonly [string]} | {tag: "RegisteredDex", values: readonly [string]} | {tag: "MaxSlippageBps", values: void};


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
export type ActionType = {tag: "SetPlatformTreasury", values: readonly [string]} | {tag: "SetFeeConfig", values: readonly [i128, i128]} | {tag: "SetFeeBps", values: readonly [i128]} | {tag: "SetGovernance", values: readonly [string]} | {tag: "SetMinLimit", values: readonly [i128]} | {tag: "TransferAdmin", values: readonly [string]} | {tag: "Upgrade", values: readonly [Buffer]} | {tag: "RegisterDex", values: readonly [string]} | {tag: "DeregisterDex", values: readonly [string]} | {tag: "SetMaxSlippageBps", values: readonly [i128]};


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
 * `BytesN<24>` (still readable via `unpack_legacy_spending`); this struct is
 * not read from or written to storage at runtime.
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
 * A single archive leaf descriptor passed into `commit_archive_root` and
 * `prune_archived_entries`.
 *
 * The contract uses `record_type + primary_key (+ secondary_key)` to locate
 * the corresponding `DataKey` to delete during a prune. It does not re-hash
 * the leaves — the Merkle root is computed and trusted from off-chain.
 */
export interface ArchiveLeaf {
  /**
 * Primary key address:
 * - `UserVolume` / `UserSpending`: the sender address.
 * - `RefundBalance`: the user (sender) address.
 */
primary_key: string;
  /**
 * Which type of record this leaf represents.
 */
record_type: ArchiveRecordType;
  /**
 * Secondary key address:
 * - `RefundBalance`: the token contract address.
 * - Other types: ignored (may be any address).
 */
secondary_key: string;
}


/**
 * Metadata stored alongside each archive root.
 */
export interface ArchiveMetadata {
  /**
 * Unix timestamp (seconds) when this archive epoch was committed.
 */
committed_at: u64;
  /**
 * Free-form description tag (e.g. `"user_volume:2026-09"`).
 */
description: string;
  /**
 * Total number of leaf records included in this archive.
 */
record_count: u32;
}

/**
 * Record types supported by the archival system.
 *
 * The `repr(u32)` discriminant doubles as the tag byte prepended when
 * computing leaf hashes off-chain.
 */
export enum ArchiveRecordType {
  UserVolume = 1,
  UserSpending = 2,
  RefundBalance = 3,
}

export interface Client {
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
   * Replaces this contract's WASM with a previously uploaded version. SuperAdmin-protected.
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
   * Panics if the current SuperAdmin does not authorize the call, or if
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
  version: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a has_role transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Queries whether a given account holds an active role assignment.
   *
   * Checks persistent user role assignments and primary designated roles.
   *
   * # Parameters
   * - `account`: Address to query.
   * - `role`: Role variant to check.
   *
   * # Returns
   * `true` if authorized for this role, `false` otherwise.
   */
  has_role: ({account, role}: {account: string, role: Role}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a unfreeze transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Removes the frozen state, restoring normal contract operation.
   *
   * Like `emergency_freeze`, this takes effect immediately and does not
   * go through the timelock.
   *
   * SuperAdmin authorization is required.
   */
  unfreeze: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Set a new admin. SuperAdmin-protected.
   *
   * # Parameters
   * - `new_admin`: Address to install as the new admin.
   *
   * # Returns
   * Always `Ok(())`.
   *
   * # Panics
   * Panics if an admin is already set and current SuperAdmin does not authorize the call.
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pauses or unpauses the payment router. ComplianceOfficer-protected.
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
   * Panics if the current ComplianceOfficer does not authorize the call.
   *
   * This is NOT timelocked — operational pausing must remain instant.
   */
  set_pause: ({paused}: {paused: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * One-time setup: records the admin and the initial fee configuration
   * in instance storage. Must be called before `route_payment`.
   *
   * # Parameters
   * * `env` - The Soroban environment interface.
   * * `sender` - The address initiating the payment. Must authorize the transaction.
   * * `recipient` - The destination address for the payment (e.g., the Anchor's wallet for fiat withdrawals).
   * * `platform_treasury` - The address where the platform fee will be deposited.
   * * `token_address` - The contract ID of the token asset being transferred (e.g., NGNC or USDC).
   * * `amount` - The total amount of tokens to be routed (inclusive of the fee).
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
   * Assigns an operational role to a specified account.
   *
   * Restricted exclusively to `SuperAdmin`.
   *
   * # Parameters
   * - `account`: Target address to receive the role.
   * - `role`: The `Role` variant to grant.
   *
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if contract is uninitialized.
   *
   * # Panics
   * Panics if the current `SuperAdmin` does not authorize the call.
   */
  assign_role: ({account, role}: {account: string, role: Role}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a revoke_role transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Revokes an operational role from a specified account.
   *
   * Restricted exclusively to `SuperAdmin`. Prevents removing the active SuperAdmin
   * when it would leave the contract without root governance.
   *
   * # Parameters
   * - `account`: Target address from which the role will be revoked.
   * - `role`: The `Role` variant to revoke.
   *
   * # Returns
   * `Ok(())` on success, `Err(Error::InvalidRole)` if attempting to revoke own SuperAdmin,
   * or `Err(Error::NotInitialized)`.
   *
   * # Panics
   * Panics if the current `SuperAdmin` does not authorize the call.
   */
  revoke_role: ({account, role}: {account: string, role: Role}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a register_dex transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Allows swap routing to invoke a DEX router contract. Admin-only.
   *
   * Restricting cross-contract calls to a registered allowlist is what keeps
   * swap routing pointed at audited code.
   *
   * # Parameters
   * - `dex`: Contract ID of the DEX router to approve.
   *
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract has
   * no admin set yet.
   *
   * # Panics
   * Panics if the current admin does not authorize the call.
   *
   * DEPRECATED for direct use.  Queue via `queue_action(ActionType::RegisterDex(…))`
   * and execute after 24 hours.
   */
  register_dex: ({dex}: {dex: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a harvest_yield transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Claims all currently available yield to the platform treasury. TreasuryManager-protected.
   */
  harvest_yield: ({token}: {token: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

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
   * Sets the minimum allowed routing amount. FeeManager-protected.
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
   * Panics if the current FeeManager does not authorize the call.
   *
   * DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetMinLimit(…))`.
   */
  set_min_limit: ({min_limit}: {min_limit: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a deregister_dex transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Stops swap routing from invoking a DEX router contract. Admin-only.
   *
   * # Parameters
   * - `dex`: Contract ID of the DEX router to revoke.
   *
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract has
   * no admin set yet.
   *
   * # Panics
   * Panics if the current admin does not authorize the call.
   *
   * DEPRECATED for direct use.  Queue via `queue_action(ActionType::DeregisterDex(…))`
   * and execute after 24 hours.
   */
  deregister_dex: ({dex}: {dex: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a get_meta_nonce transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the current meta-transaction nonce for a user.
   *
   * Relayers must use this nonce when building the signed payload.
   * The nonce starts at `0` and increments after each successful
   * `route_payment_meta`, preventing replay attacks.
   */
  get_meta_nonce: ({user}: {user: string}, options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a get_role_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the administrative role governing the specified role.
   *
   * In this RBAC architecture, `SuperAdmin` governs all operational roles.
   */
  get_role_admin: ({_role}: {_role: Role}, options?: MethodOptions) => Promise<AssembledTransaction<Role>>

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
   * Recovers tokens accidentally sent directly to the contract address. TreasuryManager-protected.
   *
   * # Parameters
   * - `token`: Contract ID of the token to recover.
   * - `amount`: Amount to transfer from the contract's balance to the treasury manager.
   *
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   *
   * # Panics
   * Panics if the current TreasuryManager does not authorize the call, or if the
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
   * Construct and simulate a set_kyc_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Configures the trusted KYC oracle and the high-value payment threshold. ComplianceOfficer-protected.
   */
  set_kyc_config: ({oracle, threshold}: {oracle: string, threshold: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a transfer_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfers admin rights to a new address. Requires current SuperAdmin authorization.
   *
   * # Parameters
   * - `new_admin`: Address to become the new admin.
   *
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   *
   * # Panics
   * Panics if the current SuperAdmin does not authorize the call.
   *
   * DEPRECATED for direct use.  Queue via `queue_action(ActionType::TransferAdmin(…))`.
   */
  transfer_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a approve_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Records `signer`'s authorization of an upgrade to `new_wasm_hash`.
   * 
   * Each group member signs off separately so the M signatures are genuinely
   * independent: one compromised key cannot produce a quorum, and every
   * approval is bound to one specific WASM hash.
   * 
   * Reaching the threshold does not install the WASM by itself — call
   * `upgrade` (or `execute_action` on a queued [`ActionType::Upgrade`]) to
   * apply it. Keeping those two steps separate lets the group approve a hash
   * and then route the installation through the 24-hour timelock if it wants
   * observers to see it coming.
   * 
   * # Parameters
   * - `signer`: The group member approving; must authorize this call.
   * - `new_wasm_hash`: The WASM hash being approved.
   * 
   * # Returns
   * `Ok(())` on success, `Err(Error::MultisigNotInitialized)` if no group
   * is configured, `Err(Error::NotMultisigSigner)` if `signer` is not a
   * group member, or `Err(Error::AlreadyApproved)` if `signer` already
   * approved this hash.
   * 
   * # Panics
   * Panics if `signer` does not authorize the call.
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
   * Construct and simulate a deposit_to_yield transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Deposits idle treasury funds into the configured lending protocol.
   *
   * Both the TreasuryManager and treasury authorize this operation. The second
   * authorization is required because the funds are held by the treasury,
   * rather than by this router contract.
   */
  deposit_to_yield: ({token, amount}: {token: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a get_archive_info transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the Merkle root and metadata for an archive epoch, or `None`
   * if no archive exists for that epoch.
   */
  get_archive_info: ({epoch}: {epoch: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<readonly [Buffer, ArchiveMetadata]>>>

  /**
   * Construct and simulate a get_fee_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_fee_proposal: ({proposal_id}: {proposal_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<FeeProposal>>>

  /**
   * Construct and simulate a set_price_oracle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Configures the price-feed oracle contract address. ComplianceOfficer-protected.
   *
   * The oracle contract must implement the [`PriceFeedOracle`] interface:
   * it must expose a `get_price(base_asset, quote_asset) -> PriceData`
   * method that returns the latest price together with a Unix timestamp so
   * staleness can be validated against the configured threshold.
   *
   * # Parameters
   * - `oracle`: Address of the oracle contract to use for price lookups.
   *
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has not been initialized.
   *
   * # Panics
   * Panics if the current ComplianceOfficer does not authorize the call.
   */
  set_price_oracle: ({oracle}: {oracle: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a blacklist_address transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Adds an address to the blacklist. ComplianceOfficer-protected.
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
   * Panics if the current ComplianceOfficer does not authorize the call.
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
   * Construct and simulate a get_archive_epoch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the current archive epoch counter (0 = no epochs committed yet).
   */
  get_archive_epoch: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a get_kyc_threshold transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the configured KYC threshold, or `None` when enforcement is off.
   */
  get_kyc_threshold: (options?: MethodOptions) => Promise<AssembledTransaction<Option<i128>>>

  /**
   * Construct and simulate a get_queued_action transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the pending `TimelockEntry` for the given nonce, or an error if
   * it does not exist.
   */
  get_queued_action: ({nonce}: {nonce: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<TimelockEntry>>>

  /**
   * Construct and simulate a is_dex_registered transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns whether a DEX router is approved for swap routing.
   *
   * # Parameters
   * - `dex`: Contract ID to check.
   *
   * # Returns
   * `true` if the DEX may be used by `route_payment_with_swap`, `false`
   * otherwise.
   *
   * # Panics
   * Does not panic.
   */
  is_dex_registered: ({dex}: {dex: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a vote_fee_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Casts one weighted vote on an open fee proposal.
   */
  vote_fee_proposal: ({voter, proposal_id, support}: {voter: string, proposal_id: u64, support: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a emergency_withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin-only emergency withdrawal of tokens held by this contract.
   *
   * # Parameters
   * - `token`: Contract ID of the token to withdraw.
   * Admin-only emergency withdrawal of tokens held by this contract. TreasuryManager-protected.
   *
   * # Parameters
   * - `token`: Contract ID of the token to withdraw.
   * - `amount`: Amount to transfer from the contract's balance to the treasury manager.
   *
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   *
   * # Panics
   * Panics if the current TreasuryManager does not authorize the call, or if the
   * token transfer fails (e.g. the contract's balance is below `amount`).
   */
  emergency_withdraw: ({token, amount}: {token: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_fallback_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the stored fallback price for a (base, quote) asset pair, if any.
   *
   * # Parameters
   * - `base_asset`: Address of the base asset.
   * - `quote_asset`: Address of the quote asset.
   *
   * # Returns
   * `Some(PriceData)` if a fallback has been configured, `None` otherwise.
   */
  get_fallback_price: ({base_asset, quote_asset}: {base_asset: string, quote_asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PriceData>>>

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
   * Construct and simulate a get_yield_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the tracked principal deposited for `token`.
   */
  get_yield_position: ({token}: {token: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a propose_fee_change transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a fee proposal weighted by governance-token balances.
   */
  propose_fee_change: ({proposer, fee_bps, fee_cap, voting_period}: {proposer: string, fee_bps: i128, fee_cap: i128, voting_period: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a route_payment_meta transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Routes a payment authorised by an off-chain relayer's Ed25519 signature
   * instead of the sender's on-chain authorization.
   *
   * The relayer signs a canonical payload binding the sender, recipient,
   * token, amount, nonce and deadline. The contract verifies the signature,
   * burns the nonce to block replays, and then settles the payment through
   * the same accounting as a direct `route_payment`.
   *
   * # Parameters
   * - `sender`: Address whose funds are routed and whose nonce is consumed.
   * - `signer_pubkey`: Ed25519 public key that must have signed the payload.
   * - `recipient`: Address the funds are delivered to.
   * - `token_address`: Contract ID of the token being transferred.
   * - `amount`: Amount to route in the token's smallest unit.
   * - `nonce`: Must equal the sender's current meta-transaction nonce.
   * - `deadline`: Ledger timestamp after which the submission is rejected.
   * - `signature`: Ed25519 signature over the canonical payload.
   *
   * # Returns
   * `Ok(())` once the payment has settled.
   *
   * # Panics
   * Panics if the signature does not verify.
   */
  route_payment_meta: ({sender, signer_pubkey, recipient, token_address, amount, nonce, deadline, signature}: {sender: string, signer_pubkey: Buffer, recipient: string, token_address: string, amount: i128, nonce: u64, deadline: u64, signature: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_fallback_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Stores an admin-supplied fallback price for a (base, quote) asset pair.
   * ComplianceOfficer-protected.
   *
   * The fallback is used by [`get_price`] when the live oracle is
   * unavailable or returns data that fails validation (stale or invalid).
   * Setting a fallback price to `0` effectively removes the fallback,
   * meaning that oracle failures will propagate as errors rather than
   * silently using a stale cached value.
   *
   * # Parameters
   * - `base_asset`: Address of the base asset (e.g. XLM contract).
   * - `quote_asset`: Address of the quote asset (e.g. USDC contract).
   * - `fallback_price`: Price expressed in the same fixed-point format as
   * the oracle (`price / 10^decimals`). Pass `0` to clear the fallback.
   * - `decimals`: Decimal precision of `fallback_price`.
   *
   * # Returns
   * `Ok(())` on success.
   *
   * # Panics
   * Panics if the current ComplianceOfficer does not authorize the call.
   */
  set_fallback_price: ({base_asset, quote_asset, fallback_price, decimals}: {base_asset: string, quote_asset: string, fallback_price: i128, decimals: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_yield_protocol transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Configures the lending protocol used for treasury yield operations. TreasuryManager-protected.
   */
  set_yield_protocol: ({protocol}: {protocol: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a unblacklist_address transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Removes an address from the blacklist. ComplianceOfficer-protected.
   *
   * # Parameters
   * - `address`: Address to remove from the blacklist.
   *
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   *
   * # Panics
   * Panics if the current ComplianceOfficer does not authorize the call.
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
   * Construct and simulate a execute_fee_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Finalizes a successful fee proposal after its voting period ends.
   */
  execute_fee_proposal: ({proposal_id}: {proposal_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Updates the treasury address that receives the platform fee. Protected by TreasuryManager.
   *
   * # Parameters
   * - `new_treasury`: Address to receive platform fees going forward.
   *
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   *
   * # Panics
   * Panics if the current TreasuryManager does not authorize the call.
   *
   * DEPRECATED for direct use.  Queue via `queue_action(ActionType::SetPlatformTreasury(…))`
   * and execute after 24 hours.  This direct path is retained for tooling
   * compatibility only.
   */
  set_platform_treasury: ({new_treasury}: {new_treasury: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a prune_archived_entries transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Deletes on-chain ledger entries committed via `commit_archive_root`.
   *
   * Requires the epoch from a prior commit call. Silently skips absent
   * entries. Returns the count of entries removed.
   *
   * Supported: UserVolume, UserSpending, RefundBalance.
   * Errors: NotInitialized, ContractFrozen, TimelockNotFound (unknown epoch).
   * Requires TreasuryManager.
   */
  prune_archived_entries: ({committed_epoch, leaves}: {committed_epoch: u64, leaves: Array<ArchiveLeaf>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a route_payment_with_swap transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Routes a payment in any token, swapping it into the recipient's
   * preferred token on the way.
   *
   * The swap-routed counterpart of [`PaymentRouter::route_payment`]: the same
   * fee, limit, blacklist, and freeze rules apply, with the conversion
   * inserted between pulling the funds and delivering them. The platform fee
   * is taken on the `buy_token` output, so `fee_cap` applies in `buy_token`
   * units for this route.
   *
   * # Parameters
   * - `payment`: The swap-routed transfer (see [`SwapPayment`]).
   *
   * # Returns
   * The amount of `buy_token` delivered to the recipient, after the
   * platform fee. Otherwise the payment is abandoned whole, with:
   * - `Err(Error::InvalidSwapParams)`, `Err(Error::SwapDeadlineExpired)`,
   * `Err(Error::DexNotRegistered)`, `Err(Error::SwapFailed)`, or
   * `Err(Error::SlippageExceeded)` for swap-specific problems,
   * - the same `Err` variants as `route_payment` otherwise.
   *
   * # Panics
   * Panics if `payment.sender` does not authorize the call, or if a token
   * transfer out of this contract fails.
   */
  route_payment_with_swap: ({payment}: {payment: SwapPayment}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a set_staleness_threshold transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the maximum age (in seconds) a price reading may have before it is
   * considered stale. ComplianceOfficer-protected.
   *
   * When a price timestamp is older than `(current_ledger_time - threshold)`
   * the reading is rejected with [`Error::OraclePriceStale`] and the
   * fallback price (if configured) is used instead.
   *
   * # Parameters
   * - `threshold_secs`: Maximum allowed age in seconds. A value of `0`
   * disables the staleness check entirely (every price is accepted).
   *
   * # Returns
   * `Ok(())` on success.
   *
   * # Panics
   * Panics if the current ComplianceOfficer does not authorize the call.
   */
  set_staleness_threshold: ({threshold_secs}: {threshold_secs: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a route_payments_with_swap transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Routes several swap-routed payments in a single transaction. If any
   * payment fails, the entire batch is reverted atomically, including any
   * swaps that already executed earlier in the batch.
   *
   * # Parameters
   * - `payments`: Batch of swap-routed transfers to apply in order. See
   * [`SwapPayment`] for per-item constraints.
   *
   * # Returns
   * The total amount of `buy_token` delivered across the batch, or the
   * first error encountered (see `route_payment_with_swap` for the
   * possible variants and their causes).
   *
   * # Panics
   * Panics if any payment's `sender` does not authorize the call, or if a
   * token transfer out of this contract fails.
   */
  route_payments_with_swap: ({payments}: {payments: Array<SwapPayment>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

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
      new ContractSpec([ "AAAAAwAAAMJSb2xlIGRlZmluaXRpb25zIGZvciB0aGUgUm9sZS1CYXNlZCBBY2Nlc3MgQ29udHJvbCAoUkJBQykgc3lzdGVtLgoKU2VncmVnYXRlcyBvcGVyYXRpb25hbCBwcml2aWxlZ2VzIGFjcm9zcyBkZWRpY2F0ZWQgcm9sZSBib3VuZGFyaWVzOgpTdXBlckFkbWluLCBUcmVhc3VyeU1hbmFnZXIsIENvbXBsaWFuY2VPZmZpY2VyLCBGZWVNYW5hZ2VyLgAAAAAAAAAAAARSb2xlAAAABAAAAIhTdXByZW1lIGFkbWluaXN0cmF0b3Igd2l0aCBleGNsdXNpdmUgYXV0aG9yaXR5IG92ZXIgcm9sZSBhc3NpZ25tZW50cywKY29udHJhY3QgdXBncmFkZXMsIGVtZXJnZW5jeSBmcmVlemUvdW5mcmVlemUsIGFuZCByb290IGdvdmVybmFuY2UuAAAAClN1cGVyQWRtaW4AAAAAAAEAAAB7TWFuYWdlciB3aXRoIGV4Y2x1c2l2ZSBhdXRob3JpdHkgb3ZlciBwbGF0Zm9ybSB0cmVhc3VyeSwgeWllbGQgb3BlcmF0aW9ucywKdG9rZW4gcmVjb3ZlcnksIGFuZCBlbWVyZ2VuY3kgYXNzZXQgd2l0aGRyYXdhbHMuAAAAAA9UcmVhc3VyeU1hbmFnZXIAAAAAAgAAAIFDb21wbGlhbmNlIG9mZmljZXIgd2l0aCBhdXRob3JpdHkgb3ZlciBhZGRyZXNzIGJsYWNrbGlzdGluZywgS1lDIG9yYWNsZQpjb25maWd1cmF0aW9ucywgYW5kIGVtZXJnZW5jeSBvcGVyYXRpb25hbCBwYXVzZSBzd2l0Y2hlcy4AAAAAAAARQ29tcGxpYW5jZU9mZmljZXIAAAAAAAADAAAAYEZlZSBtYW5hZ2VyIHdpdGggYXV0aG9yaXR5IG92ZXIgcGxhdGZvcm0gZmVlIGJhc2lzIHBvaW50cywgZmVlIGNhcHMsIGFuZAptaW5pbXVtIHBheW1lbnQgbGltaXRzLgAAAApGZWVNYW5hZ2VyAAAAAAAE",
        "AAAAAAAAAKxSZXR1cm5zIHRoZSBjdXJyZW50IHByb3RvY29sIGZlZSBwZXJjZW50YWdlIGluIGJhc2lzIHBvaW50cy4KCiMgUmV0dXJucwpUaGUgY29uZmlndXJlZCBgZmVlX2Jwc2AsIG9yIGAwYCBpZiB0aGUgY29udHJhY3QgaGFzIG5vdCBiZWVuCmluaXRpYWxpemVkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAB2dldF9mZWUAAAAAAAAAAAEAAAAL",
        "AAAAAAAAAidSZXBsYWNlcyB0aGlzIGNvbnRyYWN0J3MgV0FTTSB3aXRoIGEgcHJldmlvdXNseSB1cGxvYWRlZCB2ZXJzaW9uLiBTdXBlckFkbWluLXByb3RlY3RlZC4KCiMgUGFyYW1ldGVycwotIGBuZXdfd2FzbV9oYXNoYDogSGFzaCBvZiBhIFdBU00gYmxvYiBwcmV2aW91c2x5IHVwbG9hZGVkIHRvIHRoZQpuZXR3b3JrLCB0byBpbnN0YWxsIGFzIHRoaXMgY29udHJhY3QncyBuZXcgZXhlY3V0YWJsZS4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBTdXBlckFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYKYG5ld193YXNtX2hhc2hgIGRvZXMgbm90IHJlZmVyZW5jZSBhIHByZXZpb3VzbHkgdXBsb2FkZWQgV0FTTSBibG9iLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlVwZ3JhZGUo4oCmKSlgLgAAAAAHdXBncmFkZQAAAAABAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAHBSZXR1cm5zIHRoZSBjb250cmFjdCB2ZXJzaW9uLgoKIyBSZXR1cm5zClRoZSBjb250cmFjdCdzIHZlcnNpb24gbnVtYmVyLCBjdXJyZW50bHkgYDFgLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAB3ZlcnNpb24AAAAAAAAAAAEAAAAE",
        "AAAABAAAAIpDb250cmFjdC1sZXZlbCBlcnJvcnMgcmV0dXJuZWQgaW5zdGVhZCBvZiBwYW5pY2tpbmcsIHNvIGNhbGxlcnMgZ2V0IGEKc3BlY2lmaWMsIHN0YWJsZSBlcnJvciBjb2RlIHRvIGJyYW5jaCBvbiByYXRoZXIgdGhhbiBhbiBvcGFxdWUgdHJhcC4AAAAAAAAAAAAFRXJyb3IAAAAAAAAiAAAARUNhbGxlciBpcyBub3QgYXV0aG9yaXplZCB0byBwZXJmb3JtIHRoaXMgYWN0aW9uIChlLmcuIG5vdCB0aGUgYWRtaW4pLgAAAAAAAAxVbmF1dGhvcml6ZWQAAAABAAAAQlNlbmRlcidzIHRva2VuIGJhbGFuY2UgaXMgbG93ZXIgdGhhbiB0aGUgcmVxdWVzdGVkIHBheW1lbnQgYW1vdW50LgAAAAAAE0luc3VmZmljaWVudEJhbGFuY2UAAAAAAgAAAE1SZXF1ZXN0ZWQgYW1vdW50IGlzIG91dHNpZGUgYWxsb3dlZCBib3VuZHMsIG9yIGEgc3BlbmRpbmcgbGltaXQgd2FzIGV4Y2VlZGVkLgAAAAAAAA1MaW1pdEV4Y2VlZGVkAAAAAAAAAwAAAERgaW5pdGlhbGl6ZWAgd2FzIGNhbGxlZCBvbiBhIGNvbnRyYWN0IHRoYXQgYWxyZWFkeSBoYXMgYW4gYWRtaW4gc2V0LgAAABJBbHJlYWR5SW5pdGlhbGl6ZWQAAAAAAAQAAABOQW4gYWRtaW4tY29uZmlndXJlZCB2YWx1ZSAodHJlYXN1cnksIGZlZSwgYWRtaW4pIHdhcyByZWFkIGJlZm9yZSBgaW5pdGlhbGl6ZWAuAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAUAAABMVGhlIGNvbnRyYWN0IGlzIGN1cnJlbnRseSBwYXVzZWQ7IHJvdXRpbmcgY2FsbHMgYXJlIHJlamVjdGVkIHVudGlsIHVucGF1c2VkLgAAAAZQYXVzZWQAAAAAAAYAAABMQSBmZWUgY29uZmlndXJhdGlvbiB2YWx1ZSAoYmFzaXMgcG9pbnRzIG9yIGNhcCkgaXMgb3V0IG9mIHRoZSBhbGxvd2VkIHJhbmdlLgAAAA5JbnZhbGlkRmVlUmF0ZQAAAAAABwAAAEdTZW5kZXIgYW5kIHJlY2lwaWVudCBhZGRyZXNzZXMgYXJlIHRoZSBzYW1lIChzZWxmLXJvdXRpbmcgbm90IGFsbG93ZWQpLgAAAAAQSW52YWxpZFJlY2lwaWVudAAAAAgAAAAhUmVjaXBpZW50IGFkZHJlc3MgaXMgYmxhY2tsaXN0ZWQuAAAAAAAAC0JsYWNrbGlzdGVkAAAAAAkAAABPUmVxdWVzdGVkIHJlZnVuZCB3aXRoZHJhd2FsIGFtb3VudCBpcyB6ZXJvIG9yIGV4Y2VlZHMgYXZhaWxhYmxlIHJlZnVuZCBiYWxhbmNlLgAAAAARTm9SZWZ1bmRBdmFpbGFibGUAAAAAAAAKAAAAvEFuIGFjdGlvbiBpcyBhbHJlYWR5IHBlbmRpbmcgaW4gdGhlIHRpbWVsb2NrIHF1ZXVlOyBpdCBtdXN0IGJlIGV4ZWN1dGVkCm9yIGNhbmNlbGxlZCBiZWZvcmUgYSBkdXBsaWNhdGUgY2FuIGJlIHF1ZXVlZCAobm90IGN1cnJlbnRseSBlbmZvcmNlZCwKYnV0IHJlc2VydmVkIGZvciBmdXR1cmUgZGVkdXBsaWNhdGlvbiBsb2dpYykuAAAAD1RpbWVsb2NrUGVuZGluZwAAAAALAAAAQ1RoZSAyNC1ob3VyIGRlbGF5IGZvciB0aGUgZ2l2ZW4gdGltZWxvY2sgZW50cnkgaGFzIG5vdCBlbGFwc2VkIHlldC4AAAAAEFRpbWVsb2NrTm90UmVhZHkAAAAMAAAAM05vIHRpbWVsb2NrIGVudHJ5IGV4aXN0cyBmb3IgdGhlIHN1cHBsaWVkIG5vbmNlIElELgAAAAAQVGltZWxvY2tOb3RGb3VuZAAAAA0AAABJVGhlIGNvbnRyYWN0IGlzIGZyb3plbjsgYWxsIHBheW1lbnRzIGFuZCB0aW1lbG9jayBleGVjdXRpb25zIGFyZSBibG9ja2VkLgAAAAAAAA5Db250cmFjdEZyb3plbgAAAAAADgAAAD5UaGUgc3dhcCBuYW1lZCBhIERFWCByb3V0ZXIgdGhhdCB0aGUgYWRtaW4gaGFzIG5vdCByZWdpc3RlcmVkLgAAAAAAEERleE5vdFJlZ2lzdGVyZWQAAAAPAAAAQ1RoZSBERVggY3Jvc3MtY29udHJhY3QgY2FsbCByZXZlcnRlZCBvciByZXR1cm5lZCBhbiB1bnVzYWJsZSB2YWx1ZS4AAAAAClN3YXBGYWlsZWQAAAAAABAAAACAVGhlIHN3YXAgZGVsaXZlcmVkIGxlc3MgdGhhbiBgbWluX2Ftb3VudF9vdXRgLCBvciBtb3ZlZCB0aGUgb3V0cHV0CmZ1cnRoZXIgdGhhbiBgbWF4X3NsaXBwYWdlX2Jwc2AgYXdheSBmcm9tIHRoZSBjYWxsZXIncyBxdW90ZS4AAAAQU2xpcHBhZ2VFeGNlZWRlZAAAABEAAAA/VGhlIHN3YXAgd2FzIHN1Ym1pdHRlZCBhZnRlciBpdHMgYGRlYWRsaW5lYCBoYWQgYWxyZWFkeSBwYXNzZWQuAAAAABNTd2FwRGVhZGxpbmVFeHBpcmVkAAAAABIAAAA1VGhlIHN1cHBsaWVkIHJvbGUgaXMgbm90IG9uZSB0aGUgY29udHJhY3QgcmVjb2duaXNlcy4AAAAAAAALSW52YWxpZFJvbGUAAAAAFAAAADlBIGdvdmVybmFuY2UgcHJvcG9zYWwgaWQgaXMgdW5rbm93biBvciBubyBsb25nZXIgdm90YWJsZS4AAAAAAAAPSW52YWxpZFByb3Bvc2FsAAAAABUAAABGQSBnb3Zlcm5hbmNlIG9wZXJhdGlvbiB3YXMgYXR0ZW1wdGVkIGJlZm9yZSBnb3Zlcm5hbmNlIHdhcyBjb25maWd1cmVkLgAAAAAAF0dvdmVybmFuY2VOb3RDb25maWd1cmVkAAAAABYAAAAuVGhlIGNhbGxlciBoYXMgYWxyZWFkeSB2b3RlZCBvbiB0aGlzIHByb3Bvc2FsLgAAAAAADEFscmVhZHlWb3RlZAAAABcAAAApVGhlIGNvbmZpZ3VyZWQgS1lDIHRocmVzaG9sZCBpcyBuZWdhdGl2ZS4AAAAAAAATSW52YWxpZEt5Y1RocmVzaG9sZAAAAAAYAAAASUEgeWllbGQgb3BlcmF0aW9uIHdhcyBhdHRlbXB0ZWQgYmVmb3JlIHRoZSB5aWVsZCBwcm90b2NvbCB3YXMgY29uZmlndXJlZC4AAAAAAAAaWWllbGRQcm90b2NvbE5vdENvbmZpZ3VyZWQAAAAAABkAAABEVGhlIHlpZWxkIGFtb3VudCBpcyBub3QgcG9zaXRpdmUgb3IgZXhjZWVkcyB0aGUgYXZhaWxhYmxlIHByaW5jaXBhbC4AAAASSW52YWxpZFlpZWxkQW1vdW50AAAAAAAaAAAANU5vIHByaWNlLWZlZWQgb3JhY2xlIGlzIGNvbmZpZ3VyZWQgZm9yIHRoaXMgY29udHJhY3QuAAAAAAAAE09yYWNsZU5vdENvbmZpZ3VyZWQAAAAAGwAAAEZUaGUgb3JhY2xlIGNyb3NzLWNvbnRyYWN0IGNhbGwgcmV2ZXJ0ZWQgb3IgcmV0dXJuZWQgYW4gdW51c2FibGUgdmFsdWUuAAAAAAAQT3JhY2xlQ2FsbEZhaWxlZAAAABwAAABCVGhlIG9yYWNsZSBxdW90ZSBpcyBvbGRlciB0aGFuIHRoZSBjb25maWd1cmVkIHN0YWxlbmVzcyB0aHJlc2hvbGQuAAAAAAAQT3JhY2xlUHJpY2VTdGFsZQAAAB0AAAA6VGhlIG9yYWNsZSBxdW90ZSBpcyBub3QgYSB1c2FibGUgcHJpY2UgKHplcm8gb3IgbmVnYXRpdmUpLgAAAAAAEk9yYWNsZVByaWNlSW52YWxpZAAAAAAAHgAAAEFBIG1ldGEtdHJhbnNhY3Rpb24gd2FzIHN1Ym1pdHRlZCBhZnRlciBpdHMgYGRlYWRsaW5lYCBoYWQgcGFzc2VkLgAAAAAAAA9EZWFkbGluZUV4cGlyZWQAAAAAHwAAAERUaGUgbWV0YS10cmFuc2FjdGlvbiBub25jZSBkb2VzIG5vdCBtYXRjaCB0aGUgc2VuZGVyJ3Mgc3RvcmVkIG5vbmNlLgAAAAxJbnZhbGlkTm9uY2UAAAAgAAAAQlRoZSBtZXRhLXRyYW5zYWN0aW9uIHNpZ25hdHVyZSBkaWQgbm90IHZlcmlmeSBhZ2FpbnN0IHRoZSBwYXlsb2FkLgAAAAAAEEludmFsaWRTaWduYXR1cmUAAAAhAAAAf1N3YXAgcGFyYW1ldGVycyBhcmUgc2VsZi1jb250cmFkaWN0b3J5IG9yIHVudXNhYmxlIChmb3IgZXhhbXBsZQpgc2VsbF90b2tlbiA9PSBidXlfdG9rZW5gLCBvciBhIG5vbi1wb3NpdGl2ZSBgbWluX2Ftb3VudF9vdXRgKS4AAAAAEUludmFsaWRTd2FwUGFyYW1zAAAAAAAAEwAAAGtBIHBheW1lbnQgYWJvdmUgdGhlIGNvbmZpZ3VyZWQgS1lDIHRocmVzaG9sZCB3YXMgbWFkZSBieSBhIHNlbmRlciB0aGUKY29uZmlndXJlZCBvcmFjbGUgZG9lcyBub3QgcmVjb2duaXNlLgAAAAALS3ljUmVxdWlyZWQAAAAAIg==",
        "AAAAAAAAARdRdWVyaWVzIHdoZXRoZXIgYSBnaXZlbiBhY2NvdW50IGhvbGRzIGFuIGFjdGl2ZSByb2xlIGFzc2lnbm1lbnQuCgpDaGVja3MgcGVyc2lzdGVudCB1c2VyIHJvbGUgYXNzaWdubWVudHMgYW5kIHByaW1hcnkgZGVzaWduYXRlZCByb2xlcy4KCiMgUGFyYW1ldGVycwotIGBhY2NvdW50YDogQWRkcmVzcyB0byBxdWVyeS4KLSBgcm9sZWA6IFJvbGUgdmFyaWFudCB0byBjaGVjay4KCiMgUmV0dXJucwpgdHJ1ZWAgaWYgYXV0aG9yaXplZCBmb3IgdGhpcyByb2xlLCBgZmFsc2VgIG90aGVyd2lzZS4AAAAACGhhc19yb2xlAAAAAgAAAAAAAAAHYWNjb3VudAAAAAATAAAAAAAAAARyb2xlAAAH0AAAAARSb2xlAAAAAQAAAAE=",
        "AAAAAAAAAMNSZW1vdmVzIHRoZSBmcm96ZW4gc3RhdGUsIHJlc3RvcmluZyBub3JtYWwgY29udHJhY3Qgb3BlcmF0aW9uLgoKTGlrZSBgZW1lcmdlbmN5X2ZyZWV6ZWAsIHRoaXMgdGFrZXMgZWZmZWN0IGltbWVkaWF0ZWx5IGFuZCBkb2VzIG5vdApnbyB0aHJvdWdoIHRoZSB0aW1lbG9jay4KClN1cGVyQWRtaW4gYXV0aG9yaXphdGlvbiBpcyByZXF1aXJlZC4AAAAACHVuZnJlZXplAAAAAAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAA71GZXRjaGVzIHRoZSBjdXJyZW50IGV4Y2hhbmdlIHJhdGUgZm9yIGEgYChiYXNlX2Fzc2V0LCBxdW90ZV9hc3NldClgCnBhaXIgZnJvbSB0aGUgY29uZmlndXJlZCBwcmljZS1mZWVkIG9yYWNsZSwgdmFsaWRhdGVzIGl0LCBhbmQgcmV0dXJucwp0aGUgcmVzdWx0LgoKRXZlcnkgZmFpbHVyZSBwYXRoIGJlbG93IGZpcnN0IGF0dGVtcHRzIHRvIHNlcnZlIGFuIGFkbWluLWNvbmZpZ3VyZWQKZmFsbGJhY2sgcHJpY2UgZm9yIHRoZSBwYWlyOyB0aGUgb3JhY2xlIGVycm9yIGlzIG9ubHkgc3VyZmFjZWQgd2hlbiBubwpmYWxsYmFjayBleGlzdHMuCgojIyBWYWxpZGF0aW9uIGZsb3cKCjEuICoqT3JhY2xlIGNvbmZpZ3VyZWQ/KiogLSBPdGhlcndpc2UgYEVycihFcnJvcjo6T3JhY2xlTm90Q29uZmlndXJlZClgLgoyLiAqKkNhbGwgb3JhY2xlKiogLSBJbnZva2UgdGhlIG9yYWNsZSdzIGBnZXRfcHJpY2VgOyBhIHRyYXBwZWQgb3IKdW5hdmFpbGFibGUgY29udHJhY3QgeWllbGRzIGBFcnIoRXJyb3I6Ok9yYWNsZUNhbGxGYWlsZWQpYC4KMy4gKipTdGFsZW5lc3MgY2hlY2sqKiAtIFJlamVjdCBhIGBwcmljZV9kYXRhLnRpbWVzdGFtcGAgb2xkZXIgdGhhbiB0aGUKY29uZmlndXJlZCB0aHJlc2hvbGQgKGRlZmF1bHQgMyA2MDAgcykgd2l0aApgRXJyKEVycm9yOjpPcmFjbGVQcmljZVN0YWxlKWAuIEEgdGhyZXNob2xkIG9mIGAwYCBkaXNhYmxlcyB0aGlzIGNoZWNrLgo0LiAqKlZhbGlkaXR5IGNoZWNrKiogLSBBIHByaWNlIDw9IDAgaXMgaW52YWxpZAooYEVycihFcnJvcjo6T3JhY2xlUHJpY2VJbnZhbGlkKWApLgo1LiAqKlJldHVybioqIC0gVGhlIHZhbGlkYXRlZCBgUHJpY2VEYXRhYCBpcyByZXR1cm5lZCB0byB0aGUgY2FsbGVyLgoKYGJhc2VfYXNzZXRgIGlzIHR5cGljYWxseSB0aGUgWExNIG5hdGl2ZSBjb250cmFjdCBhbmQgYHF1b3RlX2Fzc2V0YCB0aGUKVVNEQyBjb250cmFjdC4AAAAAAAAJZ2V0X3ByaWNlAAAAAAAAAgAAAAAAAAAKYmFzZV9hc3NldAAAAAAAEwAAAAAAAAALcXVvdGVfYXNzZXQAAAAAEwAAAAEAAAPpAAAH0AAAAAlQcmljZURhdGEAAAAAAAAD",
        "AAAAAAAAADFSZXR1cm5zIHdoZXRoZXIgdGhlIGNvbnRyYWN0IGlzIGN1cnJlbnRseSBmcm96ZW4uAAAAAAAACWlzX2Zyb3plbgAAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAJRSZXR1cm5zIHdoZXRoZXIgdGhlIGNvbnRyYWN0IGlzIGN1cnJlbnRseSBwYXVzZWQuCgojIFJldHVybnMKYHRydWVgIGlmIHBhdXNlZCwgYGZhbHNlYCBpZiB1bnBhdXNlZCBvciBub3QgeWV0IGluaXRpYWxpemVkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAACWlzX3BhdXNlZAAAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAORTZXQgYSBuZXcgYWRtaW4uIFN1cGVyQWRtaW4tcHJvdGVjdGVkLgoKIyBQYXJhbWV0ZXJzCi0gYG5ld19hZG1pbmA6IEFkZHJlc3MgdG8gaW5zdGFsbCBhcyB0aGUgbmV3IGFkbWluLgoKIyBSZXR1cm5zCkFsd2F5cyBgT2soKCkpYC4KCiMgUGFuaWNzClBhbmljcyBpZiBhbiBhZG1pbiBpcyBhbHJlYWR5IHNldCBhbmQgY3VycmVudCBTdXBlckFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAa9QYXVzZXMgb3IgdW5wYXVzZXMgdGhlIHBheW1lbnQgcm91dGVyLiBDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuCgojIFBhcmFtZXRlcnMKLSBgcGF1c2VkYDogYHRydWVgIHRvIHJlamVjdCBgcm91dGVfcGF5bWVudGAgLyBgcm91dGVfcGF5bWVudHNgCmNhbGxzLCBgZmFsc2VgIHRvIGFsbG93IHRoZW0gYWdhaW4uCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgQ29tcGxpYW5jZU9mZmljZXIgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKVGhpcyBpcyBOT1QgdGltZWxvY2tlZCDigJQgb3BlcmF0aW9uYWwgcGF1c2luZyBtdXN0IHJlbWFpbiBpbnN0YW50LgAAAAAJc2V0X3BhdXNlAAAAAAAAAQAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAgAAADtTdG9yYWdlIGtleXMgZm9yIGFsbCBjb250cmFjdCBpbnN0YW5jZSBhbmQgcGVyc2lzdGVudCBkYXRhLgAAAAAAAAAAB0RhdGFLZXkAAAAAJAAAAAAAAAAaVGhlIGN1cnJlbnQgYWRtaW4gYWRkcmVzcy4AAAAAAAVBZG1pbgAAAAAAAAAAAABQR292ZXJuYW5jZSBjb250cmFjdCBhZGRyZXNzOyBpZiBzZXQsIGl0IHRha2VzIG92ZXIgZmVlLWF1dGhvcml0eSBmcm9tIHRoZSBhZG1pbi4AAAAKR292ZXJuYW5jZQAAAAAAAAAAAC5BZGRyZXNzIHRoYXQgcmVjZWl2ZXMgY29sbGVjdGVkIHBsYXRmb3JtIGZlZXMuAAAAAAAQUGxhdGZvcm1UcmVhc3VyeQAAAAAAAAA6UGxhdGZvcm0gZmVlIHJhdGUsIGluIGJhc2lzIHBvaW50cyAoMS8xMDB0aCBvZiBhIHBlcmNlbnQpLgAAAAAABkZlZUJwcwAAAAAAAAAAADNVcHBlciBib3VuZCBvbiB0aGUgZmVlIHRha2VuIGZyb20gYSBzaW5nbGUgcGF5bWVudC4AAAAABkZlZUNhcAAAAAAAAAAAAEZNaW5pbXVtIGFtb3VudCBhY2NlcHRlZCBieSBgcm91dGVfcGF5bWVudGAgLyBgcm91dGVfcGF5bWVudHNgLCBpZiBzZXQuAAAAAAAITWluTGltaXQAAAAAAAAAJFdoZXRoZXIgcm91dGluZyBpcyBjdXJyZW50bHkgcGF1c2VkLgAAAAZQYXVzZWQAAAAAAAAAAAAsTWF4aW11bSBhbW91bnQgYWNjZXB0ZWQgYnkgYSBzaW5nbGUgcGF5bWVudC4AAAAJTWF4QW1vdW50AAAAAAAAAQAAAPpDdW11bGF0aXZlIGxpZmV0aW1lIGFtb3VudCByb3V0ZWQgYnkgYSBnaXZlbiBzZW5kZXIuClBhY2tlZCBwZXItdXNlciByZWNvcmQgKGlzc3VlICM2NjMpOiB0aGUgMjQtaG91ciBzcGVuZGluZyB3aW5kb3cgcGx1cwp0aGUgY3VtdWxhdGl2ZSBsaWZldGltZSB2b2x1bWUsIHN0b3JlZCBhcyBhIHNpbmdsZSA0MC1ieXRlIHZhbHVlIHNvCnJlZ2lzdGVyaW5nIGEgc2VuZGVyIGNvc3RzIG9uZSBsZWRnZXIgZW50cnkgaW5zdGVhZCBvZiB0d28uAAAAAAAKVXNlclJlY29yZAAAAAAAAQAAABMAAAABAAAAoURFUFJFQ0FURUQgKHByZS0jNjYzKTogcGFja2VkIDI0LWhvdXIgc3BlbmRpbmcgd2luZG93IGZvciBhIHNlbmRlci4KTm8gbG9uZ2VyIHdyaXR0ZW47IHJlYWQgb25seSBieSB0aGUgYGxvYWRfdXNlcl9yZWNvcmRgIGZhbGxiYWNrIGFuZCBieQpgbWlncmF0ZV91c2VyX3JlY29yZGAuAAAAAAAADFVzZXJTcGVuZGluZwAAAAEAAAATAAAAAQAAAKNERVBSRUNBVEVEIChwcmUtIzY2Myk6IGN1bXVsYXRpdmUgbGlmZXRpbWUgYW1vdW50IHJvdXRlZCBieSBhIHNlbmRlci4KTm8gbG9uZ2VyIHdyaXR0ZW47IHJlYWQgb25seSBieSB0aGUgYGxvYWRfdXNlcl9yZWNvcmRgIGZhbGxiYWNrIGFuZCBieQpgbWlncmF0ZV91c2VyX3JlY29yZGAuAAAAAApVc2VyVm9sdW1lAAAAAAABAAAAEwAAAAEAAAAxV2hldGhlciBhIGdpdmVuIHJlY2lwaWVudCBhZGRyZXNzIGlzIGJsYWNrbGlzdGVkLgAAAAAAAAlCbGFja2xpc3QAAAAAAAABAAAAEwAAAAEAAABpSW50ZXJuYWwgcmVmdW5kIGJhbGFuY2UgZm9yIGEgKHVzZXIsIHRva2VuKSBwYWlyLCBjcmVkaXRlZCB3aGVuIGEKZGlyZWN0IHRyYW5zZmVyIHRvIHRoZSByZWNpcGllbnQgZmFpbHMuAAAAAAAADVJlZnVuZEJhbGFuY2UAAAAAAAACAAAAEwAAABMAAAAAAAAAfk1vbm90b25pY2FsbHktaW5jcmVhc2luZyBub25jZSBjb3VudGVyIHVzZWQgdG8gZ2VuZXJhdGUgdW5pcXVlIElEcyBmb3IKdGltZWxvY2sgZW50cmllcy4gIFN0b3JlZCBhcyBgdTY0YCBpbiBpbnN0YW5jZSBzdG9yYWdlLgAAAAAADVRpbWVsb2NrTm9uY2UAAAAAAAABAAAAbkEgcGVuZGluZyB0aW1lbG9jayBlbnRyeSBrZXllZCBieSBpdHMgbm9uY2UgSUQuClN0b3JlZCBpbiBwZXJzaXN0ZW50IHN0b3JhZ2Ugc28gaXQgc3Vydml2ZXMgaW5zdGFuY2UgZXZpY3Rpb24uAAAAAAANVGltZWxvY2tFbnRyeQAAAAAAAAEAAAAGAAAAAAAAAHhXaGVuIGB0cnVlYCB0aGUgY29udHJhY3QgaXMgZnJvemVuOiBwYXltZW50cyBhbmQgdGltZWxvY2sgZXhlY3V0aW9ucwphcmUgYmxvY2tlZC4gIFN0b3JlZCBhcyBgYm9vbGAgaW4gaW5zdGFuY2Ugc3RvcmFnZS4AAAAGRnJvemVuAAAAAAABAAAAJldoZXRoZXIgYW4gYWRkcmVzcyBob2xkcyBhIGdpdmVuIHJvbGUuAAAAAAAIVXNlclJvbGUAAAACAAAAEwAAB9AAAAAEUm9sZQAAAAEAAAAtVGhlIHByaW1hcnkgYWRkcmVzcyBjdXJyZW50bHkgaG9sZGluZyBhIHJvbGUuAAAAAAAABFJvbGUAAAABAAAH0AAAAARSb2xlAAAAAQAAADdNb25vdG9uaWMgbm9uY2UgZm9yIG1ldGEtdHJhbnNhY3Rpb24gcmVwbGF5IHByb3RlY3Rpb24uAAAAAAlNZXRhTm9uY2UAAAAAAAABAAAAEwAAAAAAAAA9VHJ1c3RlZCBpc3N1ZXIvb3JhY2xlIHF1ZXJpZWQgZm9yIGhpZ2gtdmFsdWUgcGF5bWVudCBzZW5kZXJzLgAAAAAAAAlLeWNPcmFjbGUAAAAAAAAAAAAAPlBheW1lbnRzIHN0cmljdGx5IGFib3ZlIHRoaXMgYW1vdW50IHJlcXVpcmUgYSB2YWxpZCBLWUMgY2xhaW0uAAAAAAAMS3ljVGhyZXNob2xkAAAAAAAAAD5BZGRyZXNzIG9mIHRoZSBwcmljZS1mZWVkIG9yYWNsZSB1c2VkIGZvciBmaWF0L2NyeXB0byBsb29rdXBzLgAAAAAADU9yYWNsZUFkZHJlc3MAAAAAAAAAAAAAPU1heGltdW0gYWNjZXB0YWJsZSBhZ2UsIGluIHNlY29uZHMsIG9mIGFuIG9yYWNsZSBwcmljZSBxdW90ZS4AAAAAAAASU3RhbGVuZXNzVGhyZXNob2xkAAAAAAABAAAAPUFkbWluLXN1cHBsaWVkIGZhbGxiYWNrIHByaWNlIGZvciBhIChiYXNlLCBxdW90ZSkgYXNzZXQgcGFpci4AAAAAAAANRmFsbGJhY2tQcmljZQAAAAAAAAIAAAATAAAAEwAAAAAAAAAxVG9rZW4gd2hvc2UgYmFsYW5jZXMgd2VpZ2h0IGZlZS1nb3Zlcm5hbmNlIHZvdGVzLgAAAAAAAA9Hb3Zlcm5hbmNlVG9rZW4AAAAAAAAAADxNaW5pbXVtIHdlaWdodGVkIHZvdGUgc2hhcmUgcmVxdWlyZWQgdG8gcGFzcyBhIGZlZSBwcm9wb3NhbC4AAAAQR292ZXJuYW5jZVF1b3J1bQAAAAAAAAAlTW9ub3RvbmljIG5vbmNlIGZvciBmZWUtcHJvcG9zYWwgaWRzLgAAAAAAAA9Hb3Zlcm5hbmNlTm9uY2UAAAAAAQAAAC5BIHBlbmRpbmcgZmVlLWNoYW5nZSBwcm9wb3NhbCBrZXllZCBieSBpdHMgaWQuAAAAAAASR292ZXJuYW5jZVByb3Bvc2FsAAAAAAABAAAABgAAAAEAAAAvUmVjb3JkZWQgeWVzL25vIHZvdGUgd2VpZ2h0IGZvciBhIGZlZSBwcm9wb3NhbC4AAAAADkdvdmVybmFuY2VWb3RlAAAAAAACAAAABgAAABMAAAAAAAAAO0N1cnJlbnQgYXJjaGl2YWwgZXBvY2ggY291bnRlciwgc3RvcmVkIGluIGluc3RhbmNlIHN0b3JhZ2UuAAAAAAxBcmNoaXZlRXBvY2gAAAABAAAALE1lcmtsZSByb290IGNvbW1pdHRlZCBmb3IgYW4gYXJjaGl2YWwgZXBvY2guAAAAC0FyY2hpdmVSb290AAAAAAEAAAAGAAAAAQAAAC5NZXRhZGF0YSBjb21taXR0ZWQgYWxvbmdzaWRlIGFuIGFyY2hpdmFsIHJvb3QuAAAAAAALQXJjaGl2ZU1ldGEAAAAAAQAAAAYAAAAAAAAAPUxlbmRpbmcgcHJvdG9jb2wgY29udHJhY3QgdXNlZCBmb3IgdHJlYXN1cnkgeWllbGQgb3BlcmF0aW9ucy4AAAAAAAANWWllbGRQcm90b2NvbAAAAAAAAAEAAABAUHJpbmNpcGFsIGN1cnJlbnRseSBkZXBvc2l0ZWQgaW50byB0aGUgeWllbGQgcHJvdG9jb2wgcGVyIHRva2VuLgAAAA5ZaWVsZFByaW5jaXBhbAAAAAAAAQAAABMAAAABAAAAeFdoZXRoZXIgYSBERVggcm91dGVyIGNvbnRyYWN0IGlzIGFwcHJvdmVkIHRvIHJlY2VpdmUgY3Jvc3MtY29udHJhY3QKc3dhcCBjYWxscy4gIFN0b3JlZCBhcyBgYm9vbGAgaW4gcGVyc2lzdGVudCBzdG9yYWdlLgAAAA1SZWdpc3RlcmVkRGV4AAAAAAAAAQAAABMAAAAAAAAAgE1heGltdW0gdG9sZXJhdGVkIHN3YXAgc2xpcHBhZ2UgaW4gYmFzaXMgcG9pbnRzLCBhcHBsaWVkIGFnYWluc3QgYQpjYWxsZXItc3VwcGxpZWQgcXVvdGUuICBTdG9yZWQgYXMgYGkxMjhgIGluIGluc3RhbmNlIHN0b3JhZ2UuAAAADk1heFNsaXBwYWdlQnBzAAA=",
        "AAAAAQAAAE1BIHNpbmdsZSB0cmFuc2ZlciBpbnN0cnVjdGlvbiBmb3IgdXNlIHdpdGggW2BQYXltZW50Um91dGVyOjpyb3V0ZV9wYXltZW50c2BdLgAAAAAAAAAAAAAHUGF5bWVudAAAAAAEAAAAgEFtb3VudCB0byByb3V0ZSwgZGVub21pbmF0ZWQgaW4gdGhlIHRva2VuJ3Mgc21hbGxlc3QgdW5pdC4gTXVzdCBiZQpwb3NpdGl2ZSBhbmQgd2l0aGluIHRoZSBjb250cmFjdCdzIGNvbmZpZ3VyZWQgbWluL21heCBib3VuZHMuAAAABmFtb3VudAAAAAAACwAAADtBZGRyZXNzIHRoZSBmdW5kcyAobWludXMgdGhlIHBsYXRmb3JtIGZlZSkgYXJlIGNyZWRpdGVkIHRvLgAAAAAJcmVjaXBpZW50AAAAAAAAEwAAADxBZGRyZXNzIHRoZSBmdW5kcyBhcmUgZGViaXRlZCBmcm9tLiBNdXN0IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAGc2VuZGVyAAAAAAATAAAAR0NvbnRyYWN0IElEIG9mIHRoZSB0b2tlbiAob3IgU3RlbGxhciBBc3NldCBDb250cmFjdCkgYmVpbmcgdHJhbnNmZXJyZWQuAAAAAA10b2tlbl9hZGRyZXNzAAAAAAAAEw==",
        "AAAAAAAAAm9PbmUtdGltZSBzZXR1cDogcmVjb3JkcyB0aGUgYWRtaW4gYW5kIHRoZSBpbml0aWFsIGZlZSBjb25maWd1cmF0aW9uCmluIGluc3RhbmNlIHN0b3JhZ2UuIE11c3QgYmUgY2FsbGVkIGJlZm9yZSBgcm91dGVfcGF5bWVudGAuCgojIFBhcmFtZXRlcnMKKiBgZW52YCAtIFRoZSBTb3JvYmFuIGVudmlyb25tZW50IGludGVyZmFjZS4KKiBgc2VuZGVyYCAtIFRoZSBhZGRyZXNzIGluaXRpYXRpbmcgdGhlIHBheW1lbnQuIE11c3QgYXV0aG9yaXplIHRoZSB0cmFuc2FjdGlvbi4KKiBgcmVjaXBpZW50YCAtIFRoZSBkZXN0aW5hdGlvbiBhZGRyZXNzIGZvciB0aGUgcGF5bWVudCAoZS5nLiwgdGhlIEFuY2hvcidzIHdhbGxldCBmb3IgZmlhdCB3aXRoZHJhd2FscykuCiogYHBsYXRmb3JtX3RyZWFzdXJ5YCAtIFRoZSBhZGRyZXNzIHdoZXJlIHRoZSBwbGF0Zm9ybSBmZWUgd2lsbCBiZSBkZXBvc2l0ZWQuCiogYHRva2VuX2FkZHJlc3NgIC0gVGhlIGNvbnRyYWN0IElEIG9mIHRoZSB0b2tlbiBhc3NldCBiZWluZyB0cmFuc2ZlcnJlZCAoZS5nLiwgTkdOQyBvciBVU0RDKS4KKiBgYW1vdW50YCAtIFRoZSB0b3RhbCBhbW91bnQgb2YgdG9rZW5zIHRvIGJlIHJvdXRlZCAoaW5jbHVzaXZlIG9mIHRoZSBmZWUpLgAAAAAKaW5pdGlhbGl6ZQAAAAAABQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAABFwbGF0Zm9ybV90cmVhc3VyeQAAAAAAABMAAAAAAAAAB2ZlZV9icHMAAAAACwAAAAAAAAAHZmVlX2NhcAAAAAALAAAAAAAAAAptYXhfYW1vdW50AAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAzxBc2tzIGEgcmVnaXN0ZXJlZCBERVggaG93IG11Y2ggYGJ1eV90b2tlbmAgYSBzd2FwIHdvdWxkIHJldHVybiwgYW5kCmRlcml2ZXMgdGhlIGBtaW5fYW1vdW50X291dGAgdGhlIHNlbmRlciBzaG91bGQgdXNlIGZyb20gdGhlIGNvbnRyYWN0J3MKY29uZmlndXJlZCBzbGlwcGFnZSBjZWlsaW5nLgoKVGhpcyBpcyBhIHJlYWQtb25seSBjcm9zcy1jb250cmFjdCBjYWxsOiBpdCBtb3ZlcyBubyBmdW5kcyBhbmQgY2hhbmdlcyBubwpzdGF0ZSwgc28gaXQgaXMgc2FmZSB0byBjYWxsIG9mZi1jaGFpbiBiZWZvcmUgYnVpbGRpbmcgYQpbYFN3YXBQYXltZW50YF0uCgojIFBhcmFtZXRlcnMKLSBgZGV4YDogQ29udHJhY3QgSUQgb2YgYSByZWdpc3RlcmVkIERFWCBhZGFwdGVyLgotIGBzZWxsX3Rva2VuYDogVG9rZW4gdGhlIHNlbmRlciB3b3VsZCBwYXkgd2l0aC4KLSBgYnV5X3Rva2VuYDogVG9rZW4gdGhlIHJlY2lwaWVudCB3b3VsZCBiZSBwYWlkIGluLgotIGBhbW91bnRfaW5gOiBBbW91bnQgb2YgYHNlbGxfdG9rZW5gIHRvIHByaWNlLCBpbiBpdHMgc21hbGxlc3QgdW5pdC4KCiMgUmV0dXJucwpBIFtgU3dhcFF1b3RlYF0gd2l0aCB0aGUgcXVvdGVkIG91dHB1dCwgdGhlIHNsaXBwYWdlLWFkanVzdGVkCmBtaW5fYW1vdW50X291dGAsIGFuZCB0aGUgc2xpcHBhZ2UgY2VpbGluZyB1c2VkLiBSZXR1cm5zCmBFcnIoRXJyb3I6OkRleE5vdFJlZ2lzdGVyZWQpYCBpZiBgZGV4YCB3YXMgbmV2ZXIgcmVnaXN0ZXJlZCBvcgpgRXJyKEVycm9yOjpTd2FwRmFpbGVkKWAgaWYgdGhlIERFWCBxdW90ZSBjYWxsIHJldmVydHMuCgojIFBhbmljcwpEb2VzIG5vdCBwYW5pYy4AAAAKcXVvdGVfc3dhcAAAAAAABAAAAAAAAAADZGV4AAAAABMAAAAAAAAACnNlbGxfdG9rZW4AAAAAABMAAAAAAAAACWJ1eV90b2tlbgAAAAAAABMAAAAAAAAACWFtb3VudF9pbgAAAAAAAAsAAAABAAAD6QAAB9AAAAAJU3dhcFF1b3RlAAAAAAAAAw==",
        "AAAAAAAAANJBbGlhcyBmb3IgYHNldF9wYXVzZWAuIEFkbWluLW9ubHkuCgojIFBhcmFtZXRlcnMKLSBgcGF1c2VkYDogYHRydWVgIHRvIHJlamVjdCByb3V0aW5nIGNhbGxzLCBgZmFsc2VgIHRvIGFsbG93IHRoZW0uCgojIFJldHVybnMKU2VlIGBzZXRfcGF1c2VgLgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IGFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAAAApzZXRfcGF1c2VkAAAAAAABAAAAAAAAAAZwYXVzZWQAAAAAAAEAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAWpBc3NpZ25zIGFuIG9wZXJhdGlvbmFsIHJvbGUgdG8gYSBzcGVjaWZpZWQgYWNjb3VudC4KClJlc3RyaWN0ZWQgZXhjbHVzaXZlbHkgdG8gYFN1cGVyQWRtaW5gLgoKIyBQYXJhbWV0ZXJzCi0gYGFjY291bnRgOiBUYXJnZXQgYWRkcmVzcyB0byByZWNlaXZlIHRoZSByb2xlLgotIGByb2xlYDogVGhlIGBSb2xlYCB2YXJpYW50IHRvIGdyYW50LgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgY29udHJhY3QgaXMgdW5pbml0aWFsaXplZC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBgU3VwZXJBZG1pbmAgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgAAAAAAC2Fzc2lnbl9yb2xlAAAAAAIAAAAAAAAAB2FjY291bnQAAAAAEwAAAAAAAAAEcm9sZQAAB9AAAAAEUm9sZQAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAgRSZXZva2VzIGFuIG9wZXJhdGlvbmFsIHJvbGUgZnJvbSBhIHNwZWNpZmllZCBhY2NvdW50LgoKUmVzdHJpY3RlZCBleGNsdXNpdmVseSB0byBgU3VwZXJBZG1pbmAuIFByZXZlbnRzIHJlbW92aW5nIHRoZSBhY3RpdmUgU3VwZXJBZG1pbgp3aGVuIGl0IHdvdWxkIGxlYXZlIHRoZSBjb250cmFjdCB3aXRob3V0IHJvb3QgZ292ZXJuYW5jZS4KCiMgUGFyYW1ldGVycwotIGBhY2NvdW50YDogVGFyZ2V0IGFkZHJlc3MgZnJvbSB3aGljaCB0aGUgcm9sZSB3aWxsIGJlIHJldm9rZWQuCi0gYHJvbGVgOiBUaGUgYFJvbGVgIHZhcmlhbnQgdG8gcmV2b2tlLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIGBFcnIoRXJyb3I6OkludmFsaWRSb2xlKWAgaWYgYXR0ZW1wdGluZyB0byByZXZva2Ugb3duIFN1cGVyQWRtaW4sCm9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgYFN1cGVyQWRtaW5gIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAALcmV2b2tlX3JvbGUAAAAAAgAAAAAAAAAHYWNjb3VudAAAAAATAAAAAAAAAARyb2xlAAAH0AAAAARSb2xlAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAa1VcGRhdGVzIHRoZSBmZWUgYmFzaXMgcG9pbnRzLgpSZXF1aXJlcyBnb3Zlcm5hbmNlIGF1dGhvcml0eSBpZiBhIGdvdmVybmFuY2UgYWRkcmVzcyBpcyBzZXQ7IG90aGVyd2lzZSBhZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYG5ld19mZWVfYnBzYDogTmV3IHBsYXRmb3JtIGZlZSByYXRlLCBpbiBiYXNpcyBwb2ludHMuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGNhbGxlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuCgpERVBSRUNBVEVEIGZvciBkaXJlY3QgdXNlLiAgUXVldWUgdmlhIGBxdWV1ZV9hY3Rpb24oQWN0aW9uVHlwZTo6U2V0RmVlQnBzKOKApikpYC4AAAAAAAALc2V0X2ZlZV9icHMAAAAAAQAAAAAAAAALbmV3X2ZlZV9icHMAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAQAAACxBIHNpbmdsZSBwcmljZSBxdW90ZSByZXR1cm5lZCBieSB0aGUgb3JhY2xlLgAAAAAAAAAJUHJpY2VEYXRhAAAAAAAAAwAAAClOdW1iZXIgb2YgZGVjaW1hbCBwbGFjZXMgdXNlZCBpbiBgcHJpY2VgLgAAAAAAAAhkZWNpbWFscwAAAAQAAABBRml4ZWQtcG9pbnQgcHJpY2UgdmFsdWUuIFRoZSB0cnVlIHByaWNlIGlzIGBwcmljZSAvIDEwXmRlY2ltYWxzYC4AAAAAAAAFcHJpY2UAAAAAAAALAAAAQ1VuaXggdGltZXN0YW1wIChzZWNvbmRzKSB3aGVuIHRoaXMgcHJpY2Ugd2FzIGxhc3QgdXBkYXRlZCBvbi1jaGFpbi4AAAAACXRpbWVzdGFtcAAAAAAAAAY=",
        "AAAAAQAAAEVUaGUgcmVzdWx0IG9mIGEgREVYIHF1b3RlLCByZXR1cm5lZCBieSBbYFBheW1lbnRSb3V0ZXI6OnF1b3RlX3N3YXBgXS4AAAAAAAAAAAAACVN3YXBRdW90ZQAAAAAAAAMAAABGQW1vdW50IG9mIGBidXlfdG9rZW5gIHRoZSBERVggZXhwZWN0cyB0byBkZWxpdmVyIGZvciB0aGUgcXVvdGVkIGlucHV0LgAAAAAACmFtb3VudF9vdXQAAAAAAAsAAABNQ29uZmlndXJlZCBtYXhpbXVtIHNsaXBwYWdlLCBpbiBiYXNpcyBwb2ludHMsIHRoYXQgcHJvZHVjZWQKYG1pbl9hbW91bnRfb3V0YC4AAAAAAAAQbWF4X3NsaXBwYWdlX2JwcwAAAAsAAABfVGlnaHRlc3QgYG1pbl9hbW91bnRfb3V0YCB0aGF0IHN0aWxsIHJlc3BlY3RzIHRoZSBjb250cmFjdCdzCmBtYXhfc2xpcHBhZ2VfYnBzYCBmb3IgdGhpcyBxdW90ZS4AAAAADm1pbl9hbW91bnRfb3V0AAAAAAAL",
        "AAAAAAAAAsdRdWV1ZXMgYW4gYWRtaW4gYWN0aW9uIHRvIGJlIGV4ZWN1dGVkIGFmdGVyIGEgMjQtaG91ciBkZWxheS4KClRoZSBhZG1pbiBwcm92aWRlcyB0aGUgZGVzaXJlZCBgQWN0aW9uVHlwZWAgdmFyaWFudCBhbmQgcmVjZWl2ZXMgYQpudW1lcmljIG5vbmNlIHRoYXQgdW5pcXVlbHkgaWRlbnRpZmllcyB0aGlzIHBlbmRpbmcgZW50cnkuICBQYXNzIHRoaXMKbm9uY2UgdG8gYGV4ZWN1dGVfYWN0aW9uYCBhZnRlciAyNCBob3Vycywgb3IgdG8gYGNhbmNlbF9hY3Rpb25gIHRvCmFib3J0IHRoZSBpbnRlbnQuCgpTZW5zaXRpdmUgcGFyYW1ldGVyIGNoYW5nZXMgKGBzZXRfcGxhdGZvcm1fdHJlYXN1cnlgLCBgc2V0X2ZlZV9jb25maWdgLApgc2V0X2ZlZV9icHNgLCBgc2V0X2dvdmVybmFuY2VgLCBgc2V0X21pbl9saW1pdGAsIGB0cmFuc2Zlcl9hZG1pbmAsCmB1cGdyYWRlYCkgbXVzdCBnbyB0aHJvdWdoIHRoZSB0aW1lbG9jay4gIFVzZSB0aGUgZGlyZWN0IHNldHRlcgpmdW5jdGlvbnMgb25seSBmb3IgYWN0aW9ucyB0aGF0IGFyZSBub3Qgc2Vuc2l0aXZlIChlLmcuIGBzZXRfcGF1c2VgCndoaWNoIGNhbiBhbHNvIGJlIGNhbGxlZCBkaXJlY3RseSBmb3IgaW1tZWRpYXRlIG9wZXJhdGlvbmFsIHBhdXNlcykuCgpUaGUgY29udHJhY3QgbXVzdCBub3QgYmUgZnJvemVuIHdoZW4gcXVldWluZywgYW5kIHRoZSBhZG1pbiBtdXN0CmF1dGhvcml6ZSB0aGUgY2FsbC4AAAAADHF1ZXVlX2FjdGlvbgAAAAEAAAAAAAAABmFjdGlvbgAAAAAH0AAAAApBY3Rpb25UeXBlAAAAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAgpBbGxvd3Mgc3dhcCByb3V0aW5nIHRvIGludm9rZSBhIERFWCByb3V0ZXIgY29udHJhY3QuIEFkbWluLW9ubHkuCgpSZXN0cmljdGluZyBjcm9zcy1jb250cmFjdCBjYWxscyB0byBhIHJlZ2lzdGVyZWQgYWxsb3dsaXN0IGlzIHdoYXQga2VlcHMKc3dhcCByb3V0aW5nIHBvaW50ZWQgYXQgYXVkaXRlZCBjb2RlLgoKIyBQYXJhbWV0ZXJzCi0gYGRleGA6IENvbnRyYWN0IElEIG9mIHRoZSBERVggcm91dGVyIHRvIGFwcHJvdmUuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QgaGFzCm5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgYWRtaW4gZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlJlZ2lzdGVyRGV4KOKApikpYAphbmQgZXhlY3V0ZSBhZnRlciAyNCBob3Vycy4AAAAAAAxyZWdpc3Rlcl9kZXgAAAABAAAAAAAAAANkZXgAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAgAAAK5EZXNjcmliZXMgd2hpY2ggYWRtaW5pc3RyYXRpdmUgcGFyYW1ldGVyIGNoYW5nZSBhIHRpbWVsb2NrIGVudHJ5IHJlcHJlc2VudHMuCkVhY2ggdmFyaWFudCBjYXJyaWVzIGFsbCB0aGUgYXJndW1lbnRzIG5lZWRlZCB0byBhcHBseSB0aGF0IGNoYW5nZSB3aGVuIHRoZQpkZWxheSBwZXJpb2QgaXMgb3Zlci4AAAAAAAAAAAAKQWN0aW9uVHlwZQAAAAAACgAAAAEAAAAlQ2hhbmdlIHRoZSBwbGF0Zm9ybSB0cmVhc3VyeSBhZGRyZXNzLgAAAAAAABNTZXRQbGF0Zm9ybVRyZWFzdXJ5AAAAAAEAAAATAAAAAQAAAEhVcGRhdGUgZmVlIGJhc2lzLXBvaW50cyBhbmQgZmVlIGNhcCB0b2dldGhlciAobGVnYWN5IC8gY29tYmluZWQgc2V0dGVyKS4AAAAMU2V0RmVlQ29uZmlnAAAAAgAAAAsAAAALAAAAAQAAAB1VcGRhdGUgZmVlIGJhc2lzLXBvaW50cyBvbmx5LgAAAAAAAAlTZXRGZWVCcHMAAAAAAAABAAAACwAAAAEAAAAkU2V0IHRoZSBnb3Zlcm5hbmNlIGNvbnRyYWN0IGFkZHJlc3MuAAAADVNldEdvdmVybmFuY2UAAAAAAAABAAAAEwAAAAEAAAAhQ2hhbmdlIHRoZSBtaW5pbXVtIHJvdXRpbmcgbGltaXQuAAAAAAAAC1NldE1pbkxpbWl0AAAAAAEAAAALAAAAAQAAACdUcmFuc2ZlciBhZG1pbiByaWdodHMgdG8gYSBuZXcgYWRkcmVzcy4AAAAADVRyYW5zZmVyQWRtaW4AAAAAAAABAAAAEwAAAAEAAAAaVXBncmFkZSB0aGUgY29udHJhY3QgV0FTTS4AAAAAAAdVcGdyYWRlAAAAAAEAAAPuAAAAIAAAAAEAAAAzQWxsb3cgc3dhcCByb3V0aW5nIHRvIGludm9rZSBhIERFWCByb3V0ZXIgY29udHJhY3QuAAAAAAtSZWdpc3RlckRleAAAAAABAAAAEwAAAAEAAAA2U3RvcCBzd2FwIHJvdXRpbmcgZnJvbSBpbnZva2luZyBhIERFWCByb3V0ZXIgY29udHJhY3QuAAAAAAANRGVyZWdpc3RlckRleAAAAAAAAAEAAAATAAAAAQAAACtVcGRhdGUgdGhlIG1heGltdW0gdG9sZXJhdGVkIHN3YXAgc2xpcHBhZ2UuAAAAABFTZXRNYXhTbGlwcGFnZUJwcwAAAAAAAAEAAAAL",
        "AAAAAQAAAOdBIHVzZXIncyBjb21iaW5lZCByb3V0aW5nIHN0YXRzLCB1bnBhY2tlZCBmcm9tIHRoZSBwYWNrZWQgYEJ5dGVzTjw0MD5gCmBVc2VyUmVjb3JkYCBsZWRnZXIgdmFsdWUgKGlzc3VlICM2NjMpLgoKUmV0dXJuZWQgYnkgW2BQYXltZW50Um91dGVyOjpnZXRfdXNlcl9yZWNvcmRgXSBzbyBhIGNsaWVudCBjYW4gcmVhZCBib3RoCmNvdW50ZXJzIGluIGEgc2luZ2xlIHZpZXcgY2FsbCBpbnN0ZWFkIG9mIHR3by4AAAAAAAAAAApVc2VyUmVjb3JkAAAAAAADAAAAPlRvdGFsIGFtb3VudCByb3V0ZWQgYnkgdGhlIHVzZXIgaW4gdGhlIGN1cnJlbnQgMjQtaG91ciB3aW5kb3cuAAAAAAASYWNjdW11bGF0ZWRfYW1vdW50AAAAAAALAAAAQFVuaXggdGltZXN0YW1wIChzZWNvbmRzKSBhdCB3aGljaCB0aGUgMjQtaG91ciB3aW5kb3cgbGFzdCByZXNldC4AAAAPbGFzdF9yZXNldF90aW1lAAAAAAYAAAAuQ3VtdWxhdGl2ZSBsaWZldGltZSBhbW91bnQgcm91dGVkIGJ5IHRoZSB1c2VyLgAAAAAABnZvbHVtZQAAAAAACw==",
        "AAAAAAAAAThDYW5jZWxzIGEgcGVuZGluZyB0aW1lbG9jayBlbnRyeSBiZWZvcmUgaXQgY2FuIGJlIGV4ZWN1dGVkLgoKVGhpcyBpcyB0aGUgcHJpbWFyeSBkZWZlbmNlIHdoZW4gYSBjb21wcm9taXNlZCBhZG1pbiBoYXMgcXVldWVkIGEKbWFsaWNpb3VzIGFjdGlvbjogYW55IG90aGVyIGFkbWluIChhZnRlciBhIGtleSByb3RhdGlvbikgb3IgYQptdWx0aS1zaWcgZ292ZXJuYW5jZSBjYW4gY2FuY2VsIGl0IHdpdGhpbiB0aGUgMjQtaG91ciB3aW5kb3cuCgpBZG1pbiBhdXRob3JpemF0aW9uIGlzIHJlcXVpcmVkLiBUaGUgY29udHJhY3QgbWF5IGJlIGZyb3plbi4AAAANY2FuY2VsX2FjdGlvbgAAAAAAAAEAAAAAAAAABW5vbmNlAAAAAAAABgAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAFlDbGFpbXMgYWxsIGN1cnJlbnRseSBhdmFpbGFibGUgeWllbGQgdG8gdGhlIHBsYXRmb3JtIHRyZWFzdXJ5LiBUcmVhc3VyeU1hbmFnZXItcHJvdGVjdGVkLgAAAAAAAA1oYXJ2ZXN0X3lpZWxkAAAAAAAAAQAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAA/ZSb3V0ZXMgYSBwYXltZW50IGZyb20gYSBzZW5kZXIgdG8gYSByZWNpcGllbnQsIGRlZHVjdGluZyBhIHBsYXRmb3JtIGZlZS4KCiMgUGFyYW1ldGVycwotIGBzZW5kZXJgOiBBZGRyZXNzIHRoZSBmdW5kcyBhcmUgZGViaXRlZCBmcm9tOyBtdXN0IGF1dGhvcml6ZSB0aGUgY2FsbC4KLSBgcmVjaXBpZW50YDogQWRkcmVzcyB0byByZWNlaXZlIHRoZSBmdW5kcyAobWludXMgdGhlIHBsYXRmb3JtIGZlZSkuCi0gYHRva2VuX2FkZHJlc3NgOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4gYmVpbmcgdHJhbnNmZXJyZWQuCi0gYGFtb3VudGA6IEFtb3VudCB0byByb3V0ZSwgaW4gdGhlIHRva2VuJ3Mgc21hbGxlc3QgdW5pdC4gTXVzdCBiZQpwb3NpdGl2ZSBhbmQgd2l0aGluIHRoZSBjb25maWd1cmVkIG1pbi9tYXggYW5kIGRhaWx5LWxpbWl0IGJvdW5kcy4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLiBSZXR1cm5zIGBFcnIoRXJyb3I6OlBhdXNlZClgIGlmIHJvdXRpbmcgaXMKcGF1c2VkLCBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdCBoYXMgbm8gYWRtaW4Kc2V0LCBgRXJyKEVycm9yOjpJbnZhbGlkUmVjaXBpZW50KWAgaWYgYHNlbmRlciA9PSByZWNpcGllbnRgLApgRXJyKEVycm9yOjpCbGFja2xpc3RlZClgIGlmIGByZWNpcGllbnRgIGlzIGJsYWNrbGlzdGVkLApgRXJyKEVycm9yOjpMaW1pdEV4Y2VlZGVkKWAgaWYgYGFtb3VudGAgaXMgb3V0c2lkZSB0aGUgY29uZmlndXJlZApib3VuZHMgb3IgZXhjZWVkcyB0aGUgc2VuZGVyJ3MgcmVtYWluaW5nIGRhaWx5IGxpbWl0LCBvcgpgRXJyKEVycm9yOjpJbnN1ZmZpY2llbnRCYWxhbmNlKWAgaWYgYHNlbmRlcmAncyB0b2tlbiBiYWxhbmNlIGlzCmJlbG93IGBhbW91bnRgLgoKIyBQYW5pY3MKUGFuaWNzIGlmIGBzZW5kZXJgIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYgdGhlIHVuZGVybHlpbmcKdG9rZW4gdHJhbnNmZXIgdG8gYHBsYXRmb3JtX3RyZWFzdXJ5YCBmYWlscy4AAAAAAA1yb3V0ZV9wYXltZW50AAAAAAAABAAAAAAAAAAGc2VuZGVyAAAAAAATAAAAAAAAAAlyZWNpcGllbnQAAAAAAAATAAAAAAAAAA10b2tlbl9hZGRyZXNzAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAbNTZXRzIHRoZSBtaW5pbXVtIGFsbG93ZWQgcm91dGluZyBhbW91bnQuIEZlZU1hbmFnZXItcHJvdGVjdGVkLgoKIyBQYXJhbWV0ZXJzCi0gYG1pbl9saW1pdGA6IFNtYWxsZXN0IGBhbW91bnRgIHRoYXQgYHJvdXRlX3BheW1lbnRgIC8KYHJvdXRlX3BheW1lbnRzYCB3aWxsIGFjY2VwdCBnb2luZyBmb3J3YXJkLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0CmhhcyBubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IEZlZU1hbmFnZXIgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlNldE1pbkxpbWl0KOKApikpYC4AAAAADXNldF9taW5fbGltaXQAAAAAAAABAAAAAAAAAAltaW5fbGltaXQAAAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAQAAADxBIGZlZSBjaGFuZ2UgcHJvcG9zYWwgd2VpZ2h0ZWQgYnkgZ292ZXJuYW5jZS10b2tlbiBiYWxhbmNlcy4AAAAAAAAAC0ZlZVByb3Bvc2FsAAAAAAkAAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAYAAAAAAAAACGV4ZWN1dGVkAAAAAQAAAAAAAAAHZmVlX2JwcwAAAAALAAAAAAAAAAdmZWVfY2FwAAAAAAsAAAAAAAAACG5vX3ZvdGVzAAAACwAAAAAAAAAIcHJvcG9zZXIAAAATAAAAAAAAAAZxdW9ydW0AAAAAAAsAAAAAAAAADnZvdGluZ19lbmRzX2F0AAAAAAAGAAAAAAAAAAl5ZXNfdm90ZXMAAAAAAAAL",
        "AAAAAQAAAClTdHJ1Y3R1cmVkIHBheWxvYWQgZm9yIG1ldGEtdHJhbnNhY3Rpb25zLgAAAAAAAAAAAAALTWV0YVBheW1lbnQAAAAABgAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAhkZWFkbGluZQAAAAYAAAAAAAAABW5vbmNlAAAAAAAABgAAAAAAAAAJcmVjaXBpZW50AAAAAAAAEwAAAAAAAAAGc2VuZGVyAAAAAAATAAAAAAAAAA10b2tlbl9hZGRyZXNzAAAAAAAAEw==",
        "AAAAAQAAAJJBIHNpbmdsZSBzd2FwLXJvdXRlZCB0cmFuc2ZlciBpbnN0cnVjdGlvbiBmb3IgdXNlIHdpdGgKW2BQYXltZW50Um91dGVyOjpyb3V0ZV9wYXltZW50X3dpdGhfc3dhcGBdIGFuZApbYFBheW1lbnRSb3V0ZXI6OnJvdXRlX3BheW1lbnRzX3dpdGhfc3dhcGBdLgAAAAAAAAAAAAtTd2FwUGF5bWVudAAAAAAJAAAAOEFtb3VudCBvZiBgc2VsbF90b2tlbmAgdG8gcHVsbCBmcm9tIHRoZSBzZW5kZXIgYW5kIHN3YXAuAAAACWFtb3VudF9pbgAAAAAAAAsAAAA+VG9rZW4gdGhlIHJlY2lwaWVudCBpcyBwYWlkIGluLiBNdXN0IGRpZmZlciBmcm9tIGBzZWxsX3Rva2VuYC4AAAAAAAlidXlfdG9rZW4AAAAAAAATAAAAeVVuaXggdGltZXN0YW1wIChzZWNvbmRzKSBhZnRlciB3aGljaCB0aGUgc3dhcCBtdXN0IG5vdCBleGVjdXRlLiBgMGAKZGlzYWJsZXMgdGhlIGRlYWRsaW5lLCBsZXR0aW5nIHRoZSBERVggYXBwbHkgaXRzIG93bi4AAAAAAAAIZGVhZGxpbmUAAAAGAAAAh0NvbnRyYWN0IElEIG9mIHRoZSBERVggYWRhcHRlciB0byBpbnZva2UuIE11c3QgYmUgcmVnaXN0ZXJlZCBieSB0aGUKYWRtaW4sIHdoaWNoIGtlZXBzIHRoZSBjcm9zcy1jb250cmFjdCBjYWxsIHBvaW50ZWQgYXQgYXVkaXRlZCBjb2RlLgAAAAADZGV4AAAAABMAAADKQW1vdW50IG9mIGBidXlfdG9rZW5gIHRoZSBjYWxsZXIgZXhwZWN0ZWQgZnJvbSBhIHByaW9yIGBxdW90ZV9zd2FwYApjYWxsLiBgMGAgZGlzYWJsZXMgdGhlIGNlaWxpbmcgY2hlY2s7IG90aGVyd2lzZSB0aGUgcmVhbGlzZWQgb3V0cHV0Cm11c3Qgc3RheSB3aXRoaW4gdGhlIGNvbnRyYWN0J3MgYG1heF9zbGlwcGFnZV9icHNgIG9mIHRoaXMgZmlndXJlLgAAAAAAE2V4cGVjdGVkX2Ftb3VudF9vdXQAAAAACwAAAIRNaW5pbXVtIGFtb3VudCBvZiBgYnV5X3Rva2VuYCB0aGUgc3dhcCBtdXN0IGRlbGl2ZXIuIFRoaXMgaXMgdGhlCnNsaXBwYWdlIGZsb29yOiBpZiB0aGUgREVYIHJldHVybnMgbGVzcywgdGhlIHdob2xlIHBheW1lbnQgcmV2ZXJ0cy4AAAAObWluX2Ftb3VudF9vdXQAAAAAAAsAAABDQWRkcmVzcyB0aGUgc3dhcHBlZCBmdW5kcyAobWludXMgdGhlIHBsYXRmb3JtIGZlZSkgYXJlIGNyZWRpdGVkIHRvLgAAAAAJcmVjaXBpZW50AAAAAAAAEwAAADpUb2tlbiB0aGUgc2VuZGVyIHBheXMgd2l0aCwgaW4gdGhhdCB0b2tlbidzIHNtYWxsZXN0IHVuaXQuAAAAAAAKc2VsbF90b2tlbgAAAAAAEwAAADxBZGRyZXNzIHRoZSBmdW5kcyBhcmUgZGViaXRlZCBmcm9tLiBNdXN0IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAGc2VuZGVyAAAAAAAT",
        "AAAAAAAAAZ5TdG9wcyBzd2FwIHJvdXRpbmcgZnJvbSBpbnZva2luZyBhIERFWCByb3V0ZXIgY29udHJhY3QuIEFkbWluLW9ubHkuCgojIFBhcmFtZXRlcnMKLSBgZGV4YDogQ29udHJhY3QgSUQgb2YgdGhlIERFWCByb3V0ZXIgdG8gcmV2b2tlLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0IGhhcwpubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IGFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4KCkRFUFJFQ0FURUQgZm9yIGRpcmVjdCB1c2UuICBRdWV1ZSB2aWEgYHF1ZXVlX2FjdGlvbihBY3Rpb25UeXBlOjpEZXJlZ2lzdGVyRGV4KOKApikpYAphbmQgZXhlY3V0ZSBhZnRlciAyNCBob3Vycy4AAAAAAA5kZXJlZ2lzdGVyX2RleAAAAAAAAQAAAAAAAAADZGV4AAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAURFeGVjdXRlcyBhIHByZXZpb3VzbHkgcXVldWVkIGFjdGlvbiBpZGVudGlmaWVkIGJ5IGBub25jZWAuCgpSZXF1aXJlbWVudHM6Ci0gVGhlIGNvbnRyYWN0IG11c3Qgbm90IGJlIGZyb3plbi4KLSBUaGUgYWRtaW4gbXVzdCBhdXRob3JpemUuCi0gVGhlIGVudHJ5IGlkZW50aWZpZWQgYnkgYG5vbmNlYCBtdXN0IGV4aXN0LgotIEF0IGxlYXN0IDI0IGhvdXJzIChgU0VDT05EU19JTl8yNEhgKSBtdXN0IGhhdmUgcGFzc2VkIHNpbmNlIHF1ZXVpbmcuCgpPbiBzdWNjZXNzIHRoZSBlbnRyeSBpcyByZW1vdmVkIGFuZCB0aGUgdW5kZXJseWluZyBzZXR0ZXIgaXMgaW52b2tlZC4AAAAOZXhlY3V0ZV9hY3Rpb24AAAAAAAEAAAAAAAAABW5vbmNlAAAAAAAABgAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAORSZXR1cm5zIHRoZSBjdXJyZW50IG1ldGEtdHJhbnNhY3Rpb24gbm9uY2UgZm9yIGEgdXNlci4KClJlbGF5ZXJzIG11c3QgdXNlIHRoaXMgbm9uY2Ugd2hlbiBidWlsZGluZyB0aGUgc2lnbmVkIHBheWxvYWQuClRoZSBub25jZSBzdGFydHMgYXQgYDBgIGFuZCBpbmNyZW1lbnRzIGFmdGVyIGVhY2ggc3VjY2Vzc2Z1bApgcm91dGVfcGF5bWVudF9tZXRhYCwgcHJldmVudGluZyByZXBsYXkgYXR0YWNrcy4AAAAOZ2V0X21ldGFfbm9uY2UAAAAAAAEAAAAAAAAABHVzZXIAAAATAAAAAQAAAAY=",
        "AAAAAAAAAIVSZXR1cm5zIHRoZSBhZG1pbmlzdHJhdGl2ZSByb2xlIGdvdmVybmluZyB0aGUgc3BlY2lmaWVkIHJvbGUuCgpJbiB0aGlzIFJCQUMgYXJjaGl0ZWN0dXJlLCBgU3VwZXJBZG1pbmAgZ292ZXJucyBhbGwgb3BlcmF0aW9uYWwgcm9sZXMuAAAAAAAADmdldF9yb2xlX2FkbWluAAAAAAABAAAAAAAAAAVfcm9sZQAAAAAAB9AAAAAEUm9sZQAAAAEAAAfQAAAABFJvbGU=",
        "AAAAAAAAALNSZXR1cm5zIHdoZXRoZXIgYW4gYWRkcmVzcyBpcyBibGFja2xpc3RlZC4KCiMgUGFyYW1ldGVycwotIGBhZGRyZXNzYDogQWRkcmVzcyB0byBjaGVjay4KCiMgUmV0dXJucwpgdHJ1ZWAgaWYgYGFkZHJlc3NgIGlzIGJsYWNrbGlzdGVkLCBgZmFsc2VgIG90aGVyd2lzZS4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAAAOaXNfYmxhY2tsaXN0ZWQAAAAAAAEAAAAAAAAAB2FkZHJlc3MAAAAAEwAAAAEAAAAB",
        "AAAAAAAAAfNSZWNvdmVycyB0b2tlbnMgYWNjaWRlbnRhbGx5IHNlbnQgZGlyZWN0bHkgdG8gdGhlIGNvbnRyYWN0IGFkZHJlc3MuIFRyZWFzdXJ5TWFuYWdlci1wcm90ZWN0ZWQuCgojIFBhcmFtZXRlcnMKLSBgdG9rZW5gOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4gdG8gcmVjb3Zlci4KLSBgYW1vdW50YDogQW1vdW50IHRvIHRyYW5zZmVyIGZyb20gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSB0byB0aGUgdHJlYXN1cnkgbWFuYWdlci4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBUcmVhc3VyeU1hbmFnZXIgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLCBvciBpZiB0aGUKdG9rZW4gdHJhbnNmZXIgZmFpbHMgKGUuZy4gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSBpcyBiZWxvdyBgYW1vdW50YCkuAAAAAA5yZWNvdmVyX3Rva2VucwAAAAAAAgAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAnhSb3V0ZXMgbXVsdGlwbGUgcGF5bWVudHMgaW4gYSBzaW5nbGUgdHJhbnNhY3Rpb24uIElmIGFueSBwYXltZW50IGZhaWxzLAp0aGUgZW50aXJlIGJhdGNoIGlzIHJldmVydGVkIGF0b21pY2FsbHkuCgojIFBhcmFtZXRlcnMKLSBgcGF5bWVudHNgOiBCYXRjaCBvZiB0cmFuc2ZlciBpbnN0cnVjdGlvbnMgdG8gYXBwbHkgaW4gb3JkZXIuIFNlZQpbYFBheW1lbnRgXSBmb3IgcGVyLWl0ZW0gY29uc3RyYWludHMuCgojIFJldHVybnMKYE9rKCgpKWAgaWYgZXZlcnkgcGF5bWVudCBpbiB0aGUgYmF0Y2ggc3VjY2VlZHMuIFJldHVybnMgdGhlIGZpcnN0CmVycm9yIGVuY291bnRlcmVkIChzZWUgYHJvdXRlX3BheW1lbnRgIGZvciB0aGUgcG9zc2libGUgYEVycmAKdmFyaWFudHMgYW5kIHRoZWlyIGNhdXNlcykgaWYgYW55IHBheW1lbnQgZmFpbHM7IHRoZSBTb3JvYmFuIGhvc3QKcmV2ZXJ0cyBhbGwgc3RvcmFnZSBhbmQgYmFsYW5jZSBjaGFuZ2VzIGZyb20gdGhlIGJhdGNoIGluIHRoYXQgY2FzZS4KCiMgUGFuaWNzClBhbmljcyBpZiBhbnkgcGF5bWVudCdzIGBzZW5kZXJgIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYKYSB0b2tlbiB0cmFuc2ZlciB0byBgcGxhdGZvcm1fdHJlYXN1cnlgIGZhaWxzLgAAAA5yb3V0ZV9wYXltZW50cwAAAAAAAQAAAAAAAAAIcGF5bWVudHMAAAPqAAAH0AAAAAdQYXltZW50AAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAWxBbGlhcyBmb3IgYHNldF9mZWVfY29uZmlnX2xlZ2FjeWAuIEFkbWluLW9ubHkuCgojIFBhcmFtZXRlcnMKLSBgZmVlX2Jwc2A6IE5ldyBwbGF0Zm9ybSBmZWUgcmF0ZSwgaW4gYmFzaXMgcG9pbnRzLgotIGBmZWVfY2FwYDogTmV3IG1heGltdW0gZmVlIHRha2VuIGZyb20gYSBzaW5nbGUgcGF5bWVudC4KCiMgUmV0dXJucwpTZWUgYHNldF9mZWVfY29uZmlnX2xlZ2FjeWAuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgYWRtaW4gZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlNldEZlZUNvbmZpZyjigKYpKWAuAAAADnNldF9mZWVfY29uZmlnAAAAAAACAAAAAAAAAAdmZWVfYnBzAAAAAAsAAAAAAAAAB2ZlZV9jYXAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAPVTZXRzIHRoZSBnb3Zlcm5hbmNlIGNvbnRyYWN0IGFkZHJlc3MuIEFmdGVyIHRoaXMgY2FsbCwgb25seSB0aGUgZ292ZXJuYW5jZQpjb250cmFjdCBjYW4gdXBkYXRlIGZlZXMuIEFkbWluLW9ubHkg4oCUIGNhbiBvbmx5IGJlIHNldCBvbmNlIHBlciBnb3Zlcm5hbmNlIGN5Y2xlLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlNldEdvdmVybmFuY2Uo4oCmKSlgLgAAAAAAAA5zZXRfZ292ZXJuYW5jZQAAAAAAAQAAAAAAAAADZ292AAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAGRDb25maWd1cmVzIHRoZSB0cnVzdGVkIEtZQyBvcmFjbGUgYW5kIHRoZSBoaWdoLXZhbHVlIHBheW1lbnQgdGhyZXNob2xkLiBDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuAAAADnNldF9reWNfY29uZmlnAAAAAAACAAAAAAAAAAZvcmFjbGUAAAAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAZZUcmFuc2ZlcnMgYWRtaW4gcmlnaHRzIHRvIGEgbmV3IGFkZHJlc3MuIFJlcXVpcmVzIGN1cnJlbnQgU3VwZXJBZG1pbiBhdXRob3JpemF0aW9uLgoKIyBQYXJhbWV0ZXJzCi0gYG5ld19hZG1pbmA6IEFkZHJlc3MgdG8gYmVjb21lIHRoZSBuZXcgYWRtaW4uCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgU3VwZXJBZG1pbiBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuCgpERVBSRUNBVEVEIGZvciBkaXJlY3QgdXNlLiAgUXVldWUgdmlhIGBxdWV1ZV9hY3Rpb24oQWN0aW9uVHlwZTo6VHJhbnNmZXJBZG1pbijigKYpKWAuAAAAAAAOdHJhbnNmZXJfYWRtaW4AAAAAAAEAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAQAAATVBIHVzZXIncyByb2xsaW5nIDI0LWhvdXIgc3BlbmRpbmcgcmVjb3JkLgoKUmV0YWluZWQgcHVyZWx5IHNvIGV4aXN0aW5nIHRlc3Qgc25hcHNob3RzIHRoYXQgcmVmZXJlbmNlIHRoaXMgdHlwZSBieQpuYW1lIGtlZXAgY29tcGlsaW5nLiBQcmUtIzY2MyBsaXZlIGNvbnRyYWN0IHN0YXRlIHdhcyBzdG9yZWQgYXMgYSBwYWNrZWQKYEJ5dGVzTjwyND5gIChzdGlsbCByZWFkYWJsZSB2aWEgYHVucGFja19sZWdhY3lfc3BlbmRpbmdgKTsgdGhpcyBzdHJ1Y3QgaXMKbm90IHJlYWQgZnJvbSBvciB3cml0dGVuIHRvIHN0b3JhZ2UgYXQgcnVudGltZS4AAAAAAAAAAAAADFVzZXJTcGVuZGluZwAAAAIAAAA4VG90YWwgYW1vdW50IHJvdXRlZCBieSB0aGUgdXNlciBzaW5jZSBgbGFzdF9yZXNldF90aW1lYC4AAAASYWNjdW11bGF0ZWRfYW1vdW50AAAAAAALAAAAQFVuaXggdGltZXN0YW1wIChzZWNvbmRzKSBhdCB3aGljaCB0aGUgMjQtaG91ciB3aW5kb3cgbGFzdCByZXNldC4AAAAPbGFzdF9yZXNldF90aW1lAAAAAAY=",
        "AAAAAAAAAL5SZXR1cm5zIHRoZSBwcmltYXJ5IGRlc2lnbmF0ZWQgbWVtYmVyIGFkZHJlc3MgZm9yIGEgcm9sZSwgaWYgb25lIGlzIGNvbmZpZ3VyZWQuCgojIFBhcmFtZXRlcnMKLSBgcm9sZWA6IFRoZSByb2xlIHZhcmlhbnQgdG8gcXVlcnkuCgojIFJldHVybnMKYFNvbWUoQWRkcmVzcylgIGlmIHNldCwgb3IgYE5vbmVgIGlmIHVuYXNzaWduZWQuAAAAAAAPZ2V0X3JvbGVfbWVtYmVyAAAAAAEAAAAAAAAABHJvbGUAAAfQAAAABFJvbGUAAAABAAAD6AAAABM=",
        "AAAAAAAAAhpSZXR1cm5zIGEgc2VuZGVyJ3MgY29tYmluZWQgcm91dGluZyByZWNvcmQ6IHRoZSBhbW91bnQgYWNjdW11bGF0ZWQgaW4KdGhlIGN1cnJlbnQgMjQtaG91ciB3aW5kb3cgYW5kIHRoZWlyIGN1bXVsYXRpdmUgbGlmZXRpbWUgdm9sdW1lCihpc3N1ZSAjNjYzKS4KClJlYWRzIHRoZSBzaW5nbGUgcGFja2VkIGBVc2VyUmVjb3JkYCBlbnRyeS4gRm9yIGEgc2VuZGVyIHRoYXQgb25seSBoYXMKdGhlIGxlZ2FjeSBwcmUtIzY2MyBzcGxpdCBlbnRyaWVzLCBib3RoIGNvdW50ZXJzIGFyZSBjb21iaW5lZCBmcm9tCnRob3NlIHdpdGhvdXQgd3JpdGluZyBhbnl0aGluZy4KCiMgUGFyYW1ldGVycwotIGB1c2VyYDogU2VuZGVyIGFkZHJlc3MgdG8gbG9vayB1cC4KCiMgUmV0dXJucwpBIFtgVXNlclJlY29yZGBdIHdpdGggemVyb2VkIGNvdW50ZXJzIGlmIGB1c2VyYCBoYXMgbmV2ZXIgcm91dGVkIGEKcGF5bWVudDsgYGxhc3RfcmVzZXRfdGltZWAgaXMgdGhlbiB0aGUgY3VycmVudCBsZWRnZXIgdGltZXN0YW1wLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAAAAPZ2V0X3VzZXJfcmVjb3JkAAAAAAEAAAAAAAAABHVzZXIAAAATAAAAAQAAB9AAAAAKVXNlclJlY29yZAAA",
        "AAAAAAAAAPhSZXR1cm5zIHRoZSBjdW11bGF0aXZlIGFtb3VudCBhIGdpdmVuIHNlbmRlciBoYXMgcm91dGVkIHRocm91Z2ggdGhlIGNvbnRyYWN0LgoKIyBQYXJhbWV0ZXJzCi0gYHVzZXJgOiBTZW5kZXIgYWRkcmVzcyB0byBsb29rIHVwLgoKIyBSZXR1cm5zClRoZSBsaWZldGltZSByb3V0ZWQgdm9sdW1lIGZvciBgdXNlcmAsIG9yIGAwYCBpZiB0aGV5IGhhdmUgbmV2ZXIKcm91dGVkIGEgcGF5bWVudC4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAA9nZXRfdXNlcl92b2x1bWUAAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAACw==",
        "AAAAAAAAAs1XaXRoZHJhd3MgYSBzcGVjaWZpYyBhbW91bnQgZnJvbSB0aGUgdXNlcidzIGludGVybmFsIHJlZnVuZCBiYWxhbmNlLgoKQSByZWZ1bmQgYmFsYW5jZSBhY2NydWVzIHdoZW4gYSBgcm91dGVfcGF5bWVudGAgLyBgcm91dGVfcGF5bWVudHNgCnRyYW5zZmVyIHRvIHRoZSByZWNpcGllbnQgZmFpbHMgKGUuZy4gbWlzc2luZyB0cnVzdGxpbmUpIGFuZCB0aGUKZnVuZHMgYXJlIGhlbGQgYnkgdGhlIGNvbnRyYWN0IG9uIHRoZSBzZW5kZXIncyBiZWhhbGYgaW5zdGVhZC4KCiMgUGFyYW1ldGVycwotIGB1c2VyYDogQWRkcmVzcyB3aXRoZHJhd2luZyBmdW5kczsgbXVzdCBhdXRob3JpemUgdGhlIGNhbGwuCi0gYHRva2VuYDogQ29udHJhY3QgSUQgb2YgdGhlIHRva2VuIHRvIHdpdGhkcmF3LgotIGBhbW91bnRgOiBBbW91bnQgdG8gd2l0aGRyYXcuIE11c3QgYmUgcG9zaXRpdmUgYW5kIG5vdCBleGNlZWQgdGhlCmN1cnJlbnQgcmVmdW5kIGJhbGFuY2UuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm9SZWZ1bmRBdmFpbGFibGUpYCBpZiBgYW1vdW50YAppcyB6ZXJvLCBuZWdhdGl2ZSwgb3IgZ3JlYXRlciB0aGFuIHRoZSBhdmFpbGFibGUgYmFsYW5jZS4KCiMgUGFuaWNzClBhbmljcyBpZiBgdXNlcmAgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLCBvciBpZiB0aGUgdW5kZXJseWluZwp0b2tlbiB0cmFuc2ZlciBmYWlscy4AAAAAAAAPd2l0aGRyYXdfcmVmdW5kAAAAAAMAAAAAAAAABHVzZXIAAAATAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAQAAAD1BIHBlbmRpbmcgdGltZWxvY2sgZW50cnkgc3RvcmVkIGluIHBlcnNpc3RlbnQgbGVkZ2VyIHN0b3JhZ2UuAAAAAAAAAAAAAA1UaW1lbG9ja0VudHJ5AAAAAAAAAgAAADdUaGUgYWN0aW9uIHBheWxvYWQgdG8gYXBwbHkgb25jZSB0aGUgZGVsYXkgaGFzIGVsYXBzZWQuAAAAAAZhY3Rpb24AAAAAB9AAAAAKQWN0aW9uVHlwZQAAAAAAQ0xlZGdlciB0aW1lc3RhbXAgKHNlY29uZHMgc2luY2UgZXBvY2gpIHdoZW4gdGhpcyBhY3Rpb24gd2FzIHF1ZXVlZC4AAAAACXF1ZXVlZF9hdAAAAAAAAAY=",
        "AAAAAAAAAPlEZXBvc2l0cyBpZGxlIHRyZWFzdXJ5IGZ1bmRzIGludG8gdGhlIGNvbmZpZ3VyZWQgbGVuZGluZyBwcm90b2NvbC4KCkJvdGggdGhlIFRyZWFzdXJ5TWFuYWdlciBhbmQgdHJlYXN1cnkgYXV0aG9yaXplIHRoaXMgb3BlcmF0aW9uLiBUaGUgc2Vjb25kCmF1dGhvcml6YXRpb24gaXMgcmVxdWlyZWQgYmVjYXVzZSB0aGUgZnVuZHMgYXJlIGhlbGQgYnkgdGhlIHRyZWFzdXJ5LApyYXRoZXIgdGhhbiBieSB0aGlzIHJvdXRlciBjb250cmFjdC4AAAAAAAAQZGVwb3NpdF90b195aWVsZAAAAAIAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAWtJbnN0YW50bHkgZnJlZXplcyB0aGUgY29udHJhY3QsIGJsb2NraW5nIGFsbCBwYXltZW50cyBhbmQgdGltZWxvY2sKZXhlY3V0aW9ucy4gIFRoaXMgaXMgdGhlIGVtZXJnZW5jeSBsYXN0IHJlc29ydCB3aGVuIGFuIGFkbWluIGtleSBpcwprbm93biB0byBiZSBjb21wcm9taXNlZC4KClVubGlrZSBvdGhlciBzZW5zaXRpdmUgYWRtaW4gb3BlcmF0aW9ucywgZnJlZXplIHRha2VzIGVmZmVjdCBpbW1lZGlhdGVseQrigJQgaXQgZG9lcyBOT1QgZ28gdGhyb3VnaCB0aGUgdGltZWxvY2sg4oCUIHNvIGl0IGlzIGFsd2F5cyBhdmFpbGFibGUgYXMgYQpyYXBpZC1yZXNwb25zZSB0b29sLgoKQWRtaW4gYXV0aG9yaXphdGlvbiBpcyByZXF1aXJlZC4AAAAAEGVtZXJnZW5jeV9mcmVlemUAAAAAAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAGlSZXR1cm5zIHRoZSBNZXJrbGUgcm9vdCBhbmQgbWV0YWRhdGEgZm9yIGFuIGFyY2hpdmUgZXBvY2gsIG9yIGBOb25lYAppZiBubyBhcmNoaXZlIGV4aXN0cyBmb3IgdGhhdCBlcG9jaC4AAAAAAAAQZ2V0X2FyY2hpdmVfaW5mbwAAAAEAAAAAAAAABWVwb2NoAAAAAAAABgAAAAEAAAPoAAAD7QAAAAIAAAPuAAAAIAAAB9AAAAAPQXJjaGl2ZU1ldGFkYXRhAA==",
        "AAAAAAAAAAAAAAAQZ2V0X2ZlZV9wcm9wb3NhbAAAAAEAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAABAAAD6AAAB9AAAAALRmVlUHJvcG9zYWwA",
        "AAAAAAAAAmlDb25maWd1cmVzIHRoZSBwcmljZS1mZWVkIG9yYWNsZSBjb250cmFjdCBhZGRyZXNzLiBDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuCgpUaGUgb3JhY2xlIGNvbnRyYWN0IG11c3QgaW1wbGVtZW50IHRoZSBbYFByaWNlRmVlZE9yYWNsZWBdIGludGVyZmFjZToKaXQgbXVzdCBleHBvc2UgYSBgZ2V0X3ByaWNlKGJhc2VfYXNzZXQsIHF1b3RlX2Fzc2V0KSAtPiBQcmljZURhdGFgCm1ldGhvZCB0aGF0IHJldHVybnMgdGhlIGxhdGVzdCBwcmljZSB0b2dldGhlciB3aXRoIGEgVW5peCB0aW1lc3RhbXAgc28Kc3RhbGVuZXNzIGNhbiBiZSB2YWxpZGF0ZWQgYWdhaW5zdCB0aGUgY29uZmlndXJlZCB0aHJlc2hvbGQuCgojIFBhcmFtZXRlcnMKLSBgb3JhY2xlYDogQWRkcmVzcyBvZiB0aGUgb3JhY2xlIGNvbnRyYWN0IHRvIHVzZSBmb3IgcHJpY2UgbG9va3Vwcy4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm90IGJlZW4gaW5pdGlhbGl6ZWQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgQ29tcGxpYW5jZU9mZmljZXIgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgAAAAAAABBzZXRfcHJpY2Vfb3JhY2xlAAAAAQAAAAAAAAAGb3JhY2xlAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAV9BZGRzIGFuIGFkZHJlc3MgdG8gdGhlIGJsYWNrbGlzdC4gQ29tcGxpYW5jZU9mZmljZXItcHJvdGVjdGVkLgoKIyBQYXJhbWV0ZXJzCi0gYGFkZHJlc3NgOiBBZGRyZXNzIHRvIGJsYWNrbGlzdDsgc3Vic2VxdWVudCBwYXltZW50cyB0byBpdCBhcyBhCnJlY2lwaWVudCB3aWxsIGJlIHJlamVjdGVkLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0CmhhcyBubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IENvbXBsaWFuY2VPZmZpY2VyIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAAEWJsYWNrbGlzdF9hZGRyZXNzAAAAAAAAAQAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAaNDbGFpbXMgYW5kIHdpdGhkcmF3cyB0aGUgZW50aXJlIGF2YWlsYWJsZSByZWZ1bmQgYmFsYW5jZSBmb3IgYSB1c2VyIGFuZCB0b2tlbi4KCiMgUGFyYW1ldGVycwotIGB1c2VyYDogQWRkcmVzcyB3aXRoZHJhd2luZyBmdW5kczsgbXVzdCBhdXRob3JpemUgdGhlIGNhbGwuCi0gYHRva2VuYDogQ29udHJhY3QgSUQgb2YgdGhlIHRva2VuIHRvIHdpdGhkcmF3LgoKIyBSZXR1cm5zCmBPayhhbW91bnQpYCB3aXRoIHRoZSBhbW91bnQgd2l0aGRyYXduLCBvcgpgRXJyKEVycm9yOjpOb1JlZnVuZEF2YWlsYWJsZSlgIGlmIHRoZSByZWZ1bmQgYmFsYW5jZSBpcyB6ZXJvLgoKIyBQYW5pY3MKUGFuaWNzIGlmIGB1c2VyYCBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwsIG9yIGlmIHRoZSB1bmRlcmx5aW5nCnRva2VuIHRyYW5zZmVyIGZhaWxzLgAAAAARY2xhaW1fYWxsX3JlZnVuZHMAAAAAAAACAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAEhSZXR1cm5zIHRoZSBjdXJyZW50IGFyY2hpdmUgZXBvY2ggY291bnRlciAoMCA9IG5vIGVwb2NocyBjb21taXR0ZWQgeWV0KS4AAAARZ2V0X2FyY2hpdmVfZXBvY2gAAAAAAAAAAAAAAQAAAAY=",
        "AAAAAAAAAEhSZXR1cm5zIHRoZSBjb25maWd1cmVkIEtZQyB0aHJlc2hvbGQsIG9yIGBOb25lYCB3aGVuIGVuZm9yY2VtZW50IGlzIG9mZi4AAAARZ2V0X2t5Y190aHJlc2hvbGQAAAAAAAAAAAAAAQAAA+gAAAAL",
        "AAAAAAAAAFpSZXR1cm5zIHRoZSBwZW5kaW5nIGBUaW1lbG9ja0VudHJ5YCBmb3IgdGhlIGdpdmVuIG5vbmNlLCBvciBhbiBlcnJvciBpZgppdCBkb2VzIG5vdCBleGlzdC4AAAAAABFnZXRfcXVldWVkX2FjdGlvbgAAAAAAAAEAAAAAAAAABW5vbmNlAAAAAAAABgAAAAEAAAPpAAAH0AAAAA1UaW1lbG9ja0VudHJ5AAAAAAAAAw==",
        "AAAAAAAAANtSZXR1cm5zIHdoZXRoZXIgYSBERVggcm91dGVyIGlzIGFwcHJvdmVkIGZvciBzd2FwIHJvdXRpbmcuCgojIFBhcmFtZXRlcnMKLSBgZGV4YDogQ29udHJhY3QgSUQgdG8gY2hlY2suCgojIFJldHVybnMKYHRydWVgIGlmIHRoZSBERVggbWF5IGJlIHVzZWQgYnkgYHJvdXRlX3BheW1lbnRfd2l0aF9zd2FwYCwgYGZhbHNlYApvdGhlcndpc2UuCgojIFBhbmljcwpEb2VzIG5vdCBwYW5pYy4AAAAAEWlzX2RleF9yZWdpc3RlcmVkAAAAAAAAAQAAAAAAAAADZGV4AAAAABMAAAABAAAAAQ==",
        "AAAAAAAAADBDYXN0cyBvbmUgd2VpZ2h0ZWQgdm90ZSBvbiBhbiBvcGVuIGZlZSBwcm9wb3NhbC4AAAARdm90ZV9mZWVfcHJvcG9zYWwAAAAAAAADAAAAAAAAAAV2b3RlcgAAAAAAABMAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAAAAAAAB3N1cHBvcnQAAAAAAQAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAnFBZG1pbi1vbmx5IGVtZXJnZW5jeSB3aXRoZHJhd2FsIG9mIHRva2VucyBoZWxkIGJ5IHRoaXMgY29udHJhY3QuCgojIFBhcmFtZXRlcnMKLSBgdG9rZW5gOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4gdG8gd2l0aGRyYXcuCkFkbWluLW9ubHkgZW1lcmdlbmN5IHdpdGhkcmF3YWwgb2YgdG9rZW5zIGhlbGQgYnkgdGhpcyBjb250cmFjdC4gVHJlYXN1cnlNYW5hZ2VyLXByb3RlY3RlZC4KCiMgUGFyYW1ldGVycwotIGB0b2tlbmA6IENvbnRyYWN0IElEIG9mIHRoZSB0b2tlbiB0byB3aXRoZHJhdy4KLSBgYW1vdW50YDogQW1vdW50IHRvIHRyYW5zZmVyIGZyb20gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSB0byB0aGUgdHJlYXN1cnkgbWFuYWdlci4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBUcmVhc3VyeU1hbmFnZXIgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLCBvciBpZiB0aGUKdG9rZW4gdHJhbnNmZXIgZmFpbHMgKGUuZy4gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSBpcyBiZWxvdyBgYW1vdW50YCkuAAAAAAAAEmVtZXJnZW5jeV93aXRoZHJhdwAAAAAAAgAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAQFSZXR1cm5zIHRoZSBzdG9yZWQgZmFsbGJhY2sgcHJpY2UgZm9yIGEgKGJhc2UsIHF1b3RlKSBhc3NldCBwYWlyLCBpZiBhbnkuCgojIFBhcmFtZXRlcnMKLSBgYmFzZV9hc3NldGA6IEFkZHJlc3Mgb2YgdGhlIGJhc2UgYXNzZXQuCi0gYHF1b3RlX2Fzc2V0YDogQWRkcmVzcyBvZiB0aGUgcXVvdGUgYXNzZXQuCgojIFJldHVybnMKYFNvbWUoUHJpY2VEYXRhKWAgaWYgYSBmYWxsYmFjayBoYXMgYmVlbiBjb25maWd1cmVkLCBgTm9uZWAgb3RoZXJ3aXNlLgAAAAAAABJnZXRfZmFsbGJhY2tfcHJpY2UAAAAAAAIAAAAAAAAACmJhc2VfYXNzZXQAAAAAABMAAAAAAAAAC3F1b3RlX2Fzc2V0AAAAABMAAAABAAAD6AAAB9AAAAAJUHJpY2VEYXRhAAAA",
        "AAAAAAAAARJSZXR1cm5zIHRoZSBhdmFpbGFibGUgaW50ZXJuYWwgcmVmdW5kIGJhbGFuY2UgZm9yIGEgdXNlciBhbmQgdG9rZW4uCgojIFBhcmFtZXRlcnMKLSBgdXNlcmA6IEFkZHJlc3Mgd2hvc2UgcmVmdW5kIGJhbGFuY2UgdG8gbG9vayB1cC4KLSBgdG9rZW5gOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4uCgojIFJldHVybnMKVGhlIHJlZnVuZGFibGUgYmFsYW5jZSBmb3IgYCh1c2VyLCB0b2tlbilgLCBvciBgMGAgaWYgbm9uZSBpcyBoZWxkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAAAASZ2V0X3JlZnVuZF9iYWxhbmNlAAAAAAACAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAAAs=",
        "AAAAAAAAADRSZXR1cm5zIHRoZSB0cmFja2VkIHByaW5jaXBhbCBkZXBvc2l0ZWQgZm9yIGB0b2tlbmAuAAAAEmdldF95aWVsZF9wb3NpdGlvbgAAAAAAAQAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAAAs=",
        "AAAAAAAAAD1DcmVhdGVzIGEgZmVlIHByb3Bvc2FsIHdlaWdodGVkIGJ5IGdvdmVybmFuY2UtdG9rZW4gYmFsYW5jZXMuAAAAAAAAEnByb3Bvc2VfZmVlX2NoYW5nZQAAAAAABAAAAAAAAAAIcHJvcG9zZXIAAAATAAAAAAAAAAdmZWVfYnBzAAAAAAsAAAAAAAAAB2ZlZV9jYXAAAAAACwAAAAAAAAANdm90aW5nX3BlcmlvZAAAAAAAAAYAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAA/RSb3V0ZXMgYSBwYXltZW50IGF1dGhvcmlzZWQgYnkgYW4gb2ZmLWNoYWluIHJlbGF5ZXIncyBFZDI1NTE5IHNpZ25hdHVyZQppbnN0ZWFkIG9mIHRoZSBzZW5kZXIncyBvbi1jaGFpbiBhdXRob3JpemF0aW9uLgoKVGhlIHJlbGF5ZXIgc2lnbnMgYSBjYW5vbmljYWwgcGF5bG9hZCBiaW5kaW5nIHRoZSBzZW5kZXIsIHJlY2lwaWVudCwKdG9rZW4sIGFtb3VudCwgbm9uY2UgYW5kIGRlYWRsaW5lLiBUaGUgY29udHJhY3QgdmVyaWZpZXMgdGhlIHNpZ25hdHVyZSwKYnVybnMgdGhlIG5vbmNlIHRvIGJsb2NrIHJlcGxheXMsIGFuZCB0aGVuIHNldHRsZXMgdGhlIHBheW1lbnQgdGhyb3VnaAp0aGUgc2FtZSBhY2NvdW50aW5nIGFzIGEgZGlyZWN0IGByb3V0ZV9wYXltZW50YC4KCiMgUGFyYW1ldGVycwotIGBzZW5kZXJgOiBBZGRyZXNzIHdob3NlIGZ1bmRzIGFyZSByb3V0ZWQgYW5kIHdob3NlIG5vbmNlIGlzIGNvbnN1bWVkLgotIGBzaWduZXJfcHVia2V5YDogRWQyNTUxOSBwdWJsaWMga2V5IHRoYXQgbXVzdCBoYXZlIHNpZ25lZCB0aGUgcGF5bG9hZC4KLSBgcmVjaXBpZW50YDogQWRkcmVzcyB0aGUgZnVuZHMgYXJlIGRlbGl2ZXJlZCB0by4KLSBgdG9rZW5fYWRkcmVzc2A6IENvbnRyYWN0IElEIG9mIHRoZSB0b2tlbiBiZWluZyB0cmFuc2ZlcnJlZC4KLSBgYW1vdW50YDogQW1vdW50IHRvIHJvdXRlIGluIHRoZSB0b2tlbidzIHNtYWxsZXN0IHVuaXQuCi0gYG5vbmNlYDogTXVzdCBlcXVhbCB0aGUgc2VuZGVyJ3MgY3VycmVudCBtZXRhLXRyYW5zYWN0aW9uIG5vbmNlLgotIGBkZWFkbGluZWA6IExlZGdlciB0aW1lc3RhbXAgYWZ0ZXIgd2hpY2ggdGhlIHN1Ym1pc3Npb24gaXMgcmVqZWN0ZWQuCi0gYHNpZ25hdHVyZWA6IEVkMjU1MTkgc2lnbmF0dXJlIG92ZXIgdGhlIGNhbm9uaWNhbCBwYXlsb2FkLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uY2UgdGhlIHBheW1lbnQgaGFzIHNldHRsZWQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIHNpZ25hdHVyZSBkb2VzIG5vdCB2ZXJpZnkuAAAAEnJvdXRlX3BheW1lbnRfbWV0YQAAAAAACAAAAAAAAAAGc2VuZGVyAAAAAAATAAAAAAAAAA1zaWduZXJfcHVia2V5AAAAAAAD7gAAACAAAAAAAAAACXJlY2lwaWVudAAAAAAAABMAAAAAAAAADXRva2VuX2FkZHJlc3MAAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAABW5vbmNlAAAAAAAABgAAAAAAAAAIZGVhZGxpbmUAAAAGAAAAAAAAAAlzaWduYXR1cmUAAAAAAAPuAAAAQAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAA09TdG9yZXMgYW4gYWRtaW4tc3VwcGxpZWQgZmFsbGJhY2sgcHJpY2UgZm9yIGEgKGJhc2UsIHF1b3RlKSBhc3NldCBwYWlyLgpDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuCgpUaGUgZmFsbGJhY2sgaXMgdXNlZCBieSBbYGdldF9wcmljZWBdIHdoZW4gdGhlIGxpdmUgb3JhY2xlIGlzCnVuYXZhaWxhYmxlIG9yIHJldHVybnMgZGF0YSB0aGF0IGZhaWxzIHZhbGlkYXRpb24gKHN0YWxlIG9yIGludmFsaWQpLgpTZXR0aW5nIGEgZmFsbGJhY2sgcHJpY2UgdG8gYDBgIGVmZmVjdGl2ZWx5IHJlbW92ZXMgdGhlIGZhbGxiYWNrLAptZWFuaW5nIHRoYXQgb3JhY2xlIGZhaWx1cmVzIHdpbGwgcHJvcGFnYXRlIGFzIGVycm9ycyByYXRoZXIgdGhhbgpzaWxlbnRseSB1c2luZyBhIHN0YWxlIGNhY2hlZCB2YWx1ZS4KCiMgUGFyYW1ldGVycwotIGBiYXNlX2Fzc2V0YDogQWRkcmVzcyBvZiB0aGUgYmFzZSBhc3NldCAoZS5nLiBYTE0gY29udHJhY3QpLgotIGBxdW90ZV9hc3NldGA6IEFkZHJlc3Mgb2YgdGhlIHF1b3RlIGFzc2V0IChlLmcuIFVTREMgY29udHJhY3QpLgotIGBmYWxsYmFja19wcmljZWA6IFByaWNlIGV4cHJlc3NlZCBpbiB0aGUgc2FtZSBmaXhlZC1wb2ludCBmb3JtYXQgYXMKdGhlIG9yYWNsZSAoYHByaWNlIC8gMTBeZGVjaW1hbHNgKS4gUGFzcyBgMGAgdG8gY2xlYXIgdGhlIGZhbGxiYWNrLgotIGBkZWNpbWFsc2A6IERlY2ltYWwgcHJlY2lzaW9uIG9mIGBmYWxsYmFja19wcmljZWAuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcy4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBDb21wbGlhbmNlT2ZmaWNlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAABJzZXRfZmFsbGJhY2tfcHJpY2UAAAAAAAQAAAAAAAAACmJhc2VfYXNzZXQAAAAAABMAAAAAAAAAC3F1b3RlX2Fzc2V0AAAAABMAAAAAAAAADmZhbGxiYWNrX3ByaWNlAAAAAAALAAAAAAAAAAhkZWNpbWFscwAAAAQAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAF5Db25maWd1cmVzIHRoZSBsZW5kaW5nIHByb3RvY29sIHVzZWQgZm9yIHRyZWFzdXJ5IHlpZWxkIG9wZXJhdGlvbnMuIFRyZWFzdXJ5TWFuYWdlci1wcm90ZWN0ZWQuAAAAAAASc2V0X3lpZWxkX3Byb3RvY29sAAAAAAABAAAAAAAAAAhwcm90b2NvbAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAMRSZWNvcmRzIGEgdG9rZW4gYXMgc3VwcG9ydGVkIChuby1vcDsgcm91dGluZyBhY2NlcHRzIGFueSB0b2tlbiBjb250cmFjdCBJRCkuCgojIFBhcmFtZXRlcnMKLSBgX3Rva2VuYDogSWdub3JlZDsgcHJlc2VudCBmb3IgQVBJIGNvbXBhdGliaWxpdHkuCgojIFJldHVybnMKQWx3YXlzIGBPaygoKSlgLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAE2FkZF9zdXBwb3J0ZWRfdG9rZW4AAAAAAQAAAAAAAAAGX3Rva2VuAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAQdDb21taXRzIGEgU0hBLTI1NiBNZXJrbGUgcm9vdCBvZiBhIGJhdGNoIG9mIHBheW1lbnQtcmVjb3JkIHNuYXBzaG90cwppbnRvIHBlcnNpc3RlbnQgc3RvcmFnZSwgb3BlbmluZyBhIG5ldyBhcmNoaXZlIGVwb2NoLgoKQ2FsbCB0aGlzIGJlZm9yZSBgcHJ1bmVfYXJjaGl2ZWRfZW50cmllc2AuIFJlcXVpcmVzIFRyZWFzdXJ5TWFuYWdlci4KUmV0dXJucyB0aGUgbmV3IGVwb2NoIG51bWJlci4KCkVycm9yczogTm90SW5pdGlhbGl6ZWQsIENvbnRyYWN0RnJvemVuLgAAAAATY29tbWl0X2FyY2hpdmVfcm9vdAAAAAADAAAAAAAAAARyb290AAAD7gAAACAAAAAAAAAABmxlYXZlcwAAAAAD6gAAB9AAAAALQXJjaGl2ZUxlYWYAAAAAAAAAAAtkZXNjcmlwdGlvbgAAAAAQAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAnFQZXJtaXNzaW9ubGVzcyBtaWdyYXRpb24gb2YgYSBzZW5kZXIncyBsZWdhY3kgcHJlLSM2NjMgc3BsaXQgZW50cmllcwooYFVzZXJTcGVuZGluZ2AgKyBgVXNlclZvbHVtZWApIGludG8gdGhlIHNpbmdsZSBwYWNrZWQgYFVzZXJSZWNvcmRgCihpc3N1ZSAjNjYzKS4KCkNhbGxhYmxlIGJ5IGFueW9uZTogaXQgb25seSByZWNvbWJpbmVzIHZhbHVlcyB0aGF0IGFyZSBhbHJlYWR5IG9uIHRoZQpsZWRnZXIgYW5kIG5ldmVyIGludmVudHMgb3IgZGVzdHJveXMgdmFsdWUuIFdoZW4gdGhlIHNlbmRlcidzIHBhY2tlZApyZWNvcmQgd2FzIGFscmVhZHkgY3JlYXRlZCBieSBhIHJlY2VudCBwYXltZW50LCB0aGlzIGp1c3QgcmVtb3ZlcyB0aGUKc3RhbGUgbGVnYWN5IGtleXMgYW5kIGtlZXBzIHRoZSBuZXdlciBwYWNrZWQgdmFsdWVzLgoKIyBQYXJhbWV0ZXJzCi0gYHVzZXJgOiBUaGUgc2VuZGVyIHdob3NlIGxlZ2FjeSBlbnRyaWVzIHNob3VsZCBiZSBtaWdyYXRlZC4KCiMgUmV0dXJucwpgdHJ1ZWAgaWYgbGVnYWN5IHN0YXRlIHdhcyBmb3VuZCBhbmQgbWlncmF0ZWQsIGBmYWxzZWAgaWYgYHVzZXJgIGhhcwpubyBsZWdhY3kgZW50cmllcyB0byBtaWdyYXRlLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAAAAAE21pZ3JhdGVfdXNlcl9yZWNvcmQAAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAAAQ==",
        "AAAAAAAAATlSZW1vdmVzIGFuIGFkZHJlc3MgZnJvbSB0aGUgYmxhY2tsaXN0LiBDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuCgojIFBhcmFtZXRlcnMKLSBgYWRkcmVzc2A6IEFkZHJlc3MgdG8gcmVtb3ZlIGZyb20gdGhlIGJsYWNrbGlzdC4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBDb21wbGlhbmNlT2ZmaWNlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAAE3VuYmxhY2tsaXN0X2FkZHJlc3MAAAAAAQAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAF1XaXRoZHJhd3MgdHJlYXN1cnkgcHJpbmNpcGFsIGZyb20gdGhlIGNvbmZpZ3VyZWQgbGVuZGluZyBwcm90b2NvbC4gVHJlYXN1cnlNYW5hZ2VyLXByb3RlY3RlZC4AAAAAAAATd2l0aGRyYXdfZnJvbV95aWVsZAAAAAACAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAMNDb25maWd1cmVzIHRoZSBEQU8gdG9rZW4gYW5kIG1pbmltdW0gdm90aW5nIHdlaWdodCBmb3IgZmVlIHByb3Bvc2Fscy4KVGhpcyBhZG1pbmlzdHJhdGl2ZSBib290c3RyYXAgZG9lcyBub3QgaXRzZWxmIGNoYW5nZSBmZWVzOyBzdWJzZXF1ZW50CmZlZSBjaGFuZ2VzIGNhbiBiZSBtYWRlIHRocm91Z2ggdGhlIHByb3Bvc2FsIGxpZmVjeWNsZS4AAAAAFGNvbmZpZ3VyZV9nb3Zlcm5hbmNlAAAAAgAAAAAAAAAQZ292ZXJuYW5jZV90b2tlbgAAABMAAAAAAAAABnF1b3J1bQAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAEFGaW5hbGl6ZXMgYSBzdWNjZXNzZnVsIGZlZSBwcm9wb3NhbCBhZnRlciBpdHMgdm90aW5nIHBlcmlvZCBlbmRzLgAAAAAAABRleGVjdXRlX2ZlZV9wcm9wb3NhbAAAAAEAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAM1SZXR1cm5zIHRoZSBtYXhpbXVtIHRvbGVyYXRlZCBzd2FwIHNsaXBwYWdlIGluIGJhc2lzIHBvaW50cy4KCiMgUmV0dXJucwpUaGUgY29uZmlndXJlZCBgbWF4X3NsaXBwYWdlX2Jwc2AsIG9yIHRoZSAxIDAwMCBicHMgKDEwJSkgZGVmYXVsdCBpZgp0aGUgY29udHJhY3QgaGFzIG5vdCBiZWVuIGluaXRpYWxpemVkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAAAAAFGdldF9tYXhfc2xpcHBhZ2VfYnBzAAAAAAAAAAEAAAAL",
        "AAAAAAAAAoBTZXRzIHRoZSBtYXhpbXVtIHRvbGVyYXRlZCBzd2FwIHNsaXBwYWdlLiBBZG1pbi1vbmx5LgoKQXBwbGllZCBhZ2FpbnN0IHRoZSBgZXhwZWN0ZWRfYW1vdW50X291dGAgYSBjYWxsZXIgc3VwcGxpZXMgYWxvbmdzaWRlIGEKcXVvdGUsIGFzIGEgc2Vjb25kIGd1YXJkIG9uIHRvcCBvZiB0aGUgcGVyLXBheW1lbnQgYG1pbl9hbW91bnRfb3V0YApmbG9vci4KCiMgUGFyYW1ldGVycwotIGBtYXhfc2xpcHBhZ2VfYnBzYDogTmV3IGNlaWxpbmcgaW4gYmFzaXMgcG9pbnRzOyBgMGAgdG8gYDEwXzAwMGAuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2VzcywgYEVycihFcnJvcjo6SW52YWxpZFN3YXBQYXJhbXMpYCBpZiB0aGUgdmFsdWUgaXMKb3V0c2lkZSBgMC4uPTEwXzAwMGAsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0IGhhcwpubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IGFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4KCkRFUFJFQ0FURUQgZm9yIGRpcmVjdCB1c2UuICBRdWV1ZSB2aWEgYHF1ZXVlX2FjdGlvbihBY3Rpb25UeXBlOjpTZXRNYXhTbGlwcGFnZUJwcyjigKYpKWAKYW5kIGV4ZWN1dGUgYWZ0ZXIgMjQgaG91cnMuAAAAFHNldF9tYXhfc2xpcHBhZ2VfYnBzAAAAAQAAAAAAAAAQbWF4X3NsaXBwYWdlX2JwcwAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAUlSZXR1cm5zIHRoZSBlZmZlY3RpdmUgZmVlX2JwcyBmb3IgYSBzZW5kZXIgYWZ0ZXIgYXBwbHlpbmcgYW55CnZvbHVtZS1iYXNlZCB0aWVyZWQgZGlzY291bnQuCgojIFBhcmFtZXRlcnMKLSBgc2VuZGVyYDogQWRkcmVzcyB3aG9zZSBkaXNjb3VudGVkIGZlZSByYXRlIHRvIGNvbXB1dGUuCgojIFJldHVybnMKVGhlIGNvbmZpZ3VyZWQgYGZlZV9icHNgLCBoYWx2ZWQgaWYgYHNlbmRlcmAncyBsaWZldGltZSB2b2x1bWUKZXhjZWVkcyB0aGUgdGllcmVkLWRpc2NvdW50IHRocmVzaG9sZCwgb3IgYDBgIGlmIG5vdCBpbml0aWFsaXplZC4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAAAAABVnZXRfZWZmZWN0aXZlX2ZlZV9icHMAAAAAAAABAAAAAAAAAAZzZW5kZXIAAAAAABMAAAABAAAACw==",
        "AAAAAAAAAYxSZXR1cm5zIHRoZSBzaWduZXJzIHdob3NlIGFwcHJvdmFsIG9mIGFuIHVwZ3JhZGUgdG8gYG5ld193YXNtX2hhc2hgCmN1cnJlbnRseSBjb3VudHMuCgpBcHByb3ZhbHMgY2FzdCBieSBhIHNpZ25lciB0aGF0IGhhcyBzaW5jZSBiZWVuIHJvdGF0ZWQgb3V0IG9mIHRoZSBncm91cAphcmUgb21pdHRlZCwgc28gdGhpcyBsaXN0IGFsd2F5cyBhZ3JlZXMgd2l0aCBgaXNfdXBncmFkZV9hdXRob3JpemVkYC4KCiMgUmV0dXJucwpUaGUgY291bnRlZCBhcHByb3ZhbHMgaW4gdGhlIG9yZGVyIHRoZXkgd2VyZSByZWNvcmRlZCwgb3IgYW4gZW1wdHkKdmVjdG9yIGlmIHRoZSBoYXNoIGhhcyBub25lLiBFbXB0eSB3aGVuIG5vIGdyb3VwIGlzIGNvbmZpZ3VyZWQuCgojIFBhbmljcwpEb2VzIG5vdCBwYW5pYy4AAAAVZ2V0X3VwZ3JhZGVfYXBwcm92YWxzAAAAAAAAAQAAAAAAAAANbmV3X3dhc21faGFzaAAAAAAAA+4AAAAgAAAAAQAAA+oAAAAT",
        "AAAAAAAAAOZSZXR1cm5zIHdoZXRoZXIgYW4gdXBncmFkZSB0byBgbmV3X3dhc21faGFzaGAgaXMgYWxyZWFkeSBhdXRob3JpemVkLgoKIyBSZXR1cm5zCmB0cnVlYCBvbmNlIGBNYCBncm91cCBtZW1iZXJzIGhhdmUgYXBwcm92ZWQgdGhhdCBleGFjdCBoYXNoLgpgRXJyKEVycm9yOjpNdWx0aXNpZ05vdEluaXRpYWxpemVkKWAgaWYgbm8gZ3JvdXAgaXMgY29uZmlndXJlZC4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAAAAFWlzX3VwZ3JhZGVfYXV0aG9yaXplZAAAAAAAAAEAAAAAAAAADW5ld193YXNtX2hhc2gAAAAAAAPuAAAAIAAAAAEAAAPpAAAAAQAAAAM=",
        "AAAAAAAAAfJVcGRhdGVzIHRoZSBmZWUgYmFzaXMgcG9pbnRzIGFuZCBmZWUgY2FwLgpSZXF1aXJlcyBnb3Zlcm5hbmNlIGF1dGhvcml0eSBpZiBhIGdvdmVybmFuY2UgYWRkcmVzcyBpcyBzZXQ7IG90aGVyd2lzZSBhZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYGZlZV9icHNgOiBOZXcgcGxhdGZvcm0gZmVlIHJhdGUsIGluIGJhc2lzIHBvaW50cy4KLSBgZmVlX2NhcGA6IE5ldyBtYXhpbXVtIGZlZSB0YWtlbiBmcm9tIGEgc2luZ2xlIHBheW1lbnQuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGNhbGxlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuCgpERVBSRUNBVEVEIGZvciBkaXJlY3QgdXNlLiAgUXVldWUgdmlhIGBxdWV1ZV9hY3Rpb24oQWN0aW9uVHlwZTo6U2V0RmVlQ29uZmlnKOKApikpYC4AAAAAABVzZXRfZmVlX2NvbmZpZ19sZWdhY3kAAAAAAAACAAAAAAAAAAdmZWVfYnBzAAAAAAsAAAAAAAAAB2ZlZV9jYXAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAlFVcGRhdGVzIHRoZSB0cmVhc3VyeSBhZGRyZXNzIHRoYXQgcmVjZWl2ZXMgdGhlIHBsYXRmb3JtIGZlZS4KClVwZGF0ZXMgdGhlIHRyZWFzdXJ5IGFkZHJlc3MgdGhhdCByZWNlaXZlcyB0aGUgcGxhdGZvcm0gZmVlLiBQcm90ZWN0ZWQgYnkgVHJlYXN1cnlNYW5hZ2VyLgoKIyBQYXJhbWV0ZXJzCi0gYG5ld190cmVhc3VyeWA6IEFkZHJlc3MgdG8gcmVjZWl2ZSBwbGF0Zm9ybSBmZWVzIGdvaW5nIGZvcndhcmQuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgVHJlYXN1cnlNYW5hZ2VyIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4KCkRFUFJFQ0FURUQgZm9yIGRpcmVjdCB1c2UuICBRdWV1ZSB2aWEgYHF1ZXVlX2FjdGlvbihBY3Rpb25UeXBlOjpTZXRQbGF0Zm9ybVRyZWFzdXJ5KOKApikpYAphbmQgZXhlY3V0ZSBhZnRlciAyNCBob3Vycy4gIFRoaXMgZGlyZWN0IHBhdGggaXMgcmV0YWluZWQgZm9yIHRvb2xpbmcKY29tcGF0aWJpbGl0eSBvbmx5LgAAAAAAABVzZXRfcGxhdGZvcm1fdHJlYXN1cnkAAAAAAAABAAAAAAAAAAxuZXdfdHJlYXN1cnkAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAVBEZWxldGVzIG9uLWNoYWluIGxlZGdlciBlbnRyaWVzIGNvbW1pdHRlZCB2aWEgYGNvbW1pdF9hcmNoaXZlX3Jvb3RgLgoKUmVxdWlyZXMgdGhlIGVwb2NoIGZyb20gYSBwcmlvciBjb21taXQgY2FsbC4gU2lsZW50bHkgc2tpcHMgYWJzZW50CmVudHJpZXMuIFJldHVybnMgdGhlIGNvdW50IG9mIGVudHJpZXMgcmVtb3ZlZC4KClN1cHBvcnRlZDogVXNlclZvbHVtZSwgVXNlclNwZW5kaW5nLCBSZWZ1bmRCYWxhbmNlLgpFcnJvcnM6IE5vdEluaXRpYWxpemVkLCBDb250cmFjdEZyb3plbiwgVGltZWxvY2tOb3RGb3VuZCAodW5rbm93biBlcG9jaCkuClJlcXVpcmVzIFRyZWFzdXJ5TWFuYWdlci4AAAAWcHJ1bmVfYXJjaGl2ZWRfZW50cmllcwAAAAAAAgAAAAAAAAAPY29tbWl0dGVkX2Vwb2NoAAAAAAYAAAAAAAAABmxlYXZlcwAAAAAD6gAAB9AAAAALQXJjaGl2ZUxlYWYAAAAAAQAAA+kAAAAEAAAAAw==",
        "AAAAAAAAA89Sb3V0ZXMgYSBwYXltZW50IGluIGFueSB0b2tlbiwgc3dhcHBpbmcgaXQgaW50byB0aGUgcmVjaXBpZW50J3MKcHJlZmVycmVkIHRva2VuIG9uIHRoZSB3YXkuCgpUaGUgc3dhcC1yb3V0ZWQgY291bnRlcnBhcnQgb2YgW2BQYXltZW50Um91dGVyOjpyb3V0ZV9wYXltZW50YF06IHRoZSBzYW1lCmZlZSwgbGltaXQsIGJsYWNrbGlzdCwgYW5kIGZyZWV6ZSBydWxlcyBhcHBseSwgd2l0aCB0aGUgY29udmVyc2lvbgppbnNlcnRlZCBiZXR3ZWVuIHB1bGxpbmcgdGhlIGZ1bmRzIGFuZCBkZWxpdmVyaW5nIHRoZW0uIFRoZSBwbGF0Zm9ybSBmZWUKaXMgdGFrZW4gb24gdGhlIGBidXlfdG9rZW5gIG91dHB1dCwgc28gYGZlZV9jYXBgIGFwcGxpZXMgaW4gYGJ1eV90b2tlbmAKdW5pdHMgZm9yIHRoaXMgcm91dGUuCgojIFBhcmFtZXRlcnMKLSBgcGF5bWVudGA6IFRoZSBzd2FwLXJvdXRlZCB0cmFuc2ZlciAoc2VlIFtgU3dhcFBheW1lbnRgXSkuCgojIFJldHVybnMKVGhlIGFtb3VudCBvZiBgYnV5X3Rva2VuYCBkZWxpdmVyZWQgdG8gdGhlIHJlY2lwaWVudCwgYWZ0ZXIgdGhlCnBsYXRmb3JtIGZlZS4gT3RoZXJ3aXNlIHRoZSBwYXltZW50IGlzIGFiYW5kb25lZCB3aG9sZSwgd2l0aDoKLSBgRXJyKEVycm9yOjpJbnZhbGlkU3dhcFBhcmFtcylgLCBgRXJyKEVycm9yOjpTd2FwRGVhZGxpbmVFeHBpcmVkKWAsCmBFcnIoRXJyb3I6OkRleE5vdFJlZ2lzdGVyZWQpYCwgYEVycihFcnJvcjo6U3dhcEZhaWxlZClgLCBvcgpgRXJyKEVycm9yOjpTbGlwcGFnZUV4Y2VlZGVkKWAgZm9yIHN3YXAtc3BlY2lmaWMgcHJvYmxlbXMsCi0gdGhlIHNhbWUgYEVycmAgdmFyaWFudHMgYXMgYHJvdXRlX3BheW1lbnRgIG90aGVyd2lzZS4KCiMgUGFuaWNzClBhbmljcyBpZiBgcGF5bWVudC5zZW5kZXJgIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYgYSB0b2tlbgp0cmFuc2ZlciBvdXQgb2YgdGhpcyBjb250cmFjdCBmYWlscy4AAAAAF3JvdXRlX3BheW1lbnRfd2l0aF9zd2FwAAAAAAEAAAAAAAAAB3BheW1lbnQAAAAH0AAAAAtTd2FwUGF5bWVudAAAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAjJTZXRzIHRoZSBtYXhpbXVtIGFnZSAoaW4gc2Vjb25kcykgYSBwcmljZSByZWFkaW5nIG1heSBoYXZlIGJlZm9yZSBpdCBpcwpjb25zaWRlcmVkIHN0YWxlLiBDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuCgpXaGVuIGEgcHJpY2UgdGltZXN0YW1wIGlzIG9sZGVyIHRoYW4gYChjdXJyZW50X2xlZGdlcl90aW1lIC0gdGhyZXNob2xkKWAKdGhlIHJlYWRpbmcgaXMgcmVqZWN0ZWQgd2l0aCBbYEVycm9yOjpPcmFjbGVQcmljZVN0YWxlYF0gYW5kIHRoZQpmYWxsYmFjayBwcmljZSAoaWYgY29uZmlndXJlZCkgaXMgdXNlZCBpbnN0ZWFkLgoKIyBQYXJhbWV0ZXJzCi0gYHRocmVzaG9sZF9zZWNzYDogTWF4aW11bSBhbGxvd2VkIGFnZSBpbiBzZWNvbmRzLiBBIHZhbHVlIG9mIGAwYApkaXNhYmxlcyB0aGUgc3RhbGVuZXNzIGNoZWNrIGVudGlyZWx5IChldmVyeSBwcmljZSBpcyBhY2NlcHRlZCkuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcy4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBDb21wbGlhbmNlT2ZmaWNlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAXc2V0X3N0YWxlbmVzc190aHJlc2hvbGQAAAAAAQAAAAAAAAAOdGhyZXNob2xkX3NlY3MAAAAAAAYAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAmRSb3V0ZXMgc2V2ZXJhbCBzd2FwLXJvdXRlZCBwYXltZW50cyBpbiBhIHNpbmdsZSB0cmFuc2FjdGlvbi4gSWYgYW55CnBheW1lbnQgZmFpbHMsIHRoZSBlbnRpcmUgYmF0Y2ggaXMgcmV2ZXJ0ZWQgYXRvbWljYWxseSwgaW5jbHVkaW5nIGFueQpzd2FwcyB0aGF0IGFscmVhZHkgZXhlY3V0ZWQgZWFybGllciBpbiB0aGUgYmF0Y2guCgojIFBhcmFtZXRlcnMKLSBgcGF5bWVudHNgOiBCYXRjaCBvZiBzd2FwLXJvdXRlZCB0cmFuc2ZlcnMgdG8gYXBwbHkgaW4gb3JkZXIuIFNlZQpbYFN3YXBQYXltZW50YF0gZm9yIHBlci1pdGVtIGNvbnN0cmFpbnRzLgoKIyBSZXR1cm5zClRoZSB0b3RhbCBhbW91bnQgb2YgYGJ1eV90b2tlbmAgZGVsaXZlcmVkIGFjcm9zcyB0aGUgYmF0Y2gsIG9yIHRoZQpmaXJzdCBlcnJvciBlbmNvdW50ZXJlZCAoc2VlIGByb3V0ZV9wYXltZW50X3dpdGhfc3dhcGAgZm9yIHRoZQpwb3NzaWJsZSB2YXJpYW50cyBhbmQgdGhlaXIgY2F1c2VzKS4KCiMgUGFuaWNzClBhbmljcyBpZiBhbnkgcGF5bWVudCdzIGBzZW5kZXJgIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYgYQp0b2tlbiB0cmFuc2ZlciBvdXQgb2YgdGhpcyBjb250cmFjdCBmYWlscy4AAAAYcm91dGVfcGF5bWVudHNfd2l0aF9zd2FwAAAAAQAAAAAAAAAIcGF5bWVudHMAAAPqAAAH0AAAAAtTd2FwUGF5bWVudAAAAAABAAAD6QAAAAsAAAAD",
        "AAAAAQAAATxBIHNpbmdsZSBhcmNoaXZlIGxlYWYgZGVzY3JpcHRvciBwYXNzZWQgaW50byBgY29tbWl0X2FyY2hpdmVfcm9vdGAgYW5kCmBwcnVuZV9hcmNoaXZlZF9lbnRyaWVzYC4KClRoZSBjb250cmFjdCB1c2VzIGByZWNvcmRfdHlwZSArIHByaW1hcnlfa2V5ICgrIHNlY29uZGFyeV9rZXkpYCB0byBsb2NhdGUKdGhlIGNvcnJlc3BvbmRpbmcgYERhdGFLZXlgIHRvIGRlbGV0ZSBkdXJpbmcgYSBwcnVuZS4gSXQgZG9lcyBub3QgcmUtaGFzaAp0aGUgbGVhdmVzIOKAlCB0aGUgTWVya2xlIHJvb3QgaXMgY29tcHV0ZWQgYW5kIHRydXN0ZWQgZnJvbSBvZmYtY2hhaW4uAAAAAAAAAAtBcmNoaXZlTGVhZgAAAAADAAAAd1ByaW1hcnkga2V5IGFkZHJlc3M6Ci0gYFVzZXJWb2x1bWVgIC8gYFVzZXJTcGVuZGluZ2A6IHRoZSBzZW5kZXIgYWRkcmVzcy4KLSBgUmVmdW5kQmFsYW5jZWA6IHRoZSB1c2VyIChzZW5kZXIpIGFkZHJlc3MuAAAAAAtwcmltYXJ5X2tleQAAAAATAAAAKldoaWNoIHR5cGUgb2YgcmVjb3JkIHRoaXMgbGVhZiByZXByZXNlbnRzLgAAAAAAC3JlY29yZF90eXBlAAAAB9AAAAARQXJjaGl2ZVJlY29yZFR5cGUAAAAAAAByU2Vjb25kYXJ5IGtleSBhZGRyZXNzOgotIGBSZWZ1bmRCYWxhbmNlYDogdGhlIHRva2VuIGNvbnRyYWN0IGFkZHJlc3MuCi0gT3RoZXIgdHlwZXM6IGlnbm9yZWQgKG1heSBiZSBhbnkgYWRkcmVzcykuAAAAAAANc2Vjb25kYXJ5X2tleQAAAAAAABM=",
        "AAAAAQAAACxNZXRhZGF0YSBzdG9yZWQgYWxvbmdzaWRlIGVhY2ggYXJjaGl2ZSByb290LgAAAAAAAAAPQXJjaGl2ZU1ldGFkYXRhAAAAAAMAAAA/VW5peCB0aW1lc3RhbXAgKHNlY29uZHMpIHdoZW4gdGhpcyBhcmNoaXZlIGVwb2NoIHdhcyBjb21taXR0ZWQuAAAAAAxjb21taXR0ZWRfYXQAAAAGAAAAOUZyZWUtZm9ybSBkZXNjcmlwdGlvbiB0YWcgKGUuZy4gYCJ1c2VyX3ZvbHVtZToyMDI2LTA5ImApLgAAAAAAAAtkZXNjcmlwdGlvbgAAAAAQAAAANlRvdGFsIG51bWJlciBvZiBsZWFmIHJlY29yZHMgaW5jbHVkZWQgaW4gdGhpcyBhcmNoaXZlLgAAAAAADHJlY29yZF9jb3VudAAAAAQ=",
        "AAAAAwAAAJRSZWNvcmQgdHlwZXMgc3VwcG9ydGVkIGJ5IHRoZSBhcmNoaXZhbCBzeXN0ZW0uCgpUaGUgYHJlcHIodTMyKWAgZGlzY3JpbWluYW50IGRvdWJsZXMgYXMgdGhlIHRhZyBieXRlIHByZXBlbmRlZCB3aGVuCmNvbXB1dGluZyBsZWFmIGhhc2hlcyBvZmYtY2hhaW4uAAAAAAAAABFBcmNoaXZlUmVjb3JkVHlwZQAAAAAAAAMAAABFYERhdGFLZXk6OlVzZXJWb2x1bWUoYWRkcmVzcylgIOKAlCBjdW11bGF0aXZlIGxpZmV0aW1lIHJvdXRlZCB2b2x1bWUuAAAAAAAAClVzZXJWb2x1bWUAAAAAAAEAAABEYERhdGFLZXk6OlVzZXJTcGVuZGluZyhhZGRyZXNzKWAg4oCUIHBhY2tlZCAyNC1ob3VyIHNwZW5kaW5nIHdpbmRvdy4AAAAMVXNlclNwZW5kaW5nAAAAAgAAAENgRGF0YUtleTo6UmVmdW5kQmFsYW5jZSh1c2VyLCB0b2tlbilgIOKAlCB1bmNsYWltZWQgcmVmdW5kIGJhbGFuY2UuAAAAAA1SZWZ1bmRCYWxhbmNlAAAAAAAAAw==" ]),
      options
    )
  }
  public readonly fromJSON = {
    get_fee: this.txFromJSON<i128>,
        upgrade: this.txFromJSON<Result<void>>,
        version: this.txFromJSON<u32>,
        has_role: this.txFromJSON<boolean>,
        unfreeze: this.txFromJSON<Result<void>>,
        get_price: this.txFromJSON<Result<PriceData>>,
        is_frozen: this.txFromJSON<boolean>,
        is_paused: this.txFromJSON<boolean>,
        set_admin: this.txFromJSON<Result<void>>,
        set_pause: this.txFromJSON<Result<void>>,
        initialize: this.txFromJSON<Result<void>>,
        quote_swap: this.txFromJSON<Result<SwapQuote>>,
        set_paused: this.txFromJSON<Result<void>>,
        assign_role: this.txFromJSON<Result<void>>,
        revoke_role: this.txFromJSON<Result<void>>,
        set_fee_bps: this.txFromJSON<Result<void>>,
        queue_action: this.txFromJSON<Result<u64>>,
        register_dex: this.txFromJSON<Result<void>>,
        cancel_action: this.txFromJSON<Result<void>>,
        harvest_yield: this.txFromJSON<Result<i128>>,
        route_payment: this.txFromJSON<Result<void>>,
        set_min_limit: this.txFromJSON<Result<void>>,
        deregister_dex: this.txFromJSON<Result<void>>,
        execute_action: this.txFromJSON<Result<void>>,
        get_meta_nonce: this.txFromJSON<u64>,
        get_role_admin: this.txFromJSON<Role>,
        is_blacklisted: this.txFromJSON<boolean>,
        recover_tokens: this.txFromJSON<Result<void>>,
        route_payments: this.txFromJSON<Result<void>>,
        set_fee_config: this.txFromJSON<Result<void>>,
        set_governance: this.txFromJSON<Result<void>>,
        set_kyc_config: this.txFromJSON<Result<void>>,
        transfer_admin: this.txFromJSON<Result<void>>,
        approve_upgrade: this.txFromJSON<Result<void>>,
        get_role_member: this.txFromJSON<Option<string>>,
        get_user_record: this.txFromJSON<UserRecord>,
        get_user_volume: this.txFromJSON<i128>,
        withdraw_refund: this.txFromJSON<Result<void>>,
        deposit_to_yield: this.txFromJSON<Result<void>>,
        emergency_freeze: this.txFromJSON<Result<void>>,
        get_archive_info: this.txFromJSON<Option<readonly [Buffer, ArchiveMetadata]>>,
        get_fee_proposal: this.txFromJSON<Option<FeeProposal>>,
        set_price_oracle: this.txFromJSON<Result<void>>,
        blacklist_address: this.txFromJSON<Result<void>>,
        claim_all_refunds: this.txFromJSON<Result<i128>>,
        get_archive_epoch: this.txFromJSON<u64>,
        get_kyc_threshold: this.txFromJSON<Option<i128>>,
        get_queued_action: this.txFromJSON<Result<TimelockEntry>>,
        is_dex_registered: this.txFromJSON<boolean>,
        vote_fee_proposal: this.txFromJSON<Result<void>>,
        emergency_withdraw: this.txFromJSON<Result<void>>,
        get_fallback_price: this.txFromJSON<Option<PriceData>>,
        get_refund_balance: this.txFromJSON<i128>,
        get_yield_position: this.txFromJSON<i128>,
        propose_fee_change: this.txFromJSON<Result<u64>>,
        route_payment_meta: this.txFromJSON<Result<void>>,
        set_fallback_price: this.txFromJSON<Result<void>>,
        set_yield_protocol: this.txFromJSON<Result<void>>,
        add_supported_token: this.txFromJSON<Result<void>>,
        commit_archive_root: this.txFromJSON<Result<u64>>,
        migrate_user_record: this.txFromJSON<boolean>,
        unblacklist_address: this.txFromJSON<Result<void>>,
        withdraw_from_yield: this.txFromJSON<Result<void>>,
        configure_governance: this.txFromJSON<Result<void>>,
        execute_fee_proposal: this.txFromJSON<Result<void>>,
        get_max_slippage_bps: this.txFromJSON<i128>,
        set_max_slippage_bps: this.txFromJSON<Result<void>>,
        get_effective_fee_bps: this.txFromJSON<i128>,
        get_upgrade_approvals: this.txFromJSON<Array<string>>,
        is_upgrade_authorized: this.txFromJSON<Result<boolean>>,
        set_fee_config_legacy: this.txFromJSON<Result<void>>,
        set_platform_treasury: this.txFromJSON<Result<void>>,
        prune_archived_entries: this.txFromJSON<Result<u32>>,
        route_payment_with_swap: this.txFromJSON<Result<i128>>,
        set_staleness_threshold: this.txFromJSON<Result<void>>,
        route_payments_with_swap: this.txFromJSON<Result<i128>>
  }
}