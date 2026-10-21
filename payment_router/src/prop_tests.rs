use proptest::prelude::*;

// --- constants mirrored from the contract ---
const BPS_DIVISOR: i128 = 10_000;
/// Maximum valid fee in basis points (100% = 10 000 bps).
const MAX_FEE_BPS: i128 = 10_000;
/// Upper bound for a single payment amount (matches contract MAX_AMOUNT).
const MAX_AMOUNT: i128 = 1_000_000_000_000_000;

// --- pure fee calculation logic (mirrors process_single_payment) ---

/// Computes `(fee_amount, remainder)` exactly as the contract does.
///
/// `user_volume_above_threshold` stands in for the tiered-discount check:
/// when `true` the effective fee is halved.
fn compute_fee(
    amount: i128,
    fee_bps: i128,
    fee_cap: i128,
    user_volume_above_threshold: bool,
) -> (i128, i128) {
    let effective_fee_bps = if user_volume_above_threshold {
        fee_bps / 2
    } else {
        fee_bps
    };

    let mut fee_amount = (amount * effective_fee_bps) / BPS_DIVISOR;
    if fee_amount > fee_cap {
        fee_amount = fee_cap;
    }
    if fee_amount > amount {
        fee_amount = amount;
    }
    let remainder = amount - fee_amount;
    (fee_amount, remainder)
}

// -----------------------------------------------------------------------
// Strategies
// -----------------------------------------------------------------------

/// A valid payment amount: 1 ..= MAX_AMOUNT (positive, within contract bounds).
fn valid_amount() -> impl Strategy<Value = i128> {
    1i128..=MAX_AMOUNT
}

/// A valid fee in basis points: 0 ..= 10 000 (0% to 100%).
fn valid_fee_bps() -> impl Strategy<Value = i128> {
    0i128..=MAX_FEE_BPS
}

/// A valid fee cap: 0 ..= MAX_AMOUNT.
fn valid_fee_cap() -> impl Strategy<Value = i128> {
    0i128..=MAX_AMOUNT
}

// -----------------------------------------------------------------------
// Property: fee_amount + remainder == amount  (conservation of funds)
// -----------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    /// Funds are fully conserved: every strobe of the amount ends up either
    /// in the treasury (fee) or the recipient (remainder), never lost or
    /// created.
    #[test]
    fn prop_fee_plus_remainder_equals_amount(
        amount in valid_amount(),
        fee_bps in valid_fee_bps(),
        fee_cap in valid_fee_cap(),
        above_threshold in any::<bool>(),
    ) {
        let (fee_amount, remainder) = compute_fee(amount, fee_bps, fee_cap, above_threshold);
        prop_assert_eq!(
            fee_amount + remainder,
            amount,
            "fee_amount ({}) + remainder ({}) != amount ({})",
            fee_amount, remainder, amount
        );
    }

    /// The fee is always non-negative — the treasury never receives a
    /// negative transfer.
    #[test]
    fn prop_fee_amount_is_non_negative(
        amount in valid_amount(),
        fee_bps in valid_fee_bps(),
        fee_cap in valid_fee_cap(),
        above_threshold in any::<bool>(),
    ) {
        let (fee_amount, _) = compute_fee(amount, fee_bps, fee_cap, above_threshold);
        prop_assert!(
            fee_amount >= 0,
            "fee_amount ({}) must be >= 0",
            fee_amount
        );
    }

    /// The remainder is always non-negative — the recipient never receives a
    /// negative transfer.
    #[test]
    fn prop_remainder_is_non_negative(
        amount in valid_amount(),
        fee_bps in valid_fee_bps(),
        fee_cap in valid_fee_cap(),
        above_threshold in any::<bool>(),
    ) {
        let (_, remainder) = compute_fee(amount, fee_bps, fee_cap, above_threshold);
        prop_assert!(
            remainder >= 0,
            "remainder ({}) must be >= 0",
            remainder
        );
    }

    /// The fee never exceeds the configured cap.
    #[test]
    fn prop_fee_respects_cap(
        amount in valid_amount(),
        fee_bps in valid_fee_bps(),
        fee_cap in valid_fee_cap(),
        above_threshold in any::<bool>(),
    ) {
        let (fee_amount, _) = compute_fee(amount, fee_bps, fee_cap, above_threshold);
        prop_assert!(
            fee_amount <= fee_cap,
            "fee_amount ({}) exceeds fee_cap ({})",
            fee_amount, fee_cap
        );
    }

    /// The fee never exceeds the payment amount itself — the sender cannot
    /// be charged more than they are sending.
    #[test]
    fn prop_fee_never_exceeds_amount(
        amount in valid_amount(),
        fee_bps in valid_fee_bps(),
        fee_cap in valid_fee_cap(),
        above_threshold in any::<bool>(),
    ) {
        let (fee_amount, _) = compute_fee(amount, fee_bps, fee_cap, above_threshold);
        prop_assert!(
            fee_amount <= amount,
            "fee_amount ({}) exceeds amount ({})",
            fee_amount, amount
        );
    }

    /// When the fee rate is zero the entire amount flows to the recipient.
    #[test]
    fn prop_zero_fee_bps_means_no_fee(
        amount in valid_amount(),
        fee_cap in valid_fee_cap(),
        above_threshold in any::<bool>(),
    ) {
        let (fee_amount, remainder) = compute_fee(amount, 0, fee_cap, above_threshold);
        prop_assert_eq!(fee_amount, 0, "fee_amount must be 0 when fee_bps is 0");
        prop_assert_eq!(remainder, amount, "remainder must equal amount when fee_bps is 0");
    }

    /// When the fee cap is zero no fee is ever collected regardless of the
    /// rate.
    #[test]
    fn prop_zero_fee_cap_means_no_fee(
        amount in valid_amount(),
        fee_bps in valid_fee_bps(),
        above_threshold in any::<bool>(),
    ) {
        let (fee_amount, remainder) = compute_fee(amount, fee_bps, 0, above_threshold);
        prop_assert_eq!(fee_amount, 0, "fee_amount must be 0 when fee_cap is 0");
        prop_assert_eq!(remainder, amount, "remainder must equal amount when fee_cap is 0");
    }

    /// The tiered discount never produces a *higher* fee than the standard
    /// rate: halving the bps can only leave the fee equal or reduce it.
    #[test]
    fn prop_tiered_discount_never_increases_fee(
        amount in valid_amount(),
        fee_bps in valid_fee_bps(),
        fee_cap in valid_fee_cap(),
    ) {
        let (fee_full, _) = compute_fee(amount, fee_bps, fee_cap, false);
        let (fee_discounted, _) = compute_fee(amount, fee_bps, fee_cap, true);
        prop_assert!(
            fee_discounted <= fee_full,
            "discounted fee ({}) must be <= full fee ({})",
            fee_discounted, fee_full
        );
    }
}
