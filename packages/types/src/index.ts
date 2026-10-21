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
export type ActionType = {tag: "SetPlatformTreasury", values: readonly [string]} | {tag: "SetFeeConfig", values: readonly [i128, i128]} | {tag: "SetFeeBps", values: readonly [i128]} | {tag: "SetGovernance", values: readonly [string]} | {tag: "SetMinLimit", values: readonly [i128]} | {tag: "TransferAdmin", values: readonly [string]} | {tag: "Upgrade", values: readonly [Buffer]} | {tag: "SetBackupAdmin", values: readonly [string, u64]} | {tag: "RegisterDex", values: readonly [string]} | {tag: "DeregisterDex", values: readonly [string]} | {tag: "SetMaxSlippageBps", values: readonly [i128]} | {tag: "SetPairMaxSlippageBps", values: readonly [string, string, i128]} | {tag: "SetMultisigConfig", values: readonly [Array<string>, u32]};


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
   * No backup admin has been armed, so the dead man's switch cannot fire.
   */
  43: {message:"NoBackupAdmin"},
  /**
   * The dead man's switch timeout has not elapsed since the last heartbeat.
   */
  44: {message:"DmsNotReady"},
  /**
   * A dead man's switch configuration value is out of the allowed range.
   */
  45: {message:"InvalidDmsConfig"},
  /**
   * The sender exceeded the per-ledger payment invocation cap.
   */
  46: {message:"RateLimited"},
  /**
   * The caller does not hold the role required by the entrypoint.
   */
  47: {message:"RoleNotFound"},
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
  34: {message:"KycRequired"},
  /**
   * A swap path is empty, malformed, or does not connect the requested assets.
   */
  35: {message:"InvalidSwapPath"},
  /**
   * The DEX returned less than the caller's minimum acceptable output.
   */
  36: {message:"SlippageExceededSwap"},
  /**
   * The multi-signature configuration is unusable: the signer set is empty,
   * contains a duplicate address, the threshold is zero, or the threshold
   * exceeds the number of signers (so the upgrade could never be authorized).
   */
  37: {message:"InvalidMultisigConfig"},
  /**
   * The calling address is not a member of the multi-signature admin group.
   */
  38: {message:"NotMultisigSigner"},
  /**
   * The number of collected upgrade approvals is below the configured
   * threshold, so the upgrade is not authorized yet.
   */
  39: {message:"InsufficientApprovals"},
  /**
   * No multi-signature admin group has been configured yet.  Upgrades fail
   * closed until `set_multisig_config` has been called, so a freshly
   * deployed contract can never be upgraded through the single admin key
   * that the group was introduced to de-risk.
   */
  40: {message:"MultisigNotInitialized"},
  /**
   * The calling address has already approved this WASM hash.  Duplicate
   * approvals are rejected rather than ignored so that a replayed signature
   * can never inflate the approval count towards the threshold.
   */
  41: {message:"AlreadyApproved"},
  /**
   * A reentrant call was detected.
   */
  42: {message:"ReentrantCall"},
  /**
   * A multi-hop swap path contains the same asset more than once.
   */
  48: {message:"CyclicSwapPath"},
  /**
   * A pair-specific slippage cap is negative or exceeds the 500 bps limit.
   */
  49: {message:"InvalidSlippageConfig"}
}

/**
 * Role definitions for the Role-Based Access Control (RBAC) system.
 *
 * Segregates operational privileges across dedicated role boundaries:
 * SuperAdmin (root Admin), Pauser, FeeManager, TreasuryManager, and
 * ComplianceOfficer.
 */
export enum Role {
  SuperAdmin = 1,
  TreasuryManager = 2,
  ComplianceOfficer = 3,
  FeeManager = 4,
  Pauser = 5,
}

/**
 * Storage keys for all contract instance and persistent data.
 */
export type DataKey = {tag: "Admin", values: void} | {tag: "Governance", values: void} | {tag: "PlatformTreasury", values: void} | {tag: "FeeBps", values: void} | {tag: "FeeCap", values: void} | {tag: "MinLimit", values: void} | {tag: "Paused", values: void} | {tag: "MaxAmount", values: void} | {tag: "UserRecord", values: readonly [string]} | {tag: "UserSpending", values: readonly [string]} | {tag: "UserVolume", values: readonly [string]} | {tag: "Blacklist", values: readonly [string]} | {tag: "RefundBalance", values: readonly [string, string]} | {tag: "TimelockNonce", values: void} | {tag: "TimelockEntry", values: readonly [u64]} | {tag: "Frozen", values: void} | {tag: "UserRole", values: readonly [string, Role]} | {tag: "Role", values: readonly [Role]} | {tag: "MetaNonce", values: readonly [string]} | {tag: "KycOracle", values: void} | {tag: "KycThreshold", values: void} | {tag: "BackupAdmin", values: void} | {tag: "LastHeartbeat", values: void} | {tag: "DmsTimeout", values: void} | {tag: "RateLimitConfig", values: void} | {tag: "RateLimitCounter", values: readonly [string]} | {tag: "RateLimitWhitelist", values: readonly [string]} | {tag: "OracleAddress", values: void} | {tag: "StalenessThreshold", values: void} | {tag: "FallbackPrice", values: readonly [string, string]} | {tag: "GovernanceToken", values: void} | {tag: "GovernanceQuorum", values: void} | {tag: "GovernanceNonce", values: void} | {tag: "GovernanceProposal", values: readonly [u64]} | {tag: "GovernanceVote", values: readonly [u64, string]} | {tag: "ArchiveEpoch", values: void} | {tag: "ArchiveRoot", values: readonly [u64]} | {tag: "ArchiveMeta", values: readonly [u64]} | {tag: "YieldProtocol", values: void} | {tag: "YieldPrincipal", values: readonly [string]} | {tag: "RegisteredDex", values: readonly [string]} | {tag: "MaxSlippageBps", values: void} | {tag: "PairSlippage", values: readonly [string, string]} | {tag: "MultisigSigners", values: void} | {tag: "MultisigThreshold", values: void} | {tag: "UpgradeApproval", values: readonly [Buffer]} | {tag: "ReentrancyGuard", values: void};


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
   * Replaces this contract's WASM with a previously uploaded version, once
   * the multi-signature group has authorized that exact hash.
   *
   * # Parameters
   * - `new_wasm_hash`: Hash of a WASM blob previously uploaded to the
   * network. Must match a hash with at least `threshold` approvals.
   *
   * # Returns
   * `Ok(())` on success, `Err(Error::MultisigNotInitialized)` if no group
   * is configured, or `Err(Error::InsufficientApprovals)` if fewer than
   * `threshold` members have approved this hash.
   *
   * # Panics
   * Panics if `new_wasm_hash` does not reference an uploaded WASM blob.
   */
  upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the contract version.
   *
   * This is a read-only view function: it does not write to ledger storage
   * and costs only the base invocation fee.  The UI calls this before
   * submitting transactions to confirm it is compatible with the deployed
   * contract.
   *
   * # Returns
   * A [`String`] in the form `"MAJOR.MINOR.PATCH"` (e.g. `"1.0.0"`).
   */
  version: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a has_role transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Queries whether a given account holds an active role assignment.
   *
   * Read-only and authorization-free.  Reports effective authority: the
   * account is granted the role directly, is the role's designated holder,
   * or is the root admin standing in for a role that has not been delegated.
   *
   * # Parameters
   * - `account`: Address to query.
   * - `role`: Role variant to check.
   *
   * # Returns
   * `true` if the account can exercise `role`, `false` otherwise.
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
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the current admin address.
   *
   * # Returns
   * `Some(admin)` if the contract is initialized, otherwise `None`.
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
   * Pauses or unpauses the payment router. Pauser-protected.
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
   * Panics if the current Pauser does not authorize the call.
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
   * Alias for `set_pause`. Pauser-protected.
   *
   * # Parameters
   * - `paused`: `true` to reject routing calls, `false` to allow them.
   *
   * # Returns
   * See `set_pause`.
   *
   * # Panics
   * Panics if the current Pauser does not authorize the call.
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
   * numeric nonce identifying this entry. Pass this nonce to `execute_action`
   * after 24 hours, or to `cancel_action` to abort the intent.
   *
   * Sensitive parameter changes must go through the timelock.
   * The contract must not be frozen, and the admin must authorize.
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
   * - `sender`: Address funds are debited from; must authorize call.
   * - `recipient`: Address to receive funds (minus platform fee).
   * - `token_address`: Contract ID of token transferred.
   * - `amount`: Amount to route, in token's smallest unit.
   *
   * # Returns
   * `Ok(())` on success, or appropriate `Error` on failure.
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
   * Construct and simulate a cancel_upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Discards every approval collected for `new_wasm_hash`. Admin-only.
   *
   * The blunt instrument for a compromised hash: it drops the quorum even
   * when the threshold was already met, so the group can force the group
   * back to zero signatures. Note that `upgrade` is permissionless once the
   * threshold is met, so the admin should prefer having signers revoke their
   * own approvals (or rotate the group) while the hash is still in flight.
   *
   * # Parameters
   * - `new_wasm_hash`: The WASM hash to clear approvals for.
   *
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract has
   * no admin set yet. Clearing a hash with no approvals is a no-op.
   *
   * # Panics
   * Panics if the current admin does not authorize the call.
   */
  cancel_upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * - For [`ActionType::Upgrade`], the multi-signature threshold must
   * already be met for that WASM hash.
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
   * Construct and simulate a get_rate_limit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the active per-ledger invocation cap. A value of `0` means
   * rate limiting is disabled.
   *
   * # Returns
   * The configured cap, or the default cap (10) when no explicit
   * configuration has been stored.
   *
   * # Panics
   * Does not panic.
   */
  get_rate_limit: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

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
   * Construct and simulate a set_kyc_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Configures the trusted KYC oracle and the high-value payment threshold. ComplianceOfficer-protected.
   */
  set_kyc_config: ({oracle, threshold}: {oracle: string, threshold: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_rate_limit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets the maximum number of payment invocations a single sender may
   * make per ledger sequence. Admin-only.
   *
   * Rate limiting is active immediately after `initialize` with a default
   * cap of 10 invocations per address per ledger. This setter changes the
   * cap; a value of `0` disables rate limiting entirely (whitelisting
   * individual addresses via `set_rate_limit_whitelist` is usually
   * preferable to disabling the limiter for everyone).
   *
   * # Parameters
   * - `max_calls_per_ledger`: Invocation cap per address per ledger.
   * Must not exceed `MAX_RATE_LIMIT` (1,000,000).
   *
   * # Returns
   * `Ok(())` on success, `Err(Error::NotInitialized)` if the contract has
   * no admin set yet, or `Err(Error::LimitExceeded)` if the cap exceeds
   * `MAX_RATE_LIMIT`.
   *
   * # Panics
   * Panics if the current admin does not authorize the call.
   */
  set_rate_limit: ({max_calls_per_ledger}: {max_calls_per_ledger: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * # Parameters
   * - `sender`: Address whose funds are routed.
   * - `signer_pubkey`: Ed25519 public key that signed the payload.
   * - `recipient`: Destination address.
   * - `token_address`: Token contract ID.
   * - `amount`: Amount to route.
   * - `nonce`: Sender's current meta-transaction nonce.
   * - `deadline`: Expiration timestamp.
   * - `signature`: Ed25519 signature over canonical payload.
   *
   * # Returns
   * `Ok(())` once the payment has settled.
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
   * Construct and simulate a route_multihop_swap transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Routes a payment through two to four consecutive DEX swaps. `path`
   * contains the input asset followed by every intermediate asset and the
   * output asset. `min_amounts_out[i]` is the required output for hop `i`.
   * Any input dust returned by a hop is refunded to `sender` in that hop's
   * input asset. All swaps and settlement are atomic.
   */
  route_multihop_swap: ({sender, recipient, dex_router, amount_in, path, min_amounts_out}: {sender: string, recipient: string, dex_router: string, amount_in: i128, path: Array<string>, min_amounts_out: Array<i128>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

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
   * Construct and simulate a execute_batch_actions transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Executes a batch of previously queued timelock actions sequentially within
   * a single atomic invocation.
   *
   * Requirements:
   * - The contract must not be frozen.
   * - Circuit breaker must be closed.
   * - The admin must authorize.
   * - All nonces in the batch must be verified ready and valid BEFORE any action is executed.
   * - All actions execute sequentially. If any action fails execution,
   * the entire invocation reverts atomically.
   * - Emits `batch_actions_executed` event with the list of nonces.
   */
  execute_batch_actions: ({nonces}: {nonces: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a revoke_upgrade_approval transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Withdraws a signer's previously recorded approval of an upgrade.
   *
   * Lets a signer pull its signature back before the threshold is reached,
   * which is the way a group stops an upgrade it no longer wants without
   * having to rotate the whole signer set. Idempotent: withdrawing an
   * approval that was never recorded is a no-op.
   *
   * # Parameters
   * - `signer`: The group member withdrawing its approval; must authorize
   * this call.
   * - `new_wasm_hash`: The WASM hash to withdraw the approval for.
   *
   * # Returns
   * `Ok(())` on success or `Err(Error::MultisigNotInitialized)` if no group
   * is configured.
   *
   * # Panics
   * Panics if `signer` does not authorize the call.
   */
  revoke_upgrade_approval: ({signer, new_wasm_hash}: {signer: string, new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a get_rate_limit_remaining transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns how many more payment invocations `sender` can make in the
   * current ledger under the active cap.
   *
   * # Parameters
   * - `sender`: Address whose remaining allowance to compute.
   *
   * # Returns
   * Remaining invocations in the current ledger window, saturating at 0
   * once the cap is reached. Whitelisted senders (and a disabled limiter)
   * report `u32::MAX`.
   *
   * # Panics
   * Does not panic.
   */
  get_rate_limit_remaining: ({sender}: {sender: string}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

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

  /**
   * Construct and simulate a set_rate_limit_whitelist transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Whitelists an address, exempting it from the per-ledger invocation cap
   * so legitimate high-volume senders are never throttled. Admin-only.
   *
   * # Parameters
   * - `address`: Sender to exempt from rate limiting.
   *
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   *
   * # Panics
   * Panics if the current admin does not authorize the call.
   */
  set_rate_limit_whitelist: ({address}: {address: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_pair_max_slippage_bps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the configured cap for `(token_in, token_out)`, or the global
   * cap when no pair override exists. Invalid stored overrides fail closed.
   */
  get_pair_max_slippage_bps: ({token_in, token_out}: {token_in: string, token_out: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a is_rate_limit_whitelisted transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns whether an address is exempt from the rate limiter.
   *
   * # Parameters
   * - `address`: Address to check.
   *
   * # Returns
   * `true` if the address is on the rate-limit whitelist.
   *
   * # Panics
   * Does not panic.
   */
  is_rate_limit_whitelisted: ({address}: {address: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a set_backup_admin_internal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Arms the dead man's switch directly (bypassing the timelock).
   *
   * # Parameters
   * - `backup`: Address allowed to claim admin rights after the timeout.
   * - `timeout_seconds`: Inactivity window in seconds. Must be at least
   * `MIN_DMS_TIMEOUT` (7 days).
   *
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet, or `Err(Error::InvalidDmsConfig)` if
   * `timeout_seconds` is below the minimum or `backup` equals the
   * current admin.
   *
   * # Panics
   * Panics if the current admin does not authorize the call.
   */
  set_backup_admin_internal: ({backup, timeout_seconds}: {backup: string, timeout_seconds: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_pair_max_slippage_bps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Sets a pair-specific slippage cap. Prefer the timelocked
   * `SetPairMaxSlippageBps` action for production configuration.
   */
  set_pair_max_slippage_bps: ({token_in, token_out, max_slippage_bps}: {token_in: string, token_out: string, max_slippage_bps: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a is_dead_mans_switch_expired transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns `true` if the dead man's switch is armed (a backup admin is
   * configured) and the timeout has elapsed, i.e. `claim_admin` would
   * currently succeed for the backup.
   *
   * # Panics
   * Does not panic.
   */
  is_dead_mans_switch_expired: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a remove_rate_limit_whitelist transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Removes an address from the rate-limit whitelist, restoring the
   * standard per-ledger cap for it. Admin-only.
   *
   * # Parameters
   * - `address`: Sender to remove from the whitelist.
   *
   * # Returns
   * `Ok(())` on success, or `Err(Error::NotInitialized)` if the contract
   * has no admin set yet.
   *
   * # Panics
   * Panics if the current admin does not authorize the call.
   */
  remove_rate_limit_whitelist: ({address}: {address: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a route_payment_with_swap_raw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Swaps `token_in` through a caller-supplied DEX path and routes the
   * resulting `token_out` to the recipient. The DEX adapter must return the
   * received output and any unused input as `[received, unused]`; unused
   * input is credited to the sender's refund balance.
   *
   * # Panics
   * Panics if the DEX router returns a swap result with fewer than 2 elements,
   * or if `swap_result.get(0)` or `swap_result.get(1)` returns `None`.
   */
  route_payment_with_swap_raw: ({sender, recipient, dex_router, token_in, token_out, amount_in, path, min_amount_out}: {sender: string, recipient: string, dex_router: string, token_in: string, token_out: string, amount_in: i128, path: Array<string>, min_amount_out: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
      new ContractSpec([ "AAAAAAAAAuxSb3V0ZXMgYSBwYXltZW50IGZyb20gYSBzZW5kZXIgdG8gYSByZWNpcGllbnQsIGRlZHVjdGluZyBhIHBsYXRmb3JtIGZlZS4KCiMgUGFyYW1ldGVycwotIGBzZW5kZXJgOiBBZGRyZXNzIHRoZSBmdW5kcyBhcmUgZGViaXRlZCBmcm9tOyBtdXN0IGF1dGhvcml6ZSB0aGUgY2FsbC4KLSBgcmVjaXBpZW50YDogQWRkcmVzcyB0byByZWNlaXZlIHRoZSBmdW5kcyAobWludXMgdGhlIHBsYXRmb3JtIGZlZSkuCi0gYHRva2VuX2FkZHJlc3NgOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4gYmVpbmcgdHJhbnNmZXJyZWQuCi0gYGFtb3VudGA6IEFtb3VudCB0byByb3V0ZSwgaW4gdGhlIHRva2VuJ3Mgc21hbGxlc3QgdW5pdC4gTXVzdCBiZQpwb3NpdGl2ZSBhbmQgd2l0aGluIHRoZSBjb25maWd1cmVkIG1pbi9tYXggYW5kIGRhaWx5LWxpbWl0IGJvdW5kcy4KClRoaXMgaXMgdGhlIHByaW1hcnkgd2F5IGZvciB0aGUgYWRtaW4gdG8gcmVzZXQgdGhlIHRpbWVyIHdpdGhvdXQKY2hhbmdpbmcgYW55IGNvbnRyYWN0IHN0YXRlLiBSb3V0aW5nIGEgcGF5bWVudCBhbHNvIGJ1bXBzIHRoZQpoZWFydGJlYXQgYXV0b21hdGljYWxseS4gQSBuby1vcCB3aGVuIG5vIGJhY2t1cCBhZG1pbiBpcyBjb25maWd1cmVkLgoKQWRtaW4gYXV0aG9yaXphdGlvbiBpcyByZXF1aXJlZC4gV29ya3MgZXZlbiB3aGlsZSB0aGUgY29udHJhY3QgaXMKZnJvemVuIHNvIHRoZSBsZWdpdGltYXRlIGFkbWluIGNhbiBrZWVwIHRoZSBzd2l0Y2ggYWxpdmUuAAAABHBpbmcAAAAAAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAKxSZXR1cm5zIHRoZSBjdXJyZW50IHByb3RvY29sIGZlZSBwZXJjZW50YWdlIGluIGJhc2lzIHBvaW50cy4KCiMgUmV0dXJucwpUaGUgY29uZmlndXJlZCBgZmVlX2Jwc2AsIG9yIGAwYCBpZiB0aGUgY29udHJhY3QgaGFzIG5vdCBiZWVuCmluaXRpYWxpemVkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAB2dldF9mZWUAAAAAAAAAAAEAAAAL",
        "AAAAAAAAAiBSZXBsYWNlcyB0aGlzIGNvbnRyYWN0J3MgV0FTTSB3aXRoIGEgcHJldmlvdXNseSB1cGxvYWRlZCB2ZXJzaW9uLCBvbmNlCnRoZSBtdWx0aS1zaWduYXR1cmUgZ3JvdXAgaGFzIGF1dGhvcml6ZWQgdGhhdCBleGFjdCBoYXNoLgoKIyBQYXJhbWV0ZXJzCi0gYG5ld193YXNtX2hhc2hgOiBIYXNoIG9mIGEgV0FTTSBibG9iIHByZXZpb3VzbHkgdXBsb2FkZWQgdG8gdGhlCm5ldHdvcmsuIE11c3QgbWF0Y2ggYSBoYXNoIHdpdGggYXQgbGVhc3QgYHRocmVzaG9sZGAgYXBwcm92YWxzLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIGBFcnIoRXJyb3I6Ok11bHRpc2lnTm90SW5pdGlhbGl6ZWQpYCBpZiBubyBncm91cAppcyBjb25maWd1cmVkLCBvciBgRXJyKEVycm9yOjpJbnN1ZmZpY2llbnRBcHByb3ZhbHMpYCBpZiBmZXdlciB0aGFuCmB0aHJlc2hvbGRgIG1lbWJlcnMgaGF2ZSBhcHByb3ZlZCB0aGlzIGhhc2guCgojIFBhbmljcwpQYW5pY3MgaWYgYG5ld193YXNtX2hhc2hgIGRvZXMgbm90IHJlZmVyZW5jZSBhbiB1cGxvYWRlZCBXQVNNIGJsb2IuAAAAB3VwZ3JhZGUAAAAAAQAAAAAAAAANbmV3X3dhc21faGFzaAAAAAAAA+4AAAAgAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAUNSZXR1cm5zIHRoZSBjb250cmFjdCB2ZXJzaW9uLgoKVGhpcyBpcyBhIHJlYWQtb25seSB2aWV3IGZ1bmN0aW9uOiBpdCBkb2VzIG5vdCB3cml0ZSB0byBsZWRnZXIgc3RvcmFnZQphbmQgY29zdHMgb25seSB0aGUgYmFzZSBpbnZvY2F0aW9uIGZlZS4gIFRoZSBVSSBjYWxscyB0aGlzIGJlZm9yZQpzdWJtaXR0aW5nIHRyYW5zYWN0aW9ucyB0byBjb25maXJtIGl0IGlzIGNvbXBhdGlibGUgd2l0aCB0aGUgZGVwbG95ZWQKY29udHJhY3QuCgojIFJldHVybnMKQSBbYFN0cmluZ2BdIGluIHRoZSBmb3JtIGAiTUFKT1IuTUlOT1IuUEFUQ0giYCAoZS5nLiBgIjEuMC4wImApLgAAAAAHdmVyc2lvbgAAAAAAAAAAAQAAABA=",
        "AAAAAAAAAaxRdWVyaWVzIHdoZXRoZXIgYSBnaXZlbiBhY2NvdW50IGhvbGRzIGFuIGFjdGl2ZSByb2xlIGFzc2lnbm1lbnQuCgpSZWFkLW9ubHkgYW5kIGF1dGhvcml6YXRpb24tZnJlZS4gIFJlcG9ydHMgZWZmZWN0aXZlIGF1dGhvcml0eTogdGhlCmFjY291bnQgaXMgZ3JhbnRlZCB0aGUgcm9sZSBkaXJlY3RseSwgaXMgdGhlIHJvbGUncyBkZXNpZ25hdGVkIGhvbGRlciwKb3IgaXMgdGhlIHJvb3QgYWRtaW4gc3RhbmRpbmcgaW4gZm9yIGEgcm9sZSB0aGF0IGhhcyBub3QgYmVlbiBkZWxlZ2F0ZWQuCgojIFBhcmFtZXRlcnMKLSBgYWNjb3VudGA6IEFkZHJlc3MgdG8gcXVlcnkuCi0gYHJvbGVgOiBSb2xlIHZhcmlhbnQgdG8gY2hlY2suCgojIFJldHVybnMKYHRydWVgIGlmIHRoZSBhY2NvdW50IGNhbiBleGVyY2lzZSBgcm9sZWAsIGBmYWxzZWAgb3RoZXJ3aXNlLgAAAAhoYXNfcm9sZQAAAAIAAAAAAAAAB2FjY291bnQAAAAAEwAAAAAAAAAEcm9sZQAAB9AAAAAEUm9sZQAAAAEAAAAB",
        "AAAAAAAAAMNSZW1vdmVzIHRoZSBmcm96ZW4gc3RhdGUsIHJlc3RvcmluZyBub3JtYWwgY29udHJhY3Qgb3BlcmF0aW9uLgoKTGlrZSBgZW1lcmdlbmN5X2ZyZWV6ZWAsIHRoaXMgdGFrZXMgZWZmZWN0IGltbWVkaWF0ZWx5IGFuZCBkb2VzIG5vdApnbyB0aHJvdWdoIHRoZSB0aW1lbG9jay4KClN1cGVyQWRtaW4gYXV0aG9yaXphdGlvbiBpcyByZXF1aXJlZC4AAAAACHVuZnJlZXplAAAAAAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAIdSZXR1cm5zIHRoZSBjdXJyZW50IGFkbWluIGFkZHJlc3MuCgojIFJldHVybnMKYFNvbWUoYWRtaW4pYCBpZiB0aGUgY29udHJhY3QgaXMgaW5pdGlhbGl6ZWQsIG90aGVyd2lzZSBgTm9uZWAuCgojIFBhbmljcwpEb2VzIG5vdCBwYW5pYy4AAAAACWdldF9hZG1pbgAAAAAAAAAAAAABAAAD6AAAABM=",
        "AAAAAAAAA71GZXRjaGVzIHRoZSBjdXJyZW50IGV4Y2hhbmdlIHJhdGUgZm9yIGEgYChiYXNlX2Fzc2V0LCBxdW90ZV9hc3NldClgCnBhaXIgZnJvbSB0aGUgY29uZmlndXJlZCBwcmljZS1mZWVkIG9yYWNsZSwgdmFsaWRhdGVzIGl0LCBhbmQgcmV0dXJucwp0aGUgcmVzdWx0LgoKRXZlcnkgZmFpbHVyZSBwYXRoIGJlbG93IGZpcnN0IGF0dGVtcHRzIHRvIHNlcnZlIGFuIGFkbWluLWNvbmZpZ3VyZWQKZmFsbGJhY2sgcHJpY2UgZm9yIHRoZSBwYWlyOyB0aGUgb3JhY2xlIGVycm9yIGlzIG9ubHkgc3VyZmFjZWQgd2hlbiBubwpmYWxsYmFjayBleGlzdHMuCgojIyBWYWxpZGF0aW9uIGZsb3cKCjEuICoqT3JhY2xlIGNvbmZpZ3VyZWQ/KiogLSBPdGhlcndpc2UgYEVycihFcnJvcjo6T3JhY2xlTm90Q29uZmlndXJlZClgLgoyLiAqKkNhbGwgb3JhY2xlKiogLSBJbnZva2UgdGhlIG9yYWNsZSdzIGBnZXRfcHJpY2VgOyBhIHRyYXBwZWQgb3IKdW5hdmFpbGFibGUgY29udHJhY3QgeWllbGRzIGBFcnIoRXJyb3I6Ok9yYWNsZUNhbGxGYWlsZWQpYC4KMy4gKipTdGFsZW5lc3MgY2hlY2sqKiAtIFJlamVjdCBhIGBwcmljZV9kYXRhLnRpbWVzdGFtcGAgb2xkZXIgdGhhbiB0aGUKY29uZmlndXJlZCB0aHJlc2hvbGQgKGRlZmF1bHQgMyA2MDAgcykgd2l0aApgRXJyKEVycm9yOjpPcmFjbGVQcmljZVN0YWxlKWAuIEEgdGhyZXNob2xkIG9mIGAwYCBkaXNhYmxlcyB0aGlzIGNoZWNrLgo0LiAqKlZhbGlkaXR5IGNoZWNrKiogLSBBIHByaWNlIDw9IDAgaXMgaW52YWxpZAooYEVycihFcnJvcjo6T3JhY2xlUHJpY2VJbnZhbGlkKWApLgo1LiAqKlJldHVybioqIC0gVGhlIHZhbGlkYXRlZCBgUHJpY2VEYXRhYCBpcyByZXR1cm5lZCB0byB0aGUgY2FsbGVyLgoKYGJhc2VfYXNzZXRgIGlzIHR5cGljYWxseSB0aGUgWExNIG5hdGl2ZSBjb250cmFjdCBhbmQgYHF1b3RlX2Fzc2V0YCB0aGUKVVNEQyBjb250cmFjdC4AAAAAAAAJZ2V0X3ByaWNlAAAAAAAAAgAAAAAAAAAKYmFzZV9hc3NldAAAAAAAEwAAAAAAAAALcXVvdGVfYXNzZXQAAAAAEwAAAAEAAAPpAAAH0AAAAAlQcmljZURhdGEAAAAAAAAD",
        "AAAAAAAAADFSZXR1cm5zIHdoZXRoZXIgdGhlIGNvbnRyYWN0IGlzIGN1cnJlbnRseSBmcm96ZW4uAAAAAAAACWlzX2Zyb3plbgAAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAJRSZXR1cm5zIHdoZXRoZXIgdGhlIGNvbnRyYWN0IGlzIGN1cnJlbnRseSBwYXVzZWQuCgojIFJldHVybnMKYHRydWVgIGlmIHBhdXNlZCwgYGZhbHNlYCBpZiB1bnBhdXNlZCBvciBub3QgeWV0IGluaXRpYWxpemVkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAACWlzX3BhdXNlZAAAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAORTZXQgYSBuZXcgYWRtaW4uIFN1cGVyQWRtaW4tcHJvdGVjdGVkLgoKIyBQYXJhbWV0ZXJzCi0gYG5ld19hZG1pbmA6IEFkZHJlc3MgdG8gaW5zdGFsbCBhcyB0aGUgbmV3IGFkbWluLgoKIyBSZXR1cm5zCkFsd2F5cyBgT2soKCkpYC4KCiMgUGFuaWNzClBhbmljcyBpZiBhbiBhZG1pbiBpcyBhbHJlYWR5IHNldCBhbmQgY3VycmVudCBTdXBlckFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAZlQYXVzZXMgb3IgdW5wYXVzZXMgdGhlIHBheW1lbnQgcm91dGVyLiBQYXVzZXItcHJvdGVjdGVkLgoKIyBQYXJhbWV0ZXJzCi0gYHBhdXNlZGA6IGB0cnVlYCB0byByZWplY3QgYHJvdXRlX3BheW1lbnRgIC8gYHJvdXRlX3BheW1lbnRzYApjYWxscywgYGZhbHNlYCB0byBhbGxvdyB0aGVtIGFnYWluLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0CmhhcyBubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IFBhdXNlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuCgpUaGlzIGlzIE5PVCB0aW1lbG9ja2VkIOKAlCBvcGVyYXRpb25hbCBwYXVzaW5nIG11c3QgcmVtYWluIGluc3RhbnQuAAAAAAAACXNldF9wYXVzZQAAAAAAAAEAAAAAAAAABnBhdXNlZAAAAAAAAQAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAA6NHcmFudHMgYW4gb3BlcmF0aW9uYWwgcm9sZSB0byBgZ3JhbnRlZWAuCgpPbmx5IGFuIGFkZHJlc3MgaG9sZGluZyBgU3VwZXJBZG1pbmAgbWF5IGNhbGwgdGhpcy4gIFRoZSBgYWRtaW5gCnBhcmFtZXRlciBpcyB0aGUgYWRkcmVzcyBleHBlY3RlZCB0byBhdXRob3JpemUgdGhlIHRyYW5zYWN0aW9uLCBhbmQKYGFkbWluLnJlcXVpcmVfYXV0aCgpYCBpcyBhbHdheXMgaW52b2tlZCwgc28gYSBjYWxsZXIgdGhhdCBjYW5ub3Qgc3VwcGx5CnRoYXQgc2lnbmF0dXJlIGlzIHJlamVjdGVkIGV2ZW4gaWYgdGhlIHJvbGUgd291bGQgb3RoZXJ3aXNlIHJlc29sdmUuCgojIFBhcmFtZXRlcnMKLSBgYWRtaW5gOiBBZGRyZXNzIGV4cGVjdGVkIHRvIGF1dGhvcml6ZSB0aGUgY2FsbDsgbXVzdCBob2xkIGBTdXBlckFkbWluYC4KLSBgZ3JhbnRlZWA6IEFkZHJlc3MgdG8gcmVjZWl2ZSB0aGUgcm9sZS4KLSBgcm9sZWA6IFRoZSBgUm9sZWAgdmFyaWFudCB0byBncmFudC4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBgRXJyKEVycm9yOjpSb2xlTm90Rm91bmQpYCBpZiBgYWRtaW5gIGRvZXMgbm90IGhvbGQKYFN1cGVyQWRtaW5gLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdCBoYXMgbm8KYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiBgYWRtaW5gIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4KCkdyYW50aW5nIGEgcm9sZSB0aGUgZ3JhbnRlZSBhbHJlYWR5IGhvbGRzIGlzIGEgbm8tb3AgdGhhdCBlbWl0cwpgcm9sZV9hc3NpZ25lZGAgYWdhaW4gcmF0aGVyIHRoYW4gYW4gZXJyb3IuICBCZWNhdXNlIGEgcm9sZSBoYXMgYSBzaW5nbGUKZGVzaWduYXRlZCBob2xkZXIsIGdyYW50aW5nIGl0IHRvIGEgbmV3IGFkZHJlc3MgcmV2b2tlcyBpdCBmcm9tIHRoZQpwcmV2aW91cyBvbmUuAAAAAApncmFudF9yb2xlAAAAAAADAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAAB2dyYW50ZWUAAAAAEwAAAAAAAAAEcm9sZQAAB9AAAAAEUm9sZQAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAA5tDaXJjdWl0LWJyZWFrZXIgZ3VhcmQgYXBwbGllZCB0byBldmVyeSBub24tZXNzZW50aWFsIG9wZXJhdGlvbi4KCldoaWxlIHRoZSBwYXVzZSBzd2l0Y2ggaXMgZW5nYWdlZCBhbGwgb3BlcmF0aW9uYWwgc3RhdGUgY2hhbmdlcyDigJQKcGF5bWVudHMsIHRpbWVsb2NrIHF1ZXVlL2V4ZWN1dGUsIGZlZS90cmVhc3VyeS9nb3Zlcm5hbmNlL21pbi1saW1pdApjb25maWd1cmF0aW9uLCB0cmVhc3VyeSB5aWVsZCBtb3ZlbWVudHMgYW5kIHRva2VuIHJlY292ZXJ5IOKAlCBhcmUKcmVqZWN0ZWQgd2l0aCBgRXJyb3I6OlBhdXNlZGAuCgpPbmUtdGltZSBzZXR1cDogcmVjb3JkcyB0aGUgYWRtaW4gYW5kIHRoZSBpbml0aWFsIGZlZSBjb25maWd1cmF0aW9uCmluIGluc3RhbmNlIHN0b3JhZ2UuIE11c3QgYmUgY2FsbGVkIGJlZm9yZSBgcm91dGVfcGF5bWVudGAuCgojIFBhcmFtZXRlcnMKKiBgZW52YCAtIFRoZSBTb3JvYmFuIGVudmlyb25tZW50IGludGVyZmFjZS4KKiBgc2VuZGVyYCAtIFRoZSBhZGRyZXNzIGluaXRpYXRpbmcgdGhlIHBheW1lbnQuIE11c3QgYXV0aG9yaXplIHRoZSB0cmFuc2FjdGlvbi4KKiBgcmVjaXBpZW50YCAtIFRoZSBkZXN0aW5hdGlvbiBhZGRyZXNzIGZvciB0aGUgcGF5bWVudCAoZS5nLiwgdGhlIEFuY2hvcidzIHdhbGxldCBmb3IgZmlhdCB3aXRoZHJhd2FscykuCiogYHBsYXRmb3JtX3RyZWFzdXJ5YCAtIFRoZSBhZGRyZXNzIHdoZXJlIHRoZSBwbGF0Zm9ybSBmZWUgd2lsbCBiZSBkZXBvc2l0ZWQuCiogYHRva2VuX2FkZHJlc3NgIC0gVGhlIGNvbnRyYWN0IElEIG9mIHRoZSB0b2tlbiBhc3NldCBiZWluZyB0cmFuc2ZlcnJlZCAoZS5nLiwgTkdOQyBvciBVU0RDKS4KKiBgYW1vdW50YCAtIFRoZSB0b3RhbCBhbW91bnQgb2YgdG9rZW5zIHRvIGJlIHJvdXRlZCAoaW5jbHVzaXZlIG9mIHRoZSBmZWUpLgAAAAAKaW5pdGlhbGl6ZQAAAAAABQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAABFwbGF0Zm9ybV90cmVhc3VyeQAAAAAAABMAAAAAAAAAB2ZlZV9icHMAAAAACwAAAAAAAAAHZmVlX2NhcAAAAAALAAAAAAAAAAptYXhfYW1vdW50AAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAzxBc2tzIGEgcmVnaXN0ZXJlZCBERVggaG93IG11Y2ggYGJ1eV90b2tlbmAgYSBzd2FwIHdvdWxkIHJldHVybiwgYW5kCmRlcml2ZXMgdGhlIGBtaW5fYW1vdW50X291dGAgdGhlIHNlbmRlciBzaG91bGQgdXNlIGZyb20gdGhlIGNvbnRyYWN0J3MKY29uZmlndXJlZCBzbGlwcGFnZSBjZWlsaW5nLgoKVGhpcyBpcyBhIHJlYWQtb25seSBjcm9zcy1jb250cmFjdCBjYWxsOiBpdCBtb3ZlcyBubyBmdW5kcyBhbmQgY2hhbmdlcyBubwpzdGF0ZSwgc28gaXQgaXMgc2FmZSB0byBjYWxsIG9mZi1jaGFpbiBiZWZvcmUgYnVpbGRpbmcgYQpbYFN3YXBQYXltZW50YF0uCgojIFBhcmFtZXRlcnMKLSBgZGV4YDogQ29udHJhY3QgSUQgb2YgYSByZWdpc3RlcmVkIERFWCBhZGFwdGVyLgotIGBzZWxsX3Rva2VuYDogVG9rZW4gdGhlIHNlbmRlciB3b3VsZCBwYXkgd2l0aC4KLSBgYnV5X3Rva2VuYDogVG9rZW4gdGhlIHJlY2lwaWVudCB3b3VsZCBiZSBwYWlkIGluLgotIGBhbW91bnRfaW5gOiBBbW91bnQgb2YgYHNlbGxfdG9rZW5gIHRvIHByaWNlLCBpbiBpdHMgc21hbGxlc3QgdW5pdC4KCiMgUmV0dXJucwpBIFtgU3dhcFF1b3RlYF0gd2l0aCB0aGUgcXVvdGVkIG91dHB1dCwgdGhlIHNsaXBwYWdlLWFkanVzdGVkCmBtaW5fYW1vdW50X291dGAsIGFuZCB0aGUgc2xpcHBhZ2UgY2VpbGluZyB1c2VkLiBSZXR1cm5zCmBFcnIoRXJyb3I6OkRleE5vdFJlZ2lzdGVyZWQpYCBpZiBgZGV4YCB3YXMgbmV2ZXIgcmVnaXN0ZXJlZCBvcgpgRXJyKEVycm9yOjpTd2FwRmFpbGVkKWAgaWYgdGhlIERFWCBxdW90ZSBjYWxsIHJldmVydHMuCgojIFBhbmljcwpEb2VzIG5vdCBwYW5pYy4AAAAKcXVvdGVfc3dhcAAAAAAABAAAAAAAAAADZGV4AAAAABMAAAAAAAAACnNlbGxfdG9rZW4AAAAAABMAAAAAAAAACWJ1eV90b2tlbgAAAAAAABMAAAAAAAAACWFtb3VudF9pbgAAAAAAAAsAAAABAAAD6QAAB9AAAAAJU3dhcFF1b3RlAAAAAAAAAw==",
        "AAAAAAAAANlBbGlhcyBmb3IgYHNldF9wYXVzZWAuIFBhdXNlci1wcm90ZWN0ZWQuCgojIFBhcmFtZXRlcnMKLSBgcGF1c2VkYDogYHRydWVgIHRvIHJlamVjdCByb3V0aW5nIGNhbGxzLCBgZmFsc2VgIHRvIGFsbG93IHRoZW0uCgojIFJldHVybnMKU2VlIGBzZXRfcGF1c2VgLgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IFBhdXNlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAACnNldF9wYXVzZWQAAAAAAAEAAAAAAAAABnBhdXNlZAAAAAAAAQAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAe1HcmFudHMgYW4gb3BlcmF0aW9uYWwgcm9sZSB0byBhbiBhY2NvdW50LiBTdXBlckFkbWluLXByb3RlY3RlZC4KClJldGFpbmVkIGZvciBjb21wYXRpYmlsaXR5IHdpdGggdGhlIHB1Ymxpc2hlZCBiaW5kaW5nczsgdGhpcyBpcwpbYFNlbGY6OmdyYW50X3JvbGVgXSB3aXRoIHRoZSBgYWRtaW5gIGFyZ3VtZW50IHJlc29sdmVkIGJ5IHRoZSBjb250cmFjdAppbnN0ZWFkIG9mIHN1cHBsaWVkIGJ5IHRoZSBjYWxsZXIuCgojIFBhcmFtZXRlcnMKLSBgYWNjb3VudGA6IFRhcmdldCBhZGRyZXNzIHRvIHJlY2VpdmUgdGhlIHJvbGUuCi0gYHJvbGVgOiBUaGUgYFJvbGVgIHZhcmlhbnQgdG8gZ3JhbnQuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB1bmluaXRpYWxpemVkLgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IGBTdXBlckFkbWluYCBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAAC2Fzc2lnbl9yb2xlAAAAAAIAAAAAAAAAB2FjY291bnQAAAAAEwAAAAAAAAAEcm9sZQAAB9AAAAAEUm9sZQAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAtpEZWFkIG1hbidzIHN3aXRjaCBjbGFpbTogdHJhbnNmZXJzIGFkbWluIHJpZ2h0cyB0byBgY2xhaW1hbnRgIGlmIHRoZXkKYXJlIHRoZSBjb25maWd1cmVkIGJhY2t1cCBhZG1pbiBhbmQgdGhlIGFkbWluIGhhcyBub3QgcGluZ2VkIChkaXJlY3RseQpvciB2aWEgcm91dGluZyBhIHBheW1lbnQpIGZvciBhdCBsZWFzdCB0aGUgY29uZmlndXJlZCB0aW1lb3V0LgoKRGVsaWJlcmF0ZWx5IE5PVCB0aW1lbG9ja2VkIGFuZCBOT1QgYmxvY2tlZCBieSBhIGNvbnRyYWN0IGZyZWV6ZTogaWYKdGhlIHByaW1hcnkgYWRtaW4gaXMgZ29uZSB0aGVyZSBpcyBub2JvZHkgbGVmdCB0byBleGVjdXRlIGEgcXVldWVkCmFjdGlvbiwgYW5kIGZyZWV6aW5nIG11c3Qgbm90IGJlIGFibGUgdG8gYnJpY2sgcmVjb3ZlcnkuCgojIFBhcmFtZXRlcnMKLSBgY2xhaW1hbnRgOiBBZGRyZXNzIGNsYWltaW5nIGFkbWluIHJpZ2h0cy4gTXVzdCBiZSB0aGUgY29uZmlndXJlZApiYWNrdXAgYWRtaW4gYW5kIG11c3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIGBFcnIoRXJyb3I6Ok5vQmFja3VwQWRtaW4pYCBpZiBubyBiYWNrdXAgaXMKY29uZmlndXJlZCwgYEVycihFcnJvcjo6VW5hdXRob3JpemVkKWAgaWYgYGNsYWltYW50YCBpcyBub3QgdGhlCmJhY2t1cCwgb3IgYEVycihFcnJvcjo6RG1zTm90UmVhZHkpYCBpZiB0aGUgdGltZW91dCBoYXMgbm90IGVsYXBzZWQuAAAAAAALY2xhaW1fYWRtaW4AAAAAAQAAAAAAAAAIY2xhaW1hbnQAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAxBSZXZva2VzIGFuIG9wZXJhdGlvbmFsIHJvbGUgZnJvbSBgZ3JhbnRlZWAuCgpPbmx5IGFuIGFkZHJlc3MgaG9sZGluZyBgU3VwZXJBZG1pbmAgbWF5IGNhbGwgdGhpcy4gIEFzIHdpdGgKW2BTZWxmOjpncmFudF9yb2xlYF0sIGBhZG1pbi5yZXF1aXJlX2F1dGgoKWAgaXMgYWx3YXlzIGludm9rZWQuCgojIFBhcmFtZXRlcnMKLSBgYWRtaW5gOiBBZGRyZXNzIGV4cGVjdGVkIHRvIGF1dGhvcml6ZSB0aGUgY2FsbDsgbXVzdCBob2xkIGBTdXBlckFkbWluYC4KLSBgZ3JhbnRlZWA6IEFkZHJlc3MgZnJvbSB3aGljaCB0aGUgcm9sZSB3aWxsIGJlIHJldm9rZWQuCi0gYHJvbGVgOiBUaGUgYFJvbGVgIHZhcmlhbnQgdG8gcmV2b2tlLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIGBFcnIoRXJyb3I6OlJvbGVOb3RGb3VuZClgIGlmIGBhZG1pbmAgZG9lcyBub3QgaG9sZApgU3VwZXJBZG1pbmAsIGBFcnIoRXJyb3I6OkludmFsaWRSb2xlKWAgaWYgdGhlIGNhbGwgd291bGQgcmV2b2tlIHRoZQphY3RpbmcgYFN1cGVyQWRtaW5gJ3Mgb3duIHJvb3Qgcm9sZSwgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYC4KCiMgUGFuaWNzClBhbmljcyBpZiBgYWRtaW5gIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4KClJldm9raW5nIGEgcm9sZSB0aGUgZ3JhbnRlZSBuZXZlciBoZWxkIGlzIGEgbm8tb3AgdGhhdCBlbWl0cwpgcm9sZV9yZXZva2VkYCByYXRoZXIgdGhhbiBhbiBlcnJvciwgc28gcmV2b2NhdGlvbnMgYXJlIGlkZW1wb3RlbnQgYW5kCnNhZmUgdG8gcmV0cnkuAAAAC3Jldm9rZV9yb2xlAAAAAAMAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAHZ3JhbnRlZQAAAAATAAAAAAAAAARyb2xlAAAH0AAAAARSb2xlAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAa1VcGRhdGVzIHRoZSBmZWUgYmFzaXMgcG9pbnRzLgpSZXF1aXJlcyBnb3Zlcm5hbmNlIGF1dGhvcml0eSBpZiBhIGdvdmVybmFuY2UgYWRkcmVzcyBpcyBzZXQ7IG90aGVyd2lzZSBhZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYG5ld19mZWVfYnBzYDogTmV3IHBsYXRmb3JtIGZlZSByYXRlLCBpbiBiYXNpcyBwb2ludHMuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGNhbGxlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuCgpERVBSRUNBVEVEIGZvciBkaXJlY3QgdXNlLiAgUXVldWUgdmlhIGBxdWV1ZV9hY3Rpb24oQWN0aW9uVHlwZTo6U2V0RmVlQnBzKOKApikpYC4AAAAAAAALc2V0X2ZlZV9icHMAAAAAAQAAAAAAAAALbmV3X2ZlZV9icHMAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAX9RdWV1ZXMgYW4gYWRtaW4gYWN0aW9uIHRvIGJlIGV4ZWN1dGVkIGFmdGVyIGEgMjQtaG91ciBkZWxheS4KClRoZSBhZG1pbiBwcm92aWRlcyB0aGUgZGVzaXJlZCBgQWN0aW9uVHlwZWAgdmFyaWFudCBhbmQgcmVjZWl2ZXMgYQpudW1lcmljIG5vbmNlIGlkZW50aWZ5aW5nIHRoaXMgZW50cnkuIFBhc3MgdGhpcyBub25jZSB0byBgZXhlY3V0ZV9hY3Rpb25gCmFmdGVyIDI0IGhvdXJzLCBvciB0byBgY2FuY2VsX2FjdGlvbmAgdG8gYWJvcnQgdGhlIGludGVudC4KClNlbnNpdGl2ZSBwYXJhbWV0ZXIgY2hhbmdlcyBtdXN0IGdvIHRocm91Z2ggdGhlIHRpbWVsb2NrLgpUaGUgY29udHJhY3QgbXVzdCBub3QgYmUgZnJvemVuLCBhbmQgdGhlIGFkbWluIG11c3QgYXV0aG9yaXplLgAAAAAMcXVldWVfYWN0aW9uAAAAAQAAAAAAAAAGYWN0aW9uAAAAAAfQAAAACkFjdGlvblR5cGUAAAAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAgpBbGxvd3Mgc3dhcCByb3V0aW5nIHRvIGludm9rZSBhIERFWCByb3V0ZXIgY29udHJhY3QuIEFkbWluLW9ubHkuCgpSZXN0cmljdGluZyBjcm9zcy1jb250cmFjdCBjYWxscyB0byBhIHJlZ2lzdGVyZWQgYWxsb3dsaXN0IGlzIHdoYXQga2VlcHMKc3dhcCByb3V0aW5nIHBvaW50ZWQgYXQgYXVkaXRlZCBjb2RlLgoKIyBQYXJhbWV0ZXJzCi0gYGRleGA6IENvbnRyYWN0IElEIG9mIHRoZSBERVggcm91dGVyIHRvIGFwcHJvdmUuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QgaGFzCm5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgYWRtaW4gZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlJlZ2lzdGVyRGV4KOKApikpYAphbmQgZXhlY3V0ZSBhZnRlciAyNCBob3Vycy4AAAAAAAxyZWdpc3Rlcl9kZXgAAAABAAAAAAAAAANkZXgAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAThDYW5jZWxzIGEgcGVuZGluZyB0aW1lbG9jayBlbnRyeSBiZWZvcmUgaXQgY2FuIGJlIGV4ZWN1dGVkLgoKVGhpcyBpcyB0aGUgcHJpbWFyeSBkZWZlbmNlIHdoZW4gYSBjb21wcm9taXNlZCBhZG1pbiBoYXMgcXVldWVkIGEKbWFsaWNpb3VzIGFjdGlvbjogYW55IG90aGVyIGFkbWluIChhZnRlciBhIGtleSByb3RhdGlvbikgb3IgYQptdWx0aS1zaWcgZ292ZXJuYW5jZSBjYW4gY2FuY2VsIGl0IHdpdGhpbiB0aGUgMjQtaG91ciB3aW5kb3cuCgpBZG1pbiBhdXRob3JpemF0aW9uIGlzIHJlcXVpcmVkLiBUaGUgY29udHJhY3QgbWF5IGJlIGZyb3plbi4AAAANY2FuY2VsX2FjdGlvbgAAAAAAAAEAAAAAAAAABW5vbmNlAAAAAAAABgAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAFlDbGFpbXMgYWxsIGN1cnJlbnRseSBhdmFpbGFibGUgeWllbGQgdG8gdGhlIHBsYXRmb3JtIHRyZWFzdXJ5LiBUcmVhc3VyeU1hbmFnZXItcHJvdGVjdGVkLgAAAAAAAA1oYXJ2ZXN0X3lpZWxkAAAAAAAAAQAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAYRSb3V0ZXMgYSBwYXltZW50IGZyb20gYSBzZW5kZXIgdG8gYSByZWNpcGllbnQsIGRlZHVjdGluZyBhIHBsYXRmb3JtIGZlZS4KCiMgUGFyYW1ldGVycwotIGBzZW5kZXJgOiBBZGRyZXNzIGZ1bmRzIGFyZSBkZWJpdGVkIGZyb207IG11c3QgYXV0aG9yaXplIGNhbGwuCi0gYHJlY2lwaWVudGA6IEFkZHJlc3MgdG8gcmVjZWl2ZSBmdW5kcyAobWludXMgcGxhdGZvcm0gZmVlKS4KLSBgdG9rZW5fYWRkcmVzc2A6IENvbnRyYWN0IElEIG9mIHRva2VuIHRyYW5zZmVycmVkLgotIGBhbW91bnRgOiBBbW91bnQgdG8gcm91dGUsIGluIHRva2VuJ3Mgc21hbGxlc3QgdW5pdC4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBhcHByb3ByaWF0ZSBgRXJyb3JgIG9uIGZhaWx1cmUuAAAADXJvdXRlX3BheW1lbnQAAAAAAAAEAAAAAAAAAAZzZW5kZXIAAAAAABMAAAAAAAAACXJlY2lwaWVudAAAAAAAABMAAAAAAAAADXRva2VuX2FkZHJlc3MAAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAbNTZXRzIHRoZSBtaW5pbXVtIGFsbG93ZWQgcm91dGluZyBhbW91bnQuIEZlZU1hbmFnZXItcHJvdGVjdGVkLgoKIyBQYXJhbWV0ZXJzCi0gYG1pbl9saW1pdGA6IFNtYWxsZXN0IGBhbW91bnRgIHRoYXQgYHJvdXRlX3BheW1lbnRgIC8KYHJvdXRlX3BheW1lbnRzYCB3aWxsIGFjY2VwdCBnb2luZyBmb3J3YXJkLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0CmhhcyBubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IEZlZU1hbmFnZXIgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlNldE1pbkxpbWl0KOKApikpYC4AAAAADXNldF9taW5fbGltaXQAAAAAAAABAAAAAAAAAAltaW5fbGltaXQAAAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAsREaXNjYXJkcyBldmVyeSBhcHByb3ZhbCBjb2xsZWN0ZWQgZm9yIGBuZXdfd2FzbV9oYXNoYC4gQWRtaW4tb25seS4KClRoZSBibHVudCBpbnN0cnVtZW50IGZvciBhIGNvbXByb21pc2VkIGhhc2g6IGl0IGRyb3BzIHRoZSBxdW9ydW0gZXZlbgp3aGVuIHRoZSB0aHJlc2hvbGQgd2FzIGFscmVhZHkgbWV0LCBzbyB0aGUgZ3JvdXAgY2FuIGZvcmNlIHRoZSBncm91cApiYWNrIHRvIHplcm8gc2lnbmF0dXJlcy4gTm90ZSB0aGF0IGB1cGdyYWRlYCBpcyBwZXJtaXNzaW9ubGVzcyBvbmNlIHRoZQp0aHJlc2hvbGQgaXMgbWV0LCBzbyB0aGUgYWRtaW4gc2hvdWxkIHByZWZlciBoYXZpbmcgc2lnbmVycyByZXZva2UgdGhlaXIKb3duIGFwcHJvdmFscyAob3Igcm90YXRlIHRoZSBncm91cCkgd2hpbGUgdGhlIGhhc2ggaXMgc3RpbGwgaW4gZmxpZ2h0LgoKIyBQYXJhbWV0ZXJzCi0gYG5ld193YXNtX2hhc2hgOiBUaGUgV0FTTSBoYXNoIHRvIGNsZWFyIGFwcHJvdmFscyBmb3IuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QgaGFzCm5vIGFkbWluIHNldCB5ZXQuIENsZWFyaW5nIGEgaGFzaCB3aXRoIG5vIGFwcHJvdmFscyBpcyBhIG5vLW9wLgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IGFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAOY2FuY2VsX3VwZ3JhZGUAAAAAAAEAAAAAAAAADW5ld193YXNtX2hhc2gAAAAAAAPuAAAAIAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAZ5TdG9wcyBzd2FwIHJvdXRpbmcgZnJvbSBpbnZva2luZyBhIERFWCByb3V0ZXIgY29udHJhY3QuIEFkbWluLW9ubHkuCgojIFBhcmFtZXRlcnMKLSBgZGV4YDogQ29udHJhY3QgSUQgb2YgdGhlIERFWCByb3V0ZXIgdG8gcmV2b2tlLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0IGhhcwpubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IGFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4KCkRFUFJFQ0FURUQgZm9yIGRpcmVjdCB1c2UuICBRdWV1ZSB2aWEgYHF1ZXVlX2FjdGlvbihBY3Rpb25UeXBlOjpEZXJlZ2lzdGVyRGV4KOKApikpYAphbmQgZXhlY3V0ZSBhZnRlciAyNCBob3Vycy4AAAAAAA5kZXJlZ2lzdGVyX2RleAAAAAAAAQAAAAAAAAADZGV4AAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAalFeGVjdXRlcyBhIHByZXZpb3VzbHkgcXVldWVkIGFjdGlvbiBpZGVudGlmaWVkIGJ5IGBub25jZWAuCgpSZXF1aXJlbWVudHM6Ci0gVGhlIGNvbnRyYWN0IG11c3Qgbm90IGJlIGZyb3plbi4KLSBUaGUgYWRtaW4gbXVzdCBhdXRob3JpemUuCi0gVGhlIGVudHJ5IGlkZW50aWZpZWQgYnkgYG5vbmNlYCBtdXN0IGV4aXN0LgotIEF0IGxlYXN0IDI0IGhvdXJzIChgU0VDT05EU19JTl8yNEhgKSBtdXN0IGhhdmUgcGFzc2VkIHNpbmNlIHF1ZXVpbmcuCi0gRm9yIFtgQWN0aW9uVHlwZTo6VXBncmFkZWBdLCB0aGUgbXVsdGktc2lnbmF0dXJlIHRocmVzaG9sZCBtdXN0CmFscmVhZHkgYmUgbWV0IGZvciB0aGF0IFdBU00gaGFzaC4KCk9uIHN1Y2Nlc3MgdGhlIGVudHJ5IGlzIHJlbW92ZWQgYW5kIHRoZSB1bmRlcmx5aW5nIHNldHRlciBpcyBpbnZva2VkLgAAAAAAAA5leGVjdXRlX2FjdGlvbgAAAAAAAQAAAAAAAAAFbm9uY2UAAAAAAAAGAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAORSZXR1cm5zIHRoZSBjdXJyZW50IG1ldGEtdHJhbnNhY3Rpb24gbm9uY2UgZm9yIGEgdXNlci4KClJlbGF5ZXJzIG11c3QgdXNlIHRoaXMgbm9uY2Ugd2hlbiBidWlsZGluZyB0aGUgc2lnbmVkIHBheWxvYWQuClRoZSBub25jZSBzdGFydHMgYXQgYDBgIGFuZCBpbmNyZW1lbnRzIGFmdGVyIGVhY2ggc3VjY2Vzc2Z1bApgcm91dGVfcGF5bWVudF9tZXRhYCwgcHJldmVudGluZyByZXBsYXkgYXR0YWNrcy4AAAAOZ2V0X21ldGFfbm9uY2UAAAAAAAEAAAAAAAAABHVzZXIAAAATAAAAAQAAAAY=",
        "AAAAAAAAAN5SZXR1cm5zIHRoZSBhY3RpdmUgcGVyLWxlZGdlciBpbnZvY2F0aW9uIGNhcC4gQSB2YWx1ZSBvZiBgMGAgbWVhbnMKcmF0ZSBsaW1pdGluZyBpcyBkaXNhYmxlZC4KCiMgUmV0dXJucwpUaGUgY29uZmlndXJlZCBjYXAsIG9yIHRoZSBkZWZhdWx0IGNhcCAoMTApIHdoZW4gbm8gZXhwbGljaXQKY29uZmlndXJhdGlvbiBoYXMgYmVlbiBzdG9yZWQuCgojIFBhbmljcwpEb2VzIG5vdCBwYW5pYy4AAAAAAA5nZXRfcmF0ZV9saW1pdAAAAAAAAAAAAAEAAAAE",
        "AAAAAAAAAIVSZXR1cm5zIHRoZSBhZG1pbmlzdHJhdGl2ZSByb2xlIGdvdmVybmluZyB0aGUgc3BlY2lmaWVkIHJvbGUuCgpJbiB0aGlzIFJCQUMgYXJjaGl0ZWN0dXJlLCBgU3VwZXJBZG1pbmAgZ292ZXJucyBhbGwgb3BlcmF0aW9uYWwgcm9sZXMuAAAAAAAADmdldF9yb2xlX2FkbWluAAAAAAABAAAAAAAAAAVfcm9sZQAAAAAAB9AAAAAEUm9sZQAAAAEAAAfQAAAABFJvbGU=",
        "AAAAAAAAALNSZXR1cm5zIHdoZXRoZXIgYW4gYWRkcmVzcyBpcyBibGFja2xpc3RlZC4KCiMgUGFyYW1ldGVycwotIGBhZGRyZXNzYDogQWRkcmVzcyB0byBjaGVjay4KCiMgUmV0dXJucwpgdHJ1ZWAgaWYgYGFkZHJlc3NgIGlzIGJsYWNrbGlzdGVkLCBgZmFsc2VgIG90aGVyd2lzZS4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAAAOaXNfYmxhY2tsaXN0ZWQAAAAAAAEAAAAAAAAAB2FkZHJlc3MAAAAAEwAAAAEAAAAB",
        "AAAAAAAAAc9SZWNvdmVycyB0b2tlbnMgYWNjaWRlbnRhbGx5IHNlbnQgZGlyZWN0bHkgdG8gdGhlIGNvbnRyYWN0IGFkZHJlc3MuIEFkbWluLW9ubHkuCgojIFBhcmFtZXRlcnMKLSBgdG9rZW5gOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4gdG8gcmVjb3Zlci4KLSBgYW1vdW50YDogQW1vdW50IHRvIHRyYW5zZmVyIGZyb20gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSB0byB0aGUgYWRtaW4uCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgYWRtaW4gZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLCBvciBpZiB0aGUKdG9rZW4gdHJhbnNmZXIgZmFpbHMgKGUuZy4gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSBpcyBiZWxvdyBgYW1vdW50YCkuAAAAAA5yZWNvdmVyX3Rva2VucwAAAAAAAgAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAnhSb3V0ZXMgbXVsdGlwbGUgcGF5bWVudHMgaW4gYSBzaW5nbGUgdHJhbnNhY3Rpb24uIElmIGFueSBwYXltZW50IGZhaWxzLAp0aGUgZW50aXJlIGJhdGNoIGlzIHJldmVydGVkIGF0b21pY2FsbHkuCgojIFBhcmFtZXRlcnMKLSBgcGF5bWVudHNgOiBCYXRjaCBvZiB0cmFuc2ZlciBpbnN0cnVjdGlvbnMgdG8gYXBwbHkgaW4gb3JkZXIuIFNlZQpbYFBheW1lbnRgXSBmb3IgcGVyLWl0ZW0gY29uc3RyYWludHMuCgojIFJldHVybnMKYE9rKCgpKWAgaWYgZXZlcnkgcGF5bWVudCBpbiB0aGUgYmF0Y2ggc3VjY2VlZHMuIFJldHVybnMgdGhlIGZpcnN0CmVycm9yIGVuY291bnRlcmVkIChzZWUgYHJvdXRlX3BheW1lbnRgIGZvciB0aGUgcG9zc2libGUgYEVycmAKdmFyaWFudHMgYW5kIHRoZWlyIGNhdXNlcykgaWYgYW55IHBheW1lbnQgZmFpbHM7IHRoZSBTb3JvYmFuIGhvc3QKcmV2ZXJ0cyBhbGwgc3RvcmFnZSBhbmQgYmFsYW5jZSBjaGFuZ2VzIGZyb20gdGhlIGJhdGNoIGluIHRoYXQgY2FzZS4KCiMgUGFuaWNzClBhbmljcyBpZiBhbnkgcGF5bWVudCdzIGBzZW5kZXJgIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYKYSB0b2tlbiB0cmFuc2ZlciB0byBgcGxhdGZvcm1fdHJlYXN1cnlgIGZhaWxzLgAAAA5yb3V0ZV9wYXltZW50cwAAAAAAAQAAAAAAAAAIcGF5bWVudHMAAAPqAAAH0AAAAAdQYXltZW50AAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAWxBbGlhcyBmb3IgYHNldF9mZWVfY29uZmlnX2xlZ2FjeWAuIEFkbWluLW9ubHkuCgojIFBhcmFtZXRlcnMKLSBgZmVlX2Jwc2A6IE5ldyBwbGF0Zm9ybSBmZWUgcmF0ZSwgaW4gYmFzaXMgcG9pbnRzLgotIGBmZWVfY2FwYDogTmV3IG1heGltdW0gZmVlIHRha2VuIGZyb20gYSBzaW5nbGUgcGF5bWVudC4KCiMgUmV0dXJucwpTZWUgYHNldF9mZWVfY29uZmlnX2xlZ2FjeWAuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgYWRtaW4gZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlNldEZlZUNvbmZpZyjigKYpKWAuAAAADnNldF9mZWVfY29uZmlnAAAAAAACAAAAAAAAAAdmZWVfYnBzAAAAAAsAAAAAAAAAB2ZlZV9jYXAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAPVTZXRzIHRoZSBnb3Zlcm5hbmNlIGNvbnRyYWN0IGFkZHJlc3MuIEFmdGVyIHRoaXMgY2FsbCwgb25seSB0aGUgZ292ZXJuYW5jZQpjb250cmFjdCBjYW4gdXBkYXRlIGZlZXMuIEFkbWluLW9ubHkg4oCUIGNhbiBvbmx5IGJlIHNldCBvbmNlIHBlciBnb3Zlcm5hbmNlIGN5Y2xlLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlNldEdvdmVybmFuY2Uo4oCmKSlgLgAAAAAAAA5zZXRfZ292ZXJuYW5jZQAAAAAAAQAAAAAAAAADZ292AAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAGRDb25maWd1cmVzIHRoZSB0cnVzdGVkIEtZQyBvcmFjbGUgYW5kIHRoZSBoaWdoLXZhbHVlIHBheW1lbnQgdGhyZXNob2xkLiBDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuAAAADnNldF9reWNfY29uZmlnAAAAAAACAAAAAAAAAAZvcmFjbGUAAAAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAxBTZXRzIHRoZSBtYXhpbXVtIG51bWJlciBvZiBwYXltZW50IGludm9jYXRpb25zIGEgc2luZ2xlIHNlbmRlciBtYXkKbWFrZSBwZXIgbGVkZ2VyIHNlcXVlbmNlLiBBZG1pbi1vbmx5LgoKUmF0ZSBsaW1pdGluZyBpcyBhY3RpdmUgaW1tZWRpYXRlbHkgYWZ0ZXIgYGluaXRpYWxpemVgIHdpdGggYSBkZWZhdWx0CmNhcCBvZiAxMCBpbnZvY2F0aW9ucyBwZXIgYWRkcmVzcyBwZXIgbGVkZ2VyLiBUaGlzIHNldHRlciBjaGFuZ2VzIHRoZQpjYXA7IGEgdmFsdWUgb2YgYDBgIGRpc2FibGVzIHJhdGUgbGltaXRpbmcgZW50aXJlbHkgKHdoaXRlbGlzdGluZwppbmRpdmlkdWFsIGFkZHJlc3NlcyB2aWEgYHNldF9yYXRlX2xpbWl0X3doaXRlbGlzdGAgaXMgdXN1YWxseQpwcmVmZXJhYmxlIHRvIGRpc2FibGluZyB0aGUgbGltaXRlciBmb3IgZXZlcnlvbmUpLgoKIyBQYXJhbWV0ZXJzCi0gYG1heF9jYWxsc19wZXJfbGVkZ2VyYDogSW52b2NhdGlvbiBjYXAgcGVyIGFkZHJlc3MgcGVyIGxlZGdlci4KTXVzdCBub3QgZXhjZWVkIGBNQVhfUkFURV9MSU1JVGAgKDEsMDAwLDAwMCkuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2VzcywgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QgaGFzCm5vIGFkbWluIHNldCB5ZXQsIG9yIGBFcnIoRXJyb3I6OkxpbWl0RXhjZWVkZWQpYCBpZiB0aGUgY2FwIGV4Y2VlZHMKYE1BWF9SQVRFX0xJTUlUYC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBhZG1pbiBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAADnNldF9yYXRlX2xpbWl0AAAAAAABAAAAAAAAABRtYXhfY2FsbHNfcGVyX2xlZGdlcgAAAAQAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAZZUcmFuc2ZlcnMgYWRtaW4gcmlnaHRzIHRvIGEgbmV3IGFkZHJlc3MuIFJlcXVpcmVzIGN1cnJlbnQgU3VwZXJBZG1pbiBhdXRob3JpemF0aW9uLgoKIyBQYXJhbWV0ZXJzCi0gYG5ld19hZG1pbmA6IEFkZHJlc3MgdG8gYmVjb21lIHRoZSBuZXcgYWRtaW4uCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgU3VwZXJBZG1pbiBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuCgpERVBSRUNBVEVEIGZvciBkaXJlY3QgdXNlLiAgUXVldWUgdmlhIGBxdWV1ZV9hY3Rpb24oQWN0aW9uVHlwZTo6VHJhbnNmZXJBZG1pbijigKYpKWAuAAAAAAAOdHJhbnNmZXJfYWRtaW4AAAAAAAEAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAQZSZWNvcmRzIGBzaWduZXJgJ3MgYXV0aG9yaXphdGlvbiBvZiBhbiB1cGdyYWRlIHRvIGBuZXdfd2FzbV9oYXNoYC4KCiMgUGFyYW1ldGVycwotIGBzaWduZXJgOiBUaGUgZ3JvdXAgbWVtYmVyIGFwcHJvdmluZzsgbXVzdCBhdXRob3JpemUgdGhpcyBjYWxsLgotIGBuZXdfd2FzbV9oYXNoYDogVGhlIFdBU00gaGFzaCBiZWluZyBhcHByb3ZlZC4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBhcHByb3ByaWF0ZSBgRXJyb3JgIG9uIGZhaWx1cmUuAAAAAAAPYXBwcm92ZV91cGdyYWRlAAAAAAIAAAAAAAAABnNpZ25lcgAAAAAAEwAAAAAAAAANbmV3X3dhc21faGFzaAAAAAAAA+4AAAAgAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAL5SZXR1cm5zIHRoZSBwcmltYXJ5IGRlc2lnbmF0ZWQgbWVtYmVyIGFkZHJlc3MgZm9yIGEgcm9sZSwgaWYgb25lIGlzIGNvbmZpZ3VyZWQuCgojIFBhcmFtZXRlcnMKLSBgcm9sZWA6IFRoZSByb2xlIHZhcmlhbnQgdG8gcXVlcnkuCgojIFJldHVybnMKYFNvbWUoQWRkcmVzcylgIGlmIHNldCwgb3IgYE5vbmVgIGlmIHVuYXNzaWduZWQuAAAAAAAPZ2V0X3JvbGVfbWVtYmVyAAAAAAEAAAAAAAAABHJvbGUAAAfQAAAABFJvbGUAAAABAAAD6AAAABM=",
        "AAAAAAAAAhpSZXR1cm5zIGEgc2VuZGVyJ3MgY29tYmluZWQgcm91dGluZyByZWNvcmQ6IHRoZSBhbW91bnQgYWNjdW11bGF0ZWQgaW4KdGhlIGN1cnJlbnQgMjQtaG91ciB3aW5kb3cgYW5kIHRoZWlyIGN1bXVsYXRpdmUgbGlmZXRpbWUgdm9sdW1lCihpc3N1ZSAjNjYzKS4KClJlYWRzIHRoZSBzaW5nbGUgcGFja2VkIGBVc2VyUmVjb3JkYCBlbnRyeS4gRm9yIGEgc2VuZGVyIHRoYXQgb25seSBoYXMKdGhlIGxlZ2FjeSBwcmUtIzY2MyBzcGxpdCBlbnRyaWVzLCBib3RoIGNvdW50ZXJzIGFyZSBjb21iaW5lZCBmcm9tCnRob3NlIHdpdGhvdXQgd3JpdGluZyBhbnl0aGluZy4KCiMgUGFyYW1ldGVycwotIGB1c2VyYDogU2VuZGVyIGFkZHJlc3MgdG8gbG9vayB1cC4KCiMgUmV0dXJucwpBIFtgVXNlclJlY29yZGBdIHdpdGggemVyb2VkIGNvdW50ZXJzIGlmIGB1c2VyYCBoYXMgbmV2ZXIgcm91dGVkIGEKcGF5bWVudDsgYGxhc3RfcmVzZXRfdGltZWAgaXMgdGhlbiB0aGUgY3VycmVudCBsZWRnZXIgdGltZXN0YW1wLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAAAAPZ2V0X3VzZXJfcmVjb3JkAAAAAAEAAAAAAAAABHVzZXIAAAATAAAAAQAAB9AAAAAKVXNlclJlY29yZAAA",
        "AAAAAAAAAPhSZXR1cm5zIHRoZSBjdW11bGF0aXZlIGFtb3VudCBhIGdpdmVuIHNlbmRlciBoYXMgcm91dGVkIHRocm91Z2ggdGhlIGNvbnRyYWN0LgoKIyBQYXJhbWV0ZXJzCi0gYHVzZXJgOiBTZW5kZXIgYWRkcmVzcyB0byBsb29rIHVwLgoKIyBSZXR1cm5zClRoZSBsaWZldGltZSByb3V0ZWQgdm9sdW1lIGZvciBgdXNlcmAsIG9yIGAwYCBpZiB0aGV5IGhhdmUgbmV2ZXIKcm91dGVkIGEgcGF5bWVudC4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAA9nZXRfdXNlcl92b2x1bWUAAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAACw==",
        "AAAAAAAAAs1XaXRoZHJhd3MgYSBzcGVjaWZpYyBhbW91bnQgZnJvbSB0aGUgdXNlcidzIGludGVybmFsIHJlZnVuZCBiYWxhbmNlLgoKQSByZWZ1bmQgYmFsYW5jZSBhY2NydWVzIHdoZW4gYSBgcm91dGVfcGF5bWVudGAgLyBgcm91dGVfcGF5bWVudHNgCnRyYW5zZmVyIHRvIHRoZSByZWNpcGllbnQgZmFpbHMgKGUuZy4gbWlzc2luZyB0cnVzdGxpbmUpIGFuZCB0aGUKZnVuZHMgYXJlIGhlbGQgYnkgdGhlIGNvbnRyYWN0IG9uIHRoZSBzZW5kZXIncyBiZWhhbGYgaW5zdGVhZC4KCiMgUGFyYW1ldGVycwotIGB1c2VyYDogQWRkcmVzcyB3aXRoZHJhd2luZyBmdW5kczsgbXVzdCBhdXRob3JpemUgdGhlIGNhbGwuCi0gYHRva2VuYDogQ29udHJhY3QgSUQgb2YgdGhlIHRva2VuIHRvIHdpdGhkcmF3LgotIGBhbW91bnRgOiBBbW91bnQgdG8gd2l0aGRyYXcuIE11c3QgYmUgcG9zaXRpdmUgYW5kIG5vdCBleGNlZWQgdGhlCmN1cnJlbnQgcmVmdW5kIGJhbGFuY2UuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm9SZWZ1bmRBdmFpbGFibGUpYCBpZiBgYW1vdW50YAppcyB6ZXJvLCBuZWdhdGl2ZSwgb3IgZ3JlYXRlciB0aGFuIHRoZSBhdmFpbGFibGUgYmFsYW5jZS4KCiMgUGFuaWNzClBhbmljcyBpZiBgdXNlcmAgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLCBvciBpZiB0aGUgdW5kZXJseWluZwp0b2tlbiB0cmFuc2ZlciBmYWlscy4AAAAAAAAPd2l0aGRyYXdfcmVmdW5kAAAAAAMAAAAAAAAABHVzZXIAAAATAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
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
        "AAAAAAAAAnFBZG1pbi1vbmx5IGVtZXJnZW5jeSB3aXRoZHJhd2FsIG9mIHRva2VucyBoZWxkIGJ5IHRoaXMgY29udHJhY3QuCgojIFBhcmFtZXRlcnMKLSBgdG9rZW5gOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4gdG8gd2l0aGRyYXcuCkFkbWluLW9ubHkgZW1lcmdlbmN5IHdpdGhkcmF3YWwgb2YgdG9rZW5zIGhlbGQgYnkgdGhpcyBjb250cmFjdC4gVHJlYXN1cnlNYW5hZ2VyLXByb3RlY3RlZC4KCiMgUGFyYW1ldGVycwotIGB0b2tlbmA6IENvbnRyYWN0IElEIG9mIHRoZSB0b2tlbiB0byB3aXRoZHJhdy4KLSBgYW1vdW50YDogQW1vdW50IHRvIHRyYW5zZmVyIGZyb20gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSB0byB0aGUgdHJlYXN1cnkgbWFuYWdlci4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBUcmVhc3VyeU1hbmFnZXIgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLCBvciBpZiB0aGUKdG9rZW4gdHJhbnNmZXIgZmFpbHMgKGUuZy4gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSBpcyBiZWxvdyBgYW1vdW50YCkuAAAAAAAAEmVtZXJnZW5jeV93aXRoZHJhdwAAAAAAAgAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAQFSZXR1cm5zIHRoZSBzdG9yZWQgZmFsbGJhY2sgcHJpY2UgZm9yIGEgKGJhc2UsIHF1b3RlKSBhc3NldCBwYWlyLCBpZiBhbnkuCgojIFBhcmFtZXRlcnMKLSBgYmFzZV9hc3NldGA6IEFkZHJlc3Mgb2YgdGhlIGJhc2UgYXNzZXQuCi0gYHF1b3RlX2Fzc2V0YDogQWRkcmVzcyBvZiB0aGUgcXVvdGUgYXNzZXQuCgojIFJldHVybnMKYFNvbWUoUHJpY2VEYXRhKWAgaWYgYSBmYWxsYmFjayBoYXMgYmVlbiBjb25maWd1cmVkLCBgTm9uZWAgb3RoZXJ3aXNlLgAAAAAAABJnZXRfZmFsbGJhY2tfcHJpY2UAAAAAAAIAAAAAAAAACmJhc2VfYXNzZXQAAAAAABMAAAAAAAAAC3F1b3RlX2Fzc2V0AAAAABMAAAABAAAD6AAAB9AAAAAJUHJpY2VEYXRhAAAA",
        "AAAAAAAAARJSZXR1cm5zIHRoZSBhdmFpbGFibGUgaW50ZXJuYWwgcmVmdW5kIGJhbGFuY2UgZm9yIGEgdXNlciBhbmQgdG9rZW4uCgojIFBhcmFtZXRlcnMKLSBgdXNlcmA6IEFkZHJlc3Mgd2hvc2UgcmVmdW5kIGJhbGFuY2UgdG8gbG9vayB1cC4KLSBgdG9rZW5gOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4uCgojIFJldHVybnMKVGhlIHJlZnVuZGFibGUgYmFsYW5jZSBmb3IgYCh1c2VyLCB0b2tlbilgLCBvciBgMGAgaWYgbm9uZSBpcyBoZWxkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAAAASZ2V0X3JlZnVuZF9iYWxhbmNlAAAAAAACAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAAAs=",
        "AAAAAAAAADRSZXR1cm5zIHRoZSB0cmFja2VkIHByaW5jaXBhbCBkZXBvc2l0ZWQgZm9yIGB0b2tlbmAuAAAAEmdldF95aWVsZF9wb3NpdGlvbgAAAAAAAQAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAAAs=",
        "AAAAAAAAAD1DcmVhdGVzIGEgZmVlIHByb3Bvc2FsIHdlaWdodGVkIGJ5IGdvdmVybmFuY2UtdG9rZW4gYmFsYW5jZXMuAAAAAAAAEnByb3Bvc2VfZmVlX2NoYW5nZQAAAAAABAAAAAAAAAAIcHJvcG9zZXIAAAATAAAAAAAAAAdmZWVfYnBzAAAAAAsAAAAAAAAAB2ZlZV9jYXAAAAAACwAAAAAAAAANdm90aW5nX3BlcmlvZAAAAAAAAAYAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAhpSb3V0ZXMgYSBwYXltZW50IGF1dGhvcmlzZWQgYnkgYW4gb2ZmLWNoYWluIHJlbGF5ZXIncyBFZDI1NTE5IHNpZ25hdHVyZQppbnN0ZWFkIG9mIHRoZSBzZW5kZXIncyBvbi1jaGFpbiBhdXRob3JpemF0aW9uLgoKIyBQYXJhbWV0ZXJzCi0gYHNlbmRlcmA6IEFkZHJlc3Mgd2hvc2UgZnVuZHMgYXJlIHJvdXRlZC4KLSBgc2lnbmVyX3B1YmtleWA6IEVkMjU1MTkgcHVibGljIGtleSB0aGF0IHNpZ25lZCB0aGUgcGF5bG9hZC4KLSBgcmVjaXBpZW50YDogRGVzdGluYXRpb24gYWRkcmVzcy4KLSBgdG9rZW5fYWRkcmVzc2A6IFRva2VuIGNvbnRyYWN0IElELgotIGBhbW91bnRgOiBBbW91bnQgdG8gcm91dGUuCi0gYG5vbmNlYDogU2VuZGVyJ3MgY3VycmVudCBtZXRhLXRyYW5zYWN0aW9uIG5vbmNlLgotIGBkZWFkbGluZWA6IEV4cGlyYXRpb24gdGltZXN0YW1wLgotIGBzaWduYXR1cmVgOiBFZDI1NTE5IHNpZ25hdHVyZSBvdmVyIGNhbm9uaWNhbCBwYXlsb2FkLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uY2UgdGhlIHBheW1lbnQgaGFzIHNldHRsZWQuAAAAAAAScm91dGVfcGF5bWVudF9tZXRhAAAAAAAIAAAAAAAAAAZzZW5kZXIAAAAAABMAAAAAAAAADXNpZ25lcl9wdWJrZXkAAAAAAAPuAAAAIAAAAAAAAAAJcmVjaXBpZW50AAAAAAAAEwAAAAAAAAANdG9rZW5fYWRkcmVzcwAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAFbm9uY2UAAAAAAAAGAAAAAAAAAAhkZWFkbGluZQAAAAYAAAAAAAAACXNpZ25hdHVyZQAAAAAAA+4AAABAAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAA09TdG9yZXMgYW4gYWRtaW4tc3VwcGxpZWQgZmFsbGJhY2sgcHJpY2UgZm9yIGEgKGJhc2UsIHF1b3RlKSBhc3NldCBwYWlyLgpDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuCgpUaGUgZmFsbGJhY2sgaXMgdXNlZCBieSBbYGdldF9wcmljZWBdIHdoZW4gdGhlIGxpdmUgb3JhY2xlIGlzCnVuYXZhaWxhYmxlIG9yIHJldHVybnMgZGF0YSB0aGF0IGZhaWxzIHZhbGlkYXRpb24gKHN0YWxlIG9yIGludmFsaWQpLgpTZXR0aW5nIGEgZmFsbGJhY2sgcHJpY2UgdG8gYDBgIGVmZmVjdGl2ZWx5IHJlbW92ZXMgdGhlIGZhbGxiYWNrLAptZWFuaW5nIHRoYXQgb3JhY2xlIGZhaWx1cmVzIHdpbGwgcHJvcGFnYXRlIGFzIGVycm9ycyByYXRoZXIgdGhhbgpzaWxlbnRseSB1c2luZyBhIHN0YWxlIGNhY2hlZCB2YWx1ZS4KCiMgUGFyYW1ldGVycwotIGBiYXNlX2Fzc2V0YDogQWRkcmVzcyBvZiB0aGUgYmFzZSBhc3NldCAoZS5nLiBYTE0gY29udHJhY3QpLgotIGBxdW90ZV9hc3NldGA6IEFkZHJlc3Mgb2YgdGhlIHF1b3RlIGFzc2V0IChlLmcuIFVTREMgY29udHJhY3QpLgotIGBmYWxsYmFja19wcmljZWA6IFByaWNlIGV4cHJlc3NlZCBpbiB0aGUgc2FtZSBmaXhlZC1wb2ludCBmb3JtYXQgYXMKdGhlIG9yYWNsZSAoYHByaWNlIC8gMTBeZGVjaW1hbHNgKS4gUGFzcyBgMGAgdG8gY2xlYXIgdGhlIGZhbGxiYWNrLgotIGBkZWNpbWFsc2A6IERlY2ltYWwgcHJlY2lzaW9uIG9mIGBmYWxsYmFja19wcmljZWAuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcy4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBDb21wbGlhbmNlT2ZmaWNlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAABJzZXRfZmFsbGJhY2tfcHJpY2UAAAAAAAQAAAAAAAAACmJhc2VfYXNzZXQAAAAAABMAAAAAAAAAC3F1b3RlX2Fzc2V0AAAAABMAAAAAAAAADmZhbGxiYWNrX3ByaWNlAAAAAAALAAAAAAAAAAhkZWNpbWFscwAAAAQAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAF5Db25maWd1cmVzIHRoZSBsZW5kaW5nIHByb3RvY29sIHVzZWQgZm9yIHRyZWFzdXJ5IHlpZWxkIG9wZXJhdGlvbnMuIFRyZWFzdXJ5TWFuYWdlci1wcm90ZWN0ZWQuAAAAAAASc2V0X3lpZWxkX3Byb3RvY29sAAAAAAABAAAAAAAAAAhwcm90b2NvbAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAMRSZWNvcmRzIGEgdG9rZW4gYXMgc3VwcG9ydGVkIChuby1vcDsgcm91dGluZyBhY2NlcHRzIGFueSB0b2tlbiBjb250cmFjdCBJRCkuCgojIFBhcmFtZXRlcnMKLSBgX3Rva2VuYDogSWdub3JlZDsgcHJlc2VudCBmb3IgQVBJIGNvbXBhdGliaWxpdHkuCgojIFJldHVybnMKQWx3YXlzIGBPaygoKSlgLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAE2FkZF9zdXBwb3J0ZWRfdG9rZW4AAAAAAQAAAAAAAAAGX3Rva2VuAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAQdDb21taXRzIGEgU0hBLTI1NiBNZXJrbGUgcm9vdCBvZiBhIGJhdGNoIG9mIHBheW1lbnQtcmVjb3JkIHNuYXBzaG90cwppbnRvIHBlcnNpc3RlbnQgc3RvcmFnZSwgb3BlbmluZyBhIG5ldyBhcmNoaXZlIGVwb2NoLgoKQ2FsbCB0aGlzIGJlZm9yZSBgcHJ1bmVfYXJjaGl2ZWRfZW50cmllc2AuIFJlcXVpcmVzIFRyZWFzdXJ5TWFuYWdlci4KUmV0dXJucyB0aGUgbmV3IGVwb2NoIG51bWJlci4KCkVycm9yczogTm90SW5pdGlhbGl6ZWQsIENvbnRyYWN0RnJvemVuLgAAAAATY29tbWl0X2FyY2hpdmVfcm9vdAAAAAADAAAAAAAAAARyb290AAAD7gAAACAAAAAAAAAABmxlYXZlcwAAAAAD6gAAB9AAAAALQXJjaGl2ZUxlYWYAAAAAAAAAAAtkZXNjcmlwdGlvbgAAAAAQAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAANVSZXR1cm5zIHRoZSBjdXJyZW50IG11bHRpLXNpZ25hdHVyZSBhZG1pbiBncm91cC4KCiMgUmV0dXJucwpUaGUgY29uZmlndXJlZCBzaWduZXJzIGFuZCB0aHJlc2hvbGQsIG9yIGBFcnIoRXJyb3I6Ok11bHRpc2lnTm90SW5pdGlhbGl6ZWQpYAppZiBgc2V0X211bHRpc2lnX2NvbmZpZ2AgaGFzIG5vdCBiZWVuIGNhbGxlZCB5ZXQuCgojIFBhbmljcwpEb2VzIG5vdCBwYW5pYy4AAAAAAAATZ2V0X211bHRpc2lnX2NvbmZpZwAAAAAAAAAAAQAAA+kAAAfQAAAADk11bHRpc2lnQ29uZmlnAAAAAAAD",
        "AAAAAAAAAnFQZXJtaXNzaW9ubGVzcyBtaWdyYXRpb24gb2YgYSBzZW5kZXIncyBsZWdhY3kgcHJlLSM2NjMgc3BsaXQgZW50cmllcwooYFVzZXJTcGVuZGluZ2AgKyBgVXNlclZvbHVtZWApIGludG8gdGhlIHNpbmdsZSBwYWNrZWQgYFVzZXJSZWNvcmRgCihpc3N1ZSAjNjYzKS4KCkNhbGxhYmxlIGJ5IGFueW9uZTogaXQgb25seSByZWNvbWJpbmVzIHZhbHVlcyB0aGF0IGFyZSBhbHJlYWR5IG9uIHRoZQpsZWRnZXIgYW5kIG5ldmVyIGludmVudHMgb3IgZGVzdHJveXMgdmFsdWUuIFdoZW4gdGhlIHNlbmRlcidzIHBhY2tlZApyZWNvcmQgd2FzIGFscmVhZHkgY3JlYXRlZCBieSBhIHJlY2VudCBwYXltZW50LCB0aGlzIGp1c3QgcmVtb3ZlcyB0aGUKc3RhbGUgbGVnYWN5IGtleXMgYW5kIGtlZXBzIHRoZSBuZXdlciBwYWNrZWQgdmFsdWVzLgoKIyBQYXJhbWV0ZXJzCi0gYHVzZXJgOiBUaGUgc2VuZGVyIHdob3NlIGxlZ2FjeSBlbnRyaWVzIHNob3VsZCBiZSBtaWdyYXRlZC4KCiMgUmV0dXJucwpgdHJ1ZWAgaWYgbGVnYWN5IHN0YXRlIHdhcyBmb3VuZCBhbmQgbWlncmF0ZWQsIGBmYWxzZWAgaWYgYHVzZXJgIGhhcwpubyBsZWdhY3kgZW50cmllcyB0byBtaWdyYXRlLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAAAAAE21pZ3JhdGVfdXNlcl9yZWNvcmQAAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAAAQ==",
        "AAAAAAAAANdEaXNhYmxlcyB0aGUgZGVhZCBtYW4ncyBzd2l0Y2gsIHJlbW92aW5nIHRoZSBiYWNrdXAgYWRtaW4gYW5kIGl0cwpjbGFpbSB3aW5kb3cuIFRoZSBpbmFjdGl2aXR5IHRpbWVvdXQgaXMgbGVmdCBpbiBzdG9yYWdlIHVudG91Y2hlZCBzbwphIGxhdGVyIHJlLWFybWluZyAodmlhIHRpbWVsb2NrKSBjYW4gcmV1c2UgaXQuCgpBZG1pbiBhdXRob3JpemF0aW9uIGlzIHJlcXVpcmVkLgAAAAATcmVtb3ZlX2JhY2t1cF9hZG1pbgAAAAAAAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAUhSb3V0ZXMgYSBwYXltZW50IHRocm91Z2ggdHdvIHRvIGZvdXIgY29uc2VjdXRpdmUgREVYIHN3YXBzLiBgcGF0aGAKY29udGFpbnMgdGhlIGlucHV0IGFzc2V0IGZvbGxvd2VkIGJ5IGV2ZXJ5IGludGVybWVkaWF0ZSBhc3NldCBhbmQgdGhlCm91dHB1dCBhc3NldC4gYG1pbl9hbW91bnRzX291dFtpXWAgaXMgdGhlIHJlcXVpcmVkIG91dHB1dCBmb3IgaG9wIGBpYC4KQW55IGlucHV0IGR1c3QgcmV0dXJuZWQgYnkgYSBob3AgaXMgcmVmdW5kZWQgdG8gYHNlbmRlcmAgaW4gdGhhdCBob3AncwppbnB1dCBhc3NldC4gQWxsIHN3YXBzIGFuZCBzZXR0bGVtZW50IGFyZSBhdG9taWMuAAAAE3JvdXRlX211bHRpaG9wX3N3YXAAAAAABgAAAAAAAAAGc2VuZGVyAAAAAAATAAAAAAAAAAlyZWNpcGllbnQAAAAAAAATAAAAAAAAAApkZXhfcm91dGVyAAAAAAATAAAAAAAAAAlhbW91bnRfaW4AAAAAAAALAAAAAAAAAARwYXRoAAAD6gAAABMAAAAAAAAAD21pbl9hbW91bnRzX291dAAAAAPqAAAACwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAw1Db25maWd1cmVzIHRoZSBtdWx0aS1zaWduYXR1cmUgYWRtaW4gZ3JvdXAgdGhhdCBhdXRob3JpemVzIHVwZ3JhZGVzLgoKVGhlIHNpZ25lciBzZXQgaXMgcmVwbGFjZWQgd2hvbGVzYWxlOiBhZGRyZXNzZXMgdGhhdCBhcmUgbm90IGluCmBzaWduZXJzYCBpbW1lZGlhdGVseSBsb3NlIHRoZSBhYmlsaXR5IHRvIGFwcHJvdmUsIGFuZCBhIHRocmVzaG9sZAphbHJlYWR5IHJlYWNoZWQgZm9yIGEgcGVuZGluZyBoYXNoIGlzIHJlLWV2YWx1YXRlZCBhZ2FpbnN0IHRoZSBuZXcKY29uZmlndXJhdGlvbi4KCiMgUGFyYW1ldGVycwotIGBzaWduZXJzYDogVGhlIE4gYWRkcmVzc2VzIHdob3NlIHNpZ25hdHVyZXMgY291bnQuIE11c3QgYmUgbm9uLWVtcHR5CmFuZCBmcmVlIG9mIGR1cGxpY2F0ZXMuCi0gYHRocmVzaG9sZGA6IFRoZSBNIHNpZ25lcnMgcmVxdWlyZWQgdG8gYXV0aG9yaXplIGFuIHVwZ3JhZGUsIGluCmAxLi49c2lnbmVycy5sZW4oKWAuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2VzcywgYEVycihFcnJvcjo6SW52YWxpZE11bHRpc2lnQ29uZmlnKWAgaWYgdGhlIHNpZ25lcgpzZXQgaXMgZW1wdHkgb3IgaG9sZHMgYSBkdXBsaWNhdGUsIG9yIHRoZSB0aHJlc2hvbGQgaXMgemVybyBvciBsYXJnZXIKdGhhbiB0aGUgc2V0LCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdCBoYXMgbm8KYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBhZG1pbiBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAAE3NldF9tdWx0aXNpZ19jb25maWcAAAAAAgAAAAAAAAAHc2lnbmVycwAAAAPqAAAAEwAAAAAAAAAJdGhyZXNob2xkAAAAAAAABAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAATlSZW1vdmVzIGFuIGFkZHJlc3MgZnJvbSB0aGUgYmxhY2tsaXN0LiBDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuCgojIFBhcmFtZXRlcnMKLSBgYWRkcmVzc2A6IEFkZHJlc3MgdG8gcmVtb3ZlIGZyb20gdGhlIGJsYWNrbGlzdC4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBDb21wbGlhbmNlT2ZmaWNlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAAE3VuYmxhY2tsaXN0X2FkZHJlc3MAAAAAAQAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAF1XaXRoZHJhd3MgdHJlYXN1cnkgcHJpbmNpcGFsIGZyb20gdGhlIGNvbmZpZ3VyZWQgbGVuZGluZyBwcm90b2NvbC4gVHJlYXN1cnlNYW5hZ2VyLXByb3RlY3RlZC4AAAAAAAATd2l0aGRyYXdfZnJvbV95aWVsZAAAAAACAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAMNDb25maWd1cmVzIHRoZSBEQU8gdG9rZW4gYW5kIG1pbmltdW0gdm90aW5nIHdlaWdodCBmb3IgZmVlIHByb3Bvc2Fscy4KVGhpcyBhZG1pbmlzdHJhdGl2ZSBib290c3RyYXAgZG9lcyBub3QgaXRzZWxmIGNoYW5nZSBmZWVzOyBzdWJzZXF1ZW50CmZlZSBjaGFuZ2VzIGNhbiBiZSBtYWRlIHRocm91Z2ggdGhlIHByb3Bvc2FsIGxpZmVjeWNsZS4AAAAAFGNvbmZpZ3VyZV9nb3Zlcm5hbmNlAAAAAgAAAAAAAAAQZ292ZXJuYW5jZV90b2tlbgAAABMAAAAAAAAABnF1b3J1bQAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAOtSZXR1cm5zIHRoZSBkZWFkIG1hbidzIHN3aXRjaCBjb25maWd1cmF0aW9uLgoKIyBSZXR1cm5zCmAoYmFja3VwX2FkbWluLCB0aW1lb3V0X3NlY29uZHMsIGxhc3RfaGVhcnRiZWF0LCBzZWNvbmRzX3NpbmNlX2hlYXJ0YmVhdClgLgpgYmFja3VwX2FkbWluYCBpcyBgTm9uZWAgYW5kIHRoZSB0aW1lc3RhbXBzIGAwYCB3aGVuIG5vIGJhY2t1cCBpcwpjb25maWd1cmVkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAABRnZXRfZGVhZF9tYW5zX3N3aXRjaAAAAAAAAAABAAAD7QAAAAQAAAPoAAAAEwAAAAYAAAAGAAAABg==",
        "AAAAAAAAAM1SZXR1cm5zIHRoZSBtYXhpbXVtIHRvbGVyYXRlZCBzd2FwIHNsaXBwYWdlIGluIGJhc2lzIHBvaW50cy4KCiMgUmV0dXJucwpUaGUgY29uZmlndXJlZCBgbWF4X3NsaXBwYWdlX2Jwc2AsIG9yIHRoZSAxIDAwMCBicHMgKDEwJSkgZGVmYXVsdCBpZgp0aGUgY29udHJhY3QgaGFzIG5vdCBiZWVuIGluaXRpYWxpemVkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAAAAAFGdldF9tYXhfc2xpcHBhZ2VfYnBzAAAAAAAAAAEAAAAL",
        "AAAAAAAAAoBTZXRzIHRoZSBtYXhpbXVtIHRvbGVyYXRlZCBzd2FwIHNsaXBwYWdlLiBBZG1pbi1vbmx5LgoKQXBwbGllZCBhZ2FpbnN0IHRoZSBgZXhwZWN0ZWRfYW1vdW50X291dGAgYSBjYWxsZXIgc3VwcGxpZXMgYWxvbmdzaWRlIGEKcXVvdGUsIGFzIGEgc2Vjb25kIGd1YXJkIG9uIHRvcCBvZiB0aGUgcGVyLXBheW1lbnQgYG1pbl9hbW91bnRfb3V0YApmbG9vci4KCiMgUGFyYW1ldGVycwotIGBtYXhfc2xpcHBhZ2VfYnBzYDogTmV3IGNlaWxpbmcgaW4gYmFzaXMgcG9pbnRzOyBgMGAgdG8gYDEwXzAwMGAuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2VzcywgYEVycihFcnJvcjo6SW52YWxpZFN3YXBQYXJhbXMpYCBpZiB0aGUgdmFsdWUgaXMKb3V0c2lkZSBgMC4uPTEwXzAwMGAsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0IGhhcwpubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IGFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4KCkRFUFJFQ0FURUQgZm9yIGRpcmVjdCB1c2UuICBRdWV1ZSB2aWEgYHF1ZXVlX2FjdGlvbihBY3Rpb25UeXBlOjpTZXRNYXhTbGlwcGFnZUJwcyjigKYpKWAKYW5kIGV4ZWN1dGUgYWZ0ZXIgMjQgaG91cnMuAAAAFHNldF9tYXhfc2xpcHBhZ2VfYnBzAAAAAQAAAAAAAAAQbWF4X3NsaXBwYWdlX2JwcwAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAd1FeGVjdXRlcyBhIGJhdGNoIG9mIHByZXZpb3VzbHkgcXVldWVkIHRpbWVsb2NrIGFjdGlvbnMgc2VxdWVudGlhbGx5IHdpdGhpbgphIHNpbmdsZSBhdG9taWMgaW52b2NhdGlvbi4KClJlcXVpcmVtZW50czoKLSBUaGUgY29udHJhY3QgbXVzdCBub3QgYmUgZnJvemVuLgotIENpcmN1aXQgYnJlYWtlciBtdXN0IGJlIGNsb3NlZC4KLSBUaGUgYWRtaW4gbXVzdCBhdXRob3JpemUuCi0gQWxsIG5vbmNlcyBpbiB0aGUgYmF0Y2ggbXVzdCBiZSB2ZXJpZmllZCByZWFkeSBhbmQgdmFsaWQgQkVGT1JFIGFueSBhY3Rpb24gaXMgZXhlY3V0ZWQuCi0gQWxsIGFjdGlvbnMgZXhlY3V0ZSBzZXF1ZW50aWFsbHkuIElmIGFueSBhY3Rpb24gZmFpbHMgZXhlY3V0aW9uLAp0aGUgZW50aXJlIGludm9jYXRpb24gcmV2ZXJ0cyBhdG9taWNhbGx5LgotIEVtaXRzIGBiYXRjaF9hY3Rpb25zX2V4ZWN1dGVkYCBldmVudCB3aXRoIHRoZSBsaXN0IG9mIG5vbmNlcy4AAAAAAAAVZXhlY3V0ZV9iYXRjaF9hY3Rpb25zAAAAAAAAAQAAAAAAAAAGbm9uY2VzAAAAAAPqAAAABgAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAUlSZXR1cm5zIHRoZSBlZmZlY3RpdmUgZmVlX2JwcyBmb3IgYSBzZW5kZXIgYWZ0ZXIgYXBwbHlpbmcgYW55CnZvbHVtZS1iYXNlZCB0aWVyZWQgZGlzY291bnQuCgojIFBhcmFtZXRlcnMKLSBgc2VuZGVyYDogQWRkcmVzcyB3aG9zZSBkaXNjb3VudGVkIGZlZSByYXRlIHRvIGNvbXB1dGUuCgojIFJldHVybnMKVGhlIGNvbmZpZ3VyZWQgYGZlZV9icHNgLCBoYWx2ZWQgaWYgYHNlbmRlcmAncyBsaWZldGltZSB2b2x1bWUKZXhjZWVkcyB0aGUgdGllcmVkLWRpc2NvdW50IHRocmVzaG9sZCwgb3IgYDBgIGlmIG5vdCBpbml0aWFsaXplZC4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAAAAABVnZXRfZWZmZWN0aXZlX2ZlZV9icHMAAAAAAAABAAAAAAAAAAZzZW5kZXIAAAAAABMAAAABAAAACw==",
        "AAAAAAAAAYxSZXR1cm5zIHRoZSBzaWduZXJzIHdob3NlIGFwcHJvdmFsIG9mIGFuIHVwZ3JhZGUgdG8gYG5ld193YXNtX2hhc2hgCmN1cnJlbnRseSBjb3VudHMuCgpBcHByb3ZhbHMgY2FzdCBieSBhIHNpZ25lciB0aGF0IGhhcyBzaW5jZSBiZWVuIHJvdGF0ZWQgb3V0IG9mIHRoZSBncm91cAphcmUgb21pdHRlZCwgc28gdGhpcyBsaXN0IGFsd2F5cyBhZ3JlZXMgd2l0aCBgaXNfdXBncmFkZV9hdXRob3JpemVkYC4KCiMgUmV0dXJucwpUaGUgY291bnRlZCBhcHByb3ZhbHMgaW4gdGhlIG9yZGVyIHRoZXkgd2VyZSByZWNvcmRlZCwgb3IgYW4gZW1wdHkKdmVjdG9yIGlmIHRoZSBoYXNoIGhhcyBub25lLiBFbXB0eSB3aGVuIG5vIGdyb3VwIGlzIGNvbmZpZ3VyZWQuCgojIFBhbmljcwpEb2VzIG5vdCBwYW5pYy4AAAAVZ2V0X3VwZ3JhZGVfYXBwcm92YWxzAAAAAAAAAQAAAAAAAAANbmV3X3dhc21faGFzaAAAAAAAA+4AAAAgAAAAAQAAA+oAAAAT",
        "AAAAAAAAAOZSZXR1cm5zIHdoZXRoZXIgYW4gdXBncmFkZSB0byBgbmV3X3dhc21faGFzaGAgaXMgYWxyZWFkeSBhdXRob3JpemVkLgoKIyBSZXR1cm5zCmB0cnVlYCBvbmNlIGBNYCBncm91cCBtZW1iZXJzIGhhdmUgYXBwcm92ZWQgdGhhdCBleGFjdCBoYXNoLgpgRXJyKEVycm9yOjpNdWx0aXNpZ05vdEluaXRpYWxpemVkKWAgaWYgbm8gZ3JvdXAgaXMgY29uZmlndXJlZC4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAAAAFWlzX3VwZ3JhZGVfYXV0aG9yaXplZAAAAAAAAAEAAAAAAAAADW5ld193YXNtX2hhc2gAAAAAAAPuAAAAIAAAAAEAAAPpAAAAAQAAAAM=",
        "AAAAAAAAAfJVcGRhdGVzIHRoZSBmZWUgYmFzaXMgcG9pbnRzIGFuZCBmZWUgY2FwLgpSZXF1aXJlcyBnb3Zlcm5hbmNlIGF1dGhvcml0eSBpZiBhIGdvdmVybmFuY2UgYWRkcmVzcyBpcyBzZXQ7IG90aGVyd2lzZSBhZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYGZlZV9icHNgOiBOZXcgcGxhdGZvcm0gZmVlIHJhdGUsIGluIGJhc2lzIHBvaW50cy4KLSBgZmVlX2NhcGA6IE5ldyBtYXhpbXVtIGZlZSB0YWtlbiBmcm9tIGEgc2luZ2xlIHBheW1lbnQuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGNhbGxlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuCgpERVBSRUNBVEVEIGZvciBkaXJlY3QgdXNlLiAgUXVldWUgdmlhIGBxdWV1ZV9hY3Rpb24oQWN0aW9uVHlwZTo6U2V0RmVlQ29uZmlnKOKApikpYC4AAAAAABVzZXRfZmVlX2NvbmZpZ19sZWdhY3kAAAAAAAACAAAAAAAAAAdmZWVfYnBzAAAAAAsAAAAAAAAAB2ZlZV9jYXAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAlFVcGRhdGVzIHRoZSB0cmVhc3VyeSBhZGRyZXNzIHRoYXQgcmVjZWl2ZXMgdGhlIHBsYXRmb3JtIGZlZS4KClVwZGF0ZXMgdGhlIHRyZWFzdXJ5IGFkZHJlc3MgdGhhdCByZWNlaXZlcyB0aGUgcGxhdGZvcm0gZmVlLiBQcm90ZWN0ZWQgYnkgVHJlYXN1cnlNYW5hZ2VyLgoKIyBQYXJhbWV0ZXJzCi0gYG5ld190cmVhc3VyeWA6IEFkZHJlc3MgdG8gcmVjZWl2ZSBwbGF0Zm9ybSBmZWVzIGdvaW5nIGZvcndhcmQuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgVHJlYXN1cnlNYW5hZ2VyIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4KCkRFUFJFQ0FURUQgZm9yIGRpcmVjdCB1c2UuICBRdWV1ZSB2aWEgYHF1ZXVlX2FjdGlvbihBY3Rpb25UeXBlOjpTZXRQbGF0Zm9ybVRyZWFzdXJ5KOKApikpYAphbmQgZXhlY3V0ZSBhZnRlciAyNCBob3Vycy4gIFRoaXMgZGlyZWN0IHBhdGggaXMgcmV0YWluZWQgZm9yIHRvb2xpbmcKY29tcGF0aWJpbGl0eSBvbmx5LgAAAAAAABVzZXRfcGxhdGZvcm1fdHJlYXN1cnkAAAAAAAABAAAAAAAAAAxuZXdfdHJlYXN1cnkAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAVBEZWxldGVzIG9uLWNoYWluIGxlZGdlciBlbnRyaWVzIGNvbW1pdHRlZCB2aWEgYGNvbW1pdF9hcmNoaXZlX3Jvb3RgLgoKUmVxdWlyZXMgdGhlIGVwb2NoIGZyb20gYSBwcmlvciBjb21taXQgY2FsbC4gU2lsZW50bHkgc2tpcHMgYWJzZW50CmVudHJpZXMuIFJldHVybnMgdGhlIGNvdW50IG9mIGVudHJpZXMgcmVtb3ZlZC4KClN1cHBvcnRlZDogVXNlclZvbHVtZSwgVXNlclNwZW5kaW5nLCBSZWZ1bmRCYWxhbmNlLgpFcnJvcnM6IE5vdEluaXRpYWxpemVkLCBDb250cmFjdEZyb3plbiwgVGltZWxvY2tOb3RGb3VuZCAodW5rbm93biBlcG9jaCkuClJlcXVpcmVzIFRyZWFzdXJ5TWFuYWdlci4AAAAWcHJ1bmVfYXJjaGl2ZWRfZW50cmllcwAAAAAAAgAAAAAAAAAPY29tbWl0dGVkX2Vwb2NoAAAAAAYAAAAAAAAABmxlYXZlcwAAAAAD6gAAB9AAAAALQXJjaGl2ZUxlYWYAAAAAAQAAA+kAAAAEAAAAAw==",
        "AAAAAAAAAnZXaXRoZHJhd3MgYSBzaWduZXIncyBwcmV2aW91c2x5IHJlY29yZGVkIGFwcHJvdmFsIG9mIGFuIHVwZ3JhZGUuCgpMZXRzIGEgc2lnbmVyIHB1bGwgaXRzIHNpZ25hdHVyZSBiYWNrIGJlZm9yZSB0aGUgdGhyZXNob2xkIGlzIHJlYWNoZWQsCndoaWNoIGlzIHRoZSB3YXkgYSBncm91cCBzdG9wcyBhbiB1cGdyYWRlIGl0IG5vIGxvbmdlciB3YW50cyB3aXRob3V0CmhhdmluZyB0byByb3RhdGUgdGhlIHdob2xlIHNpZ25lciBzZXQuIElkZW1wb3RlbnQ6IHdpdGhkcmF3aW5nIGFuCmFwcHJvdmFsIHRoYXQgd2FzIG5ldmVyIHJlY29yZGVkIGlzIGEgbm8tb3AuCgojIFBhcmFtZXRlcnMKLSBgc2lnbmVyYDogVGhlIGdyb3VwIG1lbWJlciB3aXRoZHJhd2luZyBpdHMgYXBwcm92YWw7IG11c3QgYXV0aG9yaXplCnRoaXMgY2FsbC4KLSBgbmV3X3dhc21faGFzaGA6IFRoZSBXQVNNIGhhc2ggdG8gd2l0aGRyYXcgdGhlIGFwcHJvdmFsIGZvci4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzIG9yIGBFcnIoRXJyb3I6Ok11bHRpc2lnTm90SW5pdGlhbGl6ZWQpYCBpZiBubyBncm91cAppcyBjb25maWd1cmVkLgoKIyBQYW5pY3MKUGFuaWNzIGlmIGBzaWduZXJgIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAAABdyZXZva2VfdXBncmFkZV9hcHByb3ZhbAAAAAACAAAAAAAAAAZzaWduZXIAAAAAABMAAAAAAAAADW5ld193YXNtX2hhc2gAAAAAAAPuAAAAIAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAA89Sb3V0ZXMgYSBwYXltZW50IGluIGFueSB0b2tlbiwgc3dhcHBpbmcgaXQgaW50byB0aGUgcmVjaXBpZW50J3MKcHJlZmVycmVkIHRva2VuIG9uIHRoZSB3YXkuCgpUaGUgc3dhcC1yb3V0ZWQgY291bnRlcnBhcnQgb2YgW2BQYXltZW50Um91dGVyOjpyb3V0ZV9wYXltZW50YF06IHRoZSBzYW1lCmZlZSwgbGltaXQsIGJsYWNrbGlzdCwgYW5kIGZyZWV6ZSBydWxlcyBhcHBseSwgd2l0aCB0aGUgY29udmVyc2lvbgppbnNlcnRlZCBiZXR3ZWVuIHB1bGxpbmcgdGhlIGZ1bmRzIGFuZCBkZWxpdmVyaW5nIHRoZW0uIFRoZSBwbGF0Zm9ybSBmZWUKaXMgdGFrZW4gb24gdGhlIGBidXlfdG9rZW5gIG91dHB1dCwgc28gYGZlZV9jYXBgIGFwcGxpZXMgaW4gYGJ1eV90b2tlbmAKdW5pdHMgZm9yIHRoaXMgcm91dGUuCgojIFBhcmFtZXRlcnMKLSBgcGF5bWVudGA6IFRoZSBzd2FwLXJvdXRlZCB0cmFuc2ZlciAoc2VlIFtgU3dhcFBheW1lbnRgXSkuCgojIFJldHVybnMKVGhlIGFtb3VudCBvZiBgYnV5X3Rva2VuYCBkZWxpdmVyZWQgdG8gdGhlIHJlY2lwaWVudCwgYWZ0ZXIgdGhlCnBsYXRmb3JtIGZlZS4gT3RoZXJ3aXNlIHRoZSBwYXltZW50IGlzIGFiYW5kb25lZCB3aG9sZSwgd2l0aDoKLSBgRXJyKEVycm9yOjpJbnZhbGlkU3dhcFBhcmFtcylgLCBgRXJyKEVycm9yOjpTd2FwRGVhZGxpbmVFeHBpcmVkKWAsCmBFcnIoRXJyb3I6OkRleE5vdFJlZ2lzdGVyZWQpYCwgYEVycihFcnJvcjo6U3dhcEZhaWxlZClgLCBvcgpgRXJyKEVycm9yOjpTbGlwcGFnZUV4Y2VlZGVkKWAgZm9yIHN3YXAtc3BlY2lmaWMgcHJvYmxlbXMsCi0gdGhlIHNhbWUgYEVycmAgdmFyaWFudHMgYXMgYHJvdXRlX3BheW1lbnRgIG90aGVyd2lzZS4KCiMgUGFuaWNzClBhbmljcyBpZiBgcGF5bWVudC5zZW5kZXJgIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYgYSB0b2tlbgp0cmFuc2ZlciBvdXQgb2YgdGhpcyBjb250cmFjdCBmYWlscy4AAAAAF3JvdXRlX3BheW1lbnRfd2l0aF9zd2FwAAAAAAEAAAAAAAAAB3BheW1lbnQAAAAH0AAAAAtTd2FwUGF5bWVudAAAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAjJTZXRzIHRoZSBtYXhpbXVtIGFnZSAoaW4gc2Vjb25kcykgYSBwcmljZSByZWFkaW5nIG1heSBoYXZlIGJlZm9yZSBpdCBpcwpjb25zaWRlcmVkIHN0YWxlLiBDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuCgpXaGVuIGEgcHJpY2UgdGltZXN0YW1wIGlzIG9sZGVyIHRoYW4gYChjdXJyZW50X2xlZGdlcl90aW1lIC0gdGhyZXNob2xkKWAKdGhlIHJlYWRpbmcgaXMgcmVqZWN0ZWQgd2l0aCBbYEVycm9yOjpPcmFjbGVQcmljZVN0YWxlYF0gYW5kIHRoZQpmYWxsYmFjayBwcmljZSAoaWYgY29uZmlndXJlZCkgaXMgdXNlZCBpbnN0ZWFkLgoKIyBQYXJhbWV0ZXJzCi0gYHRocmVzaG9sZF9zZWNzYDogTWF4aW11bSBhbGxvd2VkIGFnZSBpbiBzZWNvbmRzLiBBIHZhbHVlIG9mIGAwYApkaXNhYmxlcyB0aGUgc3RhbGVuZXNzIGNoZWNrIGVudGlyZWx5IChldmVyeSBwcmljZSBpcyBhY2NlcHRlZCkuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcy4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBDb21wbGlhbmNlT2ZmaWNlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAXc2V0X3N0YWxlbmVzc190aHJlc2hvbGQAAAAAAQAAAAAAAAAOdGhyZXNob2xkX3NlY3MAAAAAAAYAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAXFSZXR1cm5zIGhvdyBtYW55IG1vcmUgcGF5bWVudCBpbnZvY2F0aW9ucyBgc2VuZGVyYCBjYW4gbWFrZSBpbiB0aGUKY3VycmVudCBsZWRnZXIgdW5kZXIgdGhlIGFjdGl2ZSBjYXAuCgojIFBhcmFtZXRlcnMKLSBgc2VuZGVyYDogQWRkcmVzcyB3aG9zZSByZW1haW5pbmcgYWxsb3dhbmNlIHRvIGNvbXB1dGUuCgojIFJldHVybnMKUmVtYWluaW5nIGludm9jYXRpb25zIGluIHRoZSBjdXJyZW50IGxlZGdlciB3aW5kb3csIHNhdHVyYXRpbmcgYXQgMApvbmNlIHRoZSBjYXAgaXMgcmVhY2hlZC4gV2hpdGVsaXN0ZWQgc2VuZGVycyAoYW5kIGEgZGlzYWJsZWQgbGltaXRlcikKcmVwb3J0IGB1MzI6Ok1BWGAuCgojIFBhbmljcwpEb2VzIG5vdCBwYW5pYy4AAAAAAAAYZ2V0X3JhdGVfbGltaXRfcmVtYWluaW5nAAAAAQAAAAAAAAAGc2VuZGVyAAAAAAATAAAAAQAAAAQ=",
        "AAAAAAAAAmRSb3V0ZXMgc2V2ZXJhbCBzd2FwLXJvdXRlZCBwYXltZW50cyBpbiBhIHNpbmdsZSB0cmFuc2FjdGlvbi4gSWYgYW55CnBheW1lbnQgZmFpbHMsIHRoZSBlbnRpcmUgYmF0Y2ggaXMgcmV2ZXJ0ZWQgYXRvbWljYWxseSwgaW5jbHVkaW5nIGFueQpzd2FwcyB0aGF0IGFscmVhZHkgZXhlY3V0ZWQgZWFybGllciBpbiB0aGUgYmF0Y2guCgojIFBhcmFtZXRlcnMKLSBgcGF5bWVudHNgOiBCYXRjaCBvZiBzd2FwLXJvdXRlZCB0cmFuc2ZlcnMgdG8gYXBwbHkgaW4gb3JkZXIuIFNlZQpbYFN3YXBQYXltZW50YF0gZm9yIHBlci1pdGVtIGNvbnN0cmFpbnRzLgoKIyBSZXR1cm5zClRoZSB0b3RhbCBhbW91bnQgb2YgYGJ1eV90b2tlbmAgZGVsaXZlcmVkIGFjcm9zcyB0aGUgYmF0Y2gsIG9yIHRoZQpmaXJzdCBlcnJvciBlbmNvdW50ZXJlZCAoc2VlIGByb3V0ZV9wYXltZW50X3dpdGhfc3dhcGAgZm9yIHRoZQpwb3NzaWJsZSB2YXJpYW50cyBhbmQgdGhlaXIgY2F1c2VzKS4KCiMgUGFuaWNzClBhbmljcyBpZiBhbnkgcGF5bWVudCdzIGBzZW5kZXJgIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYgYQp0b2tlbiB0cmFuc2ZlciBvdXQgb2YgdGhpcyBjb250cmFjdCBmYWlscy4AAAAYcm91dGVfcGF5bWVudHNfd2l0aF9zd2FwAAAAAQAAAAAAAAAIcGF5bWVudHMAAAPqAAAH0AAAAAtTd2FwUGF5bWVudAAAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAXJXaGl0ZWxpc3RzIGFuIGFkZHJlc3MsIGV4ZW1wdGluZyBpdCBmcm9tIHRoZSBwZXItbGVkZ2VyIGludm9jYXRpb24gY2FwCnNvIGxlZ2l0aW1hdGUgaGlnaC12b2x1bWUgc2VuZGVycyBhcmUgbmV2ZXIgdGhyb3R0bGVkLiBBZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYGFkZHJlc3NgOiBTZW5kZXIgdG8gZXhlbXB0IGZyb20gcmF0ZSBsaW1pdGluZy4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBhZG1pbiBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAYc2V0X3JhdGVfbGltaXRfd2hpdGVsaXN0AAAAAQAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAI1SZXR1cm5zIHRoZSBjb25maWd1cmVkIGNhcCBmb3IgYCh0b2tlbl9pbiwgdG9rZW5fb3V0KWAsIG9yIHRoZSBnbG9iYWwKY2FwIHdoZW4gbm8gcGFpciBvdmVycmlkZSBleGlzdHMuIEludmFsaWQgc3RvcmVkIG92ZXJyaWRlcyBmYWlsIGNsb3NlZC4AAAAAAAAZZ2V0X3BhaXJfbWF4X3NsaXBwYWdlX2JwcwAAAAAAAAIAAAAAAAAACHRva2VuX2luAAAAEwAAAAAAAAAJdG9rZW5fb3V0AAAAAAAAEwAAAAEAAAPpAAAACwAAAAM=",
        "AAAAAAAAAMNSZXR1cm5zIHdoZXRoZXIgYW4gYWRkcmVzcyBpcyBleGVtcHQgZnJvbSB0aGUgcmF0ZSBsaW1pdGVyLgoKIyBQYXJhbWV0ZXJzCi0gYGFkZHJlc3NgOiBBZGRyZXNzIHRvIGNoZWNrLgoKIyBSZXR1cm5zCmB0cnVlYCBpZiB0aGUgYWRkcmVzcyBpcyBvbiB0aGUgcmF0ZS1saW1pdCB3aGl0ZWxpc3QuCgojIFBhbmljcwpEb2VzIG5vdCBwYW5pYy4AAAAAGWlzX3JhdGVfbGltaXRfd2hpdGVsaXN0ZWQAAAAAAAABAAAAAAAAAAdhZGRyZXNzAAAAABMAAAABAAAAAQ==",
        "AAAAAAAAAgtBcm1zIHRoZSBkZWFkIG1hbidzIHN3aXRjaCBkaXJlY3RseSAoYnlwYXNzaW5nIHRoZSB0aW1lbG9jaykuCgojIFBhcmFtZXRlcnMKLSBgYmFja3VwYDogQWRkcmVzcyBhbGxvd2VkIHRvIGNsYWltIGFkbWluIHJpZ2h0cyBhZnRlciB0aGUgdGltZW91dC4KLSBgdGltZW91dF9zZWNvbmRzYDogSW5hY3Rpdml0eSB3aW5kb3cgaW4gc2Vjb25kcy4gTXVzdCBiZSBhdCBsZWFzdApgTUlOX0RNU19USU1FT1VUYCAoNyBkYXlzKS4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldCwgb3IgYEVycihFcnJvcjo6SW52YWxpZERtc0NvbmZpZylgIGlmCmB0aW1lb3V0X3NlY29uZHNgIGlzIGJlbG93IHRoZSBtaW5pbXVtIG9yIGBiYWNrdXBgIGVxdWFscyB0aGUKY3VycmVudCBhZG1pbi4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBhZG1pbiBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAABlzZXRfYmFja3VwX2FkbWluX2ludGVybmFsAAAAAAAAAgAAAAAAAAAGYmFja3VwAAAAAAATAAAAAAAAAA90aW1lb3V0X3NlY29uZHMAAAAABgAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAHVTZXRzIGEgcGFpci1zcGVjaWZpYyBzbGlwcGFnZSBjYXAuIFByZWZlciB0aGUgdGltZWxvY2tlZApgU2V0UGFpck1heFNsaXBwYWdlQnBzYCBhY3Rpb24gZm9yIHByb2R1Y3Rpb24gY29uZmlndXJhdGlvbi4AAAAAAAAZc2V0X3BhaXJfbWF4X3NsaXBwYWdlX2JwcwAAAAAAAAMAAAAAAAAACHRva2VuX2luAAAAEwAAAAAAAAAJdG9rZW5fb3V0AAAAAAAAEwAAAAAAAAAQbWF4X3NsaXBwYWdlX2JwcwAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAMFSZXR1cm5zIGB0cnVlYCBpZiB0aGUgZGVhZCBtYW4ncyBzd2l0Y2ggaXMgYXJtZWQgKGEgYmFja3VwIGFkbWluIGlzCmNvbmZpZ3VyZWQpIGFuZCB0aGUgdGltZW91dCBoYXMgZWxhcHNlZCwgaS5lLiBgY2xhaW1fYWRtaW5gIHdvdWxkCmN1cnJlbnRseSBzdWNjZWVkIGZvciB0aGUgYmFja3VwLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAAAAAG2lzX2RlYWRfbWFuc19zd2l0Y2hfZXhwaXJlZAAAAAAAAAAAAQAAAAE=",
        "AAAAAAAAAVRSZW1vdmVzIGFuIGFkZHJlc3MgZnJvbSB0aGUgcmF0ZS1saW1pdCB3aGl0ZWxpc3QsIHJlc3RvcmluZyB0aGUKc3RhbmRhcmQgcGVyLWxlZGdlciBjYXAgZm9yIGl0LiBBZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYGFkZHJlc3NgOiBTZW5kZXIgdG8gcmVtb3ZlIGZyb20gdGhlIHdoaXRlbGlzdC4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBhZG1pbiBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAG3JlbW92ZV9yYXRlX2xpbWl0X3doaXRlbGlzdAAAAAABAAAAAAAAAAdhZGRyZXNzAAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAZlTd2FwcyBgdG9rZW5faW5gIHRocm91Z2ggYSBjYWxsZXItc3VwcGxpZWQgREVYIHBhdGggYW5kIHJvdXRlcyB0aGUKcmVzdWx0aW5nIGB0b2tlbl9vdXRgIHRvIHRoZSByZWNpcGllbnQuIFRoZSBERVggYWRhcHRlciBtdXN0IHJldHVybiB0aGUKcmVjZWl2ZWQgb3V0cHV0IGFuZCBhbnkgdW51c2VkIGlucHV0IGFzIGBbcmVjZWl2ZWQsIHVudXNlZF1gOyB1bnVzZWQKaW5wdXQgaXMgY3JlZGl0ZWQgdG8gdGhlIHNlbmRlcidzIHJlZnVuZCBiYWxhbmNlLgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBERVggcm91dGVyIHJldHVybnMgYSBzd2FwIHJlc3VsdCB3aXRoIGZld2VyIHRoYW4gMiBlbGVtZW50cywKb3IgaWYgYHN3YXBfcmVzdWx0LmdldCgwKWAgb3IgYHN3YXBfcmVzdWx0LmdldCgxKWAgcmV0dXJucyBgTm9uZWAuAAAAAAAAG3JvdXRlX3BheW1lbnRfd2l0aF9zd2FwX3JhdwAAAAAIAAAAAAAAAAZzZW5kZXIAAAAAABMAAAAAAAAACXJlY2lwaWVudAAAAAAAABMAAAAAAAAACmRleF9yb3V0ZXIAAAAAABMAAAAAAAAACHRva2VuX2luAAAAEwAAAAAAAAAJdG9rZW5fb3V0AAAAAAAAEwAAAAAAAAAJYW1vdW50X2luAAAAAAAACwAAAAAAAAAEcGF0aAAAA+oAAAATAAAAAAAAAA5taW5fYW1vdW50X291dAAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAQAAAE1BIHNpbmdsZSB0cmFuc2ZlciBpbnN0cnVjdGlvbiBmb3IgdXNlIHdpdGggW2BQYXltZW50Um91dGVyOjpyb3V0ZV9wYXltZW50c2BdLgAAAAAAAAAAAAAHUGF5bWVudAAAAAAEAAAAgEFtb3VudCB0byByb3V0ZSwgZGVub21pbmF0ZWQgaW4gdGhlIHRva2VuJ3Mgc21hbGxlc3QgdW5pdC4gTXVzdCBiZQpwb3NpdGl2ZSBhbmQgd2l0aGluIHRoZSBjb250cmFjdCdzIGNvbmZpZ3VyZWQgbWluL21heCBib3VuZHMuAAAABmFtb3VudAAAAAAACwAAADtBZGRyZXNzIHRoZSBmdW5kcyAobWludXMgdGhlIHBsYXRmb3JtIGZlZSkgYXJlIGNyZWRpdGVkIHRvLgAAAAAJcmVjaXBpZW50AAAAAAAAEwAAADxBZGRyZXNzIHRoZSBmdW5kcyBhcmUgZGViaXRlZCBmcm9tLiBNdXN0IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAGc2VuZGVyAAAAAAATAAAAR0NvbnRyYWN0IElEIG9mIHRoZSB0b2tlbiAob3IgU3RlbGxhciBBc3NldCBDb250cmFjdCkgYmVpbmcgdHJhbnNmZXJyZWQuAAAAAA10b2tlbl9hZGRyZXNzAAAAAAAAEw==",
        "AAAAAQAAACxBIHNpbmdsZSBwcmljZSBxdW90ZSByZXR1cm5lZCBieSB0aGUgb3JhY2xlLgAAAAAAAAAJUHJpY2VEYXRhAAAAAAAAAwAAAClOdW1iZXIgb2YgZGVjaW1hbCBwbGFjZXMgdXNlZCBpbiBgcHJpY2VgLgAAAAAAAAhkZWNpbWFscwAAAAQAAABBRml4ZWQtcG9pbnQgcHJpY2UgdmFsdWUuIFRoZSB0cnVlIHByaWNlIGlzIGBwcmljZSAvIDEwXmRlY2ltYWxzYC4AAAAAAAAFcHJpY2UAAAAAAAALAAAAQ1VuaXggdGltZXN0YW1wIChzZWNvbmRzKSB3aGVuIHRoaXMgcHJpY2Ugd2FzIGxhc3QgdXBkYXRlZCBvbi1jaGFpbi4AAAAACXRpbWVzdGFtcAAAAAAAAAY=",
        "AAAAAQAAAEVUaGUgcmVzdWx0IG9mIGEgREVYIHF1b3RlLCByZXR1cm5lZCBieSBbYFBheW1lbnRSb3V0ZXI6OnF1b3RlX3N3YXBgXS4AAAAAAAAAAAAACVN3YXBRdW90ZQAAAAAAAAMAAABGQW1vdW50IG9mIGBidXlfdG9rZW5gIHRoZSBERVggZXhwZWN0cyB0byBkZWxpdmVyIGZvciB0aGUgcXVvdGVkIGlucHV0LgAAAAAACmFtb3VudF9vdXQAAAAAAAsAAABNQ29uZmlndXJlZCBtYXhpbXVtIHNsaXBwYWdlLCBpbiBiYXNpcyBwb2ludHMsIHRoYXQgcHJvZHVjZWQKYG1pbl9hbW91bnRfb3V0YC4AAAAAAAAQbWF4X3NsaXBwYWdlX2JwcwAAAAsAAABfVGlnaHRlc3QgYG1pbl9hbW91bnRfb3V0YCB0aGF0IHN0aWxsIHJlc3BlY3RzIHRoZSBjb250cmFjdCdzCmBtYXhfc2xpcHBhZ2VfYnBzYCBmb3IgdGhpcyBxdW90ZS4AAAAADm1pbl9hbW91bnRfb3V0AAAAAAAL",
        "AAAAAgAAAK5EZXNjcmliZXMgd2hpY2ggYWRtaW5pc3RyYXRpdmUgcGFyYW1ldGVyIGNoYW5nZSBhIHRpbWVsb2NrIGVudHJ5IHJlcHJlc2VudHMuCkVhY2ggdmFyaWFudCBjYXJyaWVzIGFsbCB0aGUgYXJndW1lbnRzIG5lZWRlZCB0byBhcHBseSB0aGF0IGNoYW5nZSB3aGVuIHRoZQpkZWxheSBwZXJpb2QgaXMgb3Zlci4AAAAAAAAAAAAKQWN0aW9uVHlwZQAAAAAADQAAAAEAAAAlQ2hhbmdlIHRoZSBwbGF0Zm9ybSB0cmVhc3VyeSBhZGRyZXNzLgAAAAAAABNTZXRQbGF0Zm9ybVRyZWFzdXJ5AAAAAAEAAAATAAAAAQAAAEhVcGRhdGUgZmVlIGJhc2lzLXBvaW50cyBhbmQgZmVlIGNhcCB0b2dldGhlciAobGVnYWN5IC8gY29tYmluZWQgc2V0dGVyKS4AAAAMU2V0RmVlQ29uZmlnAAAAAgAAAAsAAAALAAAAAQAAAB1VcGRhdGUgZmVlIGJhc2lzLXBvaW50cyBvbmx5LgAAAAAAAAlTZXRGZWVCcHMAAAAAAAABAAAACwAAAAEAAAAkU2V0IHRoZSBnb3Zlcm5hbmNlIGNvbnRyYWN0IGFkZHJlc3MuAAAADVNldEdvdmVybmFuY2UAAAAAAAABAAAAEwAAAAEAAAAhQ2hhbmdlIHRoZSBtaW5pbXVtIHJvdXRpbmcgbGltaXQuAAAAAAAAC1NldE1pbkxpbWl0AAAAAAEAAAALAAAAAQAAACdUcmFuc2ZlciBhZG1pbiByaWdodHMgdG8gYSBuZXcgYWRkcmVzcy4AAAAADVRyYW5zZmVyQWRtaW4AAAAAAAABAAAAEwAAAAEAAAAaVXBncmFkZSB0aGUgY29udHJhY3QgV0FTTS4AAAAAAAdVcGdyYWRlAAAAAAEAAAPuAAAAIAAAAAEAAABUQXJtIHRoZSBkZWFkIG1hbidzIHN3aXRjaDogbm9taW5hdGUgYSBiYWNrdXAgYWRtaW4gYW5kIGl0cyBjbGFpbQp0aW1lb3V0IGluIHNlY29uZHMuAAAADlNldEJhY2t1cEFkbWluAAAAAAACAAAAEwAAAAYAAAABAAAAM0FsbG93IHN3YXAgcm91dGluZyB0byBpbnZva2UgYSBERVggcm91dGVyIGNvbnRyYWN0LgAAAAALUmVnaXN0ZXJEZXgAAAAAAQAAABMAAAABAAAANlN0b3Agc3dhcCByb3V0aW5nIGZyb20gaW52b2tpbmcgYSBERVggcm91dGVyIGNvbnRyYWN0LgAAAAAADURlcmVnaXN0ZXJEZXgAAAAAAAABAAAAEwAAAAEAAAArVXBkYXRlIHRoZSBtYXhpbXVtIHRvbGVyYXRlZCBzd2FwIHNsaXBwYWdlLgAAAAARU2V0TWF4U2xpcHBhZ2VCcHMAAAAAAAABAAAACwAAAAEAAAA5VXBkYXRlIHRoZSBtYXhpbXVtIHRvbGVyYXRlZCBzbGlwcGFnZSBmb3Igb25lIHRva2VuIHBhaXIuAAAAAAAAFVNldFBhaXJNYXhTbGlwcGFnZUJwcwAAAAAAAAMAAAATAAAAEwAAAAsAAAABAAAAQENvbmZpZ3VyZSB0aGUgbXVsdGktc2lnbmF0dXJlIGFkbWluIGdyb3VwIGZvciBjb250cmFjdCB1cGdyYWRlcy4AAAARU2V0TXVsdGlzaWdDb25maWcAAAAAAAACAAAD6gAAABMAAAAE",
        "AAAAAQAAAOdBIHVzZXIncyBjb21iaW5lZCByb3V0aW5nIHN0YXRzLCB1bnBhY2tlZCBmcm9tIHRoZSBwYWNrZWQgYEJ5dGVzTjw0MD5gCmBVc2VyUmVjb3JkYCBsZWRnZXIgdmFsdWUgKGlzc3VlICM2NjMpLgoKUmV0dXJuZWQgYnkgW2BQYXltZW50Um91dGVyOjpnZXRfdXNlcl9yZWNvcmRgXSBzbyBhIGNsaWVudCBjYW4gcmVhZCBib3RoCmNvdW50ZXJzIGluIGEgc2luZ2xlIHZpZXcgY2FsbCBpbnN0ZWFkIG9mIHR3by4AAAAAAAAAAApVc2VyUmVjb3JkAAAAAAADAAAAPlRvdGFsIGFtb3VudCByb3V0ZWQgYnkgdGhlIHVzZXIgaW4gdGhlIGN1cnJlbnQgMjQtaG91ciB3aW5kb3cuAAAAAAASYWNjdW11bGF0ZWRfYW1vdW50AAAAAAALAAAAQFVuaXggdGltZXN0YW1wIChzZWNvbmRzKSBhdCB3aGljaCB0aGUgMjQtaG91ciB3aW5kb3cgbGFzdCByZXNldC4AAAAPbGFzdF9yZXNldF90aW1lAAAAAAYAAAAuQ3VtdWxhdGl2ZSBsaWZldGltZSBhbW91bnQgcm91dGVkIGJ5IHRoZSB1c2VyLgAAAAAABnZvbHVtZQAAAAAACw==",
        "AAAAAQAAADxBIGZlZSBjaGFuZ2UgcHJvcG9zYWwgd2VpZ2h0ZWQgYnkgZ292ZXJuYW5jZS10b2tlbiBiYWxhbmNlcy4AAAAAAAAAC0ZlZVByb3Bvc2FsAAAAAAkAAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAYAAAAAAAAACGV4ZWN1dGVkAAAAAQAAAAAAAAAHZmVlX2JwcwAAAAALAAAAAAAAAAdmZWVfY2FwAAAAAAsAAAAAAAAACG5vX3ZvdGVzAAAACwAAAAAAAAAIcHJvcG9zZXIAAAATAAAAAAAAAAZxdW9ydW0AAAAAAAsAAAAAAAAADnZvdGluZ19lbmRzX2F0AAAAAAAGAAAAAAAAAAl5ZXNfdm90ZXMAAAAAAAAL",
        "AAAAAQAAAClTdHJ1Y3R1cmVkIHBheWxvYWQgZm9yIG1ldGEtdHJhbnNhY3Rpb25zLgAAAAAAAAAAAAALTWV0YVBheW1lbnQAAAAABgAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAhkZWFkbGluZQAAAAYAAAAAAAAABW5vbmNlAAAAAAAABgAAAAAAAAAJcmVjaXBpZW50AAAAAAAAEwAAAAAAAAAGc2VuZGVyAAAAAAATAAAAAAAAAA10b2tlbl9hZGRyZXNzAAAAAAAAEw==",
        "AAAAAQAAAJJBIHNpbmdsZSBzd2FwLXJvdXRlZCB0cmFuc2ZlciBpbnN0cnVjdGlvbiBmb3IgdXNlIHdpdGgKW2BQYXltZW50Um91dGVyOjpyb3V0ZV9wYXltZW50X3dpdGhfc3dhcGBdIGFuZApbYFBheW1lbnRSb3V0ZXI6OnJvdXRlX3BheW1lbnRzX3dpdGhfc3dhcGBdLgAAAAAAAAAAAAtTd2FwUGF5bWVudAAAAAAJAAAAOEFtb3VudCBvZiBgc2VsbF90b2tlbmAgdG8gcHVsbCBmcm9tIHRoZSBzZW5kZXIgYW5kIHN3YXAuAAAACWFtb3VudF9pbgAAAAAAAAsAAAA+VG9rZW4gdGhlIHJlY2lwaWVudCBpcyBwYWlkIGluLiBNdXN0IGRpZmZlciBmcm9tIGBzZWxsX3Rva2VuYC4AAAAAAAlidXlfdG9rZW4AAAAAAAATAAAAeVVuaXggdGltZXN0YW1wIChzZWNvbmRzKSBhZnRlciB3aGljaCB0aGUgc3dhcCBtdXN0IG5vdCBleGVjdXRlLiBgMGAKZGlzYWJsZXMgdGhlIGRlYWRsaW5lLCBsZXR0aW5nIHRoZSBERVggYXBwbHkgaXRzIG93bi4AAAAAAAAIZGVhZGxpbmUAAAAGAAAAh0NvbnRyYWN0IElEIG9mIHRoZSBERVggYWRhcHRlciB0byBpbnZva2UuIE11c3QgYmUgcmVnaXN0ZXJlZCBieSB0aGUKYWRtaW4sIHdoaWNoIGtlZXBzIHRoZSBjcm9zcy1jb250cmFjdCBjYWxsIHBvaW50ZWQgYXQgYXVkaXRlZCBjb2RlLgAAAAADZGV4AAAAABMAAADKQW1vdW50IG9mIGBidXlfdG9rZW5gIHRoZSBjYWxsZXIgZXhwZWN0ZWQgZnJvbSBhIHByaW9yIGBxdW90ZV9zd2FwYApjYWxsLiBgMGAgZGlzYWJsZXMgdGhlIGNlaWxpbmcgY2hlY2s7IG90aGVyd2lzZSB0aGUgcmVhbGlzZWQgb3V0cHV0Cm11c3Qgc3RheSB3aXRoaW4gdGhlIGNvbnRyYWN0J3MgYG1heF9zbGlwcGFnZV9icHNgIG9mIHRoaXMgZmlndXJlLgAAAAAAE2V4cGVjdGVkX2Ftb3VudF9vdXQAAAAACwAAAIRNaW5pbXVtIGFtb3VudCBvZiBgYnV5X3Rva2VuYCB0aGUgc3dhcCBtdXN0IGRlbGl2ZXIuIFRoaXMgaXMgdGhlCnNsaXBwYWdlIGZsb29yOiBpZiB0aGUgREVYIHJldHVybnMgbGVzcywgdGhlIHdob2xlIHBheW1lbnQgcmV2ZXJ0cy4AAAAObWluX2Ftb3VudF9vdXQAAAAAAAsAAABDQWRkcmVzcyB0aGUgc3dhcHBlZCBmdW5kcyAobWludXMgdGhlIHBsYXRmb3JtIGZlZSkgYXJlIGNyZWRpdGVkIHRvLgAAAAAJcmVjaXBpZW50AAAAAAAAEwAAADpUb2tlbiB0aGUgc2VuZGVyIHBheXMgd2l0aCwgaW4gdGhhdCB0b2tlbidzIHNtYWxsZXN0IHVuaXQuAAAAAAAKc2VsbF90b2tlbgAAAAAAEwAAADxBZGRyZXNzIHRoZSBmdW5kcyBhcmUgZGViaXRlZCBmcm9tLiBNdXN0IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAGc2VuZGVyAAAAAAAT",
        "AAAAAQAAAQdBIHVzZXIncyByb2xsaW5nIDI0LWhvdXIgc3BlbmRpbmcgcmVjb3JkLgoKUmV0YWluZWQgcHVyZWx5IHNvIGV4aXN0aW5nIHRlc3Qgc25hcHNob3RzIHRoYXQgcmVmZXJlbmNlIHRoaXMgdHlwZSBieQpuYW1lIGtlZXAgY29tcGlsaW5nLiBQcmUtIzY2MyBsaXZlIGNvbnRyYWN0IHN0YXRlIHdhcyBzdG9yZWQgYXMgYSBwYWNrZWQKYEJ5dGVzTjwyND5gOyB0aGlzIHN0cnVjdCBpcyBub3QgcmVhZCBmcm9tIG9yIHdyaXR0ZW4gdG8gc3RvcmFnZSBhdCBydW50aW1lLgAAAAAAAAAADFVzZXJTcGVuZGluZwAAAAIAAAA4VG90YWwgYW1vdW50IHJvdXRlZCBieSB0aGUgdXNlciBzaW5jZSBgbGFzdF9yZXNldF90aW1lYC4AAAASYWNjdW11bGF0ZWRfYW1vdW50AAAAAAALAAAAQFVuaXggdGltZXN0YW1wIChzZWNvbmRzKSBhdCB3aGljaCB0aGUgMjQtaG91ciB3aW5kb3cgbGFzdCByZXNldC4AAAAPbGFzdF9yZXNldF90aW1lAAAAAAY=",
        "AAAAAQAAAD1BIHBlbmRpbmcgdGltZWxvY2sgZW50cnkgc3RvcmVkIGluIHBlcnNpc3RlbnQgbGVkZ2VyIHN0b3JhZ2UuAAAAAAAAAAAAAA1UaW1lbG9ja0VudHJ5AAAAAAAAAgAAADdUaGUgYWN0aW9uIHBheWxvYWQgdG8gYXBwbHkgb25jZSB0aGUgZGVsYXkgaGFzIGVsYXBzZWQuAAAAAAZhY3Rpb24AAAAAB9AAAAAKQWN0aW9uVHlwZQAAAAAAQ0xlZGdlciB0aW1lc3RhbXAgKHNlY29uZHMgc2luY2UgZXBvY2gpIHdoZW4gdGhpcyBhY3Rpb24gd2FzIHF1ZXVlZC4AAAAACXF1ZXVlZF9hdAAAAAAAAAY=",
        "AAAAAQAAADRNdWx0aS1zaWduYXR1cmUgY29uZmlndXJhdGlvbiBmb3IgY29udHJhY3QgdXBncmFkZXMuAAAAAAAAAA5NdWx0aXNpZ0NvbmZpZwAAAAAAAgAAAB9UaGUgbGlzdCBvZiBhdXRob3JpemVkIHNpZ25lcnMuAAAAAAdzaWduZXJzAAAAA+oAAAATAAAAPVRoZSBtaW5pbXVtIG51bWJlciBvZiBzaWduZXJzIHJlcXVpcmVkIHRvIGFwcHJvdmUgYW4gdXBncmFkZS4AAAAAAAAJdGhyZXNob2xkAAAAAAAABA==",
        "AAAABAAAAIpDb250cmFjdC1sZXZlbCBlcnJvcnMgcmV0dXJuZWQgaW5zdGVhZCBvZiBwYW5pY2tpbmcsIHNvIGNhbGxlcnMgZ2V0IGEKc3BlY2lmaWMsIHN0YWJsZSBlcnJvciBjb2RlIHRvIGJyYW5jaCBvbiByYXRoZXIgdGhhbiBhbiBvcGFxdWUgdHJhcC4AAAAAAAAAAAAFRXJyb3IAAAAAAAAxAAAARUNhbGxlciBpcyBub3QgYXV0aG9yaXplZCB0byBwZXJmb3JtIHRoaXMgYWN0aW9uIChlLmcuIG5vdCB0aGUgYWRtaW4pLgAAAAAAAAxVbmF1dGhvcml6ZWQAAAABAAAAQlNlbmRlcidzIHRva2VuIGJhbGFuY2UgaXMgbG93ZXIgdGhhbiB0aGUgcmVxdWVzdGVkIHBheW1lbnQgYW1vdW50LgAAAAAAE0luc3VmZmljaWVudEJhbGFuY2UAAAAAAgAAAE1SZXF1ZXN0ZWQgYW1vdW50IGlzIG91dHNpZGUgYWxsb3dlZCBib3VuZHMsIG9yIGEgc3BlbmRpbmcgbGltaXQgd2FzIGV4Y2VlZGVkLgAAAAAAAA1MaW1pdEV4Y2VlZGVkAAAAAAAAAwAAAERgaW5pdGlhbGl6ZWAgd2FzIGNhbGxlZCBvbiBhIGNvbnRyYWN0IHRoYXQgYWxyZWFkeSBoYXMgYW4gYWRtaW4gc2V0LgAAABJBbHJlYWR5SW5pdGlhbGl6ZWQAAAAAAAQAAABOQW4gYWRtaW4tY29uZmlndXJlZCB2YWx1ZSAodHJlYXN1cnksIGZlZSwgYWRtaW4pIHdhcyByZWFkIGJlZm9yZSBgaW5pdGlhbGl6ZWAuAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAUAAABMVGhlIGNvbnRyYWN0IGlzIGN1cnJlbnRseSBwYXVzZWQ7IHJvdXRpbmcgY2FsbHMgYXJlIHJlamVjdGVkIHVudGlsIHVucGF1c2VkLgAAAAZQYXVzZWQAAAAAAAYAAABMQSBmZWUgY29uZmlndXJhdGlvbiB2YWx1ZSAoYmFzaXMgcG9pbnRzIG9yIGNhcCkgaXMgb3V0IG9mIHRoZSBhbGxvd2VkIHJhbmdlLgAAAA5JbnZhbGlkRmVlUmF0ZQAAAAAABwAAAEdTZW5kZXIgYW5kIHJlY2lwaWVudCBhZGRyZXNzZXMgYXJlIHRoZSBzYW1lIChzZWxmLXJvdXRpbmcgbm90IGFsbG93ZWQpLgAAAAAQSW52YWxpZFJlY2lwaWVudAAAAAgAAAAhUmVjaXBpZW50IGFkZHJlc3MgaXMgYmxhY2tsaXN0ZWQuAAAAAAAAC0JsYWNrbGlzdGVkAAAAAAkAAABPUmVxdWVzdGVkIHJlZnVuZCB3aXRoZHJhd2FsIGFtb3VudCBpcyB6ZXJvIG9yIGV4Y2VlZHMgYXZhaWxhYmxlIHJlZnVuZCBiYWxhbmNlLgAAAAARTm9SZWZ1bmRBdmFpbGFibGUAAAAAAAAKAAAAvEFuIGFjdGlvbiBpcyBhbHJlYWR5IHBlbmRpbmcgaW4gdGhlIHRpbWVsb2NrIHF1ZXVlOyBpdCBtdXN0IGJlIGV4ZWN1dGVkCm9yIGNhbmNlbGxlZCBiZWZvcmUgYSBkdXBsaWNhdGUgY2FuIGJlIHF1ZXVlZCAobm90IGN1cnJlbnRseSBlbmZvcmNlZCwKYnV0IHJlc2VydmVkIGZvciBmdXR1cmUgZGVkdXBsaWNhdGlvbiBsb2dpYykuAAAAD1RpbWVsb2NrUGVuZGluZwAAAAALAAAAQ1RoZSAyNC1ob3VyIGRlbGF5IGZvciB0aGUgZ2l2ZW4gdGltZWxvY2sgZW50cnkgaGFzIG5vdCBlbGFwc2VkIHlldC4AAAAAEFRpbWVsb2NrTm90UmVhZHkAAAAMAAAAM05vIHRpbWVsb2NrIGVudHJ5IGV4aXN0cyBmb3IgdGhlIHN1cHBsaWVkIG5vbmNlIElELgAAAAAQVGltZWxvY2tOb3RGb3VuZAAAAA0AAABJVGhlIGNvbnRyYWN0IGlzIGZyb3plbjsgYWxsIHBheW1lbnRzIGFuZCB0aW1lbG9jayBleGVjdXRpb25zIGFyZSBibG9ja2VkLgAAAAAAAA5Db250cmFjdEZyb3plbgAAAAAADgAAAD5UaGUgc3dhcCBuYW1lZCBhIERFWCByb3V0ZXIgdGhhdCB0aGUgYWRtaW4gaGFzIG5vdCByZWdpc3RlcmVkLgAAAAAAEERleE5vdFJlZ2lzdGVyZWQAAAAPAAAAQ1RoZSBERVggY3Jvc3MtY29udHJhY3QgY2FsbCByZXZlcnRlZCBvciByZXR1cm5lZCBhbiB1bnVzYWJsZSB2YWx1ZS4AAAAAClN3YXBGYWlsZWQAAAAAABAAAACAVGhlIHN3YXAgZGVsaXZlcmVkIGxlc3MgdGhhbiBgbWluX2Ftb3VudF9vdXRgLCBvciBtb3ZlZCB0aGUgb3V0cHV0CmZ1cnRoZXIgdGhhbiBgbWF4X3NsaXBwYWdlX2Jwc2AgYXdheSBmcm9tIHRoZSBjYWxsZXIncyBxdW90ZS4AAAAQU2xpcHBhZ2VFeGNlZWRlZAAAABEAAAA/VGhlIHN3YXAgd2FzIHN1Ym1pdHRlZCBhZnRlciBpdHMgYGRlYWRsaW5lYCBoYWQgYWxyZWFkeSBwYXNzZWQuAAAAABNTd2FwRGVhZGxpbmVFeHBpcmVkAAAAABIAAAA1VGhlIHN1cHBsaWVkIHJvbGUgaXMgbm90IG9uZSB0aGUgY29udHJhY3QgcmVjb2duaXNlcy4AAAAAAAALSW52YWxpZFJvbGUAAAAAFAAAAEVObyBiYWNrdXAgYWRtaW4gaGFzIGJlZW4gYXJtZWQsIHNvIHRoZSBkZWFkIG1hbidzIHN3aXRjaCBjYW5ub3QgZmlyZS4AAAAAAAANTm9CYWNrdXBBZG1pbgAAAAAAACsAAABHVGhlIGRlYWQgbWFuJ3Mgc3dpdGNoIHRpbWVvdXQgaGFzIG5vdCBlbGFwc2VkIHNpbmNlIHRoZSBsYXN0IGhlYXJ0YmVhdC4AAAAAC0Rtc05vdFJlYWR5AAAAACwAAABEQSBkZWFkIG1hbidzIHN3aXRjaCBjb25maWd1cmF0aW9uIHZhbHVlIGlzIG91dCBvZiB0aGUgYWxsb3dlZCByYW5nZS4AAAAQSW52YWxpZERtc0NvbmZpZwAAAC0AAAA6VGhlIHNlbmRlciBleGNlZWRlZCB0aGUgcGVyLWxlZGdlciBwYXltZW50IGludm9jYXRpb24gY2FwLgAAAAAAC1JhdGVMaW1pdGVkAAAAAC4AAAA9VGhlIGNhbGxlciBkb2VzIG5vdCBob2xkIHRoZSByb2xlIHJlcXVpcmVkIGJ5IHRoZSBlbnRyeXBvaW50LgAAAAAAAAxSb2xlTm90Rm91bmQAAAAvAAAAOUEgZ292ZXJuYW5jZSBwcm9wb3NhbCBpZCBpcyB1bmtub3duIG9yIG5vIGxvbmdlciB2b3RhYmxlLgAAAAAAAA9JbnZhbGlkUHJvcG9zYWwAAAAAFQAAAEZBIGdvdmVybmFuY2Ugb3BlcmF0aW9uIHdhcyBhdHRlbXB0ZWQgYmVmb3JlIGdvdmVybmFuY2Ugd2FzIGNvbmZpZ3VyZWQuAAAAAAAXR292ZXJuYW5jZU5vdENvbmZpZ3VyZWQAAAAAFgAAAC5UaGUgY2FsbGVyIGhhcyBhbHJlYWR5IHZvdGVkIG9uIHRoaXMgcHJvcG9zYWwuAAAAAAAMQWxyZWFkeVZvdGVkAAAAFwAAAClUaGUgY29uZmlndXJlZCBLWUMgdGhyZXNob2xkIGlzIG5lZ2F0aXZlLgAAAAAAABNJbnZhbGlkS3ljVGhyZXNob2xkAAAAABgAAABJQSB5aWVsZCBvcGVyYXRpb24gd2FzIGF0dGVtcHRlZCBiZWZvcmUgdGhlIHlpZWxkIHByb3RvY29sIHdhcyBjb25maWd1cmVkLgAAAAAAABpZaWVsZFByb3RvY29sTm90Q29uZmlndXJlZAAAAAAAGQAAAERUaGUgeWllbGQgYW1vdW50IGlzIG5vdCBwb3NpdGl2ZSBvciBleGNlZWRzIHRoZSBhdmFpbGFibGUgcHJpbmNpcGFsLgAAABJJbnZhbGlkWWllbGRBbW91bnQAAAAAABoAAAA1Tm8gcHJpY2UtZmVlZCBvcmFjbGUgaXMgY29uZmlndXJlZCBmb3IgdGhpcyBjb250cmFjdC4AAAAAAAATT3JhY2xlTm90Q29uZmlndXJlZAAAAAAbAAAARlRoZSBvcmFjbGUgY3Jvc3MtY29udHJhY3QgY2FsbCByZXZlcnRlZCBvciByZXR1cm5lZCBhbiB1bnVzYWJsZSB2YWx1ZS4AAAAAABBPcmFjbGVDYWxsRmFpbGVkAAAAHAAAAEJUaGUgb3JhY2xlIHF1b3RlIGlzIG9sZGVyIHRoYW4gdGhlIGNvbmZpZ3VyZWQgc3RhbGVuZXNzIHRocmVzaG9sZC4AAAAAABBPcmFjbGVQcmljZVN0YWxlAAAAHQAAADpUaGUgb3JhY2xlIHF1b3RlIGlzIG5vdCBhIHVzYWJsZSBwcmljZSAoemVybyBvciBuZWdhdGl2ZSkuAAAAAAAST3JhY2xlUHJpY2VJbnZhbGlkAAAAAAAeAAAAQUEgbWV0YS10cmFuc2FjdGlvbiB3YXMgc3VibWl0dGVkIGFmdGVyIGl0cyBgZGVhZGxpbmVgIGhhZCBwYXNzZWQuAAAAAAAAD0RlYWRsaW5lRXhwaXJlZAAAAAAfAAAARFRoZSBtZXRhLXRyYW5zYWN0aW9uIG5vbmNlIGRvZXMgbm90IG1hdGNoIHRoZSBzZW5kZXIncyBzdG9yZWQgbm9uY2UuAAAADEludmFsaWROb25jZQAAACAAAABCVGhlIG1ldGEtdHJhbnNhY3Rpb24gc2lnbmF0dXJlIGRpZCBub3QgdmVyaWZ5IGFnYWluc3QgdGhlIHBheWxvYWQuAAAAAAAQSW52YWxpZFNpZ25hdHVyZQAAACEAAAB/U3dhcCBwYXJhbWV0ZXJzIGFyZSBzZWxmLWNvbnRyYWRpY3Rvcnkgb3IgdW51c2FibGUgKGZvciBleGFtcGxlCmBzZWxsX3Rva2VuID09IGJ1eV90b2tlbmAsIG9yIGEgbm9uLXBvc2l0aXZlIGBtaW5fYW1vdW50X291dGApLgAAAAARSW52YWxpZFN3YXBQYXJhbXMAAAAAAAATAAAAa0EgcGF5bWVudCBhYm92ZSB0aGUgY29uZmlndXJlZCBLWUMgdGhyZXNob2xkIHdhcyBtYWRlIGJ5IGEgc2VuZGVyIHRoZQpjb25maWd1cmVkIG9yYWNsZSBkb2VzIG5vdCByZWNvZ25pc2UuAAAAAAtLeWNSZXF1aXJlZAAAAAAiAAAASkEgc3dhcCBwYXRoIGlzIGVtcHR5LCBtYWxmb3JtZWQsIG9yIGRvZXMgbm90IGNvbm5lY3QgdGhlIHJlcXVlc3RlZCBhc3NldHMuAAAAAAAPSW52YWxpZFN3YXBQYXRoAAAAACMAAABCVGhlIERFWCByZXR1cm5lZCBsZXNzIHRoYW4gdGhlIGNhbGxlcidzIG1pbmltdW0gYWNjZXB0YWJsZSBvdXRwdXQuAAAAAAAUU2xpcHBhZ2VFeGNlZWRlZFN3YXAAAAAkAAAA11RoZSBtdWx0aS1zaWduYXR1cmUgY29uZmlndXJhdGlvbiBpcyB1bnVzYWJsZTogdGhlIHNpZ25lciBzZXQgaXMgZW1wdHksCmNvbnRhaW5zIGEgZHVwbGljYXRlIGFkZHJlc3MsIHRoZSB0aHJlc2hvbGQgaXMgemVybywgb3IgdGhlIHRocmVzaG9sZApleGNlZWRzIHRoZSBudW1iZXIgb2Ygc2lnbmVycyAoc28gdGhlIHVwZ3JhZGUgY291bGQgbmV2ZXIgYmUgYXV0aG9yaXplZCkuAAAAABVJbnZhbGlkTXVsdGlzaWdDb25maWcAAAAAAAAlAAAAR1RoZSBjYWxsaW5nIGFkZHJlc3MgaXMgbm90IGEgbWVtYmVyIG9mIHRoZSBtdWx0aS1zaWduYXR1cmUgYWRtaW4gZ3JvdXAuAAAAABFOb3RNdWx0aXNpZ1NpZ25lcgAAAAAAACYAAAByVGhlIG51bWJlciBvZiBjb2xsZWN0ZWQgdXBncmFkZSBhcHByb3ZhbHMgaXMgYmVsb3cgdGhlIGNvbmZpZ3VyZWQKdGhyZXNob2xkLCBzbyB0aGUgdXBncmFkZSBpcyBub3QgYXV0aG9yaXplZCB5ZXQuAAAAAAAVSW5zdWZmaWNpZW50QXBwcm92YWxzAAAAAAAAJwAAAPZObyBtdWx0aS1zaWduYXR1cmUgYWRtaW4gZ3JvdXAgaGFzIGJlZW4gY29uZmlndXJlZCB5ZXQuICBVcGdyYWRlcyBmYWlsCmNsb3NlZCB1bnRpbCBgc2V0X211bHRpc2lnX2NvbmZpZ2AgaGFzIGJlZW4gY2FsbGVkLCBzbyBhIGZyZXNobHkKZGVwbG95ZWQgY29udHJhY3QgY2FuIG5ldmVyIGJlIHVwZ3JhZGVkIHRocm91Z2ggdGhlIHNpbmdsZSBhZG1pbiBrZXkKdGhhdCB0aGUgZ3JvdXAgd2FzIGludHJvZHVjZWQgdG8gZGUtcmlzay4AAAAAABZNdWx0aXNpZ05vdEluaXRpYWxpemVkAAAAAAAoAAAAx1RoZSBjYWxsaW5nIGFkZHJlc3MgaGFzIGFscmVhZHkgYXBwcm92ZWQgdGhpcyBXQVNNIGhhc2guICBEdXBsaWNhdGUKYXBwcm92YWxzIGFyZSByZWplY3RlZCByYXRoZXIgdGhhbiBpZ25vcmVkIHNvIHRoYXQgYSByZXBsYXllZCBzaWduYXR1cmUKY2FuIG5ldmVyIGluZmxhdGUgdGhlIGFwcHJvdmFsIGNvdW50IHRvd2FyZHMgdGhlIHRocmVzaG9sZC4AAAAAD0FscmVhZHlBcHByb3ZlZAAAAAApAAAAHkEgcmVlbnRyYW50IGNhbGwgd2FzIGRldGVjdGVkLgAAAAAADVJlZW50cmFudENhbGwAAAAAAAAqAAAAPUEgbXVsdGktaG9wIHN3YXAgcGF0aCBjb250YWlucyB0aGUgc2FtZSBhc3NldCBtb3JlIHRoYW4gb25jZS4AAAAAAAAOQ3ljbGljU3dhcFBhdGgAAAAAADAAAABGQSBwYWlyLXNwZWNpZmljIHNsaXBwYWdlIGNhcCBpcyBuZWdhdGl2ZSBvciBleGNlZWRzIHRoZSA1MDAgYnBzIGxpbWl0LgAAAAAAFUludmFsaWRTbGlwcGFnZUNvbmZpZwAAAAAAADE=",
        "AAAAAwAAANtSb2xlIGRlZmluaXRpb25zIGZvciB0aGUgUm9sZS1CYXNlZCBBY2Nlc3MgQ29udHJvbCAoUkJBQykgc3lzdGVtLgoKU2VncmVnYXRlcyBvcGVyYXRpb25hbCBwcml2aWxlZ2VzIGFjcm9zcyBkZWRpY2F0ZWQgcm9sZSBib3VuZGFyaWVzOgpTdXBlckFkbWluIChyb290IEFkbWluKSwgUGF1c2VyLCBGZWVNYW5hZ2VyLCBUcmVhc3VyeU1hbmFnZXIsIGFuZApDb21wbGlhbmNlT2ZmaWNlci4AAAAAAAAAAARSb2xlAAAABQAAAIhTdXByZW1lIGFkbWluaXN0cmF0b3Igd2l0aCBleGNsdXNpdmUgYXV0aG9yaXR5IG92ZXIgcm9sZSBhc3NpZ25tZW50cywKY29udHJhY3QgdXBncmFkZXMsIGVtZXJnZW5jeSBmcmVlemUvdW5mcmVlemUsIGFuZCByb290IGdvdmVybmFuY2UuAAAAClN1cGVyQWRtaW4AAAAAAAEAAAB7TWFuYWdlciB3aXRoIGV4Y2x1c2l2ZSBhdXRob3JpdHkgb3ZlciBwbGF0Zm9ybSB0cmVhc3VyeSwgeWllbGQgb3BlcmF0aW9ucywKdG9rZW4gcmVjb3ZlcnksIGFuZCBlbWVyZ2VuY3kgYXNzZXQgd2l0aGRyYXdhbHMuAAAAAA9UcmVhc3VyeU1hbmFnZXIAAAAAAgAAAHdDb21wbGlhbmNlIG9mZmljZXIgd2l0aCBhdXRob3JpdHkgb3ZlciBhZGRyZXNzIGJsYWNrbGlzdGluZywgS1lDIG9yYWNsZQpjb25maWd1cmF0aW9ucywgYW5kIG9yYWNsZSBwcmljZSBjb25maWd1cmF0aW9uLgAAAAARQ29tcGxpYW5jZU9mZmljZXIAAAAAAAADAAAAYEZlZSBtYW5hZ2VyIHdpdGggYXV0aG9yaXR5IG92ZXIgcGxhdGZvcm0gZmVlIGJhc2lzIHBvaW50cywgZmVlIGNhcHMsIGFuZAptaW5pbXVtIHBheW1lbnQgbGltaXRzLgAAAApGZWVNYW5hZ2VyAAAAAAAEAAAAoVBhdXNlciB3aXRoIGF1dGhvcml0eSBvdmVyIHRoZSBvcGVyYXRpb25hbCBwYXVzZSBzd2l0Y2guIEtlcHQgc2VwYXJhdGUKZnJvbSB0aGUgYnJvYWRlciBjb21wbGlhbmNlIHJvbGUgc28gdGhlIGFiaWxpdHkgdG8gaGFsdCByb3V0aW5nIGNhbiBiZQpkZWxlZ2F0ZWQgbmFycm93bHkuAAAAAAAABlBhdXNlcgAAAAAABQ==",
        "AAAAAgAAADtTdG9yYWdlIGtleXMgZm9yIGFsbCBjb250cmFjdCBpbnN0YW5jZSBhbmQgcGVyc2lzdGVudCBkYXRhLgAAAAAAAAAAB0RhdGFLZXkAAAAALwAAAAAAAAAaVGhlIGN1cnJlbnQgYWRtaW4gYWRkcmVzcy4AAAAAAAVBZG1pbgAAAAAAAAAAAABQR292ZXJuYW5jZSBjb250cmFjdCBhZGRyZXNzOyBpZiBzZXQsIGl0IHRha2VzIG92ZXIgZmVlLWF1dGhvcml0eSBmcm9tIHRoZSBhZG1pbi4AAAAKR292ZXJuYW5jZQAAAAAAAAAAAC5BZGRyZXNzIHRoYXQgcmVjZWl2ZXMgY29sbGVjdGVkIHBsYXRmb3JtIGZlZXMuAAAAAAAQUGxhdGZvcm1UcmVhc3VyeQAAAAAAAAA6UGxhdGZvcm0gZmVlIHJhdGUsIGluIGJhc2lzIHBvaW50cyAoMS8xMDB0aCBvZiBhIHBlcmNlbnQpLgAAAAAABkZlZUJwcwAAAAAAAAAAADNVcHBlciBib3VuZCBvbiB0aGUgZmVlIHRha2VuIGZyb20gYSBzaW5nbGUgcGF5bWVudC4AAAAABkZlZUNhcAAAAAAAAAAAAEZNaW5pbXVtIGFtb3VudCBhY2NlcHRlZCBieSBgcm91dGVfcGF5bWVudGAgLyBgcm91dGVfcGF5bWVudHNgLCBpZiBzZXQuAAAAAAAITWluTGltaXQAAAAAAAAAJFdoZXRoZXIgcm91dGluZyBpcyBjdXJyZW50bHkgcGF1c2VkLgAAAAZQYXVzZWQAAAAAAAAAAAAsTWF4aW11bSBhbW91bnQgYWNjZXB0ZWQgYnkgYSBzaW5nbGUgcGF5bWVudC4AAAAJTWF4QW1vdW50AAAAAAAAAQAAAPpDdW11bGF0aXZlIGxpZmV0aW1lIGFtb3VudCByb3V0ZWQgYnkgYSBnaXZlbiBzZW5kZXIuClBhY2tlZCBwZXItdXNlciByZWNvcmQgKGlzc3VlICM2NjMpOiB0aGUgMjQtaG91ciBzcGVuZGluZyB3aW5kb3cgcGx1cwp0aGUgY3VtdWxhdGl2ZSBsaWZldGltZSB2b2x1bWUsIHN0b3JlZCBhcyBhIHNpbmdsZSA0MC1ieXRlIHZhbHVlIHNvCnJlZ2lzdGVyaW5nIGEgc2VuZGVyIGNvc3RzIG9uZSBsZWRnZXIgZW50cnkgaW5zdGVhZCBvZiB0d28uAAAAAAAKVXNlclJlY29yZAAAAAAAAQAAABMAAAABAAAAoURFUFJFQ0FURUQgKHByZS0jNjYzKTogcGFja2VkIDI0LWhvdXIgc3BlbmRpbmcgd2luZG93IGZvciBhIHNlbmRlci4KTm8gbG9uZ2VyIHdyaXR0ZW47IHJlYWQgb25seSBieSB0aGUgYGxvYWRfdXNlcl9yZWNvcmRgIGZhbGxiYWNrIGFuZCBieQpgbWlncmF0ZV91c2VyX3JlY29yZGAuAAAAAAAADFVzZXJTcGVuZGluZwAAAAEAAAATAAAAAQAAAKNERVBSRUNBVEVEIChwcmUtIzY2Myk6IGN1bXVsYXRpdmUgbGlmZXRpbWUgYW1vdW50IHJvdXRlZCBieSBhIHNlbmRlci4KTm8gbG9uZ2VyIHdyaXR0ZW47IHJlYWQgb25seSBieSB0aGUgYGxvYWRfdXNlcl9yZWNvcmRgIGZhbGxiYWNrIGFuZCBieQpgbWlncmF0ZV91c2VyX3JlY29yZGAuAAAAAApVc2VyVm9sdW1lAAAAAAABAAAAEwAAAAEAAAAxV2hldGhlciBhIGdpdmVuIHJlY2lwaWVudCBhZGRyZXNzIGlzIGJsYWNrbGlzdGVkLgAAAAAAAAlCbGFja2xpc3QAAAAAAAABAAAAEwAAAAEAAABpSW50ZXJuYWwgcmVmdW5kIGJhbGFuY2UgZm9yIGEgKHVzZXIsIHRva2VuKSBwYWlyLCBjcmVkaXRlZCB3aGVuIGEKZGlyZWN0IHRyYW5zZmVyIHRvIHRoZSByZWNpcGllbnQgZmFpbHMuAAAAAAAADVJlZnVuZEJhbGFuY2UAAAAAAAACAAAAEwAAABMAAAAAAAAAfk1vbm90b25pY2FsbHktaW5jcmVhc2luZyBub25jZSBjb3VudGVyIHVzZWQgdG8gZ2VuZXJhdGUgdW5pcXVlIElEcyBmb3IKdGltZWxvY2sgZW50cmllcy4gIFN0b3JlZCBhcyBgdTY0YCBpbiBpbnN0YW5jZSBzdG9yYWdlLgAAAAAADVRpbWVsb2NrTm9uY2UAAAAAAAABAAAAbkEgcGVuZGluZyB0aW1lbG9jayBlbnRyeSBrZXllZCBieSBpdHMgbm9uY2UgSUQuClN0b3JlZCBpbiBwZXJzaXN0ZW50IHN0b3JhZ2Ugc28gaXQgc3Vydml2ZXMgaW5zdGFuY2UgZXZpY3Rpb24uAAAAAAANVGltZWxvY2tFbnRyeQAAAAAAAAEAAAAGAAAAAAAAAHhXaGVuIGB0cnVlYCB0aGUgY29udHJhY3QgaXMgZnJvemVuOiBwYXltZW50cyBhbmQgdGltZWxvY2sgZXhlY3V0aW9ucwphcmUgYmxvY2tlZC4gIFN0b3JlZCBhcyBgYm9vbGAgaW4gaW5zdGFuY2Ugc3RvcmFnZS4AAAAGRnJvemVuAAAAAAABAAAAJldoZXRoZXIgYW4gYWRkcmVzcyBob2xkcyBhIGdpdmVuIHJvbGUuAAAAAAAIVXNlclJvbGUAAAACAAAAEwAAB9AAAAAEUm9sZQAAAAEAAAAtVGhlIHByaW1hcnkgYWRkcmVzcyBjdXJyZW50bHkgaG9sZGluZyBhIHJvbGUuAAAAAAAABFJvbGUAAAABAAAH0AAAAARSb2xlAAAAAQAAADdNb25vdG9uaWMgbm9uY2UgZm9yIG1ldGEtdHJhbnNhY3Rpb24gcmVwbGF5IHByb3RlY3Rpb24uAAAAAAlNZXRhTm9uY2UAAAAAAAABAAAAEwAAAAAAAAA9VHJ1c3RlZCBpc3N1ZXIvb3JhY2xlIHF1ZXJpZWQgZm9yIGhpZ2gtdmFsdWUgcGF5bWVudCBzZW5kZXJzLgAAAAAAAAlLeWNPcmFjbGUAAAAAAAAAAAAAPlBheW1lbnRzIHN0cmljdGx5IGFib3ZlIHRoaXMgYW1vdW50IHJlcXVpcmUgYSB2YWxpZCBLWUMgY2xhaW0uAAAAAAAMS3ljVGhyZXNob2xkAAAAAAAAAG1UaGUgYmFja3VwIGFkbWluIHRoYXQgY2FuIGNsYWltIG93bmVyc2hpcCB2aWEgdGhlIGRlYWQgbWFuJ3Mgc3dpdGNoLgpTdG9yZWQgYXMgYEFkZHJlc3NgIGluIGluc3RhbmNlIHN0b3JhZ2UuAAAAAAAAC0JhY2t1cEFkbWluAAAAAAAAAABdVW5peCB0aW1lc3RhbXAgb2YgdGhlIGxhc3QgYWRtaW4gaGVhcnRiZWF0IChzZWUgYHBpbmdgKS4KU3RvcmVkIGFzIGB1NjRgIGluIGluc3RhbmNlIHN0b3JhZ2UuAAAAAAAADUxhc3RIZWFydGJlYXQAAAAAAAAAAAAAaEluYWN0aXZpdHkgd2luZG93IChzZWNvbmRzKSBhZnRlciB3aGljaCB0aGUgYmFja3VwIGFkbWluIG1heSBjbGFpbS4KU3RvcmVkIGFzIGB1NjRgIGluIGluc3RhbmNlIHN0b3JhZ2UuAAAACkRtc1RpbWVvdXQAAAAAAAAAAAB5UGVyLWFkZHJlc3MgcGF5bWVudCBpbnZvY2F0aW9uIGNhcCBwZXIgbGVkZ2VyIHNlcXVlbmNlLgpTdG9yZWQgYXMgYHUzMmAgaW4gaW5zdGFuY2Ugc3RvcmFnZSAoYDBgIGRpc2FibGVzIHJhdGUgbGltaXRpbmcpLgAAAAAAAA9SYXRlTGltaXRDb25maWcAAAAAAQAAADlQYWNrZWQgaW52b2NhdGlvbiBjb3VudGVyIGZvciBhIGdpdmVuIHNlbmRlciAoQnl0ZXNOPDg+KS4AAAAAAAAQUmF0ZUxpbWl0Q291bnRlcgAAAAEAAAATAAAAAQAAAFFXaGV0aGVyIGEgZ2l2ZW4gc2VuZGVyIGlzIHdoaXRlbGlzdGVkIGFuZCB0aGVyZWZvcmUgZXhlbXB0IGZyb20gdGhlIHJhdGUgbGltaXRlci4AAAAAAAASUmF0ZUxpbWl0V2hpdGVsaXN0AAAAAAABAAAAEwAAAAAAAAA+QWRkcmVzcyBvZiB0aGUgcHJpY2UtZmVlZCBvcmFjbGUgdXNlZCBmb3IgZmlhdC9jcnlwdG8gbG9va3Vwcy4AAAAAAA1PcmFjbGVBZGRyZXNzAAAAAAAAAAAAAD1NYXhpbXVtIGFjY2VwdGFibGUgYWdlLCBpbiBzZWNvbmRzLCBvZiBhbiBvcmFjbGUgcHJpY2UgcXVvdGUuAAAAAAAAElN0YWxlbmVzc1RocmVzaG9sZAAAAAAAAQAAAD1BZG1pbi1zdXBwbGllZCBmYWxsYmFjayBwcmljZSBmb3IgYSAoYmFzZSwgcXVvdGUpIGFzc2V0IHBhaXIuAAAAAAAADUZhbGxiYWNrUHJpY2UAAAAAAAACAAAAEwAAABMAAAAAAAAAMVRva2VuIHdob3NlIGJhbGFuY2VzIHdlaWdodCBmZWUtZ292ZXJuYW5jZSB2b3Rlcy4AAAAAAAAPR292ZXJuYW5jZVRva2VuAAAAAAAAAAA8TWluaW11bSB3ZWlnaHRlZCB2b3RlIHNoYXJlIHJlcXVpcmVkIHRvIHBhc3MgYSBmZWUgcHJvcG9zYWwuAAAAEEdvdmVybmFuY2VRdW9ydW0AAAAAAAAAJU1vbm90b25pYyBub25jZSBmb3IgZmVlLXByb3Bvc2FsIGlkcy4AAAAAAAAPR292ZXJuYW5jZU5vbmNlAAAAAAEAAAAuQSBwZW5kaW5nIGZlZS1jaGFuZ2UgcHJvcG9zYWwga2V5ZWQgYnkgaXRzIGlkLgAAAAAAEkdvdmVybmFuY2VQcm9wb3NhbAAAAAAAAQAAAAYAAAABAAAAL1JlY29yZGVkIHllcy9ubyB2b3RlIHdlaWdodCBmb3IgYSBmZWUgcHJvcG9zYWwuAAAAAA5Hb3Zlcm5hbmNlVm90ZQAAAAAAAgAAAAYAAAATAAAAAAAAADtDdXJyZW50IGFyY2hpdmFsIGVwb2NoIGNvdW50ZXIsIHN0b3JlZCBpbiBpbnN0YW5jZSBzdG9yYWdlLgAAAAAMQXJjaGl2ZUVwb2NoAAAAAQAAACxNZXJrbGUgcm9vdCBjb21taXR0ZWQgZm9yIGFuIGFyY2hpdmFsIGVwb2NoLgAAAAtBcmNoaXZlUm9vdAAAAAABAAAABgAAAAEAAAAuTWV0YWRhdGEgY29tbWl0dGVkIGFsb25nc2lkZSBhbiBhcmNoaXZhbCByb290LgAAAAAAC0FyY2hpdmVNZXRhAAAAAAEAAAAGAAAAAAAAAD1MZW5kaW5nIHByb3RvY29sIGNvbnRyYWN0IHVzZWQgZm9yIHRyZWFzdXJ5IHlpZWxkIG9wZXJhdGlvbnMuAAAAAAAADVlpZWxkUHJvdG9jb2wAAAAAAAABAAAAQFByaW5jaXBhbCBjdXJyZW50bHkgZGVwb3NpdGVkIGludG8gdGhlIHlpZWxkIHByb3RvY29sIHBlciB0b2tlbi4AAAAOWWllbGRQcmluY2lwYWwAAAAAAAEAAAATAAAAAQAAAE9XaGV0aGVyIGEgREVYIHJvdXRlciBjb250cmFjdCBpcyBhcHByb3ZlZCB0byByZWNlaXZlIGNyb3NzLWNvbnRyYWN0IHN3YXAgY2FsbHMuAAAAAA1SZWdpc3RlcmVkRGV4AAAAAAAAAQAAABMAAAAAAAAAME1heGltdW0gdG9sZXJhdGVkIHN3YXAgc2xpcHBhZ2UgaW4gYmFzaXMgcG9pbnRzLgAAAA5NYXhTbGlwcGFnZUJwcwAAAAAAAQAAAEdNYXhpbXVtIHRvbGVyYXRlZCBzd2FwIHNsaXBwYWdlIGZvciBhIHNwZWNpZmljIGlucHV0L291dHB1dCB0b2tlbiBwYWlyLgAAAAAMUGFpclNsaXBwYWdlAAAAAgAAABMAAAATAAAAAAAAAEBUaGUgTiBhZGRyZXNzZXMgb2YgdGhlIG11bHRpLXNpZ25hdHVyZSBhZG1pbiBncm91cCBmb3IgdXBncmFkZXMuAAAAD011bHRpc2lnU2lnbmVycwAAAAAAAAAAO1RoZSBNIHNpZ25lcnMgdGhyZXNob2xkIG9mIHRoZSBtdWx0aS1zaWduYXR1cmUgYWRtaW4gZ3JvdXAuAAAAABFNdWx0aXNpZ1RocmVzaG9sZAAAAAAAAAEAAAA8U2lnbmVyIGFwcHJvdmFscyBjb2xsZWN0ZWQgZm9yIGEgc3BlY2lmaWMgdXBncmFkZSBXQVNNIGhhc2guAAAAD1VwZ3JhZGVBcHByb3ZhbAAAAAABAAAD7gAAACAAAAAAAAAAMEd1YXJkIGFnYWluc3QgY3Jvc3MtY29udHJhY3QgcmVlbnRyYW5jeSBhdHRhY2tzLgAAAA9SZWVudHJhbmN5R3VhcmQA",
        "AAAAAQAAATxBIHNpbmdsZSBhcmNoaXZlIGxlYWYgZGVzY3JpcHRvciBwYXNzZWQgaW50byBgY29tbWl0X2FyY2hpdmVfcm9vdGAgYW5kCmBwcnVuZV9hcmNoaXZlZF9lbnRyaWVzYC4KClRoZSBjb250cmFjdCB1c2VzIGByZWNvcmRfdHlwZSArIHByaW1hcnlfa2V5ICgrIHNlY29uZGFyeV9rZXkpYCB0byBsb2NhdGUKdGhlIGNvcnJlc3BvbmRpbmcgYERhdGFLZXlgIHRvIGRlbGV0ZSBkdXJpbmcgYSBwcnVuZS4gSXQgZG9lcyBub3QgcmUtaGFzaAp0aGUgbGVhdmVzIOKAlCB0aGUgTWVya2xlIHJvb3QgaXMgY29tcHV0ZWQgYW5kIHRydXN0ZWQgZnJvbSBvZmYtY2hhaW4uAAAAAAAAAAtBcmNoaXZlTGVhZgAAAAADAAAAd1ByaW1hcnkga2V5IGFkZHJlc3M6Ci0gYFVzZXJWb2x1bWVgIC8gYFVzZXJTcGVuZGluZ2A6IHRoZSBzZW5kZXIgYWRkcmVzcy4KLSBgUmVmdW5kQmFsYW5jZWA6IHRoZSB1c2VyIChzZW5kZXIpIGFkZHJlc3MuAAAAAAtwcmltYXJ5X2tleQAAAAATAAAAKldoaWNoIHR5cGUgb2YgcmVjb3JkIHRoaXMgbGVhZiByZXByZXNlbnRzLgAAAAAAC3JlY29yZF90eXBlAAAAB9AAAAARQXJjaGl2ZVJlY29yZFR5cGUAAAAAAAByU2Vjb25kYXJ5IGtleSBhZGRyZXNzOgotIGBSZWZ1bmRCYWxhbmNlYDogdGhlIHRva2VuIGNvbnRyYWN0IGFkZHJlc3MuCi0gT3RoZXIgdHlwZXM6IGlnbm9yZWQgKG1heSBiZSBhbnkgYWRkcmVzcykuAAAAAAANc2Vjb25kYXJ5X2tleQAAAAAAABM=",
        "AAAAAQAAACxNZXRhZGF0YSBzdG9yZWQgYWxvbmdzaWRlIGVhY2ggYXJjaGl2ZSByb290LgAAAAAAAAAPQXJjaGl2ZU1ldGFkYXRhAAAAAAMAAAA/VW5peCB0aW1lc3RhbXAgKHNlY29uZHMpIHdoZW4gdGhpcyBhcmNoaXZlIGVwb2NoIHdhcyBjb21taXR0ZWQuAAAAAAxjb21taXR0ZWRfYXQAAAAGAAAAOUZyZWUtZm9ybSBkZXNjcmlwdGlvbiB0YWcgKGUuZy4gYCJ1c2VyX3ZvbHVtZToyMDI2LTA5ImApLgAAAAAAAAtkZXNjcmlwdGlvbgAAAAAQAAAANlRvdGFsIG51bWJlciBvZiBsZWFmIHJlY29yZHMgaW5jbHVkZWQgaW4gdGhpcyBhcmNoaXZlLgAAAAAADHJlY29yZF9jb3VudAAAAAQ=",
        "AAAAAwAAAJRSZWNvcmQgdHlwZXMgc3VwcG9ydGVkIGJ5IHRoZSBhcmNoaXZhbCBzeXN0ZW0uCgpUaGUgYHJlcHIodTMyKWAgZGlzY3JpbWluYW50IGRvdWJsZXMgYXMgdGhlIHRhZyBieXRlIHByZXBlbmRlZCB3aGVuCmNvbXB1dGluZyBsZWFmIGhhc2hlcyBvZmYtY2hhaW4uAAAAAAAAABFBcmNoaXZlUmVjb3JkVHlwZQAAAAAAAAMAAABFYERhdGFLZXk6OlVzZXJWb2x1bWUoYWRkcmVzcylgIOKAlCBjdW11bGF0aXZlIGxpZmV0aW1lIHJvdXRlZCB2b2x1bWUuAAAAAAAAClVzZXJWb2x1bWUAAAAAAAEAAABEYERhdGFLZXk6OlVzZXJTcGVuZGluZyhhZGRyZXNzKWAg4oCUIHBhY2tlZCAyNC1ob3VyIHNwZW5kaW5nIHdpbmRvdy4AAAAMVXNlclNwZW5kaW5nAAAAAgAAAENgRGF0YUtleTo6UmVmdW5kQmFsYW5jZSh1c2VyLCB0b2tlbilgIOKAlCB1bmNsYWltZWQgcmVmdW5kIGJhbGFuY2UuAAAAAA1SZWZ1bmRCYWxhbmNlAAAAAAAAAw==" ]),
      options
    )
  }
  public readonly fromJSON = {
    ping: this.txFromJSON<Result<void>>,
        get_fee: this.txFromJSON<i128>,
        upgrade: this.txFromJSON<Result<void>>,
        version: this.txFromJSON<string>,
        has_role: this.txFromJSON<boolean>,
        unfreeze: this.txFromJSON<Result<void>>,
        get_admin: this.txFromJSON<Option<string>>,
        get_price: this.txFromJSON<Result<PriceData>>,
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
        register_dex: this.txFromJSON<Result<void>>,
        cancel_action: this.txFromJSON<Result<void>>,
        harvest_yield: this.txFromJSON<Result<i128>>,
        route_payment: this.txFromJSON<Result<void>>,
        set_min_limit: this.txFromJSON<Result<void>>,
        cancel_upgrade: this.txFromJSON<Result<void>>,
        deregister_dex: this.txFromJSON<Result<void>>,
        execute_action: this.txFromJSON<Result<void>>,
        get_meta_nonce: this.txFromJSON<u64>,
        get_rate_limit: this.txFromJSON<u32>,
        get_role_admin: this.txFromJSON<Role>,
        is_blacklisted: this.txFromJSON<boolean>,
        recover_tokens: this.txFromJSON<Result<void>>,
        route_payments: this.txFromJSON<Result<void>>,
        set_fee_config: this.txFromJSON<Result<void>>,
        set_governance: this.txFromJSON<Result<void>>,
        set_kyc_config: this.txFromJSON<Result<void>>,
        set_rate_limit: this.txFromJSON<Result<void>>,
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
        get_multisig_config: this.txFromJSON<Result<MultisigConfig>>,
        migrate_user_record: this.txFromJSON<boolean>,
        remove_backup_admin: this.txFromJSON<Result<void>>,
        route_multihop_swap: this.txFromJSON<Result<i128>>,
        set_multisig_config: this.txFromJSON<Result<void>>,
        unblacklist_address: this.txFromJSON<Result<void>>,
        withdraw_from_yield: this.txFromJSON<Result<void>>,
        configure_governance: this.txFromJSON<Result<void>>,
        get_dead_mans_switch: this.txFromJSON<readonly [Option<string>, u64, u64, u64]>,
        get_max_slippage_bps: this.txFromJSON<i128>,
        set_max_slippage_bps: this.txFromJSON<Result<void>>,
        execute_batch_actions: this.txFromJSON<Result<void>>,
        get_effective_fee_bps: this.txFromJSON<i128>,
        get_upgrade_approvals: this.txFromJSON<Array<string>>,
        is_upgrade_authorized: this.txFromJSON<Result<boolean>>,
        set_fee_config_legacy: this.txFromJSON<Result<void>>,
        set_platform_treasury: this.txFromJSON<Result<void>>,
        prune_archived_entries: this.txFromJSON<Result<u32>>,
        revoke_upgrade_approval: this.txFromJSON<Result<void>>,
        route_payment_with_swap: this.txFromJSON<Result<i128>>,
        set_staleness_threshold: this.txFromJSON<Result<void>>,
        get_rate_limit_remaining: this.txFromJSON<u32>,
        route_payments_with_swap: this.txFromJSON<Result<i128>>,
        set_rate_limit_whitelist: this.txFromJSON<Result<void>>,
        get_pair_max_slippage_bps: this.txFromJSON<Result<i128>>,
        is_rate_limit_whitelisted: this.txFromJSON<boolean>,
        set_backup_admin_internal: this.txFromJSON<Result<void>>,
        set_pair_max_slippage_bps: this.txFromJSON<Result<void>>,
        is_dead_mans_switch_expired: this.txFromJSON<boolean>,
        remove_rate_limit_whitelist: this.txFromJSON<Result<void>>,
        route_payment_with_swap_raw: this.txFromJSON<Result<void>>
  }
}