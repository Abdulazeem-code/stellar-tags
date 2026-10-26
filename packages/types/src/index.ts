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
  /**
   * Tightest `min_amount_out` that still respects the contract's
   * `max_slippage_bps` for this quote.
   */
  min_amount_out: i128;
}

/**
 * Describes which administrative parameter change a timelock entry represents.
 */
export type ActionType = 
  | { tag: "SetPlatformTreasury"; values: readonly [string] } 
  | { tag: "SetFeeConfig"; values: readonly [i128, i128] } 
  | { tag: "SetFeeBps"; values: readonly [i128] } 
  | { tag: "SetGovernance"; values: readonly [string] } 
  | { tag: "SetMinLimit"; values: readonly [i128] } 
  | { tag: "TransferAdmin"; values: readonly [string] } 
  | { tag: "Upgrade"; values: readonly [Buffer] } 
  | { tag: "SetBackupAdmin"; values: readonly [string, u64] } 
  | { tag: "RegisterDex"; values: readonly [string] } 
  | { tag: "DeregisterDex"; values: readonly [string] } 
  | { tag: "SetMaxSlippageBps"; values: readonly [i128] } 
  | { tag: "SetPairMaxSlippageBps"; values: readonly [string, string, i128] } 
  | { tag: "SetMultisigConfig"; values: readonly [Array<string>, u32] };

/**
 * A user's combined routing stats, unpacked from the packed `BytesN<40>`
 * `UserRecord` ledger value.
 */
export interface UserRecord {
  accumulated_amount: i128;
  last_reset_time: u64;
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
/**
 * A batch of payments committed by a 32-byte Merkle root.
 */
export interface MerkleBatch {
  claimed_amount: i128;
  expiration: u64;
  merkle_root: Buffer;
  reclaimed: boolean;
  sender: string;
  token: string;
  total_amount: i128;
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
 * A single swap-routed transfer instruction.
 */
export interface SwapPayment {
  amount_in: i128;
  buy_token: string;
  deadline: u64;
  dex: string;
  expected_amount_out: i128;
  min_amount_out: i128;
  recipient: string;
  sell_token: string;
  sender: string;
}

/**
 * A user's rolling 24-hour spending record.
 */
export interface UserSpending {
  accumulated_amount: i128;
  last_reset_time: u64;
}

/**
 * A pending timelock entry stored in persistent ledger storage.
 */
export interface TimelockEntry {
  action: ActionType;
  queued_at: u64;
}

/**
 * Multi-signature configuration for contract upgrades.
 */
export interface MultisigConfig {
  signers: Array<string>;
  threshold: u32;
}

/**
 * The result of a DEX-routed swap simulation.
 */
export interface SwapSimulationReport {
  estimated_cpu_instructions: u64;
  estimated_memory_bytes: u64;
  exceeds_footprint_limit: boolean;
  price_impact_bps: i128;
  projected_amount_out: i128;
  read_only: Array<string>;
  read_write: Array<string>;
}main
/**
 * Contract-level errors returned instead of panicking.
 */
export const Errors = {
/**
 * A prepared cross-contract upgrade waiting for its 48-hour timelock.
 */
export interface TwoPhaseCommit {
  code_hashes: Array<Buffer>;
  contract_addresses: Array<string>;
  execution_deadline: u64;
  prepared_at: u64;
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
  ping: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;

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
  get_fee: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>;

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
  upgrade: ({ new_wasm_hash }: { new_wasm_hash: Buffer }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;

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
  version: (options?: MethodOptions) => Promise<AssembledTransaction<string>>;

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
  has_role: ({ account, role }: { account: string; role: Role }, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>;

  /**
   * Construct and simulate a unfreeze transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Removes the frozen state, restoring normal contract operation.
   *
   * Like `emergency_freeze`, this takes effect immediately and does not
   * go through the timelock.
   *
   * SuperAdmin authorization is required.
   */
  unfreeze: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;

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
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>;

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
  get_price: ({ base_asset, quote_asset }: { base_asset: string; quote_asset: string }, options?: MethodOptions) => Promise<AssembledTransaction<Result<PriceData>>>;

  /**
   * Construct and simulate a is_frozen transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns whether the contract is currently frozen.
   */
  is_frozen: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>;

  /**
   * Construct and simulate a is_paused transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns whether the contract is currently paused.
   *
   * Returns `true` only when the pause level is `FullHalt`.  Under
   * `SwapsOnly`, direct payments still work so this returns `false` to
   * preserve backward compatibility for callers that only need to know
   * whether core transfers are allowed.
   *
   * # Returns
   * `true` if fully halted, `false` otherwise.
   *
   * # Panics
   * Does not panic.
   */
  is_paused: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>;

  set_admin: ({ new_admin }: { new_admin: string }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  set_pause: ({ paused }: { paused: boolean }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  grant_role: ({ admin, grantee, role }: { admin: string; grantee: string; role: Role }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  initialize: ({ admin, platform_treasury, fee_bps, fee_cap, max_amount }: { admin: string; platform_treasury: string; fee_bps: i128; fee_cap: i128; max_amount: i128 }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  quote_swap: ({ dex, sell_token, buy_token, amount_in }: { dex: string; sell_token: string; buy_token: string; amount_in: i128 }, options?: MethodOptions) => Promise<AssembledTransaction<Result<SwapQuote>>>;
  set_paused: ({ paused }: { paused: boolean }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  assign_role: ({ account, role }: { account: string; role: Role }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  claim_admin: ({ claimant }: { claimant: string }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  revoke_role: ({ admin, grantee, role }: { admin: string; grantee: string; role: Role }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  set_fee_bps: ({ new_fee_bps }: { new_fee_bps: i128 }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  queue_action: ({ action }: { action: ActionType }, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>;
  register_dex: ({ dex }: { dex: string }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  cancel_action: ({ nonce }: { nonce: u64 }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  harvest_yield: ({ token }: { token: string }, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>;
  route_payment: ({ sender, recipient, token_address, amount }: { sender: string; recipient: string; token_address: string; amount: i128 }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  set_min_limit: ({ min_limit }: { min_limit: i128 }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  cancel_upgrade: ({ new_wasm_hash }: { new_wasm_hash: Buffer }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  deregister_dex: ({ dex }: { dex: string }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  execute_action: ({ nonce }: { nonce: u64 }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  get_meta_nonce: ({ user }: { user: string }, options?: MethodOptions) => Promise<AssembledTransaction<u64>>;
  get_rate_limit: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>;
  get_role_admin: ({ _role }: { _role: Role }, options?: MethodOptions) => Promise<AssembledTransaction<Role>>;
  is_blacklisted: ({ address }: { address: string }, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>;
  recover_tokens: ({ token, amount }: { token: string; amount: i128 }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
}