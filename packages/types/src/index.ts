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
   * Swap parameters are self-contradictory or unusable (for example
   * `sell_token == buy_token`, or a non-positive `min_amount_out`).
   */
  19: {message:"InvalidSwapParams"},
  /**
   * The caller does not hold the role required by the entrypoint.
   */
  20: {message:"RoleNotFound"},
  /**
   * The requested role operation is invalid (for example revoking the
   * only active SuperAdmin, which would leave the contract without root
   * governance).
   */
  21: {message:"InvalidRole"},
  /**
   * No lending protocol has been configured by the admin.
   */
  22: {message:"YieldProtocolNotConfigured"},
  /**
   * Yield amount must be positive and withdrawals cannot exceed principal.
   */
  23: {message:"InvalidYieldAmount"},
  /**
   * The sender lacks a valid KYC claim for a high-value payment.
   */
  24: {message:"KycRequired"},
  /**
   * The configured KYC threshold must not be negative.
   */
  25: {message:"InvalidKycThreshold"},
  /**
   * No price-feed oracle has been configured by the admin.
   */
  26: {message:"OracleNotConfigured"},
  /**
   * The price reading returned by the oracle is older than the configured
   * staleness threshold and cannot be used.
   */
  27: {message:"OraclePriceStale"},
  /**
   * The price returned by the oracle is zero or negative, which is
   * logically invalid for an asset price.
   */
  28: {message:"OraclePriceInvalid"},
  /**
   * The call to the external oracle contract failed (e.g. the oracle
   * contract is unavailable or returned an unexpected error), and no
   * fallback price has been configured for the requested asset pair.
   */
  29: {message:"OracleCallFailed"},
  /**
   * A swap path is empty, malformed, or does not connect the requested assets.
   */
  30: {message:"InvalidSwapPath"},
  /**
   * A governance token has not been configured.
   */
  31: {message:"GovernanceNotConfigured"},
  /**
   * A governance proposal is missing, expired, or not yet ready.
   */
  32: {message:"InvalidProposal"},
  /**
   * The caller already voted on the proposal.
   */
  33: {message:"AlreadyVoted"},
  /**
   * Supplied meta-transaction nonce does not match stored nonce.
   */
  34: {message:"InvalidNonce"},
  /**
   * Meta-transaction deadline has passed (`ledger.timestamp() > deadline`).
   */
  35: {message:"DeadlineExpired"},
  /**
   * Off-chain ed25519 signature failed verification.
   * Note: `env.crypto().ed25519_verify` traps on invalid signatures,
   * so this variant documents the failure mode for integrators.
   */
  36: {message:"InvalidSignature"}
}

/**
 * Storage keys for all contract instance and persistent data.
 */
export type DataKey = {tag: "Admin", values: void} | {tag: "Governance", values: void} | {tag: "PlatformTreasury", values: void} | {tag: "FeeBps", values: void} | {tag: "FeeCap", values: void} | {tag: "MinLimit", values: void} | {tag: "Paused", values: void} | {tag: "MaxAmount", values: void} | {tag: "UserVolume", values: readonly [string]} | {tag: "UserSpending", values: readonly [string]} | {tag: "Blacklist", values: readonly [string]} | {tag: "RefundBalance", values: readonly [string, string]} | {tag: "TimelockNonce", values: void} | {tag: "TimelockEntry", values: readonly [u64]} | {tag: "Frozen", values: void} | {tag: "RegisteredDex", values: readonly [string]} | {tag: "MaxSlippageBps", values: void} | {tag: "YieldProtocol", values: void} | {tag: "YieldPrincipal", values: readonly [string]} | {tag: "KycOracle", values: void} | {tag: "KycThreshold", values: void} | {tag: "Role", values: readonly [Role]} | {tag: "UserRole", values: readonly [string, Role]} | {tag: "MetaNonce", values: readonly [string]} | {tag: "OracleAddress", values: void} | {tag: "StalenessThreshold", values: void} | {tag: "FallbackPrice", values: readonly [string, string]} | {tag: "GovernanceToken", values: void} | {tag: "GovernanceQuorum", values: void} | {tag: "GovernanceNonce", values: void} | {tag: "GovernanceProposal", values: readonly [u64]} | {tag: "GovernanceVote", values: readonly [u64, string]};


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
   * Construct and simulate a get_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Fetches the current exchange rate for a (base, quote) asset pair from
   * the configured price-feed oracle, validates it, and returns the result.
   * 
   * ## Validation flow
   * 
   * 1. No oracle configured -> fallback, else `Err(Error::OracleNotConfigured)`.
   * 2. Oracle call fails (missing, trapping, or mistyped contract) ->
   * fallback, else `Err(Error::OracleCallFailed)`.
   * 3. Reading older than the staleness threshold (default 3 600 s) ->
   * fallback, else `Err(Error::OraclePriceStale)`. A threshold of `0`
   * disables the staleness check entirely.
   * 4. Price <= 0 -> fallback, else `Err(Error::OraclePriceInvalid)`.
   * 
   * On success the validated `PriceData` is returned to the caller and a
   * `price_ok` event is published for the requested pair.
   * 
   * ## Parameters
   * - `base_asset`: Address of the base asset (e.g. XLM native contract).
   * - `quote_asset`: Address of the quote asset (e.g. USDC contract).
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
   * Relays a user-signed payment on behalf of the user.
   * 
   * The user signs `SHA256(contract || sender || pubkey || recipient ||
   * token || amount || nonce || deadline)` off-chain with Ed25519.
   * Any relayer holding XLM for fees submits the payload; the contract
   * verifies the signature, checks `nonce` and `deadline`, then moves
   * funds via prior token allowance (`approve` + `transfer_from`).
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
      new ContractSpec([ "AAAAAwAAANtSb2xlIGRlZmluaXRpb25zIGZvciB0aGUgUm9sZS1CYXNlZCBBY2Nlc3MgQ29udHJvbCAoUkJBQykgc3lzdGVtLgoKU2VncmVnYXRlcyBvcGVyYXRpb25hbCBwcml2aWxlZ2VzIGFjcm9zcyBkZWRpY2F0ZWQgcm9sZSBib3VuZGFyaWVzOgpTdXBlckFkbWluIChyb290IEFkbWluKSwgUGF1c2VyLCBGZWVNYW5hZ2VyLCBUcmVhc3VyeU1hbmFnZXIsIGFuZApDb21wbGlhbmNlT2ZmaWNlci4AAAAAAAAAAARSb2xlAAAABQAAAIhTdXByZW1lIGFkbWluaXN0cmF0b3Igd2l0aCBleGNsdXNpdmUgYXV0aG9yaXR5IG92ZXIgcm9sZSBhc3NpZ25tZW50cywKY29udHJhY3QgdXBncmFkZXMsIGVtZXJnZW5jeSBmcmVlemUvdW5mcmVlemUsIGFuZCByb290IGdvdmVybmFuY2UuAAAAClN1cGVyQWRtaW4AAAAAAAEAAAB7TWFuYWdlciB3aXRoIGV4Y2x1c2l2ZSBhdXRob3JpdHkgb3ZlciBwbGF0Zm9ybSB0cmVhc3VyeSwgeWllbGQgb3BlcmF0aW9ucywKdG9rZW4gcmVjb3ZlcnksIGFuZCBlbWVyZ2VuY3kgYXNzZXQgd2l0aGRyYXdhbHMuAAAAAA9UcmVhc3VyeU1hbmFnZXIAAAAAAgAAAHdDb21wbGlhbmNlIG9mZmljZXIgd2l0aCBhdXRob3JpdHkgb3ZlciBhZGRyZXNzIGJsYWNrbGlzdGluZywgS1lDIG9yYWNsZQpjb25maWd1cmF0aW9ucywgYW5kIG9yYWNsZSBwcmljZSBjb25maWd1cmF0aW9uLgAAAAARQ29tcGxpYW5jZU9mZmljZXIAAAAAAAADAAAAYEZlZSBtYW5hZ2VyIHdpdGggYXV0aG9yaXR5IG92ZXIgcGxhdGZvcm0gZmVlIGJhc2lzIHBvaW50cywgZmVlIGNhcHMsIGFuZAptaW5pbXVtIHBheW1lbnQgbGltaXRzLgAAAApGZWVNYW5hZ2VyAAAAAAAEAAAAoVBhdXNlciB3aXRoIGF1dGhvcml0eSBvdmVyIHRoZSBvcGVyYXRpb25hbCBwYXVzZSBzd2l0Y2guIEtlcHQgc2VwYXJhdGUKZnJvbSB0aGUgYnJvYWRlciBjb21wbGlhbmNlIHJvbGUgc28gdGhlIGFiaWxpdHkgdG8gaGFsdCByb3V0aW5nIGNhbiBiZQpkZWxlZ2F0ZWQgbmFycm93bHkuAAAAAAAABlBhdXNlcgAAAAAABQ==",
        "AAAAAAAAAKxSZXR1cm5zIHRoZSBjdXJyZW50IHByb3RvY29sIGZlZSBwZXJjZW50YWdlIGluIGJhc2lzIHBvaW50cy4KCiMgUmV0dXJucwpUaGUgY29uZmlndXJlZCBgZmVlX2Jwc2AsIG9yIGAwYCBpZiB0aGUgY29udHJhY3QgaGFzIG5vdCBiZWVuCmluaXRpYWxpemVkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAB2dldF9mZWUAAAAAAAAAAAEAAAAL",
        "AAAAAAAAAidSZXBsYWNlcyB0aGlzIGNvbnRyYWN0J3MgV0FTTSB3aXRoIGEgcHJldmlvdXNseSB1cGxvYWRlZCB2ZXJzaW9uLiBTdXBlckFkbWluLXByb3RlY3RlZC4KCiMgUGFyYW1ldGVycwotIGBuZXdfd2FzbV9oYXNoYDogSGFzaCBvZiBhIFdBU00gYmxvYiBwcmV2aW91c2x5IHVwbG9hZGVkIHRvIHRoZQpuZXR3b3JrLCB0byBpbnN0YWxsIGFzIHRoaXMgY29udHJhY3QncyBuZXcgZXhlY3V0YWJsZS4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBTdXBlckFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYKYG5ld193YXNtX2hhc2hgIGRvZXMgbm90IHJlZmVyZW5jZSBhIHByZXZpb3VzbHkgdXBsb2FkZWQgV0FTTSBibG9iLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlVwZ3JhZGUo4oCmKSlgLgAAAAAHdXBncmFkZQAAAAABAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAHBSZXR1cm5zIHRoZSBjb250cmFjdCB2ZXJzaW9uLgoKIyBSZXR1cm5zClRoZSBjb250cmFjdCdzIHZlcnNpb24gbnVtYmVyLCBjdXJyZW50bHkgYDFgLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAB3ZlcnNpb24AAAAAAAAAAAEAAAAE",
        "AAAABAAAAIpDb250cmFjdC1sZXZlbCBlcnJvcnMgcmV0dXJuZWQgaW5zdGVhZCBvZiBwYW5pY2tpbmcsIHNvIGNhbGxlcnMgZ2V0IGEKc3BlY2lmaWMsIHN0YWJsZSBlcnJvciBjb2RlIHRvIGJyYW5jaCBvbiByYXRoZXIgdGhhbiBhbiBvcGFxdWUgdHJhcC4AAAAAAAAAAAAFRXJyb3IAAAAAAAAkAAAARUNhbGxlciBpcyBub3QgYXV0aG9yaXplZCB0byBwZXJmb3JtIHRoaXMgYWN0aW9uIChlLmcuIG5vdCB0aGUgYWRtaW4pLgAAAAAAAAxVbmF1dGhvcml6ZWQAAAABAAAAQlNlbmRlcidzIHRva2VuIGJhbGFuY2UgaXMgbG93ZXIgdGhhbiB0aGUgcmVxdWVzdGVkIHBheW1lbnQgYW1vdW50LgAAAAAAE0luc3VmZmljaWVudEJhbGFuY2UAAAAAAgAAAE1SZXF1ZXN0ZWQgYW1vdW50IGlzIG91dHNpZGUgYWxsb3dlZCBib3VuZHMsIG9yIGEgc3BlbmRpbmcgbGltaXQgd2FzIGV4Y2VlZGVkLgAAAAAAAA1MaW1pdEV4Y2VlZGVkAAAAAAAAAwAAAERgaW5pdGlhbGl6ZWAgd2FzIGNhbGxlZCBvbiBhIGNvbnRyYWN0IHRoYXQgYWxyZWFkeSBoYXMgYW4gYWRtaW4gc2V0LgAAABJBbHJlYWR5SW5pdGlhbGl6ZWQAAAAAAAQAAABOQW4gYWRtaW4tY29uZmlndXJlZCB2YWx1ZSAodHJlYXN1cnksIGZlZSwgYWRtaW4pIHdhcyByZWFkIGJlZm9yZSBgaW5pdGlhbGl6ZWAuAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAUAAABMVGhlIGNvbnRyYWN0IGlzIGN1cnJlbnRseSBwYXVzZWQ7IHJvdXRpbmcgY2FsbHMgYXJlIHJlamVjdGVkIHVudGlsIHVucGF1c2VkLgAAAAZQYXVzZWQAAAAAAAYAAABMQSBmZWUgY29uZmlndXJhdGlvbiB2YWx1ZSAoYmFzaXMgcG9pbnRzIG9yIGNhcCkgaXMgb3V0IG9mIHRoZSBhbGxvd2VkIHJhbmdlLgAAAA5JbnZhbGlkRmVlUmF0ZQAAAAAABwAAAEdTZW5kZXIgYW5kIHJlY2lwaWVudCBhZGRyZXNzZXMgYXJlIHRoZSBzYW1lIChzZWxmLXJvdXRpbmcgbm90IGFsbG93ZWQpLgAAAAAQSW52YWxpZFJlY2lwaWVudAAAAAgAAAAhUmVjaXBpZW50IGFkZHJlc3MgaXMgYmxhY2tsaXN0ZWQuAAAAAAAAC0JsYWNrbGlzdGVkAAAAAAkAAABPUmVxdWVzdGVkIHJlZnVuZCB3aXRoZHJhd2FsIGFtb3VudCBpcyB6ZXJvIG9yIGV4Y2VlZHMgYXZhaWxhYmxlIHJlZnVuZCBiYWxhbmNlLgAAAAARTm9SZWZ1bmRBdmFpbGFibGUAAAAAAAAKAAAAvEFuIGFjdGlvbiBpcyBhbHJlYWR5IHBlbmRpbmcgaW4gdGhlIHRpbWVsb2NrIHF1ZXVlOyBpdCBtdXN0IGJlIGV4ZWN1dGVkCm9yIGNhbmNlbGxlZCBiZWZvcmUgYSBkdXBsaWNhdGUgY2FuIGJlIHF1ZXVlZCAobm90IGN1cnJlbnRseSBlbmZvcmNlZCwKYnV0IHJlc2VydmVkIGZvciBmdXR1cmUgZGVkdXBsaWNhdGlvbiBsb2dpYykuAAAAD1RpbWVsb2NrUGVuZGluZwAAAAALAAAAQ1RoZSAyNC1ob3VyIGRlbGF5IGZvciB0aGUgZ2l2ZW4gdGltZWxvY2sgZW50cnkgaGFzIG5vdCBlbGFwc2VkIHlldC4AAAAAEFRpbWVsb2NrTm90UmVhZHkAAAAMAAAAM05vIHRpbWVsb2NrIGVudHJ5IGV4aXN0cyBmb3IgdGhlIHN1cHBsaWVkIG5vbmNlIElELgAAAAAQVGltZWxvY2tOb3RGb3VuZAAAAA0AAABJVGhlIGNvbnRyYWN0IGlzIGZyb3plbjsgYWxsIHBheW1lbnRzIGFuZCB0aW1lbG9jayBleGVjdXRpb25zIGFyZSBibG9ja2VkLgAAAAAAAA5Db250cmFjdEZyb3plbgAAAAAADgAAAD5UaGUgc3dhcCBuYW1lZCBhIERFWCByb3V0ZXIgdGhhdCB0aGUgYWRtaW4gaGFzIG5vdCByZWdpc3RlcmVkLgAAAAAAEERleE5vdFJlZ2lzdGVyZWQAAAAPAAAAQ1RoZSBERVggY3Jvc3MtY29udHJhY3QgY2FsbCByZXZlcnRlZCBvciByZXR1cm5lZCBhbiB1bnVzYWJsZSB2YWx1ZS4AAAAAClN3YXBGYWlsZWQAAAAAABAAAACAVGhlIHN3YXAgZGVsaXZlcmVkIGxlc3MgdGhhbiBgbWluX2Ftb3VudF9vdXRgLCBvciBtb3ZlZCB0aGUgb3V0cHV0CmZ1cnRoZXIgdGhhbiBgbWF4X3NsaXBwYWdlX2Jwc2AgYXdheSBmcm9tIHRoZSBjYWxsZXIncyBxdW90ZS4AAAAQU2xpcHBhZ2VFeGNlZWRlZAAAABEAAAA/VGhlIHN3YXAgd2FzIHN1Ym1pdHRlZCBhZnRlciBpdHMgYGRlYWRsaW5lYCBoYWQgYWxyZWFkeSBwYXNzZWQuAAAAABNTd2FwRGVhZGxpbmVFeHBpcmVkAAAAABIAAAB/U3dhcCBwYXJhbWV0ZXJzIGFyZSBzZWxmLWNvbnRyYWRpY3Rvcnkgb3IgdW51c2FibGUgKGZvciBleGFtcGxlCmBzZWxsX3Rva2VuID09IGJ1eV90b2tlbmAsIG9yIGEgbm9uLXBvc2l0aXZlIGBtaW5fYW1vdW50X291dGApLgAAAAARSW52YWxpZFN3YXBQYXJhbXMAAAAAAAATAAAAPVRoZSBjYWxsZXIgZG9lcyBub3QgaG9sZCB0aGUgcm9sZSByZXF1aXJlZCBieSB0aGUgZW50cnlwb2ludC4AAAAAAAAMUm9sZU5vdEZvdW5kAAAAFAAAAJJUaGUgcmVxdWVzdGVkIHJvbGUgb3BlcmF0aW9uIGlzIGludmFsaWQgKGZvciBleGFtcGxlIHJldm9raW5nIHRoZQpvbmx5IGFjdGl2ZSBTdXBlckFkbWluLCB3aGljaCB3b3VsZCBsZWF2ZSB0aGUgY29udHJhY3Qgd2l0aG91dCByb290CmdvdmVybmFuY2UpLgAAAAAAC0ludmFsaWRSb2xlAAAAABUAAAA1Tm8gbGVuZGluZyBwcm90b2NvbCBoYXMgYmVlbiBjb25maWd1cmVkIGJ5IHRoZSBhZG1pbi4AAAAAAAAaWWllbGRQcm90b2NvbE5vdENvbmZpZ3VyZWQAAAAAABYAAABGWWllbGQgYW1vdW50IG11c3QgYmUgcG9zaXRpdmUgYW5kIHdpdGhkcmF3YWxzIGNhbm5vdCBleGNlZWQgcHJpbmNpcGFsLgAAAAAAEkludmFsaWRZaWVsZEFtb3VudAAAAAAAFwAAADxUaGUgc2VuZGVyIGxhY2tzIGEgdmFsaWQgS1lDIGNsYWltIGZvciBhIGhpZ2gtdmFsdWUgcGF5bWVudC4AAAALS3ljUmVxdWlyZWQAAAAAGAAAADJUaGUgY29uZmlndXJlZCBLWUMgdGhyZXNob2xkIG11c3Qgbm90IGJlIG5lZ2F0aXZlLgAAAAAAE0ludmFsaWRLeWNUaHJlc2hvbGQAAAAAGQAAADZObyBwcmljZS1mZWVkIG9yYWNsZSBoYXMgYmVlbiBjb25maWd1cmVkIGJ5IHRoZSBhZG1pbi4AAAAAABNPcmFjbGVOb3RDb25maWd1cmVkAAAAABoAAABtVGhlIHByaWNlIHJlYWRpbmcgcmV0dXJuZWQgYnkgdGhlIG9yYWNsZSBpcyBvbGRlciB0aGFuIHRoZSBjb25maWd1cmVkCnN0YWxlbmVzcyB0aHJlc2hvbGQgYW5kIGNhbm5vdCBiZSB1c2VkLgAAAAAAABBPcmFjbGVQcmljZVN0YWxlAAAAGwAAAGRUaGUgcHJpY2UgcmV0dXJuZWQgYnkgdGhlIG9yYWNsZSBpcyB6ZXJvIG9yIG5lZ2F0aXZlLCB3aGljaCBpcwpsb2dpY2FsbHkgaW52YWxpZCBmb3IgYW4gYXNzZXQgcHJpY2UuAAAAEk9yYWNsZVByaWNlSW52YWxpZAAAAAAAHAAAAMJUaGUgY2FsbCB0byB0aGUgZXh0ZXJuYWwgb3JhY2xlIGNvbnRyYWN0IGZhaWxlZCAoZS5nLiB0aGUgb3JhY2xlCmNvbnRyYWN0IGlzIHVuYXZhaWxhYmxlIG9yIHJldHVybmVkIGFuIHVuZXhwZWN0ZWQgZXJyb3IpLCBhbmQgbm8KZmFsbGJhY2sgcHJpY2UgaGFzIGJlZW4gY29uZmlndXJlZCBmb3IgdGhlIHJlcXVlc3RlZCBhc3NldCBwYWlyLgAAAAAAEE9yYWNsZUNhbGxGYWlsZWQAAAAdAAAASkEgc3dhcCBwYXRoIGlzIGVtcHR5LCBtYWxmb3JtZWQsIG9yIGRvZXMgbm90IGNvbm5lY3QgdGhlIHJlcXVlc3RlZCBhc3NldHMuAAAAAAAPSW52YWxpZFN3YXBQYXRoAAAAAB4AAAArQSBnb3Zlcm5hbmNlIHRva2VuIGhhcyBub3QgYmVlbiBjb25maWd1cmVkLgAAAAAXR292ZXJuYW5jZU5vdENvbmZpZ3VyZWQAAAAAHwAAADxBIGdvdmVybmFuY2UgcHJvcG9zYWwgaXMgbWlzc2luZywgZXhwaXJlZCwgb3Igbm90IHlldCByZWFkeS4AAAAPSW52YWxpZFByb3Bvc2FsAAAAACAAAAApVGhlIGNhbGxlciBhbHJlYWR5IHZvdGVkIG9uIHRoZSBwcm9wb3NhbC4AAAAAAAAMQWxyZWFkeVZvdGVkAAAAIQAAADxTdXBwbGllZCBtZXRhLXRyYW5zYWN0aW9uIG5vbmNlIGRvZXMgbm90IG1hdGNoIHN0b3JlZCBub25jZS4AAAAMSW52YWxpZE5vbmNlAAAAIgAAAEdNZXRhLXRyYW5zYWN0aW9uIGRlYWRsaW5lIGhhcyBwYXNzZWQgKGBsZWRnZXIudGltZXN0YW1wKCkgPiBkZWFkbGluZWApLgAAAAAPRGVhZGxpbmVFeHBpcmVkAAAAACMAAACtT2ZmLWNoYWluIGVkMjU1MTkgc2lnbmF0dXJlIGZhaWxlZCB2ZXJpZmljYXRpb24uCk5vdGU6IGBlbnYuY3J5cHRvKCkuZWQyNTUxOV92ZXJpZnlgIHRyYXBzIG9uIGludmFsaWQgc2lnbmF0dXJlcywKc28gdGhpcyB2YXJpYW50IGRvY3VtZW50cyB0aGUgZmFpbHVyZSBtb2RlIGZvciBpbnRlZ3JhdG9ycy4AAAAAAAAQSW52YWxpZFNpZ25hdHVyZQAAACQ=",
        "AAAAAAAAAaxRdWVyaWVzIHdoZXRoZXIgYSBnaXZlbiBhY2NvdW50IGhvbGRzIGFuIGFjdGl2ZSByb2xlIGFzc2lnbm1lbnQuCgpSZWFkLW9ubHkgYW5kIGF1dGhvcml6YXRpb24tZnJlZS4gIFJlcG9ydHMgZWZmZWN0aXZlIGF1dGhvcml0eTogdGhlCmFjY291bnQgaXMgZ3JhbnRlZCB0aGUgcm9sZSBkaXJlY3RseSwgaXMgdGhlIHJvbGUncyBkZXNpZ25hdGVkIGhvbGRlciwKb3IgaXMgdGhlIHJvb3QgYWRtaW4gc3RhbmRpbmcgaW4gZm9yIGEgcm9sZSB0aGF0IGhhcyBub3QgYmVlbiBkZWxlZ2F0ZWQuCgojIFBhcmFtZXRlcnMKLSBgYWNjb3VudGA6IEFkZHJlc3MgdG8gcXVlcnkuCi0gYHJvbGVgOiBSb2xlIHZhcmlhbnQgdG8gY2hlY2suCgojIFJldHVybnMKYHRydWVgIGlmIHRoZSBhY2NvdW50IGNhbiBleGVyY2lzZSBgcm9sZWAsIGBmYWxzZWAgb3RoZXJ3aXNlLgAAAAhoYXNfcm9sZQAAAAIAAAAAAAAAB2FjY291bnQAAAAAEwAAAAAAAAAEcm9sZQAAB9AAAAAEUm9sZQAAAAEAAAAB",
        "AAAAAAAAAMNSZW1vdmVzIHRoZSBmcm96ZW4gc3RhdGUsIHJlc3RvcmluZyBub3JtYWwgY29udHJhY3Qgb3BlcmF0aW9uLgoKTGlrZSBgZW1lcmdlbmN5X2ZyZWV6ZWAsIHRoaXMgdGFrZXMgZWZmZWN0IGltbWVkaWF0ZWx5IGFuZCBkb2VzIG5vdApnbyB0aHJvdWdoIHRoZSB0aW1lbG9jay4KClN1cGVyQWRtaW4gYXV0aG9yaXphdGlvbiBpcyByZXF1aXJlZC4AAAAACHVuZnJlZXplAAAAAAAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAA2FGZXRjaGVzIHRoZSBjdXJyZW50IGV4Y2hhbmdlIHJhdGUgZm9yIGEgKGJhc2UsIHF1b3RlKSBhc3NldCBwYWlyIGZyb20KdGhlIGNvbmZpZ3VyZWQgcHJpY2UtZmVlZCBvcmFjbGUsIHZhbGlkYXRlcyBpdCwgYW5kIHJldHVybnMgdGhlIHJlc3VsdC4KCiMjIFZhbGlkYXRpb24gZmxvdwoKMS4gTm8gb3JhY2xlIGNvbmZpZ3VyZWQgLT4gZmFsbGJhY2ssIGVsc2UgYEVycihFcnJvcjo6T3JhY2xlTm90Q29uZmlndXJlZClgLgoyLiBPcmFjbGUgY2FsbCBmYWlscyAobWlzc2luZywgdHJhcHBpbmcsIG9yIG1pc3R5cGVkIGNvbnRyYWN0KSAtPgpmYWxsYmFjaywgZWxzZSBgRXJyKEVycm9yOjpPcmFjbGVDYWxsRmFpbGVkKWAuCjMuIFJlYWRpbmcgb2xkZXIgdGhhbiB0aGUgc3RhbGVuZXNzIHRocmVzaG9sZCAoZGVmYXVsdCAzIDYwMCBzKSAtPgpmYWxsYmFjaywgZWxzZSBgRXJyKEVycm9yOjpPcmFjbGVQcmljZVN0YWxlKWAuIEEgdGhyZXNob2xkIG9mIGAwYApkaXNhYmxlcyB0aGUgc3RhbGVuZXNzIGNoZWNrIGVudGlyZWx5Lgo0LiBQcmljZSA8PSAwIC0+IGZhbGxiYWNrLCBlbHNlIGBFcnIoRXJyb3I6Ok9yYWNsZVByaWNlSW52YWxpZClgLgoKT24gc3VjY2VzcyB0aGUgdmFsaWRhdGVkIGBQcmljZURhdGFgIGlzIHJldHVybmVkIHRvIHRoZSBjYWxsZXIgYW5kIGEKYHByaWNlX29rYCBldmVudCBpcyBwdWJsaXNoZWQgZm9yIHRoZSByZXF1ZXN0ZWQgcGFpci4KCiMjIFBhcmFtZXRlcnMKLSBgYmFzZV9hc3NldGA6IEFkZHJlc3Mgb2YgdGhlIGJhc2UgYXNzZXQgKGUuZy4gWExNIG5hdGl2ZSBjb250cmFjdCkuCi0gYHF1b3RlX2Fzc2V0YDogQWRkcmVzcyBvZiB0aGUgcXVvdGUgYXNzZXQgKGUuZy4gVVNEQyBjb250cmFjdCkuAAAAAAAACWdldF9wcmljZQAAAAAAAAIAAAAAAAAACmJhc2VfYXNzZXQAAAAAABMAAAAAAAAAC3F1b3RlX2Fzc2V0AAAAABMAAAABAAAD6QAAB9AAAAAJUHJpY2VEYXRhAAAAAAAAAw==",
        "AAAAAAAAADFSZXR1cm5zIHdoZXRoZXIgdGhlIGNvbnRyYWN0IGlzIGN1cnJlbnRseSBmcm96ZW4uAAAAAAAACWlzX2Zyb3plbgAAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAJRSZXR1cm5zIHdoZXRoZXIgdGhlIGNvbnRyYWN0IGlzIGN1cnJlbnRseSBwYXVzZWQuCgojIFJldHVybnMKYHRydWVgIGlmIHBhdXNlZCwgYGZhbHNlYCBpZiB1bnBhdXNlZCBvciBub3QgeWV0IGluaXRpYWxpemVkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAACWlzX3BhdXNlZAAAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAORTZXQgYSBuZXcgYWRtaW4uIFN1cGVyQWRtaW4tcHJvdGVjdGVkLgoKIyBQYXJhbWV0ZXJzCi0gYG5ld19hZG1pbmA6IEFkZHJlc3MgdG8gaW5zdGFsbCBhcyB0aGUgbmV3IGFkbWluLgoKIyBSZXR1cm5zCkFsd2F5cyBgT2soKCkpYC4KCiMgUGFuaWNzClBhbmljcyBpZiBhbiBhZG1pbiBpcyBhbHJlYWR5IHNldCBhbmQgY3VycmVudCBTdXBlckFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAZlQYXVzZXMgb3IgdW5wYXVzZXMgdGhlIHBheW1lbnQgcm91dGVyLiBQYXVzZXItcHJvdGVjdGVkLgoKIyBQYXJhbWV0ZXJzCi0gYHBhdXNlZGA6IGB0cnVlYCB0byByZWplY3QgYHJvdXRlX3BheW1lbnRgIC8gYHJvdXRlX3BheW1lbnRzYApjYWxscywgYGZhbHNlYCB0byBhbGxvdyB0aGVtIGFnYWluLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0CmhhcyBubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IFBhdXNlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuCgpUaGlzIGlzIE5PVCB0aW1lbG9ja2VkIOKAlCBvcGVyYXRpb25hbCBwYXVzaW5nIG11c3QgcmVtYWluIGluc3RhbnQuAAAAAAAACXNldF9wYXVzZQAAAAAAAAEAAAAAAAAABnBhdXNlZAAAAAAAAQAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAgAAADtTdG9yYWdlIGtleXMgZm9yIGFsbCBjb250cmFjdCBpbnN0YW5jZSBhbmQgcGVyc2lzdGVudCBkYXRhLgAAAAAAAAAAB0RhdGFLZXkAAAAAIAAAAAAAAAAaVGhlIGN1cnJlbnQgYWRtaW4gYWRkcmVzcy4AAAAAAAVBZG1pbgAAAAAAAAAAAABQR292ZXJuYW5jZSBjb250cmFjdCBhZGRyZXNzOyBpZiBzZXQsIGl0IHRha2VzIG92ZXIgZmVlLWF1dGhvcml0eSBmcm9tIHRoZSBhZG1pbi4AAAAKR292ZXJuYW5jZQAAAAAAAAAAAC5BZGRyZXNzIHRoYXQgcmVjZWl2ZXMgY29sbGVjdGVkIHBsYXRmb3JtIGZlZXMuAAAAAAAQUGxhdGZvcm1UcmVhc3VyeQAAAAAAAAA6UGxhdGZvcm0gZmVlIHJhdGUsIGluIGJhc2lzIHBvaW50cyAoMS8xMDB0aCBvZiBhIHBlcmNlbnQpLgAAAAAABkZlZUJwcwAAAAAAAAAAADNVcHBlciBib3VuZCBvbiB0aGUgZmVlIHRha2VuIGZyb20gYSBzaW5nbGUgcGF5bWVudC4AAAAABkZlZUNhcAAAAAAAAAAAAEZNaW5pbXVtIGFtb3VudCBhY2NlcHRlZCBieSBgcm91dGVfcGF5bWVudGAgLyBgcm91dGVfcGF5bWVudHNgLCBpZiBzZXQuAAAAAAAITWluTGltaXQAAAAAAAAAJFdoZXRoZXIgcm91dGluZyBpcyBjdXJyZW50bHkgcGF1c2VkLgAAAAZQYXVzZWQAAAAAAAAAAAAsTWF4aW11bSBhbW91bnQgYWNjZXB0ZWQgYnkgYSBzaW5nbGUgcGF5bWVudC4AAAAJTWF4QW1vdW50AAAAAAAAAQAAADRDdW11bGF0aXZlIGxpZmV0aW1lIGFtb3VudCByb3V0ZWQgYnkgYSBnaXZlbiBzZW5kZXIuAAAAClVzZXJWb2x1bWUAAAAAAAEAAAATAAAAAQAAADJQYWNrZWQgMjQtaG91ciBzcGVuZGluZyB3aW5kb3cgZm9yIGEgZ2l2ZW4gc2VuZGVyLgAAAAAADFVzZXJTcGVuZGluZwAAAAEAAAATAAAAAQAAADFXaGV0aGVyIGEgZ2l2ZW4gcmVjaXBpZW50IGFkZHJlc3MgaXMgYmxhY2tsaXN0ZWQuAAAAAAAACUJsYWNrbGlzdAAAAAAAAAEAAAATAAAAAQAAAGlJbnRlcm5hbCByZWZ1bmQgYmFsYW5jZSBmb3IgYSAodXNlciwgdG9rZW4pIHBhaXIsIGNyZWRpdGVkIHdoZW4gYQpkaXJlY3QgdHJhbnNmZXIgdG8gdGhlIHJlY2lwaWVudCBmYWlscy4AAAAAAAANUmVmdW5kQmFsYW5jZQAAAAAAAAIAAAATAAAAEwAAAAAAAAB+TW9ub3RvbmljYWxseS1pbmNyZWFzaW5nIG5vbmNlIGNvdW50ZXIgdXNlZCB0byBnZW5lcmF0ZSB1bmlxdWUgSURzIGZvcgp0aW1lbG9jayBlbnRyaWVzLiAgU3RvcmVkIGFzIGB1NjRgIGluIGluc3RhbmNlIHN0b3JhZ2UuAAAAAAANVGltZWxvY2tOb25jZQAAAAAAAAEAAABuQSBwZW5kaW5nIHRpbWVsb2NrIGVudHJ5IGtleWVkIGJ5IGl0cyBub25jZSBJRC4KU3RvcmVkIGluIHBlcnNpc3RlbnQgc3RvcmFnZSBzbyBpdCBzdXJ2aXZlcyBpbnN0YW5jZSBldmljdGlvbi4AAAAAAA1UaW1lbG9ja0VudHJ5AAAAAAAAAQAAAAYAAAAAAAAAeFdoZW4gYHRydWVgIHRoZSBjb250cmFjdCBpcyBmcm96ZW46IHBheW1lbnRzIGFuZCB0aW1lbG9jayBleGVjdXRpb25zCmFyZSBibG9ja2VkLiAgU3RvcmVkIGFzIGBib29sYCBpbiBpbnN0YW5jZSBzdG9yYWdlLgAAAAZGcm96ZW4AAAAAAAEAAAB4V2hldGhlciBhIERFWCByb3V0ZXIgY29udHJhY3QgaXMgYXBwcm92ZWQgdG8gcmVjZWl2ZSBjcm9zcy1jb250cmFjdApzd2FwIGNhbGxzLiAgU3RvcmVkIGFzIGBib29sYCBpbiBwZXJzaXN0ZW50IHN0b3JhZ2UuAAAADVJlZ2lzdGVyZWREZXgAAAAAAAABAAAAEwAAAAAAAACATWF4aW11bSB0b2xlcmF0ZWQgc3dhcCBzbGlwcGFnZSBpbiBiYXNpcyBwb2ludHMsIGFwcGxpZWQgYWdhaW5zdCBhCmNhbGxlci1zdXBwbGllZCBxdW90ZS4gIFN0b3JlZCBhcyBgaTEyOGAgaW4gaW5zdGFuY2Ugc3RvcmFnZS4AAAAOTWF4U2xpcHBhZ2VCcHMAAAAAAAAAAAA9TGVuZGluZyBwcm90b2NvbCBjb250cmFjdCB1c2VkIGZvciB0cmVhc3VyeSB5aWVsZCBvcGVyYXRpb25zLgAAAAAAAA1ZaWVsZFByb3RvY29sAAAAAAAAAQAAADNQcmluY2lwYWwgY3VycmVudGx5IGRlcG9zaXRlZCBmb3IgYSB0cmVhc3VyeSBhc3NldC4AAAAADllpZWxkUHJpbmNpcGFsAAAAAAABAAAAEwAAAAAAAAA9VHJ1c3RlZCBpc3N1ZXIvb3JhY2xlIHF1ZXJpZWQgZm9yIGhpZ2gtdmFsdWUgcGF5bWVudCBzZW5kZXJzLgAAAAAAAAlLeWNPcmFjbGUAAAAAAAAAAAAAPlBheW1lbnRzIHN0cmljdGx5IGFib3ZlIHRoaXMgYW1vdW50IHJlcXVpcmUgYSB2YWxpZCBLWUMgY2xhaW0uAAAAAAAMS3ljVGhyZXNob2xkAAAAAQAAAEZBY3RpdmUgZGVzaWduYXRlZCBhZGRyZXNzIGZvciBhbiBhZG1pbmlzdHJhdGl2ZSByb2xlOiBSb2xlIC0+IEFkZHJlc3MuAAAAAAAEUm9sZQAAAAEAAAfQAAAABFJvbGUAAAABAAAATldoZXRoZXIgYW4gYWRkcmVzcyBoYXMgYmVlbiBhc3NpZ25lZCBhIHNwZWNpZmljIHJvbGU6IChBZGRyZXNzLCBSb2xlKSAtPiBib29sLgAAAAAACFVzZXJSb2xlAAAAAgAAABMAAAfQAAAABFJvbGUAAAABAAAAklBlci11c2VyIG1ldGEtdHJhbnNhY3Rpb24gbm9uY2UgZm9yIHJlcGxheSBwcm90ZWN0aW9uLgpTdG9yZWQgYXMgYHU2NGAgaW4gcGVyc2lzdGVudCBzdG9yYWdlLCBpbmNyZW1lbnRlZCBvbiBlYWNoCnN1Y2Nlc3NmdWwgYHJvdXRlX3BheW1lbnRfbWV0YWAuAAAAAAAJTWV0YU5vbmNlAAAAAAAAAQAAABMAAAAAAAAANUFkZHJlc3Mgb2YgdGhlIGNvbmZpZ3VyZWQgcHJpY2UtZmVlZCBvcmFjbGUgY29udHJhY3QuAAAAAAAADU9yYWNsZUFkZHJlc3MAAAAAAAAAAAAAfE1heGltdW0gYWdlIChpbiBzZWNvbmRzKSBhIHByaWNlIHJlYWRpbmcgbWF5IGhhdmUgYmVmb3JlIGl0IGlzCmNvbnNpZGVyZWQgc3RhbGUgYW5kIHJlamVjdGVkLiAgRGVmYXVsdHMgdG8gMyA2MDAgcyAoMSBob3VyKS4AAAASU3RhbGVuZXNzVGhyZXNob2xkAAAAAAABAAAArkFkbWluaXN0cmF0b3Itc3VwcGxpZWQgZmFsbGJhY2sgcHJpY2UgZm9yIGEgKGJhc2UsIHF1b3RlKSBhc3NldCBwYWlyLgpVc2VkIHdoZW4gdGhlIGxpdmUgb3JhY2xlIGlzIHVuYXZhaWxhYmxlIG9yIHJldHVybnMgYSBzdGFsZSB2YWx1ZS4KS2V5ZWQgYnkgYChiYXNlX2Fzc2V0LCBxdW90ZV9hc3NldClgLgAAAAAADUZhbGxiYWNrUHJpY2UAAAAAAAACAAAAEwAAABMAAAAAAAAALkdvdmVybmFuY2UgdG9rZW4gdXNlZCB0byB3ZWlnaHQgZmVlIHByb3Bvc2Fscy4AAAAAAA9Hb3Zlcm5hbmNlVG9rZW4AAAAAAAAAAD9NaW5pbXVtIHRva2VuIHZvdGluZyB3ZWlnaHQgcmVxdWlyZWQgdG8gZXhlY3V0ZSBhIGZlZSBwcm9wb3NhbC4AAAAAEEdvdmVybmFuY2VRdW9ydW0AAAAAAAAAME1vbm90b25pY2FsbHkgaW5jcmVhc2luZyBnb3Zlcm5hbmNlIHByb3Bvc2FsIElELgAAAA9Hb3Zlcm5hbmNlTm9uY2UAAAAAAQAAABpGZWUgcHJvcG9zYWwgc3RvcmVkIGJ5IElELgAAAAAAEkdvdmVybmFuY2VQcm9wb3NhbAAAAAAAAQAAAAYAAAABAAAAK1doZXRoZXIgYW4gYWRkcmVzcyBoYXMgdm90ZWQgb24gYSBwcm9wb3NhbC4AAAAADkdvdmVybmFuY2VWb3RlAAAAAAACAAAABgAAABM=",
        "AAAAAQAAAE1BIHNpbmdsZSB0cmFuc2ZlciBpbnN0cnVjdGlvbiBmb3IgdXNlIHdpdGggW2BQYXltZW50Um91dGVyOjpyb3V0ZV9wYXltZW50c2BdLgAAAAAAAAAAAAAHUGF5bWVudAAAAAAEAAAAgEFtb3VudCB0byByb3V0ZSwgZGVub21pbmF0ZWQgaW4gdGhlIHRva2VuJ3Mgc21hbGxlc3QgdW5pdC4gTXVzdCBiZQpwb3NpdGl2ZSBhbmQgd2l0aGluIHRoZSBjb250cmFjdCdzIGNvbmZpZ3VyZWQgbWluL21heCBib3VuZHMuAAAABmFtb3VudAAAAAAACwAAADtBZGRyZXNzIHRoZSBmdW5kcyAobWludXMgdGhlIHBsYXRmb3JtIGZlZSkgYXJlIGNyZWRpdGVkIHRvLgAAAAAJcmVjaXBpZW50AAAAAAAAEwAAADxBZGRyZXNzIHRoZSBmdW5kcyBhcmUgZGViaXRlZCBmcm9tLiBNdXN0IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAGc2VuZGVyAAAAAAATAAAAR0NvbnRyYWN0IElEIG9mIHRoZSB0b2tlbiAob3IgU3RlbGxhciBBc3NldCBDb250cmFjdCkgYmVpbmcgdHJhbnNmZXJyZWQuAAAAAA10b2tlbl9hZGRyZXNzAAAAAAAAEw==",
        "AAAAAAAAA6NHcmFudHMgYW4gb3BlcmF0aW9uYWwgcm9sZSB0byBgZ3JhbnRlZWAuCgpPbmx5IGFuIGFkZHJlc3MgaG9sZGluZyBgU3VwZXJBZG1pbmAgbWF5IGNhbGwgdGhpcy4gIFRoZSBgYWRtaW5gCnBhcmFtZXRlciBpcyB0aGUgYWRkcmVzcyBleHBlY3RlZCB0byBhdXRob3JpemUgdGhlIHRyYW5zYWN0aW9uLCBhbmQKYGFkbWluLnJlcXVpcmVfYXV0aCgpYCBpcyBhbHdheXMgaW52b2tlZCwgc28gYSBjYWxsZXIgdGhhdCBjYW5ub3Qgc3VwcGx5CnRoYXQgc2lnbmF0dXJlIGlzIHJlamVjdGVkIGV2ZW4gaWYgdGhlIHJvbGUgd291bGQgb3RoZXJ3aXNlIHJlc29sdmUuCgojIFBhcmFtZXRlcnMKLSBgYWRtaW5gOiBBZGRyZXNzIGV4cGVjdGVkIHRvIGF1dGhvcml6ZSB0aGUgY2FsbDsgbXVzdCBob2xkIGBTdXBlckFkbWluYC4KLSBgZ3JhbnRlZWA6IEFkZHJlc3MgdG8gcmVjZWl2ZSB0aGUgcm9sZS4KLSBgcm9sZWA6IFRoZSBgUm9sZWAgdmFyaWFudCB0byBncmFudC4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBgRXJyKEVycm9yOjpSb2xlTm90Rm91bmQpYCBpZiBgYWRtaW5gIGRvZXMgbm90IGhvbGQKYFN1cGVyQWRtaW5gLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdCBoYXMgbm8KYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiBgYWRtaW5gIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4KCkdyYW50aW5nIGEgcm9sZSB0aGUgZ3JhbnRlZSBhbHJlYWR5IGhvbGRzIGlzIGEgbm8tb3AgdGhhdCBlbWl0cwpgcm9sZV9hc3NpZ25lZGAgYWdhaW4gcmF0aGVyIHRoYW4gYW4gZXJyb3IuICBCZWNhdXNlIGEgcm9sZSBoYXMgYSBzaW5nbGUKZGVzaWduYXRlZCBob2xkZXIsIGdyYW50aW5nIGl0IHRvIGEgbmV3IGFkZHJlc3MgcmV2b2tlcyBpdCBmcm9tIHRoZQpwcmV2aW91cyBvbmUuAAAAAApncmFudF9yb2xlAAAAAAADAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAAB2dyYW50ZWUAAAAAEwAAAAAAAAAEcm9sZQAAB9AAAAAEUm9sZQAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAApJPbmUtdGltZSBzZXR1cDogcmVjb3JkcyB0aGUgYWRtaW4gYW5kIHRoZSBpbml0aWFsIGZlZSBjb25maWd1cmF0aW9uCmluIGluc3RhbmNlIHN0b3JhZ2UuIE11c3QgYmUgY2FsbGVkIGJlZm9yZSBgcm91dGVfcGF5bWVudGAuCgojIFBhcmFtZXRlcnMKLSBgYWRtaW5gOiBBZGRyZXNzIGdyYW50ZWQgYWRtaW4gcmlnaHRzIG92ZXIgdGhlIGNvbnRyYWN0OyBtdXN0CmF1dGhvcml6ZSB0aGlzIGNhbGwuCi0gYHBsYXRmb3JtX3RyZWFzdXJ5YDogQWRkcmVzcyB0aGF0IHJlY2VpdmVzIGNvbGxlY3RlZCBwbGF0Zm9ybSBmZWVzLgotIGBmZWVfYnBzYDogUGxhdGZvcm0gZmVlIHJhdGUsIGluIGJhc2lzIHBvaW50cy4KLSBgZmVlX2NhcGA6IE1heGltdW0gZmVlIChpbiB0aGUgdG9rZW4ncyBzbWFsbGVzdCB1bml0KSB0YWtlbiBmcm9tIGEKc2luZ2xlIHBheW1lbnQuCi0gYG1heF9hbW91bnRgOiBNYXhpbXVtIGFtb3VudCBhY2NlcHRlZCBieSBhIHNpbmdsZSBwYXltZW50LgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6OkFscmVhZHlJbml0aWFsaXplZClgIGlmIHRoZQpjb250cmFjdCBhbHJlYWR5IGhhcyBhbiBhZG1pbiBzZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgYGFkbWluYCBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAKaW5pdGlhbGl6ZQAAAAAABQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAABFwbGF0Zm9ybV90cmVhc3VyeQAAAAAAABMAAAAAAAAAB2ZlZV9icHMAAAAACwAAAAAAAAAHZmVlX2NhcAAAAAALAAAAAAAAAAptYXhfYW1vdW50AAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAzxBc2tzIGEgcmVnaXN0ZXJlZCBERVggaG93IG11Y2ggYGJ1eV90b2tlbmAgYSBzd2FwIHdvdWxkIHJldHVybiwgYW5kCmRlcml2ZXMgdGhlIGBtaW5fYW1vdW50X291dGAgdGhlIHNlbmRlciBzaG91bGQgdXNlIGZyb20gdGhlIGNvbnRyYWN0J3MKY29uZmlndXJlZCBzbGlwcGFnZSBjZWlsaW5nLgoKVGhpcyBpcyBhIHJlYWQtb25seSBjcm9zcy1jb250cmFjdCBjYWxsOiBpdCBtb3ZlcyBubyBmdW5kcyBhbmQgY2hhbmdlcyBubwpzdGF0ZSwgc28gaXQgaXMgc2FmZSB0byBjYWxsIG9mZi1jaGFpbiBiZWZvcmUgYnVpbGRpbmcgYQpbYFN3YXBQYXltZW50YF0uCgojIFBhcmFtZXRlcnMKLSBgZGV4YDogQ29udHJhY3QgSUQgb2YgYSByZWdpc3RlcmVkIERFWCBhZGFwdGVyLgotIGBzZWxsX3Rva2VuYDogVG9rZW4gdGhlIHNlbmRlciB3b3VsZCBwYXkgd2l0aC4KLSBgYnV5X3Rva2VuYDogVG9rZW4gdGhlIHJlY2lwaWVudCB3b3VsZCBiZSBwYWlkIGluLgotIGBhbW91bnRfaW5gOiBBbW91bnQgb2YgYHNlbGxfdG9rZW5gIHRvIHByaWNlLCBpbiBpdHMgc21hbGxlc3QgdW5pdC4KCiMgUmV0dXJucwpBIFtgU3dhcFF1b3RlYF0gd2l0aCB0aGUgcXVvdGVkIG91dHB1dCwgdGhlIHNsaXBwYWdlLWFkanVzdGVkCmBtaW5fYW1vdW50X291dGAsIGFuZCB0aGUgc2xpcHBhZ2UgY2VpbGluZyB1c2VkLiBSZXR1cm5zCmBFcnIoRXJyb3I6OkRleE5vdFJlZ2lzdGVyZWQpYCBpZiBgZGV4YCB3YXMgbmV2ZXIgcmVnaXN0ZXJlZCBvcgpgRXJyKEVycm9yOjpTd2FwRmFpbGVkKWAgaWYgdGhlIERFWCBxdW90ZSBjYWxsIHJldmVydHMuCgojIFBhbmljcwpEb2VzIG5vdCBwYW5pYy4AAAAKcXVvdGVfc3dhcAAAAAAABAAAAAAAAAADZGV4AAAAABMAAAAAAAAACnNlbGxfdG9rZW4AAAAAABMAAAAAAAAACWJ1eV90b2tlbgAAAAAAABMAAAAAAAAACWFtb3VudF9pbgAAAAAAAAsAAAABAAAD6QAAB9AAAAAJU3dhcFF1b3RlAAAAAAAAAw==",
        "AAAAAAAAANlBbGlhcyBmb3IgYHNldF9wYXVzZWAuIFBhdXNlci1wcm90ZWN0ZWQuCgojIFBhcmFtZXRlcnMKLSBgcGF1c2VkYDogYHRydWVgIHRvIHJlamVjdCByb3V0aW5nIGNhbGxzLCBgZmFsc2VgIHRvIGFsbG93IHRoZW0uCgojIFJldHVybnMKU2VlIGBzZXRfcGF1c2VgLgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IFBhdXNlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAACnNldF9wYXVzZWQAAAAAAAEAAAAAAAAABnBhdXNlZAAAAAAAAQAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAe1HcmFudHMgYW4gb3BlcmF0aW9uYWwgcm9sZSB0byBhbiBhY2NvdW50LiBTdXBlckFkbWluLXByb3RlY3RlZC4KClJldGFpbmVkIGZvciBjb21wYXRpYmlsaXR5IHdpdGggdGhlIHB1Ymxpc2hlZCBiaW5kaW5nczsgdGhpcyBpcwpbYFNlbGY6OmdyYW50X3JvbGVgXSB3aXRoIHRoZSBgYWRtaW5gIGFyZ3VtZW50IHJlc29sdmVkIGJ5IHRoZSBjb250cmFjdAppbnN0ZWFkIG9mIHN1cHBsaWVkIGJ5IHRoZSBjYWxsZXIuCgojIFBhcmFtZXRlcnMKLSBgYWNjb3VudGA6IFRhcmdldCBhZGRyZXNzIHRvIHJlY2VpdmUgdGhlIHJvbGUuCi0gYHJvbGVgOiBUaGUgYFJvbGVgIHZhcmlhbnQgdG8gZ3JhbnQuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB1bmluaXRpYWxpemVkLgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IGBTdXBlckFkbWluYCBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAAC2Fzc2lnbl9yb2xlAAAAAAIAAAAAAAAAB2FjY291bnQAAAAAEwAAAAAAAAAEcm9sZQAAB9AAAAAEUm9sZQAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAxBSZXZva2VzIGFuIG9wZXJhdGlvbmFsIHJvbGUgZnJvbSBgZ3JhbnRlZWAuCgpPbmx5IGFuIGFkZHJlc3MgaG9sZGluZyBgU3VwZXJBZG1pbmAgbWF5IGNhbGwgdGhpcy4gIEFzIHdpdGgKW2BTZWxmOjpncmFudF9yb2xlYF0sIGBhZG1pbi5yZXF1aXJlX2F1dGgoKWAgaXMgYWx3YXlzIGludm9rZWQuCgojIFBhcmFtZXRlcnMKLSBgYWRtaW5gOiBBZGRyZXNzIGV4cGVjdGVkIHRvIGF1dGhvcml6ZSB0aGUgY2FsbDsgbXVzdCBob2xkIGBTdXBlckFkbWluYC4KLSBgZ3JhbnRlZWA6IEFkZHJlc3MgZnJvbSB3aGljaCB0aGUgcm9sZSB3aWxsIGJlIHJldm9rZWQuCi0gYHJvbGVgOiBUaGUgYFJvbGVgIHZhcmlhbnQgdG8gcmV2b2tlLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIGBFcnIoRXJyb3I6OlJvbGVOb3RGb3VuZClgIGlmIGBhZG1pbmAgZG9lcyBub3QgaG9sZApgU3VwZXJBZG1pbmAsIGBFcnIoRXJyb3I6OkludmFsaWRSb2xlKWAgaWYgdGhlIGNhbGwgd291bGQgcmV2b2tlIHRoZQphY3RpbmcgYFN1cGVyQWRtaW5gJ3Mgb3duIHJvb3Qgcm9sZSwgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYC4KCiMgUGFuaWNzClBhbmljcyBpZiBgYWRtaW5gIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4KClJldm9raW5nIGEgcm9sZSB0aGUgZ3JhbnRlZSBuZXZlciBoZWxkIGlzIGEgbm8tb3AgdGhhdCBlbWl0cwpgcm9sZV9yZXZva2VkYCByYXRoZXIgdGhhbiBhbiBlcnJvciwgc28gcmV2b2NhdGlvbnMgYXJlIGlkZW1wb3RlbnQgYW5kCnNhZmUgdG8gcmV0cnkuAAAAC3Jldm9rZV9yb2xlAAAAAAMAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAHZ3JhbnRlZQAAAAATAAAAAAAAAARyb2xlAAAH0AAAAARSb2xlAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAa1VcGRhdGVzIHRoZSBmZWUgYmFzaXMgcG9pbnRzLgpSZXF1aXJlcyBnb3Zlcm5hbmNlIGF1dGhvcml0eSBpZiBhIGdvdmVybmFuY2UgYWRkcmVzcyBpcyBzZXQ7IG90aGVyd2lzZSBhZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYG5ld19mZWVfYnBzYDogTmV3IHBsYXRmb3JtIGZlZSByYXRlLCBpbiBiYXNpcyBwb2ludHMuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGNhbGxlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuCgpERVBSRUNBVEVEIGZvciBkaXJlY3QgdXNlLiAgUXVldWUgdmlhIGBxdWV1ZV9hY3Rpb24oQWN0aW9uVHlwZTo6U2V0RmVlQnBzKOKApikpYC4AAAAAAAALc2V0X2ZlZV9icHMAAAAAAQAAAAAAAAALbmV3X2ZlZV9icHMAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAQAAACxBIHNpbmdsZSBwcmljZSBxdW90ZSByZXR1cm5lZCBieSB0aGUgb3JhY2xlLgAAAAAAAAAJUHJpY2VEYXRhAAAAAAAAAwAAAClOdW1iZXIgb2YgZGVjaW1hbCBwbGFjZXMgdXNlZCBpbiBgcHJpY2VgLgAAAAAAAAhkZWNpbWFscwAAAAQAAABBRml4ZWQtcG9pbnQgcHJpY2UgdmFsdWUuIFRoZSB0cnVlIHByaWNlIGlzIGBwcmljZSAvIDEwXmRlY2ltYWxzYC4AAAAAAAAFcHJpY2UAAAAAAAALAAAAQ1VuaXggdGltZXN0YW1wIChzZWNvbmRzKSB3aGVuIHRoaXMgcHJpY2Ugd2FzIGxhc3QgdXBkYXRlZCBvbi1jaGFpbi4AAAAACXRpbWVzdGFtcAAAAAAAAAY=",
        "AAAAAQAAAEVUaGUgcmVzdWx0IG9mIGEgREVYIHF1b3RlLCByZXR1cm5lZCBieSBbYFBheW1lbnRSb3V0ZXI6OnF1b3RlX3N3YXBgXS4AAAAAAAAAAAAACVN3YXBRdW90ZQAAAAAAAAMAAABGQW1vdW50IG9mIGBidXlfdG9rZW5gIHRoZSBERVggZXhwZWN0cyB0byBkZWxpdmVyIGZvciB0aGUgcXVvdGVkIGlucHV0LgAAAAAACmFtb3VudF9vdXQAAAAAAAsAAABNQ29uZmlndXJlZCBtYXhpbXVtIHNsaXBwYWdlLCBpbiBiYXNpcyBwb2ludHMsIHRoYXQgcHJvZHVjZWQKYG1pbl9hbW91bnRfb3V0YC4AAAAAAAAQbWF4X3NsaXBwYWdlX2JwcwAAAAsAAABfVGlnaHRlc3QgYG1pbl9hbW91bnRfb3V0YCB0aGF0IHN0aWxsIHJlc3BlY3RzIHRoZSBjb250cmFjdCdzCmBtYXhfc2xpcHBhZ2VfYnBzYCBmb3IgdGhpcyBxdW90ZS4AAAAADm1pbl9hbW91bnRfb3V0AAAAAAAL",
        "AAAAAAAAAsdRdWV1ZXMgYW4gYWRtaW4gYWN0aW9uIHRvIGJlIGV4ZWN1dGVkIGFmdGVyIGEgMjQtaG91ciBkZWxheS4KClRoZSBhZG1pbiBwcm92aWRlcyB0aGUgZGVzaXJlZCBgQWN0aW9uVHlwZWAgdmFyaWFudCBhbmQgcmVjZWl2ZXMgYQpudW1lcmljIG5vbmNlIHRoYXQgdW5pcXVlbHkgaWRlbnRpZmllcyB0aGlzIHBlbmRpbmcgZW50cnkuICBQYXNzIHRoaXMKbm9uY2UgdG8gYGV4ZWN1dGVfYWN0aW9uYCBhZnRlciAyNCBob3Vycywgb3IgdG8gYGNhbmNlbF9hY3Rpb25gIHRvCmFib3J0IHRoZSBpbnRlbnQuCgpTZW5zaXRpdmUgcGFyYW1ldGVyIGNoYW5nZXMgKGBzZXRfcGxhdGZvcm1fdHJlYXN1cnlgLCBgc2V0X2ZlZV9jb25maWdgLApgc2V0X2ZlZV9icHNgLCBgc2V0X2dvdmVybmFuY2VgLCBgc2V0X21pbl9saW1pdGAsIGB0cmFuc2Zlcl9hZG1pbmAsCmB1cGdyYWRlYCkgbXVzdCBnbyB0aHJvdWdoIHRoZSB0aW1lbG9jay4gIFVzZSB0aGUgZGlyZWN0IHNldHRlcgpmdW5jdGlvbnMgb25seSBmb3IgYWN0aW9ucyB0aGF0IGFyZSBub3Qgc2Vuc2l0aXZlIChlLmcuIGBzZXRfcGF1c2VgCndoaWNoIGNhbiBhbHNvIGJlIGNhbGxlZCBkaXJlY3RseSBmb3IgaW1tZWRpYXRlIG9wZXJhdGlvbmFsIHBhdXNlcykuCgpUaGUgY29udHJhY3QgbXVzdCBub3QgYmUgZnJvemVuIHdoZW4gcXVldWluZywgYW5kIHRoZSBhZG1pbiBtdXN0CmF1dGhvcml6ZSB0aGUgY2FsbC4AAAAADHF1ZXVlX2FjdGlvbgAAAAEAAAAAAAAABmFjdGlvbgAAAAAH0AAAAApBY3Rpb25UeXBlAAAAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAgpBbGxvd3Mgc3dhcCByb3V0aW5nIHRvIGludm9rZSBhIERFWCByb3V0ZXIgY29udHJhY3QuIEFkbWluLW9ubHkuCgpSZXN0cmljdGluZyBjcm9zcy1jb250cmFjdCBjYWxscyB0byBhIHJlZ2lzdGVyZWQgYWxsb3dsaXN0IGlzIHdoYXQga2VlcHMKc3dhcCByb3V0aW5nIHBvaW50ZWQgYXQgYXVkaXRlZCBjb2RlLgoKIyBQYXJhbWV0ZXJzCi0gYGRleGA6IENvbnRyYWN0IElEIG9mIHRoZSBERVggcm91dGVyIHRvIGFwcHJvdmUuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QgaGFzCm5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgYWRtaW4gZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlJlZ2lzdGVyRGV4KOKApikpYAphbmQgZXhlY3V0ZSBhZnRlciAyNCBob3Vycy4AAAAAAAxyZWdpc3Rlcl9kZXgAAAABAAAAAAAAAANkZXgAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAgAAAK5EZXNjcmliZXMgd2hpY2ggYWRtaW5pc3RyYXRpdmUgcGFyYW1ldGVyIGNoYW5nZSBhIHRpbWVsb2NrIGVudHJ5IHJlcHJlc2VudHMuCkVhY2ggdmFyaWFudCBjYXJyaWVzIGFsbCB0aGUgYXJndW1lbnRzIG5lZWRlZCB0byBhcHBseSB0aGF0IGNoYW5nZSB3aGVuIHRoZQpkZWxheSBwZXJpb2QgaXMgb3Zlci4AAAAAAAAAAAAKQWN0aW9uVHlwZQAAAAAACgAAAAEAAAAlQ2hhbmdlIHRoZSBwbGF0Zm9ybSB0cmVhc3VyeSBhZGRyZXNzLgAAAAAAABNTZXRQbGF0Zm9ybVRyZWFzdXJ5AAAAAAEAAAATAAAAAQAAAEhVcGRhdGUgZmVlIGJhc2lzLXBvaW50cyBhbmQgZmVlIGNhcCB0b2dldGhlciAobGVnYWN5IC8gY29tYmluZWQgc2V0dGVyKS4AAAAMU2V0RmVlQ29uZmlnAAAAAgAAAAsAAAALAAAAAQAAAB1VcGRhdGUgZmVlIGJhc2lzLXBvaW50cyBvbmx5LgAAAAAAAAlTZXRGZWVCcHMAAAAAAAABAAAACwAAAAEAAAAkU2V0IHRoZSBnb3Zlcm5hbmNlIGNvbnRyYWN0IGFkZHJlc3MuAAAADVNldEdvdmVybmFuY2UAAAAAAAABAAAAEwAAAAEAAAAhQ2hhbmdlIHRoZSBtaW5pbXVtIHJvdXRpbmcgbGltaXQuAAAAAAAAC1NldE1pbkxpbWl0AAAAAAEAAAALAAAAAQAAACdUcmFuc2ZlciBhZG1pbiByaWdodHMgdG8gYSBuZXcgYWRkcmVzcy4AAAAADVRyYW5zZmVyQWRtaW4AAAAAAAABAAAAEwAAAAEAAAAaVXBncmFkZSB0aGUgY29udHJhY3QgV0FTTS4AAAAAAAdVcGdyYWRlAAAAAAEAAAPuAAAAIAAAAAEAAAAzQWxsb3cgc3dhcCByb3V0aW5nIHRvIGludm9rZSBhIERFWCByb3V0ZXIgY29udHJhY3QuAAAAAAtSZWdpc3RlckRleAAAAAABAAAAEwAAAAEAAAA2U3RvcCBzd2FwIHJvdXRpbmcgZnJvbSBpbnZva2luZyBhIERFWCByb3V0ZXIgY29udHJhY3QuAAAAAAANRGVyZWdpc3RlckRleAAAAAAAAAEAAAATAAAAAQAAACtVcGRhdGUgdGhlIG1heGltdW0gdG9sZXJhdGVkIHN3YXAgc2xpcHBhZ2UuAAAAABFTZXRNYXhTbGlwcGFnZUJwcwAAAAAAAAEAAAAL",
        "AAAAAAAAAThDYW5jZWxzIGEgcGVuZGluZyB0aW1lbG9jayBlbnRyeSBiZWZvcmUgaXQgY2FuIGJlIGV4ZWN1dGVkLgoKVGhpcyBpcyB0aGUgcHJpbWFyeSBkZWZlbmNlIHdoZW4gYSBjb21wcm9taXNlZCBhZG1pbiBoYXMgcXVldWVkIGEKbWFsaWNpb3VzIGFjdGlvbjogYW55IG90aGVyIGFkbWluIChhZnRlciBhIGtleSByb3RhdGlvbikgb3IgYQptdWx0aS1zaWcgZ292ZXJuYW5jZSBjYW4gY2FuY2VsIGl0IHdpdGhpbiB0aGUgMjQtaG91ciB3aW5kb3cuCgpBZG1pbiBhdXRob3JpemF0aW9uIGlzIHJlcXVpcmVkLiBUaGUgY29udHJhY3QgbWF5IGJlIGZyb3plbi4AAAANY2FuY2VsX2FjdGlvbgAAAAAAAAEAAAAAAAAABW5vbmNlAAAAAAAABgAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAFlDbGFpbXMgYWxsIGN1cnJlbnRseSBhdmFpbGFibGUgeWllbGQgdG8gdGhlIHBsYXRmb3JtIHRyZWFzdXJ5LiBUcmVhc3VyeU1hbmFnZXItcHJvdGVjdGVkLgAAAAAAAA1oYXJ2ZXN0X3lpZWxkAAAAAAAAAQAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAA/ZSb3V0ZXMgYSBwYXltZW50IGZyb20gYSBzZW5kZXIgdG8gYSByZWNpcGllbnQsIGRlZHVjdGluZyBhIHBsYXRmb3JtIGZlZS4KCiMgUGFyYW1ldGVycwotIGBzZW5kZXJgOiBBZGRyZXNzIHRoZSBmdW5kcyBhcmUgZGViaXRlZCBmcm9tOyBtdXN0IGF1dGhvcml6ZSB0aGUgY2FsbC4KLSBgcmVjaXBpZW50YDogQWRkcmVzcyB0byByZWNlaXZlIHRoZSBmdW5kcyAobWludXMgdGhlIHBsYXRmb3JtIGZlZSkuCi0gYHRva2VuX2FkZHJlc3NgOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4gYmVpbmcgdHJhbnNmZXJyZWQuCi0gYGFtb3VudGA6IEFtb3VudCB0byByb3V0ZSwgaW4gdGhlIHRva2VuJ3Mgc21hbGxlc3QgdW5pdC4gTXVzdCBiZQpwb3NpdGl2ZSBhbmQgd2l0aGluIHRoZSBjb25maWd1cmVkIG1pbi9tYXggYW5kIGRhaWx5LWxpbWl0IGJvdW5kcy4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLiBSZXR1cm5zIGBFcnIoRXJyb3I6OlBhdXNlZClgIGlmIHJvdXRpbmcgaXMKcGF1c2VkLCBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdCBoYXMgbm8gYWRtaW4Kc2V0LCBgRXJyKEVycm9yOjpJbnZhbGlkUmVjaXBpZW50KWAgaWYgYHNlbmRlciA9PSByZWNpcGllbnRgLApgRXJyKEVycm9yOjpCbGFja2xpc3RlZClgIGlmIGByZWNpcGllbnRgIGlzIGJsYWNrbGlzdGVkLApgRXJyKEVycm9yOjpMaW1pdEV4Y2VlZGVkKWAgaWYgYGFtb3VudGAgaXMgb3V0c2lkZSB0aGUgY29uZmlndXJlZApib3VuZHMgb3IgZXhjZWVkcyB0aGUgc2VuZGVyJ3MgcmVtYWluaW5nIGRhaWx5IGxpbWl0LCBvcgpgRXJyKEVycm9yOjpJbnN1ZmZpY2llbnRCYWxhbmNlKWAgaWYgYHNlbmRlcmAncyB0b2tlbiBiYWxhbmNlIGlzCmJlbG93IGBhbW91bnRgLgoKIyBQYW5pY3MKUGFuaWNzIGlmIGBzZW5kZXJgIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYgdGhlIHVuZGVybHlpbmcKdG9rZW4gdHJhbnNmZXIgdG8gYHBsYXRmb3JtX3RyZWFzdXJ5YCBmYWlscy4AAAAAAA1yb3V0ZV9wYXltZW50AAAAAAAABAAAAAAAAAAGc2VuZGVyAAAAAAATAAAAAAAAAAlyZWNpcGllbnQAAAAAAAATAAAAAAAAAA10b2tlbl9hZGRyZXNzAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAbNTZXRzIHRoZSBtaW5pbXVtIGFsbG93ZWQgcm91dGluZyBhbW91bnQuIEZlZU1hbmFnZXItcHJvdGVjdGVkLgoKIyBQYXJhbWV0ZXJzCi0gYG1pbl9saW1pdGA6IFNtYWxsZXN0IGBhbW91bnRgIHRoYXQgYHJvdXRlX3BheW1lbnRgIC8KYHJvdXRlX3BheW1lbnRzYCB3aWxsIGFjY2VwdCBnb2luZyBmb3J3YXJkLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0CmhhcyBubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IEZlZU1hbmFnZXIgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgoKREVQUkVDQVRFRCBmb3IgZGlyZWN0IHVzZS4gIFF1ZXVlIHZpYSBgcXVldWVfYWN0aW9uKEFjdGlvblR5cGU6OlNldE1pbkxpbWl0KOKApikpYC4AAAAADXNldF9taW5fbGltaXQAAAAAAAABAAAAAAAAAAltaW5fbGltaXQAAAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAQAAADxBIGZlZSBjaGFuZ2UgcHJvcG9zYWwgd2VpZ2h0ZWQgYnkgZ292ZXJuYW5jZS10b2tlbiBiYWxhbmNlcy4AAAAAAAAAC0ZlZVByb3Bvc2FsAAAAAAkAAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAYAAAAAAAAACGV4ZWN1dGVkAAAAAQAAAAAAAAAHZmVlX2JwcwAAAAALAAAAAAAAAAdmZWVfY2FwAAAAAAsAAAAAAAAACG5vX3ZvdGVzAAAACwAAAAAAAAAIcHJvcG9zZXIAAAATAAAAAAAAAAZxdW9ydW0AAAAAAAsAAAAAAAAADnZvdGluZ19lbmRzX2F0AAAAAAAGAAAAAAAAAAl5ZXNfdm90ZXMAAAAAAAAL",
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
        "AAAAAQAAASdBIHVzZXIncyByb2xsaW5nIDI0LWhvdXIgc3BlbmRpbmcgcmVjb3JkLgoKUmV0YWluZWQgcHVyZWx5IHNvIGV4aXN0aW5nIHRlc3Qgc25hcHNob3RzIHRoYXQgcmVmZXJlbmNlIHRoaXMgdHlwZSBieQpuYW1lIGtlZXAgY29tcGlsaW5nLiBMaXZlIGNvbnRyYWN0IHN0YXRlIGlzIHN0b3JlZCBhcyBhIHBhY2tlZApgQnl0ZXNOPDI0PmAgKHNlZSBgcGFja19zcGVuZGluZ2AgLyBgdW5wYWNrX3NwZW5kaW5nYCk7IHRoaXMgc3RydWN0IGlzIG5vdApyZWFkIGZyb20gb3Igd3JpdHRlbiB0byBzdG9yYWdlIGF0IHJ1bnRpbWUuAAAAAAAAAAAMVXNlclNwZW5kaW5nAAAAAgAAADhUb3RhbCBhbW91bnQgcm91dGVkIGJ5IHRoZSB1c2VyIHNpbmNlIGBsYXN0X3Jlc2V0X3RpbWVgLgAAABJhY2N1bXVsYXRlZF9hbW91bnQAAAAAAAsAAABAVW5peCB0aW1lc3RhbXAgKHNlY29uZHMpIGF0IHdoaWNoIHRoZSAyNC1ob3VyIHdpbmRvdyBsYXN0IHJlc2V0LgAAAA9sYXN0X3Jlc2V0X3RpbWUAAAAABg==",
        "AAAAAAAAAL5SZXR1cm5zIHRoZSBwcmltYXJ5IGRlc2lnbmF0ZWQgbWVtYmVyIGFkZHJlc3MgZm9yIGEgcm9sZSwgaWYgb25lIGlzIGNvbmZpZ3VyZWQuCgojIFBhcmFtZXRlcnMKLSBgcm9sZWA6IFRoZSByb2xlIHZhcmlhbnQgdG8gcXVlcnkuCgojIFJldHVybnMKYFNvbWUoQWRkcmVzcylgIGlmIHNldCwgb3IgYE5vbmVgIGlmIHVuYXNzaWduZWQuAAAAAAAPZ2V0X3JvbGVfbWVtYmVyAAAAAAEAAAAAAAAABHJvbGUAAAfQAAAABFJvbGUAAAABAAAD6AAAABM=",
        "AAAAAAAAAPhSZXR1cm5zIHRoZSBjdW11bGF0aXZlIGFtb3VudCBhIGdpdmVuIHNlbmRlciBoYXMgcm91dGVkIHRocm91Z2ggdGhlIGNvbnRyYWN0LgoKIyBQYXJhbWV0ZXJzCi0gYHVzZXJgOiBTZW5kZXIgYWRkcmVzcyB0byBsb29rIHVwLgoKIyBSZXR1cm5zClRoZSBsaWZldGltZSByb3V0ZWQgdm9sdW1lIGZvciBgdXNlcmAsIG9yIGAwYCBpZiB0aGV5IGhhdmUgbmV2ZXIKcm91dGVkIGEgcGF5bWVudC4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAA9nZXRfdXNlcl92b2x1bWUAAAAAAQAAAAAAAAAEdXNlcgAAABMAAAABAAAACw==",
        "AAAAAAAAAs1XaXRoZHJhd3MgYSBzcGVjaWZpYyBhbW91bnQgZnJvbSB0aGUgdXNlcidzIGludGVybmFsIHJlZnVuZCBiYWxhbmNlLgoKQSByZWZ1bmQgYmFsYW5jZSBhY2NydWVzIHdoZW4gYSBgcm91dGVfcGF5bWVudGAgLyBgcm91dGVfcGF5bWVudHNgCnRyYW5zZmVyIHRvIHRoZSByZWNpcGllbnQgZmFpbHMgKGUuZy4gbWlzc2luZyB0cnVzdGxpbmUpIGFuZCB0aGUKZnVuZHMgYXJlIGhlbGQgYnkgdGhlIGNvbnRyYWN0IG9uIHRoZSBzZW5kZXIncyBiZWhhbGYgaW5zdGVhZC4KCiMgUGFyYW1ldGVycwotIGB1c2VyYDogQWRkcmVzcyB3aXRoZHJhd2luZyBmdW5kczsgbXVzdCBhdXRob3JpemUgdGhlIGNhbGwuCi0gYHRva2VuYDogQ29udHJhY3QgSUQgb2YgdGhlIHRva2VuIHRvIHdpdGhkcmF3LgotIGBhbW91bnRgOiBBbW91bnQgdG8gd2l0aGRyYXcuIE11c3QgYmUgcG9zaXRpdmUgYW5kIG5vdCBleGNlZWQgdGhlCmN1cnJlbnQgcmVmdW5kIGJhbGFuY2UuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm9SZWZ1bmRBdmFpbGFibGUpYCBpZiBgYW1vdW50YAppcyB6ZXJvLCBuZWdhdGl2ZSwgb3IgZ3JlYXRlciB0aGFuIHRoZSBhdmFpbGFibGUgYmFsYW5jZS4KCiMgUGFuaWNzClBhbmljcyBpZiBgdXNlcmAgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLCBvciBpZiB0aGUgdW5kZXJseWluZwp0b2tlbiB0cmFuc2ZlciBmYWlscy4AAAAAAAAPd2l0aGRyYXdfcmVmdW5kAAAAAAMAAAAAAAAABHVzZXIAAAATAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAQAAAD1BIHBlbmRpbmcgdGltZWxvY2sgZW50cnkgc3RvcmVkIGluIHBlcnNpc3RlbnQgbGVkZ2VyIHN0b3JhZ2UuAAAAAAAAAAAAAA1UaW1lbG9ja0VudHJ5AAAAAAAAAgAAADdUaGUgYWN0aW9uIHBheWxvYWQgdG8gYXBwbHkgb25jZSB0aGUgZGVsYXkgaGFzIGVsYXBzZWQuAAAAAAZhY3Rpb24AAAAAB9AAAAAKQWN0aW9uVHlwZQAAAAAAQ0xlZGdlciB0aW1lc3RhbXAgKHNlY29uZHMgc2luY2UgZXBvY2gpIHdoZW4gdGhpcyBhY3Rpb24gd2FzIHF1ZXVlZC4AAAAACXF1ZXVlZF9hdAAAAAAAAAY=",
        "AAAAAAAAAPlEZXBvc2l0cyBpZGxlIHRyZWFzdXJ5IGZ1bmRzIGludG8gdGhlIGNvbmZpZ3VyZWQgbGVuZGluZyBwcm90b2NvbC4KCkJvdGggdGhlIFRyZWFzdXJ5TWFuYWdlciBhbmQgdHJlYXN1cnkgYXV0aG9yaXplIHRoaXMgb3BlcmF0aW9uLiBUaGUgc2Vjb25kCmF1dGhvcml6YXRpb24gaXMgcmVxdWlyZWQgYmVjYXVzZSB0aGUgZnVuZHMgYXJlIGhlbGQgYnkgdGhlIHRyZWFzdXJ5LApyYXRoZXIgdGhhbiBieSB0aGlzIHJvdXRlciBjb250cmFjdC4AAAAAAAAQZGVwb3NpdF90b195aWVsZAAAAAIAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAWtJbnN0YW50bHkgZnJlZXplcyB0aGUgY29udHJhY3QsIGJsb2NraW5nIGFsbCBwYXltZW50cyBhbmQgdGltZWxvY2sKZXhlY3V0aW9ucy4gIFRoaXMgaXMgdGhlIGVtZXJnZW5jeSBsYXN0IHJlc29ydCB3aGVuIGFuIGFkbWluIGtleSBpcwprbm93biB0byBiZSBjb21wcm9taXNlZC4KClVubGlrZSBvdGhlciBzZW5zaXRpdmUgYWRtaW4gb3BlcmF0aW9ucywgZnJlZXplIHRha2VzIGVmZmVjdCBpbW1lZGlhdGVseQrigJQgaXQgZG9lcyBOT1QgZ28gdGhyb3VnaCB0aGUgdGltZWxvY2sg4oCUIHNvIGl0IGlzIGFsd2F5cyBhdmFpbGFibGUgYXMgYQpyYXBpZC1yZXNwb25zZSB0b29sLgoKQWRtaW4gYXV0aG9yaXphdGlvbiBpcyByZXF1aXJlZC4AAAAAEGVtZXJnZW5jeV9mcmVlemUAAAAAAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAAAAAAAQZ2V0X2ZlZV9wcm9wb3NhbAAAAAEAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAABAAAD6AAAB9AAAAALRmVlUHJvcG9zYWwA",
        "AAAAAAAAAmlDb25maWd1cmVzIHRoZSBwcmljZS1mZWVkIG9yYWNsZSBjb250cmFjdCBhZGRyZXNzLiBDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuCgpUaGUgb3JhY2xlIGNvbnRyYWN0IG11c3QgaW1wbGVtZW50IHRoZSBbYFByaWNlRmVlZE9yYWNsZWBdIGludGVyZmFjZToKaXQgbXVzdCBleHBvc2UgYSBgZ2V0X3ByaWNlKGJhc2VfYXNzZXQsIHF1b3RlX2Fzc2V0KSAtPiBQcmljZURhdGFgCm1ldGhvZCB0aGF0IHJldHVybnMgdGhlIGxhdGVzdCBwcmljZSB0b2dldGhlciB3aXRoIGEgVW5peCB0aW1lc3RhbXAgc28Kc3RhbGVuZXNzIGNhbiBiZSB2YWxpZGF0ZWQgYWdhaW5zdCB0aGUgY29uZmlndXJlZCB0aHJlc2hvbGQuCgojIFBhcmFtZXRlcnMKLSBgb3JhY2xlYDogQWRkcmVzcyBvZiB0aGUgb3JhY2xlIGNvbnRyYWN0IHRvIHVzZSBmb3IgcHJpY2UgbG9va3Vwcy4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm90IGJlZW4gaW5pdGlhbGl6ZWQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgQ29tcGxpYW5jZU9mZmljZXIgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLgAAAAAAABBzZXRfcHJpY2Vfb3JhY2xlAAAAAQAAAAAAAAAGb3JhY2xlAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAV9BZGRzIGFuIGFkZHJlc3MgdG8gdGhlIGJsYWNrbGlzdC4gQ29tcGxpYW5jZU9mZmljZXItcHJvdGVjdGVkLgoKIyBQYXJhbWV0ZXJzCi0gYGFkZHJlc3NgOiBBZGRyZXNzIHRvIGJsYWNrbGlzdDsgc3Vic2VxdWVudCBwYXltZW50cyB0byBpdCBhcyBhCnJlY2lwaWVudCB3aWxsIGJlIHJlamVjdGVkLgoKIyBSZXR1cm5zCmBPaygoKSlgIG9uIHN1Y2Nlc3MsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0CmhhcyBubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IENvbXBsaWFuY2VPZmZpY2VyIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4AAAAAEWJsYWNrbGlzdF9hZGRyZXNzAAAAAAAAAQAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAaNDbGFpbXMgYW5kIHdpdGhkcmF3cyB0aGUgZW50aXJlIGF2YWlsYWJsZSByZWZ1bmQgYmFsYW5jZSBmb3IgYSB1c2VyIGFuZCB0b2tlbi4KCiMgUGFyYW1ldGVycwotIGB1c2VyYDogQWRkcmVzcyB3aXRoZHJhd2luZyBmdW5kczsgbXVzdCBhdXRob3JpemUgdGhlIGNhbGwuCi0gYHRva2VuYDogQ29udHJhY3QgSUQgb2YgdGhlIHRva2VuIHRvIHdpdGhkcmF3LgoKIyBSZXR1cm5zCmBPayhhbW91bnQpYCB3aXRoIHRoZSBhbW91bnQgd2l0aGRyYXduLCBvcgpgRXJyKEVycm9yOjpOb1JlZnVuZEF2YWlsYWJsZSlgIGlmIHRoZSByZWZ1bmQgYmFsYW5jZSBpcyB6ZXJvLgoKIyBQYW5pY3MKUGFuaWNzIGlmIGB1c2VyYCBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwsIG9yIGlmIHRoZSB1bmRlcmx5aW5nCnRva2VuIHRyYW5zZmVyIGZhaWxzLgAAAAARY2xhaW1fYWxsX3JlZnVuZHMAAAAAAAACAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAEhSZXR1cm5zIHRoZSBjb25maWd1cmVkIEtZQyB0aHJlc2hvbGQsIG9yIGBOb25lYCB3aGVuIGVuZm9yY2VtZW50IGlzIG9mZi4AAAARZ2V0X2t5Y190aHJlc2hvbGQAAAAAAAAAAAAAAQAAA+gAAAAL",
        "AAAAAAAAAFpSZXR1cm5zIHRoZSBwZW5kaW5nIGBUaW1lbG9ja0VudHJ5YCBmb3IgdGhlIGdpdmVuIG5vbmNlLCBvciBhbiBlcnJvciBpZgppdCBkb2VzIG5vdCBleGlzdC4AAAAAABFnZXRfcXVldWVkX2FjdGlvbgAAAAAAAAEAAAAAAAAABW5vbmNlAAAAAAAABgAAAAEAAAPpAAAH0AAAAA1UaW1lbG9ja0VudHJ5AAAAAAAAAw==",
        "AAAAAAAAANtSZXR1cm5zIHdoZXRoZXIgYSBERVggcm91dGVyIGlzIGFwcHJvdmVkIGZvciBzd2FwIHJvdXRpbmcuCgojIFBhcmFtZXRlcnMKLSBgZGV4YDogQ29udHJhY3QgSUQgdG8gY2hlY2suCgojIFJldHVybnMKYHRydWVgIGlmIHRoZSBERVggbWF5IGJlIHVzZWQgYnkgYHJvdXRlX3BheW1lbnRfd2l0aF9zd2FwYCwgYGZhbHNlYApvdGhlcndpc2UuCgojIFBhbmljcwpEb2VzIG5vdCBwYW5pYy4AAAAAEWlzX2RleF9yZWdpc3RlcmVkAAAAAAAAAQAAAAAAAAADZGV4AAAAABMAAAABAAAAAQ==",
        "AAAAAAAAADBDYXN0cyBvbmUgd2VpZ2h0ZWQgdm90ZSBvbiBhbiBvcGVuIGZlZSBwcm9wb3NhbC4AAAARdm90ZV9mZWVfcHJvcG9zYWwAAAAAAAADAAAAAAAAAAV2b3RlcgAAAAAAABMAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAAAAAAAB3N1cHBvcnQAAAAAAQAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAnFBZG1pbi1vbmx5IGVtZXJnZW5jeSB3aXRoZHJhd2FsIG9mIHRva2VucyBoZWxkIGJ5IHRoaXMgY29udHJhY3QuCgojIFBhcmFtZXRlcnMKLSBgdG9rZW5gOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4gdG8gd2l0aGRyYXcuCkFkbWluLW9ubHkgZW1lcmdlbmN5IHdpdGhkcmF3YWwgb2YgdG9rZW5zIGhlbGQgYnkgdGhpcyBjb250cmFjdC4gVHJlYXN1cnlNYW5hZ2VyLXByb3RlY3RlZC4KCiMgUGFyYW1ldGVycwotIGB0b2tlbmA6IENvbnRyYWN0IElEIG9mIHRoZSB0b2tlbiB0byB3aXRoZHJhdy4KLSBgYW1vdW50YDogQW1vdW50IHRvIHRyYW5zZmVyIGZyb20gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSB0byB0aGUgdHJlYXN1cnkgbWFuYWdlci4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBUcmVhc3VyeU1hbmFnZXIgZG9lcyBub3QgYXV0aG9yaXplIHRoZSBjYWxsLCBvciBpZiB0aGUKdG9rZW4gdHJhbnNmZXIgZmFpbHMgKGUuZy4gdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSBpcyBiZWxvdyBgYW1vdW50YCkuAAAAAAAAEmVtZXJnZW5jeV93aXRoZHJhdwAAAAAAAgAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAQFSZXR1cm5zIHRoZSBzdG9yZWQgZmFsbGJhY2sgcHJpY2UgZm9yIGEgKGJhc2UsIHF1b3RlKSBhc3NldCBwYWlyLCBpZiBhbnkuCgojIFBhcmFtZXRlcnMKLSBgYmFzZV9hc3NldGA6IEFkZHJlc3Mgb2YgdGhlIGJhc2UgYXNzZXQuCi0gYHF1b3RlX2Fzc2V0YDogQWRkcmVzcyBvZiB0aGUgcXVvdGUgYXNzZXQuCgojIFJldHVybnMKYFNvbWUoUHJpY2VEYXRhKWAgaWYgYSBmYWxsYmFjayBoYXMgYmVlbiBjb25maWd1cmVkLCBgTm9uZWAgb3RoZXJ3aXNlLgAAAAAAABJnZXRfZmFsbGJhY2tfcHJpY2UAAAAAAAIAAAAAAAAACmJhc2VfYXNzZXQAAAAAABMAAAAAAAAAC3F1b3RlX2Fzc2V0AAAAABMAAAABAAAD6AAAB9AAAAAJUHJpY2VEYXRhAAAA",
        "AAAAAAAAARJSZXR1cm5zIHRoZSBhdmFpbGFibGUgaW50ZXJuYWwgcmVmdW5kIGJhbGFuY2UgZm9yIGEgdXNlciBhbmQgdG9rZW4uCgojIFBhcmFtZXRlcnMKLSBgdXNlcmA6IEFkZHJlc3Mgd2hvc2UgcmVmdW5kIGJhbGFuY2UgdG8gbG9vayB1cC4KLSBgdG9rZW5gOiBDb250cmFjdCBJRCBvZiB0aGUgdG9rZW4uCgojIFJldHVybnMKVGhlIHJlZnVuZGFibGUgYmFsYW5jZSBmb3IgYCh1c2VyLCB0b2tlbilgLCBvciBgMGAgaWYgbm9uZSBpcyBoZWxkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAAAASZ2V0X3JlZnVuZF9iYWxhbmNlAAAAAAACAAAAAAAAAAR1c2VyAAAAEwAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAAAs=",
        "AAAAAAAAADRSZXR1cm5zIHRoZSB0cmFja2VkIHByaW5jaXBhbCBkZXBvc2l0ZWQgZm9yIGB0b2tlbmAuAAAAEmdldF95aWVsZF9wb3NpdGlvbgAAAAAAAQAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAQAAAAs=",
        "AAAAAAAAAD1DcmVhdGVzIGEgZmVlIHByb3Bvc2FsIHdlaWdodGVkIGJ5IGdvdmVybmFuY2UtdG9rZW4gYmFsYW5jZXMuAAAAAAAAEnByb3Bvc2VfZmVlX2NoYW5nZQAAAAAABAAAAAAAAAAIcHJvcG9zZXIAAAATAAAAAAAAAAdmZWVfYnBzAAAAAAsAAAAAAAAAB2ZlZV9jYXAAAAAACwAAAAAAAAANdm90aW5nX3BlcmlvZAAAAAAAAAYAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAXtSZWxheXMgYSB1c2VyLXNpZ25lZCBwYXltZW50IG9uIGJlaGFsZiBvZiB0aGUgdXNlci4KClRoZSB1c2VyIHNpZ25zIGBTSEEyNTYoY29udHJhY3QgfHwgc2VuZGVyIHx8IHB1YmtleSB8fCByZWNpcGllbnQgfHwKdG9rZW4gfHwgYW1vdW50IHx8IG5vbmNlIHx8IGRlYWRsaW5lKWAgb2ZmLWNoYWluIHdpdGggRWQyNTUxOS4KQW55IHJlbGF5ZXIgaG9sZGluZyBYTE0gZm9yIGZlZXMgc3VibWl0cyB0aGUgcGF5bG9hZDsgdGhlIGNvbnRyYWN0CnZlcmlmaWVzIHRoZSBzaWduYXR1cmUsIGNoZWNrcyBgbm9uY2VgIGFuZCBgZGVhZGxpbmVgLCB0aGVuIG1vdmVzCmZ1bmRzIHZpYSBwcmlvciB0b2tlbiBhbGxvd2FuY2UgKGBhcHByb3ZlYCArIGB0cmFuc2Zlcl9mcm9tYCkuAAAAABJyb3V0ZV9wYXltZW50X21ldGEAAAAAAAgAAAAAAAAABnNlbmRlcgAAAAAAEwAAAAAAAAANc2lnbmVyX3B1YmtleQAAAAAAA+4AAAAgAAAAAAAAAAlyZWNpcGllbnQAAAAAAAATAAAAAAAAAA10b2tlbl9hZGRyZXNzAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAVub25jZQAAAAAAAAYAAAAAAAAACGRlYWRsaW5lAAAABgAAAAAAAAAJc2lnbmF0dXJlAAAAAAAD7gAAAEAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAA09TdG9yZXMgYW4gYWRtaW4tc3VwcGxpZWQgZmFsbGJhY2sgcHJpY2UgZm9yIGEgKGJhc2UsIHF1b3RlKSBhc3NldCBwYWlyLgpDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuCgpUaGUgZmFsbGJhY2sgaXMgdXNlZCBieSBbYGdldF9wcmljZWBdIHdoZW4gdGhlIGxpdmUgb3JhY2xlIGlzCnVuYXZhaWxhYmxlIG9yIHJldHVybnMgZGF0YSB0aGF0IGZhaWxzIHZhbGlkYXRpb24gKHN0YWxlIG9yIGludmFsaWQpLgpTZXR0aW5nIGEgZmFsbGJhY2sgcHJpY2UgdG8gYDBgIGVmZmVjdGl2ZWx5IHJlbW92ZXMgdGhlIGZhbGxiYWNrLAptZWFuaW5nIHRoYXQgb3JhY2xlIGZhaWx1cmVzIHdpbGwgcHJvcGFnYXRlIGFzIGVycm9ycyByYXRoZXIgdGhhbgpzaWxlbnRseSB1c2luZyBhIHN0YWxlIGNhY2hlZCB2YWx1ZS4KCiMgUGFyYW1ldGVycwotIGBiYXNlX2Fzc2V0YDogQWRkcmVzcyBvZiB0aGUgYmFzZSBhc3NldCAoZS5nLiBYTE0gY29udHJhY3QpLgotIGBxdW90ZV9hc3NldGA6IEFkZHJlc3Mgb2YgdGhlIHF1b3RlIGFzc2V0IChlLmcuIFVTREMgY29udHJhY3QpLgotIGBmYWxsYmFja19wcmljZWA6IFByaWNlIGV4cHJlc3NlZCBpbiB0aGUgc2FtZSBmaXhlZC1wb2ludCBmb3JtYXQgYXMKdGhlIG9yYWNsZSAoYHByaWNlIC8gMTBeZGVjaW1hbHNgKS4gUGFzcyBgMGAgdG8gY2xlYXIgdGhlIGZhbGxiYWNrLgotIGBkZWNpbWFsc2A6IERlY2ltYWwgcHJlY2lzaW9uIG9mIGBmYWxsYmFja19wcmljZWAuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcy4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBDb21wbGlhbmNlT2ZmaWNlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAABJzZXRfZmFsbGJhY2tfcHJpY2UAAAAAAAQAAAAAAAAACmJhc2VfYXNzZXQAAAAAABMAAAAAAAAAC3F1b3RlX2Fzc2V0AAAAABMAAAAAAAAADmZhbGxiYWNrX3ByaWNlAAAAAAALAAAAAAAAAAhkZWNpbWFscwAAAAQAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAF5Db25maWd1cmVzIHRoZSBsZW5kaW5nIHByb3RvY29sIHVzZWQgZm9yIHRyZWFzdXJ5IHlpZWxkIG9wZXJhdGlvbnMuIFRyZWFzdXJ5TWFuYWdlci1wcm90ZWN0ZWQuAAAAAAASc2V0X3lpZWxkX3Byb3RvY29sAAAAAAABAAAAAAAAAAhwcm90b2NvbAAAABMAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAMRSZWNvcmRzIGEgdG9rZW4gYXMgc3VwcG9ydGVkIChuby1vcDsgcm91dGluZyBhY2NlcHRzIGFueSB0b2tlbiBjb250cmFjdCBJRCkuCgojIFBhcmFtZXRlcnMKLSBgX3Rva2VuYDogSWdub3JlZDsgcHJlc2VudCBmb3IgQVBJIGNvbXBhdGliaWxpdHkuCgojIFJldHVybnMKQWx3YXlzIGBPaygoKSlgLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAE2FkZF9zdXBwb3J0ZWRfdG9rZW4AAAAAAQAAAAAAAAAGX3Rva2VuAAAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAATlSZW1vdmVzIGFuIGFkZHJlc3MgZnJvbSB0aGUgYmxhY2tsaXN0LiBDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuCgojIFBhcmFtZXRlcnMKLSBgYWRkcmVzc2A6IEFkZHJlc3MgdG8gcmVtb3ZlIGZyb20gdGhlIGJsYWNrbGlzdC4KCiMgUmV0dXJucwpgT2soKCkpYCBvbiBzdWNjZXNzLCBvciBgRXJyKEVycm9yOjpOb3RJbml0aWFsaXplZClgIGlmIHRoZSBjb250cmFjdApoYXMgbm8gYWRtaW4gc2V0IHlldC4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBDb21wbGlhbmNlT2ZmaWNlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAAE3VuYmxhY2tsaXN0X2FkZHJlc3MAAAAAAQAAAAAAAAAHYWRkcmVzcwAAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAAF1XaXRoZHJhd3MgdHJlYXN1cnkgcHJpbmNpcGFsIGZyb20gdGhlIGNvbmZpZ3VyZWQgbGVuZGluZyBwcm90b2NvbC4gVHJlYXN1cnlNYW5hZ2VyLXByb3RlY3RlZC4AAAAAAAATd2l0aGRyYXdfZnJvbV95aWVsZAAAAAACAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAMNDb25maWd1cmVzIHRoZSBEQU8gdG9rZW4gYW5kIG1pbmltdW0gdm90aW5nIHdlaWdodCBmb3IgZmVlIHByb3Bvc2Fscy4KVGhpcyBhZG1pbmlzdHJhdGl2ZSBib290c3RyYXAgZG9lcyBub3QgaXRzZWxmIGNoYW5nZSBmZWVzOyBzdWJzZXF1ZW50CmZlZSBjaGFuZ2VzIGNhbiBiZSBtYWRlIHRocm91Z2ggdGhlIHByb3Bvc2FsIGxpZmVjeWNsZS4AAAAAFGNvbmZpZ3VyZV9nb3Zlcm5hbmNlAAAAAgAAAAAAAAAQZ292ZXJuYW5jZV90b2tlbgAAABMAAAAAAAAABnF1b3J1bQAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAEFGaW5hbGl6ZXMgYSBzdWNjZXNzZnVsIGZlZSBwcm9wb3NhbCBhZnRlciBpdHMgdm90aW5nIHBlcmlvZCBlbmRzLgAAAAAAABRleGVjdXRlX2ZlZV9wcm9wb3NhbAAAAAEAAAAAAAAAC3Byb3Bvc2FsX2lkAAAAAAYAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAM1SZXR1cm5zIHRoZSBtYXhpbXVtIHRvbGVyYXRlZCBzd2FwIHNsaXBwYWdlIGluIGJhc2lzIHBvaW50cy4KCiMgUmV0dXJucwpUaGUgY29uZmlndXJlZCBgbWF4X3NsaXBwYWdlX2Jwc2AsIG9yIHRoZSAxIDAwMCBicHMgKDEwJSkgZGVmYXVsdCBpZgp0aGUgY29udHJhY3QgaGFzIG5vdCBiZWVuIGluaXRpYWxpemVkLgoKIyBQYW5pY3MKRG9lcyBub3QgcGFuaWMuAAAAAAAAFGdldF9tYXhfc2xpcHBhZ2VfYnBzAAAAAAAAAAEAAAAL",
        "AAAAAAAAAoBTZXRzIHRoZSBtYXhpbXVtIHRvbGVyYXRlZCBzd2FwIHNsaXBwYWdlLiBBZG1pbi1vbmx5LgoKQXBwbGllZCBhZ2FpbnN0IHRoZSBgZXhwZWN0ZWRfYW1vdW50X291dGAgYSBjYWxsZXIgc3VwcGxpZXMgYWxvbmdzaWRlIGEKcXVvdGUsIGFzIGEgc2Vjb25kIGd1YXJkIG9uIHRvcCBvZiB0aGUgcGVyLXBheW1lbnQgYG1pbl9hbW91bnRfb3V0YApmbG9vci4KCiMgUGFyYW1ldGVycwotIGBtYXhfc2xpcHBhZ2VfYnBzYDogTmV3IGNlaWxpbmcgaW4gYmFzaXMgcG9pbnRzOyBgMGAgdG8gYDEwXzAwMGAuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2VzcywgYEVycihFcnJvcjo6SW52YWxpZFN3YXBQYXJhbXMpYCBpZiB0aGUgdmFsdWUgaXMKb3V0c2lkZSBgMC4uPTEwXzAwMGAsIG9yIGBFcnIoRXJyb3I6Ok5vdEluaXRpYWxpemVkKWAgaWYgdGhlIGNvbnRyYWN0IGhhcwpubyBhZG1pbiBzZXQgeWV0LgoKIyBQYW5pY3MKUGFuaWNzIGlmIHRoZSBjdXJyZW50IGFkbWluIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4KCkRFUFJFQ0FURUQgZm9yIGRpcmVjdCB1c2UuICBRdWV1ZSB2aWEgYHF1ZXVlX2FjdGlvbihBY3Rpb25UeXBlOjpTZXRNYXhTbGlwcGFnZUJwcyjigKYpKWAKYW5kIGV4ZWN1dGUgYWZ0ZXIgMjQgaG91cnMuAAAAFHNldF9tYXhfc2xpcHBhZ2VfYnBzAAAAAQAAAAAAAAAQbWF4X3NsaXBwYWdlX2JwcwAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAUlSZXR1cm5zIHRoZSBlZmZlY3RpdmUgZmVlX2JwcyBmb3IgYSBzZW5kZXIgYWZ0ZXIgYXBwbHlpbmcgYW55CnZvbHVtZS1iYXNlZCB0aWVyZWQgZGlzY291bnQuCgojIFBhcmFtZXRlcnMKLSBgc2VuZGVyYDogQWRkcmVzcyB3aG9zZSBkaXNjb3VudGVkIGZlZSByYXRlIHRvIGNvbXB1dGUuCgojIFJldHVybnMKVGhlIGNvbmZpZ3VyZWQgYGZlZV9icHNgLCBoYWx2ZWQgaWYgYHNlbmRlcmAncyBsaWZldGltZSB2b2x1bWUKZXhjZWVkcyB0aGUgdGllcmVkLWRpc2NvdW50IHRocmVzaG9sZCwgb3IgYDBgIGlmIG5vdCBpbml0aWFsaXplZC4KCiMgUGFuaWNzCkRvZXMgbm90IHBhbmljLgAAAAAAABVnZXRfZWZmZWN0aXZlX2ZlZV9icHMAAAAAAAABAAAAAAAAAAZzZW5kZXIAAAAAABMAAAABAAAACw==",
        "AAAAAAAAAfJVcGRhdGVzIHRoZSBmZWUgYmFzaXMgcG9pbnRzIGFuZCBmZWUgY2FwLgpSZXF1aXJlcyBnb3Zlcm5hbmNlIGF1dGhvcml0eSBpZiBhIGdvdmVybmFuY2UgYWRkcmVzcyBpcyBzZXQ7IG90aGVyd2lzZSBhZG1pbi1vbmx5LgoKIyBQYXJhbWV0ZXJzCi0gYGZlZV9icHNgOiBOZXcgcGxhdGZvcm0gZmVlIHJhdGUsIGluIGJhc2lzIHBvaW50cy4KLSBgZmVlX2NhcGA6IE5ldyBtYXhpbXVtIGZlZSB0YWtlbiBmcm9tIGEgc2luZ2xlIHBheW1lbnQuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGNhbGxlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuCgpERVBSRUNBVEVEIGZvciBkaXJlY3QgdXNlLiAgUXVldWUgdmlhIGBxdWV1ZV9hY3Rpb24oQWN0aW9uVHlwZTo6U2V0RmVlQ29uZmlnKOKApikpYC4AAAAAABVzZXRfZmVlX2NvbmZpZ19sZWdhY3kAAAAAAAACAAAAAAAAAAdmZWVfYnBzAAAAAAsAAAAAAAAAB2ZlZV9jYXAAAAAACwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        "AAAAAAAAAlFVcGRhdGVzIHRoZSB0cmVhc3VyeSBhZGRyZXNzIHRoYXQgcmVjZWl2ZXMgdGhlIHBsYXRmb3JtIGZlZS4KClVwZGF0ZXMgdGhlIHRyZWFzdXJ5IGFkZHJlc3MgdGhhdCByZWNlaXZlcyB0aGUgcGxhdGZvcm0gZmVlLiBQcm90ZWN0ZWQgYnkgVHJlYXN1cnlNYW5hZ2VyLgoKIyBQYXJhbWV0ZXJzCi0gYG5ld190cmVhc3VyeWA6IEFkZHJlc3MgdG8gcmVjZWl2ZSBwbGF0Zm9ybSBmZWVzIGdvaW5nIGZvcndhcmQuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcywgb3IgYEVycihFcnJvcjo6Tm90SW5pdGlhbGl6ZWQpYCBpZiB0aGUgY29udHJhY3QKaGFzIG5vIGFkbWluIHNldCB5ZXQuCgojIFBhbmljcwpQYW5pY3MgaWYgdGhlIGN1cnJlbnQgVHJlYXN1cnlNYW5hZ2VyIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbC4KCkRFUFJFQ0FURUQgZm9yIGRpcmVjdCB1c2UuICBRdWV1ZSB2aWEgYHF1ZXVlX2FjdGlvbihBY3Rpb25UeXBlOjpTZXRQbGF0Zm9ybVRyZWFzdXJ5KOKApikpYAphbmQgZXhlY3V0ZSBhZnRlciAyNCBob3Vycy4gIFRoaXMgZGlyZWN0IHBhdGggaXMgcmV0YWluZWQgZm9yIHRvb2xpbmcKY29tcGF0aWJpbGl0eSBvbmx5LgAAAAAAABVzZXRfcGxhdGZvcm1fdHJlYXN1cnkAAAAAAAABAAAAAAAAAAxuZXdfdHJlYXN1cnkAAAATAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
        "AAAAAAAAA89Sb3V0ZXMgYSBwYXltZW50IGluIGFueSB0b2tlbiwgc3dhcHBpbmcgaXQgaW50byB0aGUgcmVjaXBpZW50J3MKcHJlZmVycmVkIHRva2VuIG9uIHRoZSB3YXkuCgpUaGUgc3dhcC1yb3V0ZWQgY291bnRlcnBhcnQgb2YgW2BQYXltZW50Um91dGVyOjpyb3V0ZV9wYXltZW50YF06IHRoZSBzYW1lCmZlZSwgbGltaXQsIGJsYWNrbGlzdCwgYW5kIGZyZWV6ZSBydWxlcyBhcHBseSwgd2l0aCB0aGUgY29udmVyc2lvbgppbnNlcnRlZCBiZXR3ZWVuIHB1bGxpbmcgdGhlIGZ1bmRzIGFuZCBkZWxpdmVyaW5nIHRoZW0uIFRoZSBwbGF0Zm9ybSBmZWUKaXMgdGFrZW4gb24gdGhlIGBidXlfdG9rZW5gIG91dHB1dCwgc28gYGZlZV9jYXBgIGFwcGxpZXMgaW4gYGJ1eV90b2tlbmAKdW5pdHMgZm9yIHRoaXMgcm91dGUuCgojIFBhcmFtZXRlcnMKLSBgcGF5bWVudGA6IFRoZSBzd2FwLXJvdXRlZCB0cmFuc2ZlciAoc2VlIFtgU3dhcFBheW1lbnRgXSkuCgojIFJldHVybnMKVGhlIGFtb3VudCBvZiBgYnV5X3Rva2VuYCBkZWxpdmVyZWQgdG8gdGhlIHJlY2lwaWVudCwgYWZ0ZXIgdGhlCnBsYXRmb3JtIGZlZS4gT3RoZXJ3aXNlIHRoZSBwYXltZW50IGlzIGFiYW5kb25lZCB3aG9sZSwgd2l0aDoKLSBgRXJyKEVycm9yOjpJbnZhbGlkU3dhcFBhcmFtcylgLCBgRXJyKEVycm9yOjpTd2FwRGVhZGxpbmVFeHBpcmVkKWAsCmBFcnIoRXJyb3I6OkRleE5vdFJlZ2lzdGVyZWQpYCwgYEVycihFcnJvcjo6U3dhcEZhaWxlZClgLCBvcgpgRXJyKEVycm9yOjpTbGlwcGFnZUV4Y2VlZGVkKWAgZm9yIHN3YXAtc3BlY2lmaWMgcHJvYmxlbXMsCi0gdGhlIHNhbWUgYEVycmAgdmFyaWFudHMgYXMgYHJvdXRlX3BheW1lbnRgIG90aGVyd2lzZS4KCiMgUGFuaWNzClBhbmljcyBpZiBgcGF5bWVudC5zZW5kZXJgIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYgYSB0b2tlbgp0cmFuc2ZlciBvdXQgb2YgdGhpcyBjb250cmFjdCBmYWlscy4AAAAAF3JvdXRlX3BheW1lbnRfd2l0aF9zd2FwAAAAAAEAAAAAAAAAB3BheW1lbnQAAAAH0AAAAAtTd2FwUGF5bWVudAAAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAjJTZXRzIHRoZSBtYXhpbXVtIGFnZSAoaW4gc2Vjb25kcykgYSBwcmljZSByZWFkaW5nIG1heSBoYXZlIGJlZm9yZSBpdCBpcwpjb25zaWRlcmVkIHN0YWxlLiBDb21wbGlhbmNlT2ZmaWNlci1wcm90ZWN0ZWQuCgpXaGVuIGEgcHJpY2UgdGltZXN0YW1wIGlzIG9sZGVyIHRoYW4gYChjdXJyZW50X2xlZGdlcl90aW1lIC0gdGhyZXNob2xkKWAKdGhlIHJlYWRpbmcgaXMgcmVqZWN0ZWQgd2l0aCBbYEVycm9yOjpPcmFjbGVQcmljZVN0YWxlYF0gYW5kIHRoZQpmYWxsYmFjayBwcmljZSAoaWYgY29uZmlndXJlZCkgaXMgdXNlZCBpbnN0ZWFkLgoKIyBQYXJhbWV0ZXJzCi0gYHRocmVzaG9sZF9zZWNzYDogTWF4aW11bSBhbGxvd2VkIGFnZSBpbiBzZWNvbmRzLiBBIHZhbHVlIG9mIGAwYApkaXNhYmxlcyB0aGUgc3RhbGVuZXNzIGNoZWNrIGVudGlyZWx5IChldmVyeSBwcmljZSBpcyBhY2NlcHRlZCkuCgojIFJldHVybnMKYE9rKCgpKWAgb24gc3VjY2Vzcy4KCiMgUGFuaWNzClBhbmljcyBpZiB0aGUgY3VycmVudCBDb21wbGlhbmNlT2ZmaWNlciBkb2VzIG5vdCBhdXRob3JpemUgdGhlIGNhbGwuAAAAAAAXc2V0X3N0YWxlbmVzc190aHJlc2hvbGQAAAAAAQAAAAAAAAAOdGhyZXNob2xkX3NlY3MAAAAAAAYAAAABAAAD6QAAA+0AAAAAAAAAAw==",
        "AAAAAAAAAmRSb3V0ZXMgc2V2ZXJhbCBzd2FwLXJvdXRlZCBwYXltZW50cyBpbiBhIHNpbmdsZSB0cmFuc2FjdGlvbi4gSWYgYW55CnBheW1lbnQgZmFpbHMsIHRoZSBlbnRpcmUgYmF0Y2ggaXMgcmV2ZXJ0ZWQgYXRvbWljYWxseSwgaW5jbHVkaW5nIGFueQpzd2FwcyB0aGF0IGFscmVhZHkgZXhlY3V0ZWQgZWFybGllciBpbiB0aGUgYmF0Y2guCgojIFBhcmFtZXRlcnMKLSBgcGF5bWVudHNgOiBCYXRjaCBvZiBzd2FwLXJvdXRlZCB0cmFuc2ZlcnMgdG8gYXBwbHkgaW4gb3JkZXIuIFNlZQpbYFN3YXBQYXltZW50YF0gZm9yIHBlci1pdGVtIGNvbnN0cmFpbnRzLgoKIyBSZXR1cm5zClRoZSB0b3RhbCBhbW91bnQgb2YgYGJ1eV90b2tlbmAgZGVsaXZlcmVkIGFjcm9zcyB0aGUgYmF0Y2gsIG9yIHRoZQpmaXJzdCBlcnJvciBlbmNvdW50ZXJlZCAoc2VlIGByb3V0ZV9wYXltZW50X3dpdGhfc3dhcGAgZm9yIHRoZQpwb3NzaWJsZSB2YXJpYW50cyBhbmQgdGhlaXIgY2F1c2VzKS4KCiMgUGFuaWNzClBhbmljcyBpZiBhbnkgcGF5bWVudCdzIGBzZW5kZXJgIGRvZXMgbm90IGF1dGhvcml6ZSB0aGUgY2FsbCwgb3IgaWYgYQp0b2tlbiB0cmFuc2ZlciBvdXQgb2YgdGhpcyBjb250cmFjdCBmYWlscy4AAAAYcm91dGVfcGF5bWVudHNfd2l0aF9zd2FwAAAAAQAAAAAAAAAIcGF5bWVudHMAAAPqAAAH0AAAAAtTd2FwUGF5bWVudAAAAAABAAAD6QAAAAsAAAAD" ]),
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
        grant_role: this.txFromJSON<Result<void>>,
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
        get_role_member: this.txFromJSON<Option<string>>,
        get_user_volume: this.txFromJSON<i128>,
        withdraw_refund: this.txFromJSON<Result<void>>,
        deposit_to_yield: this.txFromJSON<Result<void>>,
        emergency_freeze: this.txFromJSON<Result<void>>,
        get_fee_proposal: this.txFromJSON<Option<FeeProposal>>,
        set_price_oracle: this.txFromJSON<Result<void>>,
        blacklist_address: this.txFromJSON<Result<void>>,
        claim_all_refunds: this.txFromJSON<Result<i128>>,
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
        unblacklist_address: this.txFromJSON<Result<void>>,
        withdraw_from_yield: this.txFromJSON<Result<void>>,
        configure_governance: this.txFromJSON<Result<void>>,
        execute_fee_proposal: this.txFromJSON<Result<void>>,
        get_max_slippage_bps: this.txFromJSON<i128>,
        set_max_slippage_bps: this.txFromJSON<Result<void>>,
        get_effective_fee_bps: this.txFromJSON<i128>,
        set_fee_config_legacy: this.txFromJSON<Result<void>>,
        set_platform_treasury: this.txFromJSON<Result<void>>,
        route_payment_with_swap: this.txFromJSON<Result<i128>>,
        set_staleness_threshold: this.txFromJSON<Result<void>>,
        route_payments_with_swap: this.txFromJSON<Result<i128>>
  }
}