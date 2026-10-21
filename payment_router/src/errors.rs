use soroban_sdk::contracterror;

/// Contract-level errors returned instead of panicking, so callers get a
/// specific, stable error code to branch on rather than an opaque trap.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Caller is not authorized to perform this action (e.g. not the admin).
    Unauthorized = 1,
    /// Sender's token balance is lower than the requested payment amount.
    InsufficientBalance = 2,
    /// Requested amount is outside allowed bounds, or a spending limit was exceeded.
    LimitExceeded = 3,
    /// `initialize` was called on a contract that already has an admin set.
    AlreadyInitialized = 4,
    /// An admin-configured value (treasury, fee, admin) was read before `initialize`.
    NotInitialized = 5,
    /// The contract is currently paused; routing calls are rejected until unpaused.
    Paused = 6,
    /// A fee configuration value (basis points or cap) is out of the allowed range.
    InvalidFeeRate = 7,
    /// Sender and recipient addresses are the same (self-routing not allowed).
    InvalidRecipient = 8,
    /// Recipient address is blacklisted.
    Blacklisted = 9,
    /// Requested refund withdrawal amount is zero or exceeds available refund balance.
    NoRefundAvailable = 10,
    /// An action is already pending in the timelock queue; it must be executed
    /// or cancelled before a duplicate can be queued (not currently enforced,
    /// but reserved for future deduplication logic).
    TimelockPending = 11,
    /// The 24-hour delay for the given timelock entry has not elapsed yet.
    TimelockNotReady = 12,
    /// No timelock entry exists for the supplied nonce ID.
    TimelockNotFound = 13,
    /// The contract is frozen; all payments and timelock executions are blocked.
    ContractFrozen = 14,
    /// The swap named a DEX router that the admin has not registered.
    DexNotRegistered = 15,
    /// The DEX cross-contract call reverted or returned an unusable value.
    SwapFailed = 16,
    /// The swap delivered less than `min_amount_out`, or moved the output
    /// further than `max_slippage_bps` away from the caller's quote.
    SlippageExceeded = 17,
    /// The swap was submitted after its `deadline` had already passed.
    SwapDeadlineExpired = 18,
    /// The supplied role is not one the contract recognises.
    InvalidRole = 20,
    /// No backup admin has been armed, so the dead man's switch cannot fire.
    NoBackupAdmin = 43,
    /// The dead man's switch timeout has not elapsed since the last heartbeat.
    DmsNotReady = 44,
    /// A dead man's switch configuration value is out of the allowed range.
    InvalidDmsConfig = 45,
    /// The sender exceeded the per-ledger payment invocation cap.
    RateLimited = 46,
    /// The caller does not hold the role required by the entrypoint.
    RoleNotFound = 47,
    /// A governance proposal id is unknown or no longer votable.
    InvalidProposal = 21,
    /// A governance operation was attempted before governance was configured.
    GovernanceNotConfigured = 22,
    /// The caller has already voted on this proposal.
    AlreadyVoted = 23,
    /// The configured KYC threshold is negative.
    InvalidKycThreshold = 24,
    /// A yield operation was attempted before the yield protocol was configured.
    YieldProtocolNotConfigured = 25,
    /// The yield amount is not positive or exceeds the available principal.
    InvalidYieldAmount = 26,
    /// No price-feed oracle is configured for this contract.
    OracleNotConfigured = 27,
    /// The oracle cross-contract call reverted or returned an unusable value.
    OracleCallFailed = 28,
    /// The oracle quote is older than the configured staleness threshold.
    OraclePriceStale = 29,
    /// The oracle quote is not a usable price (zero or negative).
    OraclePriceInvalid = 30,
    /// A meta-transaction was submitted after its `deadline` had passed.
    DeadlineExpired = 31,
    /// The meta-transaction nonce does not match the sender's stored nonce.
    InvalidNonce = 32,
    /// The meta-transaction signature did not verify against the payload.
    InvalidSignature = 33,
    /// Swap parameters are self-contradictory or unusable (for example
    /// `sell_token == buy_token`, or a non-positive `min_amount_out`).
    InvalidSwapParams = 19,
    /// A payment above the configured KYC threshold was made by a sender the
    /// configured oracle does not recognise.
    KycRequired = 34,
    /// A swap path is empty, malformed, or does not connect the requested assets.
    InvalidSwapPath = 35,
    /// The DEX returned less than the caller's minimum acceptable output.
    SlippageExceededSwap = 36,
    /// The multi-signature configuration is unusable: the signer set is empty,
    /// contains a duplicate address, the threshold is zero, or the threshold
    /// exceeds the number of signers (so the upgrade could never be authorized).
    InvalidMultisigConfig = 37,
    /// The calling address is not a member of the multi-signature admin group.
    NotMultisigSigner = 38,
    /// The number of collected upgrade approvals is below the configured
    /// threshold, so the upgrade is not authorized yet.
    InsufficientApprovals = 39,
    /// No multi-signature admin group has been configured yet.  Upgrades fail
    /// closed until `set_multisig_config` has been called, so a freshly
    /// deployed contract can never be upgraded through the single admin key
    /// that the group was introduced to de-risk.
    MultisigNotInitialized = 40,
    /// The calling address has already approved this WASM hash.  Duplicate
    /// approvals are rejected rather than ignored so that a replayed signature
    /// can never inflate the approval count towards the threshold.
    AlreadyApproved = 41,
    /// A reentrant call was detected.
    ReentrantCall = 42,
    /// No Merkle batch exists for the supplied root or batch id.
    MerkleBatchNotFound = 48,
    /// A Merkle batch with this root has already been registered.
    MerkleBatchAlreadyExists = 49,
    /// The supplied Merkle inclusion proof does not verify against the root.
    InvalidMerkleProof = 50,
    /// The recipient has already claimed their Merkle payment.
    MerklePaymentAlreadyClaimed = 51,
    /// The Merkle batch has not expired yet, so unclaimed funds cannot be
    /// reclaimed by the sender.
    MerkleBatchNotExpired = 52,
    /// The Merkle batch has expired and can no longer be claimed against.
    MerkleBatchExpired = 53,
    /// The claimed amount does not match the amount committed in the Merkle
    /// leaf for this recipient.
    MerkleAmountMismatch = 54,
}