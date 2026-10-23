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
 * The result of a DEX-routed swap quote, returned by [`PaymentRouter::quote_swap`].
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
}

/**
 * Contract-level errors returned instead of panicking.
 */
export const Errors = {
  1: { message: "Unauthorized" },
  2: { message: "InsufficientBalance" },
  3: { message: "LimitExceeded" },
  4: { message: "AlreadyInitialized" },
  5: { message: "NotInitialized" },
  6: { message: "Paused" },
  8: { message: "InvalidRecipient" },
  9: { message: "Blacklisted" },
  10: { message: "NoRefundAvailable" },
  11: { message: "TimelockPending" },
  12: { message: "TimelockNotReady" },
  13: { message: "TimelockNotFound" },
  14: { message: "ContractFrozen" },
  15: { message: "DexNotRegistered" },
  16: { message: "SwapFailed" },
  17: { message: "SlippageExceeded" },
  18: { message: "SwapDeadlineExpired" },
  19: { message: "InvalidSwapParams" },
  20: { message: "InvalidRole" },
  21: { message: "InvalidProposal" },
  22: { message: "GovernanceNotConfigured" },
  24: { message: "InvalidKycThreshold" },
  25: { message: "YieldProtocolNotConfigured" },
  26: { message: "InvalidYieldAmount" },
  27: { message: "OracleNotConfigured" },
  28: { message: "OracleCallFailed" },
  29: { message: "OraclePriceStale" },
  30: { message: "OraclePriceInvalid" },
  31: { message: "DeadlineExpired" },
  32: { message: "InvalidNonce" },
  33: { message: "InvalidSignature" },
  34: { message: "KycRequired" },
  35: { message: "InvalidSwapPath" },
  37: { message: "InvalidMultisigConfig" },
  38: { message: "NotMultisigSigner" },
  39: { message: "InsufficientApprovals" },
  40: { message: "MultisigNotInitialized" },
  41: { message: "AlreadyApproved" },
  42: { message: "ReentrantCall" },
  43: { message: "NoBackupAdmin" },
  44: { message: "DmsNotReady" },
  45: { message: "InvalidDmsConfig" },
  46: { message: "RateLimited" },
  47: { message: "RoleNotFound" },
  48: { message: "CyclicSwapPath" },
  49: { message: "InvalidSlippageConfig" },
  51: { message: "InvalidUpgradeManifest" },
  52: { message: "UpgradeManifestExpired" },
  53: { message: "UpgradePrepareFailed" },
  54: { message: "UpgradeCommitFailed" }
};

/**
 * Role definitions for the Role-Based Access Control (RBAC) system.
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
export type DataKey = 
  | { tag: "Admin"; values: void } 
  | { tag: "Governance"; values: void } 
  | { tag: "PlatformTreasury"; values: void } 
  | { tag: "FeeBps"; values: void } 
  | { tag: "FeeCap"; values: void } 
  | { tag: "MinLimit"; values: void } 
  | { tag: "Paused"; values: void } 
  | { tag: "PauseLevel"; values: void } 
  | { tag: "MaxAmount"; values: void } 
  | { tag: "UserRecord"; values: readonly [string] } 
  | { tag: "UserSpending"; values: readonly [string] } 
  | { tag: "UserVolume"; values: readonly [string] } 
  | { tag: "Blacklist"; values: readonly [string] } 
  | { tag: "RefundBalance"; values: readonly [string, string] } 
  | { tag: "TimelockNonce"; values: void } 
  | { tag: "TimelockEntry"; values: readonly [u64] } 
  | { tag: "Frozen"; values: void } 
  | { tag: "UserRole"; values: readonly [string, Role] } 
  | { tag: "Role"; values: readonly [Role] } 
  | { tag: "MetaNonce"; values: readonly [string] } 
  | { tag: "KycOracle"; values: void } 
  | { tag: "KycThreshold"; values: void } 
  | { tag: "BackupAdmin"; values: void } 
  | { tag: "LastHeartbeat"; values: void } 
  | { tag: "DmsTimeout"; values: void } 
  | { tag: "RateLimitConfig"; values: void } 
  | { tag: "RateLimitCounter"; values: readonly [string] } 
  | { tag: "RateLimitWhitelist"; values: readonly [string] } 
  | { tag: "OracleAddress"; values: void } 
  | { tag: "StalenessThreshold"; values: void } 
  | { tag: "FallbackPrice"; values: readonly [string, string] } 
  | { tag: "GovernanceToken"; values: void } 
  | { tag: "GovernanceQuorum"; values: void } 
  | { tag: "GovernanceNonce"; values: void } 
  | { tag: "GovernanceProposal"; values: readonly [u64] } 
  | { tag: "GovernanceVote"; values: readonly [u64, string] } 
  | { tag: "ArchiveEpoch"; values: void } 
  | { tag: "ArchiveRoot"; values: readonly [u64] } 
  | { tag: "ArchiveMeta"; values: readonly [u64] } 
  | { tag: "YieldProtocol"; values: void } 
  | { tag: "YieldPrincipal"; values: readonly [string] } 
  | { tag: "RegisteredDex"; values: readonly [string] } 
  | { tag: "MaxSlippageBps"; values: void } 
  | { tag: "PairSlippage"; values: readonly [string, string] } 
  | { tag: "MultisigSigners"; values: void } 
  | { tag: "MultisigThreshold"; values: void } 
  | { tag: "UpgradeApproval"; values: readonly [Buffer] } 
  | { tag: "ReentrancyGuard"; values: void } 
  | { tag: "MerkleClaimedBits"; values: readonly [u64] } 
  | { tag: "TwoPhaseCommit"; values: readonly [Buffer] };

/**
 * Tiered pause levels for the emergency circuit breaker.
 */
export enum PauseLevel {
  None = 0,
  SwapsOnly = 1,
  FullHalt = 2,
}

/**
 * Dedicated key type for the heartbeat operator.
 */
export type HeartbeatKey = { tag: "HeartbeatOperator"; values: void };

/**
 * Packed record describing a registered Merkle distribution batch.
 */
export interface MerkleBatchRecord {
  claimed_amount: i128;
  expiration: u64;
  merkle_root: Buffer;
  sender: string;
  token: string;
  total_amount: i128;
}

/**
 * A single archive leaf descriptor passed into `commit_archive_root`.
 */
export interface ArchiveLeaf {
  primary_key: string;
  record_type: ArchiveRecordType;
  secondary_key: string;
}

/**
 * Metadata stored alongside each archive root.
 */
export interface ArchiveMetadata {
  committed_at: u64;
  description: string;
  record_count: u32;
}

/**
 * Record types supported by the archival system.
 */
export enum ArchiveRecordType {
  UserVolume = 1,
  UserSpending = 2,
  RefundBalance = 3,
}

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
  ping: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  get_fee: (options?: MethodOptions) => Promise<AssembledTransaction<i128>>;
  upgrade: ({ new_wasm_hash }: { new_wasm_hash: Buffer }, options?:MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  version: (options?: MethodOptions) => Promise<AssembledTransaction<string>>;
  has_role: ({ account, role }: { account: string; role: Role }, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>;
  unfreeze: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>;
  get_price: ({ base_asset, quote_asset }: { base_asset: string; quote_asset: string }, options?: MethodOptions) => Promise<AssembledTransaction<Result<PriceData>>>;
  is_frozen: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>;
  is_paused: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>;
}