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
   * No lending protocol has been configured by the admin.
   */
  15: {message:"YieldProtocolNotConfigured"},
  /**
   * Yield amount must be positive and withdrawals cannot exceed principal.
   */
  16: {message:"InvalidYieldAmount"},
  /**
   * The sender lacks a valid KYC claim for a high-value payment.
   */
  17: {message:"KycRequired"},
  /**
   * The configured KYC threshold must not be negative.
   */
  18: {message:"InvalidKycThreshold"},
  /**
   * Account lacks the required role or role does not exist.
   */
  19: {message:"RoleNotFound"},
  /**
   * Invalid role assignment or revocation (e.g. revoking the last SuperAdmin).
   */
  20: {message:"InvalidRole"}
}

/**
 * Storage keys for all contract instance and persistent data.
 */
export type DataKey = {tag: "Admin", values: void} | {tag: "Governance", values: void} | {tag: "PlatformTreasury", values: void} | {tag: "FeeBps", values: void} | {tag: "FeeCap", values: void} | {tag: "MinLimit", values: void} | {tag: "Paused", values: void} | {tag: "MaxAmount", values: void} | {tag: "UserVolume", values: readonly [string]} | {tag: "UserSpending", values: readonly [string]} | {tag: "Blacklist", values: readonly [string]} | {tag: "RefundBalance", values: readonly [string, string]} | {tag: "TimelockNonce", values: void} | {tag: "TimelockEntry", values: readonly [u64]} | {tag: "Frozen", values: void} | {tag: "YieldProtocol", values: void} | {tag: "YieldPrincipal", values: readonly [string]} | {tag: "KycOracle", values: void} | {tag: "KycThreshold", values: void} | {tag: "Role", values: readonly [Role]} | {tag: "UserRole", values: readonly [string, Role]};


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
export type ActionType = {tag: "SetPlatformTreasury", values: readonly [string]} | {tag: "SetFeeConfig", values: readonly [i128, i128]} | {tag: "SetFeeBps", values: readonly [i128]} | {tag: "SetGovernance", values: readonly [string]} | {tag: "SetMinLimit", values: readonly [i128]} | {tag: "TransferAdmin", values: readonly [string]} | {tag: "Upgrade", values: readonly [Buffer]} | {tag: "SetMultisigConfig", values: readonly [Array<string>, u32]};


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
 * The multi-signature admin group that authorizes contract upgrades.
 * 
 * `threshold` signers drawn from `signers` must approve a specific WASM hash
 * before [`PaymentRouter::upgrade`] (or the timelock's
 * [`ActionType::Upgrade`]) will install it.
 */
export interface MultisigConfig {
  /**
 * The N addresses whose signatures count towards an upgrade approval.
 */
signers: Array<string>;
  /**
 * The M signers that must approve before an upgrade is authorized.
 */
threshold: u32;
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
   * network. Must match a hash with at least `threshold` approvals.
   * 
   * # Returns
   * `Ok(())` on success, `Err(Error::MultisigNotInitialized)` if no group
   * is configured, or `Err(Error::InsufficientApprovals)` if fewer than
   * `threshold` members have approved this hash.
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
   * `set_multisig_config`, `upgrade`) must go through the timelock.  Use the
   * direct setter functions only for actions that are not sensitive (e.g.
   * `set_pause` which can also be called directly for immediate operational
   * pauses).
   * 
   * Queueing does not pre-authorize anything on its own: `ActionType::Upgrade`
   * and `ActionType::SetMultisigConfig` are re-validated at execution time,
   * so an upgrade queued today still needs the multi-signature threshold to
   * be met for that hash when the delay elapses.
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
        "AAAABAAAAIpDb250cmFjdC1sZXZlbCBlcnJvcnMgcmV0dXJuZWQgaW5zdGVhZCBvZiBwYW5pY2tpbmcsIHNvIGNhbGxlcnMgZ2V0IGEKc3BlY2lmaWMsIHN0YWJsZSBlcnJvciBjb2RlIHRvIGJyYW5jaCBvbiByYXRoZXIgdGhhbiBhbiBvcGFxdWUgdHJhcC4AAAAAAAAAAAAFRXJyb3IAAAAAAAAUAAAARUNhbGxlciBpcyBub3QgYXV0aG9yaXplZCB0byBwZXJmb3JtIHRoaXMgYWN0aW9uIChlLmcuIG5vdCB0aGUgYWRtaW4pLgAAAAAAAAxVbmF1dGhvcml6ZWQAAAABAAAAQlNlbmRlcidzIHRva2VuIGJhbGFuY2UgaXMgbG93ZXIgdGhhbiB0aGUgcmVxdWVzdGVkIHBheW1lbnQgYW1vdW50LgAAAAAAE0luc3VmZmljaWVudEJhbGFuY2UAAAAAAgAAAE1SZXF1ZXN0ZWQgYW1vdW50IGlzIG91dHNpZGUgYWxsb3dlZCBib3VuZHMsIG9yIGEgc3BlbmRpbmcgbGltaXQgd2FzIGV4Y2VlZGVkLgAAAAAAAA1MaW1pdEV4Y2VlZGVkAAAAAAAAAwAAAERgaW5pdGlhbGl6ZWAgd2FzIGNhbGxlZCBvbiBhIGNvbnRyYWN0IHRoYXQgYWxyZWFkeSBoYXMgYW4gYWRtaW4gc2V0LgAAABJBbHJlYWR5SW5pdGlhbGl6ZWQAAAAAAAQAAABOQW4gYWRtaW4tY29uZmlndXJlZCB2YWx1ZSAodHJlYXN1cnksIGZlZSwgYWRtaW4pIHdhcyByZWFkIGJlZm9yZSBgaW5pdGlhbGl6ZWAuAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAUAAABMVGhlIGNvbnRyYWN0IGlzIGN1cnJlbnRseSBwYXVzZWQ7IHJvdXRpbmcgY2FsbHMgYXJlIHJlamVjdGVkIHVudGlsIHVucGF1c2VkLgAAAAZQYXVzZWQAAAAAAAYAAABMQSBmZWUgY29uZmlndXJhdGlvbiB2YWx1ZSAoYmFzaXMgcG9pbnRzIG9yIGNhcCkgaXMgb3V0IG9mIHRoZSBhbGxvd2VkIHJhbmdlLgAAAA5JbnZhbGlkRmVlUmF0ZQAAAAAABwAAAEdTZW5kZXIgYW5kIHJlY2lwaWVudCBhZGRyZXNzZXMgYXJlIHRoZSBzYW1lIChzZWxmLXJvdXRpbmcgbm90IGFsbG93ZWQpLgAAAAAQSW52YWxpZFJlY2lwaWVudAAAAAgAAAAhUmVjaXBpZW50IGFkZHJlc3MgaXMgYmxhY2tsaXN0ZWQuAAAAAAAAC0JsYWNrbGlzdGVkAAAAAAkAAABPUmVxdWVzdGVkIHJlZnVuZCB3aXRoZHJhd2FsIGFtb3VudCBpcyB6ZXJvIG9yIGV4Y2VlZHMgYXZhaWxhYmxlIHJlZnVuZCBiYWxhbmNlLgAAAAARTm9SZWZ1bmRBdmFpbGFibGUAAAAAAAAKAAAAvEFuIGFjdGlvbiBpcyBhbHJlYWR5IHBlbmRpbmcgaW4gdGhlIHRpbWVsb2NrIHF1ZXVlOyBpdCBtdXN0IGJlIGV4ZWN1dGVkCm9yIGNhbmNlbGxlZCBiZWZvcmUgYSBkdXBsaWNhdGUgY2FuIGJlIHF1ZXVlZCAobm90IGN1cnJlbnRseSBlbmZvcmNlZCwKYnV0IHJlc2VydmVkIGZvciBmdXR1cmUgZGVkdXBsaWNhdGlvbiBsb2dpYykuAAAAD1RpbWVsb2NrUGVuZGluZwAAAAALAAAAQ1RoZSAyNC1ob3VyIGRlbGF5IGZvciB0aGUgZ2l2ZW4gdGltZWxvY2sgZW50cnkgaGFzIG5vdCBlbGFwc2VkIHlldC4AAAAAEFRpbWVsb2NrTm90UmVhZHkAAAAMAAAAM05vIHRpbWVsb2NrIGVudHJ5IGV4aXN0cyBmb3IgdGhlIHN1cHBsaWVkIG5vbmNlIElELgAAAAAQVGltZWxvY2tOb3RGb3VuZAAAAA0AAABJVGhlIGNvbnRyYWN0IGlzIGZyb3plbjsgYWxsIHBheW1lbnRzIGFuZCB0aW1lbG9jayBleGVjdXRpb25zIGFyZSBibG9ja2VkLgAAAAAAAA5Db250cmFjdEZyb3plbgAAAAAADgAAADVObyBsZW5kaW5nIHByb3RvY29sIGhhcyBiZWVuIGNvbmZpZ3VyZWQgYnkgdGhlIGFkbWluLgAAAAAAABpZaWVsZFByb3RvY29sTm90Q29uZmlndXJlZAAAAAAADwAAAEZZaWVsZCBhbW91bnQgbXVzdCBiZSBwb3NpdGl2ZSBhbmQgd2l0aGRyYXdhbHMgY2Fubm90IGV4Y2VlZCBwcmluY2lwYWwuAAAAAAASSW52YWxpZFlpZWxkQW1vdW50AAAAAAAQAAAAPFRoZSBzZW5kZXIgbGFja3MgYSB2YWxpZCBLWUMgY2xhaW0gZm9yIGEgaGlnaC12YWx1ZSBwYXltZW50LgAAAAtLeWNSZXF1aXJlZAAAAAARAAAAMlRoZSBjb25maWd1cmVkIEtZQyB0aHJlc2hvbGQgbXVzdCBub3QgYmUgbmVnYXRpdmUuAAAAAAATSW52YWxpZEt5Y1RocmVzaG9sZAAAAAASAAAAN0FjY291bnQgbGFja3MgdGhlIHJlcXVpcmVkIHJvbGUgb3Igcm9sZSBkb2VzIG5vdCBleGlzdC4AAAAADFJvbGVOb3RGb3VuZAAAABMAAABKSW52YWxpZCByb2xlIGFzc2lnbm1lbnQgb3IgcmV2b2NhdGlvbiAoZS5nLiByZXZva2luZyB0aGUgbGFzdCBTdXBlckFkbWluKS4AAAAAAAtJbnZhbGlkUm9sZQAAAAAU",
        "AAAAAAAAARdRdWVyaWVzIHdoZXRoZXIgYSBnaXZlbiBhY2NvdW50IGhvbGRzIGFuIGFjdGl2ZSByb2xlIGFzc2lnbm1lbnQuCgpDaGVja3MgcGVyc2lzdGVudCB1c2VyIHJvbGUgYXNzaWdubWVudHMgYW5kIHByaW1hcnkgZGVzaWduYXRlZCByb2xlcy4KCiMgUGFyYW1ldGVycwotIGBhY2NvdW50YDogQWRkcmVzcyB0byBxdWVyeS4KLSBgcm9sZWA6IFJvbGUgdmFyaWFudCB0byBjaGVjay4KCiMgUmV0dXJucwpgdHJ1ZWAgaWYgYXV0aG9yaXplZCBmb3IgdGhpcyByb2xlLCBgZmFsc2VgIG90aGVyd2lzZS4AAAAACGhhc19yb2xlAAAAAgAAAAAAAAAHYWNjb3VudAAAAAATAAAAAAAAAARyb2xlAAAH0AAAAARSb2xlAAAAAQAAAAE=",
        "AAAAAAAAAMNSZW1vdmVzIHRoZSBmcm96ZW4gc3RhdGUsIHJlc3RvcmluZyBub3JtYWwgY29udHJhY3Qgb3BlcmF0aW9uLgoKTGlrZSBgZW1lcmdlbmN5X2ZyZWV6ZWAsIHRoaXMgdGFrZXMgZWZmZWN0IGltbWVkaWF0ZWx5IGFuZCBkb2VzIG5vdApnbyB0aHJvdWdoIHRoZSB0aW1lbG9jay4KClN1cGVyQWRtaW4gYXV0aG9yaXphdGlvbiBpcyByZXF1aXJlZC4AAAAACHVuZnJlZXplAAAAAAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAADFSZXR1cm5zIHdoZXRoZXIgdGhlIGNvbnRyYWN0IGlzIGN1cnJlbnRseSBmcm96ZW4uAAAAAAAACWlzX2Zyb3plbgAAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAJRSZXR1cm5zIHdoZXRoZXIgdGhlIGNvbnRyYWN0IGlzIGN1cnJlbnRseSBwYXVzZWQuCgojIFJldHVybnMKYHRydWVgIGlmIHBhdXNlZCwgYGZhbHNlYCBpZiB1bnBhdXNlZCBvciBub3QgeWV0IGluaXRpYWxpemVkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAACWlzX3BhdXNlZAAAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAORTZXQgYSBuZXcgYWRtaW4uIFN1cGVyQWRtaW4tcHJvdGVjdGVkLgoKIyBQYXJhbWV0ZXJzCi0gYG5ld19hZG1pbmA6IEFkZHJlc3MgdG8gaW5zdGFsbCBhcyB0aGUgbmV3IGFkbWluLgoKIyBSZXR1cm5zCkFsd2F5cyBgT2soKCkpYC4KCiMgUGFuaWNzClBhbmljcyBpZiBhbiBhZG1pbiBpcyBhbHJlYWR5IHNldCBhbmQgY3VycmVudCBTdXBlckFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAa9QYXVzZXMgb3IgdW5wYXVzZXMgdGhlIHBheW1lbnQgcm91dGVyLiBDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuCgojIFBhcmFtZXRlcnMKLSBgcGF1c2VkYDogYHRydWVgIHRvIHJlamVjdCBgcm91dGVfcGF5bWVudGAgLyBgcm91dGVfcGF5bWVudHNgCmNhbGxzLCBgZmFsc2VgIHRvIGFsbG93IHRoZW0gYWdhaW4uCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgQ29tcGxpYW5jZU9mZmljZXIgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKVGhpcyBpcyBOT1QgdGltZWxvY2tlZCDigJQgb3BlcmF0aW9uYWwgcGF1c2luZyBtdXN0IHJlbWFpbiBpbnN0YW50LgAAAAAJc2V0X3BhdXNlAAAAAAAAAQAAAAAAAAAGcGF1c2VkAAAAAAABAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAgAAADtTdG9yYWdlIGtleXMgZm9yIGFsbCBjb250cmFjdCBpbnN0YW5jZSBhbmQgcGVyc2lzdGVudCBkYXRhLgAAAAAAAAAAB0RhdGFLZXkAAAAAFQAAAAAAAAAaVGhlIGN1cnJlbnQgYWRtaW4gYWRkcmVzcy4AAAAAAAVBZG1pbgAAAAAAAAAAAABQR292ZXJuYW5jZSBjb250cmFjdCBhZGRyZXNzOyBpZiBzZXQsIGl0IHRha2VzIG92ZXIgZmVlLWF1dGhvcml0eSBmcm9tIHRoZSBhZG1pbi4AAAAKR292ZXJuYW5jZQAAAAAAAAAAAC5BZGRyZXNzIHRoYXQgcmVjZWl2ZXMgY29sbGVjdGVkIHBsYXRmb3JtIGZlZXMuAAAAAAAQUGxhdGZvcm1UcmVhc3VyeQAAAAAAAAA6UGxhdGZvcm0gZmVlIHJhdGUsIGluIGJhc2lzIHBvaW50cyAoMS8xMDB0aCBvZiBhIHBlcmNlbnQpLgAAAAAABkZlZUJwcwAAAAAAAAAAADNVcHBlciBib3VuZCBvbiB0aGUgZmVlIHRha2VuIGZyb20gYSBzaW5nbGUgcGF5bWVudC4AAAAABkZlZUNhcAAAAAAAAAAAAEZNaW5pbXVtIGFtb3VudCBhY2NlcHRlZCBieSBgcm91dGVfcGF5bWVudGAgLyBgcm91dGVfcGF5bWVudHNgLCBpZiBzZXQuAAAAAAAITWluTGltaXQAAAAAAAAAJFdoZXRoZXIgcm91dGluZyBpcyBjdXJyZW50bHkgcGF1c2VkLgAAAAZQYXVzZWQAAAAAAAAAAAAsTWF4aW11bSBhbW91bnQgYWNjZXB0ZWQgYnkgYSBzaW5nbGUgcGF5bWVudC4AAAAJTWF4QW1vdW50AAAAAAAAAQAAADRDdW11bGF0aXZlIGxpZmV0aW1lIGFtb3VudCByb3V0ZWQgYnkgYSBnaXZlbiBzZW5kZXIuAAAAClVzZXJWb2x1bWUAAAAAAAEAAAATAAAAAQAAADJQYWNrZWQgMjQtaG91ciBzcGVuZGluZyB3aW5kb3cgZm9yIGEgZ2l2ZW4gc2VuZGVyLgAAAAAADFVzZXJTcGVuZGluZwAAAAEAAAATAAAAAQAAADFXaGV0aGVyIGEgZ2l2ZW4gcmVjaXBpZW50IGFkZHJlc3MgaXMgYmxhY2tsaXN0ZWQuAAAAAAAACUJsYWNrbGlzdAAAAAAAAAEAAAATAAAAAQAAAGlJbnRlcm5hbCByZWZ1bmQgYmFsYW5jZSBmb3IgYSAodXNlciwgdG9rZW4pIHBhaXIsIGNyZWRpdGVkIHdoZW4gYQpkaXJlY3QgdHJhbnNmZXIgdG8gdGhlIHJlY2lwaWVudCBmYWlscy4AAAAAAAANUmVmdW5kQmFsYW5jZQAAAAAAAAIAAAATAAAAEwAAAAAAAAB+TW9ub3RvbmljYWxseS1pbmNyZWFzaW5nIG5vbmNlIGNvdW50ZXIgdXNlZCB0byBnZW5lcmF0ZSB1bmlxdWUgSURzIGZvcgp0aW1lbG9jayBlbnRyaWVzLiAgU3RvcmVkIGFzIGB1NjRgIGluIGluc3RhbmNlIHN0b3JhZ2UuAAAAAAANVGltZWxvY2tOb25jZQAAAAAAAAEAAABuQSBwZW5kaW5nIHRpbWVsb2NrIGVudHJ5IGtleWVkIGJ5IGl0cyBub25jZSBJRC4KU3RvcmVkIGluIHBlcnNpc3RlbnQgc3RvcmFnZSBzbyBpdCBzdXJ2aXZlcyBpbnN0YW5jZSBldmljdGlvbi4AAAAAAA1UaW1lbG9ja0VudHJ5AAAAAAAAAQAAAAYAAAAAAAAAeFdoZW4gYHRydWVgIHRoZSBjb250cmFjdCBpcyBmcm96ZW46IHBheW1lbnRzIGFuZCB0aW1lbG9jayBleGVjdXRpb25zCmFyZSBibG9ja2VkLiAgU3RvcmVkIGFzIGBib29sYCBpbiBpbnN0YW5jZSBzdG9yYWdlLgAAAAZGcm96ZW4AAAAAAAAAAAA9TGVuZGluZyBwcm90b2NvbCBjb250cmFjdCB1c2VkIGZvciB0cmVhc3VyeSB5aWVsZCBvcGVyYXRpb25zLgAAAAAAAA1ZaWVsZFByb3RvY29sAAAAAAAAAQAAADNQcmluY2lwYWwgY3VycmVudGx5IGRlcG9zaXRlZCBmb3IgYSB0cmVhc3VyeSBhc3NldC4AAAAADllpZWxkUHJpbmNpcGFsAAAAAAABAAAAEwAAAAAAAAA9VHJ1c3RlZCBpc3N1ZXIvb3JhY2xlIHF1ZXJpZWQgZm9yIGhpZ2gtdmFsdWUgcGF5bWVudCBzZW5kZXJzLgAAAAAAAAlLeWNPcmFjbGUAAAAAAAAAAAAAPlBheW1lbnRzIHN0cmljdGx5IGFib3ZlIHRoaXMgYW1vdW50IHJlcXVpcmUgYSB2YWxpZCBLWUMgY2xhaW0uAAAAAAAMS3ljVGhyZXNob2xkAAAAAQAAAEZBY3RpdmUgZGVzaWduYXRlZCBhZGRyZXNzIGZvciBhbiBhZG1pbmlzdHJhdGl2ZSByb2xlOiBSb2xlIC0+IEFkZHJlc3MuAAAAAAAEUm9sZQAAAAEAAAfQAAAABFJvbGUAAAABAAAATldoZXRoZXIgYW4gYWRkcmVzcyBoYXMgYmVlbiBhc3NpZ25lZCBhIHNwZWNpZmljIHJvbGU6IChBZGRyZXNzLCBSb2xlKSAtPiBib29sLgAAAAAACFVzZXJSb2xlAAAAAgAAABMAAAfQAAAABFJvbGU=",
        "AAAAAQAAAE1BIHNpbmdsZSB0cmFuc2ZlciBpbnN0cnVjdGlvbiBmb3IgdXNlIHdpdGggW2BQYXltZW50Um91dGVyOjpyb3V0ZV9wYXltZW50c2BdLgAAAAAAAAAAAAAHUGF5bWVudAAAAAAEAAAAgEFtb3VudCB0byByb3V0ZSwgZGVub21pbmF0ZWQgaW4gdGhlIHRva2VuJ3Mgc21hbGxlc3QgdW5pdC4gTXVzdCBiZQpwb3NpdGl2ZSBhbmQgd2l0aGluIHRoZSBjb250cmFjdCdzIGNvbmZpZ3VyZWQgbWluL21heCBib3VuZHMuAAAABmFtb3VudAAAAAAACwAAADtBZGRyZXNzIHRoZSBmdW5kcyAobWludXMgdGhlIHBsYXRmb3JtIGZlZSkgYXJlIGNyZWRpdGVkIHRvLgAAAAAJcmVjaXBpZW50AAAAAAAAEwAAADxBZGRyZXNzIHRoZSBmdW5kcyBhcmUgZGViaXRlZCBmcm9tLiBNdXN0IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAGc2VuZGVyAAAAAAATAAAAR0NvbnRyYWN0IElEIG9mIHRoZSB0b2tlbiAob3IgU3RlbGxhciBBc3NldCBDb250cmFjdCkgYmVpbmcgdHJhbnNmZXJyZWQuAAAAAA10b2tlbl9hZGRyZXNzAAAAAAAAEw==",
        "AAAAAAAAApJPbmUtdGltZSBzZXR1cDogcmVjb3JkcyB0aGUgYWRtaW4gYW5kIHRoZSBpbml0aWFsIGZlZSBjb25maWd1cmF0aW9uCmluIGluc3RhbmNlIHN0b3JhZ2UuIE11c3QgYmUgY2FsbGVkIGJlZm9yZSBgcm91dGVfcGF5bWVudGAuCgojIFBhcmFtZXRlcnMKLSBgYWRtaW5gOiBBZGRyZXNzIGdyYW50ZWQgYWRtaW4gcmlnaHRzIG92ZXIgdGhlIGNvbnRyYWN0OyBtdXN0CmF1dGhvcml6ZSB0aGlzIGNhbGwuCi0gYHBsYXRmb3JtX3RyZWFzdXJ5YDogQWRkcmVzcyB0aGF0IHJlY2VpdmVzIGNvbGxlY3RlZCBwbGF0Zm9ybSBmZWVzLgotIGBmZWVfYnBzYDogUGxhdGZvcm0gZmVlIHJhdGUsIGluIGJhc2lzIHBvaW50cy4KLSBgZmVlX2NhcGA6IE1heGltdW0gZmVlIChpbiB0aGUgdG9rZW4ncyBzbWFsbGVzdCB1bml0KSB0YWtlbiBmcm9tIGEKc2luZ2xlIHBheW1lbnQuCi0gYG1heF9hbW91bnRgOiBNYXhpbXVtIGFtb3VudCBhY2NlcHRlZCBieSBhIHNpbmdsZSBwYXltZW50LgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6OkFscmVhZHlJbml0aWFsaXplZClgIGlmIHRoZQpjb250cmFjdCBhbHJlYWR5IGhhcyBhbiBhZG1pbiBzZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgYGFkbWluYCBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAKaW5pdGlhbGl6ZQAAAAAABQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAABFwbGF0Zm9ybV90cmVhc3VyeQAAAAAAABMAAAAAAAAAB2ZlZV9icHMAAAAACwAAAAAAAAAHZmVlX2NhcAAAAAALAAAAAAAAAAptYXhfYW1vdW50AAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAANJBbGlhcyBmb3IgYHNldF9wYXVzZWAuIEFkbWluLW9ubHkuCgojIFBhcmFtZXRlcnMKLSBgcGF1c2VkYDogYHRydWVgIHRvIHJlamVjdCByb3V0aW5nIGNhbGxzLCBgZmFsc2VgIHRvIGFsbG93IHRoZW0uCgojIFJldHVybnMKU2VlIGBzZXRfcGF1c2VgLgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IGFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAAAApzZXRfcGF1c2VkAAAAAAABAAAAAAAAAAZwYXVzZWQAAAAAAAEAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAWpBc3NpZ25zIGFuIG9wZXJhdGlvbmFsIHJvbGUgdG8gYSBzcGVjaWZpZWQgYWNjb3VudC4KClJlc3RyaWN0ZWQgZXhjbHVzaXZlbHkgdG8gYFN1cGVyQWRtaW5gLgoKIyBQYXJhbWV0ZXJzCi0gYGFjY291bnRgOiBUYXJnZXQgYWRkcmVzcyB0byByZWNlaXZlIHRoZSByb2xlLgotIGByb2xlYDogVGhlIGBSb2xlYCB2YXJpYW50IHRvIGdyYW50LgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgY29udHJhY3QgaXMgdW5pbml0aWFsaXplZC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBgU3VwZXJBZG1pbmAgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgAAAAAAC2Fzc2lnbl9yb2xlAAAAAAIAAAAAAAAAB2FjY291bnQAAAAAEwAAAAAAAAAEcm9sZQAAB9AAAAAEUm9sZQAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAgRSZXZva2VzIGFuIG9wZXJhdGlvbmFsIHJvbGUgZnJvbSBhIHNwZWNpZmllZCBhY2NvdW50LgoKUmVzdHJpY3RlZCBleGNsdXNpdmVseSB0byBgU3VwZXJBZG1pbmAuIFByZXZlbnRzIHJlbW92aW5nIHRoZSBhY3RpdmUgU3VwZXJBZG1pbgp3aGVuIGl0IHdvdWxkIGxlYXZlIHRoZSBjb250cmFjdCB3aXRob3V0IHJvb3QgZ292ZXJuYW5jZS4KCiMgUGFyYW1ldGVycwotIGBhY2NvdW50YDogVGFyZ2V0IGFkZHJlc3MgZnJvbSB3aGljaCB0aGUgcm9sZSB3aWxsIGJlIHJldm9rZWQuCi0gYHJvbGVgOiBUaGUgYFJvbGVgIHZhcmlhbnQgdG8gcmV2b2tlLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIGBFcnIoRXJyb3I6OkludmFsaWRSb2xlKWAgaWYgYXR0ZW1wdGluZyB0byByZXZva2Ugb3duIFN1cGVyQWRtaW4sCm9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgYFN1cGVyQWRtaW5gIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAALcmV2b2tlX3JvbGUAAAAAAgAAAAAAAAAHYWNjb3VudAAAAAATAAAAAAAAAARyb2xlAAAH0AAAAARSb2xlAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAa1VcGRhdGVzIHRoZSBmZWUgYmFzaXMgcG9pbnRzLgpSZXF1aXJlcyBnb3Zlcm5hbmNlIGF1dGhvcml0eSBpZiBhIGdvdmVybmFuY2UgYWRkcmVzcyBpcyBzZXQ7IG90aGVyd2lzZSBhZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYG5ld19mZWVfYnBzYDogTmV3IHBsYXRmb3JtIGZlZSByYXRlLCBpbiBiYXNpcyBwb2ludHMuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGNhbGxlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuCgpERVBSRUNBVEVEIGZvciBkaXJlY3QgdXNlLiAgUXVldWUgdmlhIGBxdWV1ZV9hY3Rpb24oQWN0aW9uVHlwZTo6U2V0RmVlQnBzKOKApikpYC4AAAAAAAALc2V0X2ZlZV9icHMAAAAAAQAAAAAAAAALbmV3X2ZlZV9icHMAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAA+dRdWV1ZXMgYW4gYWRtaW4gYWN0aW9uIHRvIGJlIGV4ZWN1dGVkIGFmdGVyIGEgMjQtaG91ciBkZWxheS4KClRoZSBhZG1pbiBwcm92aWRlcyB0aGUgZGVzaXJlZCBgQWN0aW9uVHlwZWAgdmFyaWFudCBhbmQgcmVjZWl2ZXMgYQpudW1lcmljIG5vbmNlIHRoYXQgdW5pcXVlbHkgaWRlbnRpZmllcyB0aGlzIHBlbmRpbmcgZW50cnkuICBQYXNzIHRoaXMKbm9uY2UgdG8gYGV4ZWN1dGVfYWN0aW9uYCBhZnRlciAyNCBob3Vycywgb3IgdG8gYGNhbmNlbF9hY3Rpb25gIHRvCmFib3J0IHRoZSBpbnRlbnQuCgpTZW5zaXRpdmUgcGFyYW1ldGVyIGNoYW5nZXMgKGBzZXRfcGxhdGZvcm1fdHJlYXN1cnlgLCBgc2V0X2ZlZV9jb25maWdgLApgc2V0X2ZlZV9icHNgLCBgc2V0X2dvdmVybmFuY2VgLCBgc2V0X21pbl9saW1pdGAsIGB0cmFuc2Zlcl9hZG1pbmAsCmBzZXRfbXVsdGlzaWdfY29uZmlnYCwgYHVwZ3JhZGVgKSBtdXN0IGdvIHRocm91Z2ggdGhlIHRpbWVsb2NrLiAgVXNlIHRoZQpkaXJlY3Qgc2V0dGVyIGZ1bmN0aW9ucyBvbmx5IGZvciBhY3Rpb25zIHRoYXQgYXJlIG5vdCBzZW5zaXRpdmUgKGUuZy4KYHNldF9wYXVzZWAgd2hpY2ggY2FuIGFsc28gYmUgY2FsbGVkIGRpcmVjdGx5IGZvciBpbW1lZGlhdGUgb3BlcmF0aW9uYWwKcGF1c2VzKS4KClF1ZXVlaW5nIGRvZXMgbm90IHByZS1hdXRob3JpemUgYW55dGhpbmcgb24gaXRzIG93bjogYEFjdGlvblR5cGU6OlVwZ3JhZGVgCmFuZCBgQWN0aW9uVHlwZTo6U2V0TXVsdGlzaWdDb25maWdgIGFyZSByZS12YWxpZGF0ZWQgYXQgZXhlY3V0aW9uIHRpbWUsCnNvIGFuIHVwZ3JhZGUgcXVldWVkIHRvZGF5IHN0aWxsIG5lZWRzIHRoZSBtdWx0aS1zaWduYXR1cmUgdGhyZXNob2xkIHRvCmJlIG1ldCBmb3IgdGhhdCBoYXNoIHdoZW4gdGhlIGRlbGF5IGVsYXBzZXMuCgpUaGUgY29udHJhY3QgbXVzdCBub3QgYmUgZnJvemVuIHdoZW4gcXVldWluZywgYW5kIHRoZSBhZG1pbiBtdXN0CmF1dGhvcml6ZSB0aGUgY2FsbC4AAAAADHF1ZXVlX2FjdGlvbgAAAAEAAAAAAAAABmFjdGlvbgAAAAAH0AAAAApBY3Rpb25UeXBlAAAAAAABAAAD6QAAAAYAAAAD",
        "AAAAAgAAAK5EZXNjcmliZXMgd2hpY2ggYWRtaW5pc3RyYXRpdmUgcGFyYW1ldGVyIGNoYW5nZSBhIHRpbWVsb2NrIGVudHJ5IHJlcHJlc2VudHMuCkVhY2ggdmFyaWFudCBjYXJyaWVzIGFsbCB0aGUgYXJndW1lbnRzIG5lZWRlZCB0byBhcHBseSB0aGF0IGNoYW5nZSB3aGVuIHRoZQpkZWxheSBwZXJpb2QgaXMgb3Zlci4AAAAAAAAAAAAKQWN0aW9uVHlwZQAAAAAACAAAAAEAAAAlQ2hhbmdlIHRoZSBwbGF0Zm9ybSB0cmVhc3VyeSBhZGRyZXNzLgAAAAAAABNTZXRQbGF0Zm9ybVRyZWFzdXJ5AAAAAAEAAAATAAAAAQAAAEhVcGRhdGUgZmVlIGJhc2lzLXBvaW50cyBhbmQgZmVlIGNhcCB0b2dldGhlciAobGVnYWN5IC8gY29tYmluZWQgc2V0dGVyKS4AAAAMU2V0RmVlQ29uZmlnAAAAAgAAAAsAAAALAAAAAQAAAB1VcGRhdGUgZmVlIGJhc2lzLXBvaW50cyBvbmx5LgAAAAAAAAlTZXRGZWVCcHMAAAAAAAABAAAACwAAAAEAAAAkU2V0IHRoZSBnb3Zlcm5hbmNlIGNvbnRyYWN0IGFkZHJlc3MuAAAADVNldEdvdmVybmFuY2UAAAAAAAABAAAAEwAAAAEAAAAhQ2hhbmdlIHRoZSBtaW5pbXVtIHJvdXRpbmcgbGltaXQuAAAAAAAAC1NldE1pbkxpbWl0AAAAAAEAAAALAAAAAQAAACdUcmFuc2ZlciBhZG1pbiByaWdodHMgdG8gYSBuZXcgYWRkcmVzcy4AAAAADVRyYW5zZmVyQWRtaW4AAAAAAAABAAAAEwAAAAEAAAD8VXBncmFkZSB0aGUgY29udHJhY3QgV0FTTS4KCkV4ZWN1dGluZyB0aGlzIGFjdGlvbiBhbHNvIHJlcXVpcmVzIHRoZSBtdWx0aS1zaWduYXR1cmUgYWRtaW4gZ3JvdXAgdG8KaGF2ZSBhcHByb3ZlZCBgbmV3X3dhc21faGFzaGAgKHNlZSBbYFBheW1lbnRSb3V0ZXI6OmFwcHJvdmVfdXBncmFkZWBdKSwKc28gdGhlIHRpbWVsb2NrIGRlbGF5IGFuZCB0aGUgTS1vZi1OIGdhdGUgY29tcG9zZSByYXRoZXIgdGhhbiByZXBsYWNlCmVhY2ggb3RoZXIuAAAAB1VwZ3JhZGUAAAAAAQAAA+4AAAAgAAAAAQAAAEFSZXBsYWNlIHRoZSBtdWx0aS1zaWduYXR1cmUgYWRtaW4gZ3JvdXAgdGhhdCBhdXRob3JpemVzIHVwZ3JhZGVzLgAAAAAAABFTZXRNdWx0aXNpZ0NvbmZpZwAAAAAAAAIAAAPqAAAAEwAAAAQ=",
        "AAAAAAAAAThDYW5jZWxzIGEgcGVuZGluZyB0aW1lbG9jayBlbnRyeSBiZWZvcmUgaXQgY2FuIGJlIGV4ZWN1dGVkLgoKVGhpcyBpcyB0aGUgcHJpbWFyeSBkZWZlbmNlIHdoZW4gYSBjb21wcm9taXNlZCBhZG1pbiBoYXMgcXVldWVkIGEKbWFsaWNpb3VzIGFjdGlvbjogYW55IG90aGVyIGFkbWluIChhZnRlciBhIGtleSByb3RhdGlvbikgb3IgYQptdWx0aS1zaWcgZ292ZXJuYW5jZSBjYW4gY2FuY2VsIGl0IHdpdGhpbiB0aGUgMjQtaG91ciB3aW5kb3cuCgpBZG1pbiBhdXRob3JpemF0aW9uIGlzIHJlcXVpcmVkLiBUaGUgY29udHJhY3QgbWF5IGJlIGZyb3plbi4AAAANY2FuY2VsX2FjdGlvbgAAAAAAAAEAAAAAAAAABW5vbmNlAAAAAAAABgAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAFlDbGFpbXMgYWxsIGN1cnJlbnRseSBhdmFpbGFibGUgeWllbGQgdG8gdGhlIHBsYXRmb3JtIHRyZWFzdXJ5LiBUcmVhc3VyeU1hbmFnZXItcHJvdGVjdGVkLgAAAAAAAA1oYXJ2ZXN0X3lpZWxkAAAAAAAAAQAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAA/ZSb3V0ZXMgYSBwYXltZW50IGZyb20gYSBzZW5kZXIgdG8gYSByZWNpcGllbnQsIGRlZHVjdGluZyBhIHBsYXRmb3JtIGZlZS4KCiMgUGFyYW1ldGVycwotIGBzZW5kZXJgOiBBZGRyZXNzIHRoZSBmdW5kcyBhcmUgZGViaXRlZCBmcm9tOyBtdXN0IGF1dGhvcml6ZSB0aGUgY2FsbC4KLSBgcmVjaXBpZW50YDogQWRkcmVzcyB0byByZWNlaXZlIHRoZSBmdW5kcyAobWludXMgdGhlIHBsYXRmb3JtIGZlZSkuCi0gYHRva2VuX2FkZHJlc3NgOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4gYmVpbmcgdHJhbnNmZXJyZWQuCi0gYGFtb3VudGA6IEFtb3VudCB0byByb3V0ZSwgaW4gdGhlIHRva2VuJ3Mgc21hbGxlc3QgdW5pdC4gTXVzdCBiZQpwb3NpdGl2ZSBhbmQgd2l0aGluIHRoZSBjb25maWd1cmVkIG1pbi9tYXggYW5kIGRhaWx5LWxpbWl0IGJvdW5kcy4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLiBSZXR1cm5zIGBFcnIoRXJyb3I6OlBhdXNlZClgIGlmIHJvdXRpbmcgaXMKcGF1c2VkLCBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdCBoYXMgbm8gYWRtaW4Kc2V0LCBgRXJyKEVycm9yOjpJbnZhbGlkUmVjaXBpZW50KWAgaWYgYHNlbmRlciA9PSByZWNpcGllbnRgLApgRXJyKEVycm9yOjpCbGFja2xpc3RlZClgIGlmIGByZWNpcGllbnRgIGlzIGJsYWNrbGlzdGVkLApgRXJyKEVycm9yOjpMaW1pdEV4Y2VlZGVkKWAgaWYgYGFtb3VudGAgaXMgb3V0c2lkZSB0aGUgY29uZmlndXJlZApib3VuZHMgb3IgZXhjZWVkcyB0aGUgc2VuZGVyJ3MgcmVtYWluaW5nIGRhaWx5IGxpbWl0LCBvcgpgRXJyKEVycm9yOjpJbnN1ZmZpY2llbnRCYWxhbmNlKWAgaWYgYHNlbmRlcmAncyB0b2tlbiBiYWxhbmNlIGlzCmJlbG93IGBhbW91bnRgLgoKIyBQYW5pY3MKUGFuaWNzIGlmIGBzZW5kZXJgIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYgdGhlIHVuZGVybHlpbmcKdG9rZW4gdHJhbnNmZXIgdG8gYHBsYXRmb3JtX3RyZWFzdXJ5YCBmYWlscy4AAAAAAA1yb3V0ZV9wYXltZW50AAAAAAAABAAAAAAAAAAGc2VuZGVyAAAAAAATAAAAAAAAAAlyZWNpcGllbnQAAAAAAAATAAAAAAAAAA10b2tlbl9hZGRyZXNzAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAbNTZXRzIHRoZSBtaW5pbXVtIGFsbG93ZWQgcm91dGluZyBhbW91bnQuIEZlZU1hbmFnZXItcHJvdGVjdGVkLgoKIyBQYXJhbWV0ZXJzCi0gYG1pbl9saW1pdGA6IFNtYWxsZXN0IGBhbW91bnRgIHRoYXQgYHJvdXRlX3BheW1lbnRgIC8KYHJvdXRlX3BheW1lbnRzYCB3aWxsIGFjY2VwdCBnb2luZyBmb3J3YXJkLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0CmhhcyBubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IEZlZU1hbmFnZXIgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlNldE1pbkxpbWl0KOKApikpYC4AAAAADXNldF9taW5fbGltaXQAAAAAAAABAAAAAAAAAAltaW5fbGltaXQAAAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAURFeGVjdXRlcyBhIHByZXZpb3VzbHkgcXVldWVkIGFjdGlvbiBpZGVudGlmaWVkIGJ5IGBub25jZWAuCgpSZXF1aXJlbWVudHM6Ci0gVGhlIGNvbnRyYWN0IG11c3Qgbm90IGJlIGZyb3plbi4KLSBUaGUgYWRtaW4gbXVzdCBhdXRob3JpemUuCi0gVGhlIGVudHJ5IGlkZW50aWZpZWQgYnkgYG5vbmNlYCBtdXN0IGV4aXN0LgotIEF0IGxlYXN0IDI0IGhvdXJzIChgU0VDT05EU19JTl8yNEhgKSBtdXN0IGhhdmUgcGFzc2VkIHNpbmNlIHF1ZXVpbmcuCgpPbiBzdWNjZXNzIHRoZSBlbnRyeSBpcyByZW1vdmVkIGFuZCB0aGUgdW5kZXJseWluZyBzZXR0ZXIgaXMgaW52b2tlZC4AAAAOZXhlY3V0ZV9hY3Rpb24AAAAAAAEAAAAAAAAABW5vbmNlAAAAAAAABgAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAIVSZXR1cm5zIHRoZSBhZG1pbmlzdHJhdGl2ZSByb2xlIGdvdmVybmluZyB0aGUgc3BlY2lmaWVkIHJvbGUuCgpJbiB0aGlzIFJCQUMgYXJjaGl0ZWN0dXJlLCBgU3VwZXJBZG1pbmAgZ292ZXJucyBhbGwgb3BlcmF0aW9uYWwgcm9sZXMuAAAAAAAADmdldF9yb2xlX2FkbWluAAAAAAABAAAAAAAAAAVfcm9sZQAAAAAAB9AAAAAEUm9sZQAAAAEAAAfQAAAABFJvbGU=",
        "AAAAAAAAALNSZXR1cm5zIHdoZXRoZXIgYW4gYWRkcmVzcyBpcyBibGFja2xpc3RlZC4KCiMgUGFyYW1ldGVycwotIGBhZGRyZXNzYDogQWRkcmVzcyB0byBjaGVjay4KCiMgUmV0dXJucwpgdHJ1ZWAgaWYgYGFkZHJlc3NgIGlzIGJsYWNrbGlzdGVkLCBgZmFsc2VgIG90aGVyd2lzZS4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAAAOaXNfYmxhY2tsaXN0ZWQAAAAAAAEAAAAAAAAAB2FkZHJlc3MAAAAAEwAAAAEAAAAB",
        "AAAAAAAAAfNSZWNvdmVycyB0b2tlbnMgYWNjaWRlbnRhbGx5IHNlbnQgZGlyZWN0bHkgdG8gdGhlIGNvbnRyYWN0IGFkZHJlc3MuIFRyZWFzdXJ5TWFuYWdlci1wcm90ZWN0ZWQuCgojIFBhcmFtZXRlcnMKLSBgdG9rZW5gOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4gdG8gcmVjb3Zlci4KLSBgYW1vdW50YDogQW1vdW50IHRvIHRyYW5zZmVyIGZyb20gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSB0byB0aGUgdHJlYXN1cnkgbWFuYWdlci4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBUcmVhc3VyeU1hbmFnZXIgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLCBvciBpZiB0aGUKdG9rZW4gdHJhbnNmZXIgZmFpbHMgKGUuZy4gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSBpcyBiZWxvdyBgYW1vdW50YCkuAAAAAA5yZWNvdmVyX3Rva2VucwAAAAAAAgAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAnhSb3V0ZXMgbXVsdGlwbGUgcGF5bWVudHMgaW4gYSBzaW5nbGUgdHJhbnNhY3Rpb24uIElmIGFueSBwYXltZW50IGZhaWxzLAp0aGUgZW50aXJlIGJhdGNoIGlzIHJldmVydGVkIGF0b21pY2FsbHkuCgojIFBhcmFtZXRlcnMKLSBgcGF5bWVudHNgOiBCYXRjaCBvZiB0cmFuc2ZlciBpbnN0cnVjdGlvbnMgdG8gYXBwbHkgaW4gb3JkZXIuIFNlZQpbYFBheW1lbnRgXSBmb3IgcGVyLWl0ZW0gY29uc3RyYWludHMuCgojIFJldHVybnMKYE9rKCgpKWAgaWYgZXZlcnkgcGF5bWVudCBpbiB0aGUgYmF0Y2ggc3VjY2VlZHMuIFJldHVybnMgdGhlIGZpcnN0CmVycm9yIGVuY291bnRlcmVkIChzZWUgYHJvdXRlX3BheW1lbnRgIGZvciB0aGUgcG9zc2libGUgYEVycmAKdmFyaWFudHMgYW5kIHRoZWlyIGNhdXNlcykgaWYgYW55IHBheW1lbnQgZmFpbHM7IHRoZSBTb3JvYmFuIGhvc3QKcmV2ZXJ0cyBhbGwgc3RvcmFnZSBhbmQgYmFsYW5jZSBjaGFuZ2VzIGZyb20gdGhlIGJhdGNoIGluIHRoYXQgY2FzZS4KCiMgUGFuaWNzClBhbmljcyBpZiBhbnkgcGF5bWVudCdzIGBzZW5kZXJgIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYKYSB0b2tlbiB0cmFuc2ZlciB0byBgcGxhdGZvcm1fdHJlYXN1cnlgIGZhaWxzLgAAAA5yb3V0ZV9wYXltZW50cwAAAAAAAQAAAAAAAAAIcGF5bWVudHMAAAPqAAAH0AAAAAdQYXltZW50AAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAWxBbGlhcyBmb3IgYHNldF9mZWVfY29uZmlnX2xlZ2FjeWAuIEFkbWluLW9ubHkuCgojIFBhcmFtZXRlcnMKLSBgZmVlX2Jwc2A6IE5ldyBwbGF0Zm9ybSBmZWUgcmF0ZSwgaW4gYmFzaXMgcG9pbnRzLgotIGBmZWVfY2FwYDogTmV3IG1heGltdW0gZmVlIHRha2VuIGZyb20gYSBzaW5nbGUgcGF5bWVudC4KCiMgUmV0dXJucwpTZWUgYHNldF9mZWVfY29uZmlnX2xlZ2FjeWAuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgYWRtaW4gZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlNldEZlZUNvbmZpZyjigKYpKWAuAAAADnNldF9mZWVfY29uZmlnAAAAAAACAAAAAAAAAAdmZWVfYnBzAAAAAAsAAAAAAAAAB2ZlZV9jYXAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAPVTZXRzIHRoZSBnb3Zlcm5hbmNlIGNvbnRyYWN0IGFkZHJlc3MuIEFmdGVyIHRoaXMgY2FsbCwgb25seSB0aGUgZ292ZXJuYW5jZQpjb250cmFjdCBjYW4gdXBkYXRlIGZlZXMuIEFkbWluLW9ubHkg4oCUIGNhbiBvbmx5IGJlIHNldCBvbmNlIHBlciBnb3Zlcm5hbmNlIGN5Y2xlLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlNldEdvdmVybmFuY2Uo4oCmKSlgLgAAAAAAAA5zZXRfZ292ZXJuYW5jZQAAAAAAAQAAAAAAAAADZ292AAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAGRDb25maWd1cmVzIHRoZSB0cnVzdGVkIEtZQyBvcmFjbGUgYW5kIHRoZSBoaWdoLXZhbHVlIHBheW1lbnQgdGhyZXNob2xkLiBDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuAAAADnNldF9reWNfY29uZmlnAAAAAAACAAAAAAAAAAZvcmFjbGUAAAAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAZZUcmFuc2ZlcnMgYWRtaW4gcmlnaHRzIHRvIGEgbmV3IGFkZHJlc3MuIFJlcXVpcmVzIGN1cnJlbnQgU3VwZXJBZG1pbiBhdXRob3JpemF0aW9uLgoKIyBQYXJhbWV0ZXJzCi0gYG5ld19hZG1pbmA6IEFkZHJlc3MgdG8gYmVjb21lIHRoZSBuZXcgYWRtaW4uCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgU3VwZXJBZG1pbiBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuCgpERVBSRUNBVEVEIGZvciBkaXJlY3QgdXNlLiAgUXVldWUgdmlhIGBxdWV1ZV9hY3Rpb24oQWN0aW9uVHlwZTo6VHJhbnNmZXJBZG1pbijigKYpKWAuAAAAAAAOdHJhbnNmZXJfYWRtaW4AAAAAAAEAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAQAAASdBIHVzZXIncyByb2xsaW5nIDI0LWhvdXIgc3BlbmRpbmcgcmVjb3JkLgoKUmV0YWluZWQgcHVyZWx5IHNvIGV4aXN0aW5nIHRlc3Qgc25hcHNob3RzIHRoYXQgcmVmZXJlbmNlIHRoaXMgdHlwZSBieQpuYW1lIGtlZXAgY29tcGlsaW5nLiBMaXZlIGNvbnRyYWN0IHN0YXRlIGlzIHN0b3JlZCBhcyBhIHBhY2tlZApgQnl0ZXNOPDI0PmAgKHNlZSBgcGFja19zcGVuZGluZ2AgLyBgdW5wYWNrX3NwZW5kaW5nYCk7IHRoaXMgc3RydWN0IGlzIG5vdApyZWFkIGZyb20gb3Igd3JpdHRlbiB0byBzdG9yYWdlIGF0IHJ1bnRpbWUuAAAAAAAAAAAMVXNlclNwZW5kaW5nAAAAAgAAADhUb3RhbCBhbW91bnQgcm91dGVkIGJ5IHRoZSB1c2VyIHNpbmNlIGBsYXN0X3Jlc2V0X3RpbWVgLgAAABJhY2N1bXVsYXRlZF9hbW91bnQAAAAAAAsAAABAVW5peCB0aW1lc3RhbXAgKHNlY29uZHMpIGF0IHdoaWNoIHRoZSAyNC1ob3VyIHdpbmRvdyBsYXN0IHJlc2V0LgAAAA9sYXN0X3Jlc2V0X3RpbWUAAAAABg==",
        "AAAAAAAAAL5SZXR1cm5zIHRoZSBwcmltYXJ5IGRlc2lnbmF0ZWQgbWVtYmVyIGFkZHJlc3MgZm9yIGEgcm9sZSwgaWYgb25lIGlzIGNvbmZpZ3VyZWQuCgojIFBhcmFtZXRlcnMKLSBgcm9sZWA6IFRoZSByb2xlIHZhcmlhbnQgdG8gcXVlcnkuCgojIFJldHVybnMKYFNvbWUoQWRkcmVzcylgIGlmIHNldCwgb3IgYE5vbmVgIGlmIHVuYXNzaWduZWQuAAAAAAAPZ2V0X3JvbGVfbWVtYmVyAAAAAAEAAAAAAAAABHJvbGUAAAfQAAAABFJvbGUAAAABAAAD6AAAABM=",
        "AAAAAAAAAPhSZXR1cm5zIHRoZSBjdW11bGF0aXZlIGFtb3VudCBhIGdpdmVuIHNlbmRlciBoYXMgcm91dGVkIHRocm91Z2ggdGhlIGNvbnRyYWN0LgoKIyBQYXJhbWV0ZXJzCi0gYHVzZXJgOiBTZW5kZXIgYWRkcmVzcyB0byBsb29rIHVwLgoKIyBSZXR1cm5zClRoZSBsaWZldGltZSByb3V0ZWQgdm9sdW1lIGZvciBgdXNlcmAsIG9yIGAwYCBpZiB0aGV5IGhhdmUgbmV2ZXIKcm91dGVkIGEgcGF5bWVudC4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAA9nZXRfdXNlcl92b2x1bWUAAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAACw==",
        "AAAAAAAAAs1XaXRoZHJhd3MgYSBzcGVjaWZpYyBhbW91bnQgZnJvbSB0aGUgdXNlcidzIGludGVybmFsIHJlZnVuZCBiYWxhbmNlLgoKQSByZWZ1bmQgYmFsYW5jZSBhY2NydWVzIHdoZW4gYSBgcm91dGVfcGF5bWVudGAgLyBgcm91dGVfcGF5bWVudHNgCnRyYW5zZmVyIHRvIHRoZSByZWNpcGllbnQgZmFpbHMgKGUuZy4gbWlzc2luZyB0cnVzdGxpbmUpIGFuZCB0aGUKZnVuZHMgYXJlIGhlbGQgYnkgdGhlIGNvbnRyYWN0IG9uIHRoZSBzZW5kZXIncyBiZWhhbGYgaW5zdGVhZC4KCiMgUGFyYW1ldGVycwotIGB1c2VyYDogQWRkcmVzcyB3aXRoZHJhd2luZyBmdW5kczsgbXVzdCBhdXRob3JpemUgdGhlIGNhbGwuCi0gYHRva2VuYDogQ29udHJhY3QgSUQgb2YgdGhlIHRva2VuIHRvIHdpdGhkcmF3LgotIGBhbW91bnRgOiBBbW91bnQgdG8gd2l0aGRyYXcuIE11c3QgYmUgcG9zaXRpdmUgYW5kIG5vdCBleGNlZWQgdGhlCmN1cnJlbnQgcmVmdW5kIGJhbGFuY2UuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm9SZWZ1bmRBdmFpbGFibGUpYCBpZiBgYW1vdW50YAppcyB6ZXJvLCBuZWdhdGl2ZSwgb3IgZ3JlYXRlciB0aGFuIHRoZSBhdmFpbGFibGUgYmFsYW5jZS4KCiMgUGFuaWNzClBhbmljcyBpZiBgdXNlcmAgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLCBvciBpZiB0aGUgdW5kZXJseWluZwp0b2tlbiB0cmFuc2ZlciBmYWlscy4AAAAAAAAPd2l0aGRyYXdfcmVmdW5kAAAAAAMAAAAAAAAABHVzZXIAAAATAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAQAAAD1BIHBlbmRpbmcgdGltZWxvY2sgZW50cnkgc3RvcmVkIGluIHBlcnNpc3RlbnQgbGVkZ2VyIHN0b3JhZ2UuAAAAAAAAAAAAAA1UaW1lbG9ja0VudHJ5AAAAAAAAAgAAADdUaGUgYWN0aW9uIHBheWxvYWQgdG8gYXBwbHkgb25jZSB0aGUgZGVsYXkgaGFzIGVsYXBzZWQuAAAAAAZhY3Rpb24AAAAAB9AAAAAKQWN0aW9uVHlwZQAAAAAAQ0xlZGdlciB0aW1lc3RhbXAgKHNlY29uZHMgc2luY2UgZXBvY2gpIHdoZW4gdGhpcyBhY3Rpb24gd2FzIHF1ZXVlZC4AAAAACXF1ZXVlZF9hdAAAAAAAAAY=",
        "AAAAAAAAAPlEZXBvc2l0cyBpZGxlIHRyZWFzdXJ5IGZ1bmRzIGludG8gdGhlIGNvbmZpZ3VyZWQgbGVuZGluZyBwcm90b2NvbC4KCkJvdGggdGhlIFRyZWFzdXJ5TWFuYWdlciBhbmQgdHJlYXN1cnkgYXV0aG9yaXplIHRoaXMgb3BlcmF0aW9uLiBUaGUgc2Vjb25kCmF1dGhvcml6YXRpb24gaXMgcmVxdWlyZWQgYmVjYXVzZSB0aGUgZnVuZHMgYXJlIGhlbGQgYnkgdGhlIHRyZWFzdXJ5LApyYXRoZXIgdGhhbiBieSB0aGlzIHJvdXRlciBjb250cmFjdC4AAAAAAAAQZGVwb3NpdF90b195aWVsZAAAAAIAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAWtJbnN0YW50bHkgZnJlZXplcyB0aGUgY29udHJhY3QsIGJsb2NraW5nIGFsbCBwYXltZW50cyBhbmQgdGltZWxvY2sKZXhlY3V0aW9ucy4gIFRoaXMgaXMgdGhlIGVtZXJnZW5jeSBsYXN0IHJlc29ydCB3aGVuIGFuIGFkbWluIGtleSBpcwprbm93biB0byBiZSBjb21wcm9taXNlZC4KClVubGlrZSBvdGhlciBzZW5zaXRpdmUgYWRtaW4gb3BlcmF0aW9ucywgZnJlZXplIHRha2VzIGVmZmVjdCBpbW1lZGlhdGVseQrigJQgaXQgZG9lcyBOT1QgZ28gdGhyb3VnaCB0aGUgdGltZWxvY2sg4oCUIHNvIGl0IGlzIGFsd2F5cyBhdmFpbGFibGUgYXMgYQpyYXBpZC1yZXNwb25zZSB0b29sLgoKQWRtaW4gYXV0aG9yaXphdGlvbiBpcyByZXF1aXJlZC4AAAAAEGVtZXJnZW5jeV9mcmVlemUAAAAAAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAV9BZGRzIGFuIGFkZHJlc3MgdG8gdGhlIGJsYWNrbGlzdC4gQ29tcGxpYW5jZU9mZmljZXItcHJvdGVjdGVkLgoKIyBQYXJhbWV0ZXJzCi0gYGFkZHJlc3NgOiBBZGRyZXNzIHRvIGJsYWNrbGlzdDsgc3Vic2VxdWVudCBwYXltZW50cyB0byBpdCBhcyBhCnJlY2lwaWVudCB3aWxsIGJlIHJlamVjdGVkLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0CmhhcyBubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IENvbXBsaWFuY2VPZmZpY2VyIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAAEWJsYWNrbGlzdF9hZGRyZXNzAAAAAAAAAQAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAaNDbGFpbXMgYW5kIHdpdGhkcmF3cyB0aGUgZW50aXJlIGF2YWlsYWJsZSByZWZ1bmQgYmFsYW5jZSBmb3IgYSB1c2VyIGFuZCB0b2tlbi4KCiMgUGFyYW1ldGVycwotIGB1c2VyYDogQWRkcmVzcyB3aXRoZHJhd2luZyBmdW5kczsgbXVzdCBhdXRob3JpemUgdGhlIGNhbGwuCi0gYHRva2VuYDogQ29udHJhY3QgSUQgb2YgdGhlIHRva2VuIHRvIHdpdGhkcmF3LgoKIyBSZXR1cm5zCmBPayhhbW91bnQpYCB3aXRoIHRoZSBhbW91bnQgd2l0aGRyYXduLCBvcgpgRXJyKEVycm9yOjpOb1JlZnVuZEF2YWlsYWJsZSlgIGlmIHRoZSByZWZ1bmQgYmFsYW5jZSBpcyB6ZXJvLgoKIyBQYW5pY3MKUGFuaWNzIGlmIGB1c2VyYCBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwsIG9yIGlmIHRoZSB1bmRlcmx5aW5nCnRva2VuIHRyYW5zZmVyIGZhaWxzLgAAAAARY2xhaW1fYWxsX3JlZnVuZHMAAAAAAAACAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAEhSZXR1cm5zIHRoZSBjb25maWd1cmVkIEtZQyB0aHJlc2hvbGQsIG9yIGBOb25lYCB3aGVuIGVuZm9yY2VtZW50IGlzIG9mZi4AAAARZ2V0X2t5Y190aHJlc2hvbGQAAAAAAAAAAAAAAQAAA+gAAAAL",
        "AAAAAAAAAFpSZXR1cm5zIHRoZSBwZW5kaW5nIGBUaW1lbG9ja0VudHJ5YCBmb3IgdGhlIGdpdmVuIG5vbmNlLCBvciBhbiBlcnJvciBpZgppdCBkb2VzIG5vdCBleGlzdC4AAAAAABFnZXRfcXVldWVkX2FjdGlvbgAAAAAAAAEAAAAAAAAABW5vbmNlAAAAAAAABgAAAAEAAAPpAAAH0AAAAA1UaW1lbG9ja0VudHJ5AAAAAAAAAw==",
        "AAAAAAAAAnFBZG1pbi1vbmx5IGVtZXJnZW5jeSB3aXRoZHJhd2FsIG9mIHRva2VucyBoZWxkIGJ5IHRoaXMgY29udHJhY3QuCgojIFBhcmFtZXRlcnMKLSBgdG9rZW5gOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4gdG8gd2l0aGRyYXcuCkFkbWluLW9ubHkgZW1lcmdlbmN5IHdpdGhkcmF3YWwgb2YgdG9rZW5zIGhlbGQgYnkgdGhpcyBjb250cmFjdC4gVHJlYXN1cnlNYW5hZ2VyLXByb3RlY3RlZC4KCiMgUGFyYW1ldGVycwotIGB0b2tlbmA6IENvbnRyYWN0IElEIG9mIHRoZSB0b2tlbiB0byB3aXRoZHJhdy4KLSBgYW1vdW50YDogQW1vdW50IHRvIHRyYW5zZmVyIGZyb20gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSB0byB0aGUgdHJlYXN1cnkgbWFuYWdlci4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBUcmVhc3VyeU1hbmFnZXIgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLCBvciBpZiB0aGUKdG9rZW4gdHJhbnNmZXIgZmFpbHMgKGUuZy4gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSBpcyBiZWxvdyBgYW1vdW50YCkuAAAAAAAAEmVtZXJnZW5jeV93aXRoZHJhdwAAAAAAAgAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAARJSZXR1cm5zIHRoZSBhdmFpbGFibGUgaW50ZXJuYWwgcmVmdW5kIGJhbGFuY2UgZm9yIGEgdXNlciBhbmQgdG9rZW4uCgojIFBhcmFtZXRlcnMKLSBgdXNlcmA6IEFkZHJlc3Mgd2hvc2UgcmVmdW5kIGJhbGFuY2UgdG8gbG9vayB1cC4KLSBgdG9rZW5gOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4uCgojIFJldHVybnMKVGhlIHJlZnVuZGFibGUgYmFsYW5jZSBmb3IgYCh1c2VyLCB0b2tlbilgLCBvciBgMGAgaWYgbm9uZSBpcyBoZWxkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAAAASZ2V0X3JlZnVuZF9iYWxhbmNlAAAAAAACAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAAAs=",
        "AAAAAAAAADRSZXR1cm5zIHRoZSB0cmFja2VkIHByaW5jaXBhbCBkZXBvc2l0ZWQgZm9yIGB0b2tlbmAuAAAAEmdldF95aWVsZF9wb3NpdGlvbgAAAAAAAQAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAAAs=",
        "AAAAAAAAAF5Db25maWd1cmVzIHRoZSBsZW5kaW5nIHByb3RvY29sIHVzZWQgZm9yIHRyZWFzdXJ5IHlpZWxkIG9wZXJhdGlvbnMuIFRyZWFzdXJ5TWFuYWdlci1wcm90ZWN0ZWQuAAAAAAASc2V0X3lpZWxkX3Byb3RvY29sAAAAAAABAAAAAAAAAAhwcm90b2NvbAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAMRSZWNvcmRzIGEgdG9rZW4gYXMgc3VwcG9ydGVkIChuby1vcDsgcm91dGluZyBhY2NlcHRzIGFueSB0b2tlbiBjb250cmFjdCBJRCkuCgojIFBhcmFtZXRlcnMKLSBgX3Rva2VuYDogSWdub3JlZDsgcHJlc2VudCBmb3IgQVBJIGNvbXBhdGliaWxpdHkuCgojIFJldHVybnMKQWx3YXlzIGBPaygoKSlgLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAE2FkZF9zdXBwb3J0ZWRfdG9rZW4AAAAAAQAAAAAAAAAGX3Rva2VuAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAATlSZW1vdmVzIGFuIGFkZHJlc3MgZnJvbSB0aGUgYmxhY2tsaXN0LiBDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuCgojIFBhcmFtZXRlcnMKLSBgYWRkcmVzc2A6IEFkZHJlc3MgdG8gcmVtb3ZlIGZyb20gdGhlIGJsYWNrbGlzdC4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBDb21wbGlhbmNlT2ZmaWNlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAAE3VuYmxhY2tsaXN0X2FkZHJlc3MAAAAAAQAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAF1XaXRoZHJhd3MgdHJlYXN1cnkgcHJpbmNpcGFsIGZyb20gdGhlIGNvbmZpZ3VyZWQgbGVuZGluZyBwcm90b2NvbC4gVHJlYXN1cnlNYW5hZ2VyLXByb3RlY3RlZC4AAAAAAAATd2l0aGRyYXdfZnJvbV95aWVsZAAAAAACAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAUlSZXR1cm5zIHRoZSBlZmZlY3RpdmUgZmVlX2JwcyBmb3IgYSBzZW5kZXIgYWZ0ZXIgYXBwbHlpbmcgYW55CnZvbHVtZS1iYXNlZCB0aWVyZWQgZGlzY291bnQuCgojIFBhcmFtZXRlcnMKLSBgc2VuZGVyYDogQWRkcmVzcyB3aG9zZSBkaXNjb3VudGVkIGZlZSByYXRlIHRvIGNvbXB1dGUuCgojIFJldHVybnMKVGhlIGNvbmZpZ3VyZWQgYGZlZV9icHNgLCBoYWx2ZWQgaWYgYHNlbmRlcmAncyBsaWZldGltZSB2b2x1bWUKZXhjZWVkcyB0aGUgdGllcmVkLWRpc2NvdW50IHRocmVzaG9sZCwgb3IgYDBgIGlmIG5vdCBpbml0aWFsaXplZC4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAAAAABVnZXRfZWZmZWN0aXZlX2ZlZV9icHMAAAAAAAABAAAAAAAAAAZzZW5kZXIAAAAAABMAAAABAAAACw==",
        "AAAAAAAAAYxSZXR1cm5zIHRoZSBzaWduZXJzIHdob3NlIGFwcHJvdmFsIG9mIGFuIHVwZ3JhZGUgdG8gYG5ld193YXNtX2hhc2hgCmN1cnJlbnRseSBjb3VudHMuCgpBcHByb3ZhbHMgY2FzdCBieSBhIHNpZ25lciB0aGF0IGhhcyBzaW5jZSBiZWVuIHJvdGF0ZWQgb3V0IG9mIHRoZSBncm91cAphcmUgb21pdHRlZCwgc28gdGhpcyBsaXN0IGFsd2F5cyBhZ3JlZXMgd2l0aCBgaXNfdXBncmFkZV9hdXRob3JpemVkYC4KCiMgUmV0dXJucwpUaGUgY291bnRlZCBhcHByb3ZhbHMgaW4gdGhlIG9yZGVyIHRoZXkgd2VyZSByZWNvcmRlZCwgb3IgYW4gZW1wdHkKdmVjdG9yIGlmIHRoZSBoYXNoIGhhcyBub25lLiBFbXB0eSB3aGVuIG5vIGdyb3VwIGlzIGNvbmZpZ3VyZWQuCgojIFBhbmljcwpEb2VzIG5vdCBwYW5pYy4AAAAVZ2V0X3VwZ3JhZGVfYXBwcm92YWxzAAAAAAAAAQAAAAAAAAANbmV3X3dhc21faGFzaAAAAAAAA+4AAAAgAAAAAQAAA+oAAAAT",
        "AAAAAAAAAOZSZXR1cm5zIHdoZXRoZXIgYW4gdXBncmFkZSB0byBgbmV3X3dhc21faGFzaGAgaXMgYWxyZWFkeSBhdXRob3JpemVkLgoKIyBSZXR1cm5zCmB0cnVlYCBvbmNlIGBNYCBncm91cCBtZW1iZXJzIGhhdmUgYXBwcm92ZWQgdGhhdCBleGFjdCBoYXNoLgpgRXJyKEVycm9yOjpNdWx0aXNpZ05vdEluaXRpYWxpemVkKWAgaWYgbm8gZ3JvdXAgaXMgY29uZmlndXJlZC4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAAAAFWlzX3VwZ3JhZGVfYXV0aG9yaXplZAAAAAAAAAEAAAAAAAAADW5ld193YXNtX2hhc2gAAAAAAAPuAAAAIAAAAAEAAAPpAAAAAQAAAAM=",
        "AAAAAAAAAfJVcGRhdGVzIHRoZSBmZWUgYmFzaXMgcG9pbnRzIGFuZCBmZWUgY2FwLgpSZXF1aXJlcyBnb3Zlcm5hbmNlIGF1dGhvcml0eSBpZiBhIGdvdmVybmFuY2UgYWRkcmVzcyBpcyBzZXQ7IG90aGVyd2lzZSBhZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYGZlZV9icHNgOiBOZXcgcGxhdGZvcm0gZmVlIHJhdGUsIGluIGJhc2lzIHBvaW50cy4KLSBgZmVlX2NhcGA6IE5ldyBtYXhpbXVtIGZlZSB0YWtlbiBmcm9tIGEgc2luZ2xlIHBheW1lbnQuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGNhbGxlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuCgpERVBSRUNBVEVEIGZvciBkaXJlY3QgdXNlLiAgUXVldWUgdmlhIGBxdWV1ZV9hY3Rpb24oQWN0aW9uVHlwZTo6U2V0RmVlQ29uZmlnKOKApikpYC4AAAAAABVzZXRfZmVlX2NvbmZpZ19sZWdhY3kAAAAAAAACAAAAAAAAAAdmZWVfYnBzAAAAAAsAAAAAAAAAB2ZlZV9jYXAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAlFVcGRhdGVzIHRoZSB0cmVhc3VyeSBhZGRyZXNzIHRoYXQgcmVjZWl2ZXMgdGhlIHBsYXRmb3JtIGZlZS4KClVwZGF0ZXMgdGhlIHRyZWFzdXJ5IGFkZHJlc3MgdGhhdCByZWNlaXZlcyB0aGUgcGxhdGZvcm0gZmVlLiBQcm90ZWN0ZWQgYnkgVHJlYXN1cnlNYW5hZ2VyLgoKIyBQYXJhbWV0ZXJzCi0gYG5ld190cmVhc3VyeWA6IEFkZHJlc3MgdG8gcmVjZWl2ZSBwbGF0Zm9ybSBmZWVzIGdvaW5nIGZvcndhcmQuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgVHJlYXN1cnlNYW5hZ2VyIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4KCkRFUFJFQ0FURUQgZm9yIGRpcmVjdCB1c2UuICBRdWV1ZSB2aWEgYHF1ZXVlX2FjdGlvbihBY3Rpb25UeXBlOjpTZXRQbGF0Zm9ybVRyZWFzdXJ5KOKApikpYAphbmQgZXhlY3V0ZSBhZnRlciAyNCBob3Vycy4gIFRoaXMgZGlyZWN0IHBhdGggaXMgcmV0YWluZWQgZm9yIHRvb2xpbmcKY29tcGF0aWJpbGl0eSBvbmx5LgAAAAAAABVzZXRfcGxhdGZvcm1fdHJlYXN1cnkAAAAAAAABAAAAAAAAAAxuZXdfdHJlYXN1cnkAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=" ]),
      options
    )
  }
  public readonly fromJSON = {
    get_fee: this.txFromJSON<i128>,
        upgrade: this.txFromJSON<Result<void>>,
        version: this.txFromJSON<u32>,
        has_role: this.txFromJSON<boolean>,
        unfreeze: this.txFromJSON<Result<void>>,
        is_frozen: this.txFromJSON<boolean>,
        is_paused: this.txFromJSON<boolean>,
        set_admin: this.txFromJSON<Result<void>>,
        set_pause: this.txFromJSON<Result<void>>,
        initialize: this.txFromJSON<Result<void>>,
        set_paused: this.txFromJSON<Result<void>>,
        assign_role: this.txFromJSON<Result<void>>,
        revoke_role: this.txFromJSON<Result<void>>,
        set_fee_bps: this.txFromJSON<Result<void>>,
        queue_action: this.txFromJSON<Result<u64>>,
        cancel_action: this.txFromJSON<Result<void>>,
        harvest_yield: this.txFromJSON<Result<i128>>,
        route_payment: this.txFromJSON<Result<void>>,
        set_min_limit: this.txFromJSON<Result<void>>,
        cancel_upgrade: this.txFromJSON<Result<void>>,
        execute_action: this.txFromJSON<Result<void>>,
        get_role_admin: this.txFromJSON<Role>,
        is_blacklisted: this.txFromJSON<boolean>,
        recover_tokens: this.txFromJSON<Result<void>>,
        route_payments: this.txFromJSON<Result<void>>,
        set_fee_config: this.txFromJSON<Result<void>>,
        set_governance: this.txFromJSON<Result<void>>,
        set_kyc_config: this.txFromJSON<Result<void>>,
        transfer_admin: this.txFromJSON<Result<void>>,
        get_role_member: this.txFromJSON<Option<string>>,
        get_user_volume: this.txFromJSON<i128>,
        withdraw_refund: this.txFromJSON<Result<void>>,
        deposit_to_yield: this.txFromJSON<Result<void>>,
        emergency_freeze: this.txFromJSON<Result<void>>,
        blacklist_address: this.txFromJSON<Result<void>>,
        claim_all_refunds: this.txFromJSON<Result<i128>>,
        get_kyc_threshold: this.txFromJSON<Option<i128>>,
        get_queued_action: this.txFromJSON<Result<TimelockEntry>>,
        emergency_withdraw: this.txFromJSON<Result<void>>,
        get_refund_balance: this.txFromJSON<i128>,
        get_yield_position: this.txFromJSON<i128>,
        set_yield_protocol: this.txFromJSON<Result<void>>,
        add_supported_token: this.txFromJSON<Result<void>>,
        get_multisig_config: this.txFromJSON<Result<MultisigConfig>>,
        set_multisig_config: this.txFromJSON<Result<void>>,
        unblacklist_address: this.txFromJSON<Result<void>>,
        withdraw_from_yield: this.txFromJSON<Result<void>>,
        get_effective_fee_bps: this.txFromJSON<i128>,
        get_upgrade_approvals: this.txFromJSON<Array<string>>,
        is_upgrade_authorized: this.txFromJSON<Result<boolean>>,
        set_fee_config_legacy: this.txFromJSON<Result<void>>,
        set_platform_treasury: this.txFromJSON<Result<void>>,
        revoke_upgrade_approval: this.txFromJSON<Result<void>>
  }
}