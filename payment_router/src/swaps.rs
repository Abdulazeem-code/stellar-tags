use crate::errors::Error;
use crate::storage::DataKey;
use crate::types::SplitRoute;
use crate::PaymentRouter;
use soroban_sdk::{log, symbol_short, token, Address, Env, Symbol, Vec};

pub const TOTAL_WEIGHT_BPS: u32 = 10_000;

/// Core split swap routing execution logic.
///
/// Divides `amount_in` across each split route proportionally by its weight in basis points,
/// executes swaps sequentially against registered DEX adapters, verifies per-split `min_amount_out`,
/// calculates platform fees on the aggregate received tokens, and delivers remainder to recipient.
pub fn process_split_payment_with_swap(
    env: &Env,
    sender: &Address,
    recipient: &Address,
    sell_token: &Address,
    buy_token: &Address,
    amount_in: i128,
    splits: &Vec<SplitRoute>,
    platform_treasury: &Address,
    fee_bps: i128,
    fee_cap: i128,
) -> Result<i128, Error> {
    sender.require_auth();

    if sell_token == buy_token {
        return Err(Error::InvalidSwapParams);
    }
    if splits.is_empty() {
        return Err(Error::InvalidSwapParams);
    }

    // Verify total weight equals 10,000 basis points (100%)
    let mut total_weight: u32 = 0;
    for split in splits.iter() {
        if split.weight_bps == 0 || split.min_amount_out <= 0 {
            return Err(Error::InvalidSwapParams);
        }
        if !PaymentRouter::is_dex_registered_internal(env, &split.dex_address) {
            return Err(Error::DexNotRegistered);
        }
        total_weight = total_weight
            .checked_add(split.weight_bps)
            .ok_or(Error::InvalidSwapParams)?;
    }
    if total_weight != TOTAL_WEIGHT_BPS {
        return Err(Error::InvalidSwapParams);
    }

    env.events().publish(
        (Symbol::new(env, "payment_initiated"), sender.clone()),
        amount_in,
    );

    if sender == recipient {
        return Err(Error::InvalidRecipient);
    }
    if PaymentRouter::is_blacklisted(env.clone(), recipient.clone()) {
        return Err(Error::Blacklisted);
    }

    // Amount bounds
    let max_amount: i128 = env
        .storage()
        .instance()
        .get(&DataKey::MaxAmount)
        .unwrap_or(PaymentRouter::MAX_AMOUNT);
    if amount_in <= 0 || amount_in > max_amount {
        return Err(Error::LimitExceeded);
    }
    let min_limit: i128 = env
        .storage()
        .instance()
        .get(&DataKey::MinLimit)
        .unwrap_or(0);
    if amount_in < min_limit {
        return Err(Error::LimitExceeded);
    }

    let user_volume = PaymentRouter::accrue_user_record(env, sender, amount_in)?;
    let effective_fee_bps = if user_volume > PaymentRouter::VOLUME_THRESHOLD {
        fee_bps / 2
    } else {
        fee_bps
    };

    let sell_token_client = token::Client::new(env, sell_token);
    if sell_token_client.balance(sender) < amount_in {
        return Err(Error::InsufficientBalance);
    }

    let contract_address = env.current_contract_address();
    let buy_token_client = token::Client::new(env, buy_token);

    // Pull total sell tokens into the router contract
    sell_token_client.transfer(sender, &contract_address, &amount_in);

    let mut total_out: i128 = 0;
    let num_splits = splits.len();
    let mut allocated_in: i128 = 0;

    for (idx, split) in splits.iter().enumerate() {
        let is_last = (idx as u32) == num_splits - 1;
        let split_amount_in = if is_last {
            amount_in - allocated_in
        } else {
            (amount_in * (split.weight_bps as i128)) / (TOTAL_WEIGHT_BPS as i128)
        };
        allocated_in += split_amount_in;

        if split_amount_in <= 0 {
            return Err(Error::InvalidSwapParams);
        }

        let buy_balance_before = buy_token_client.balance(&contract_address);

        // Transfer split share to DEX adapter and invoke swap
        sell_token_client.transfer(&contract_address, &split.dex_address, &split_amount_in);

        PaymentRouter::invoke_dex_swap(
            env,
            &split.dex_address,
            sell_token,
            buy_token,
            split_amount_in,
            split.min_amount_out,
        )?;

        let buy_balance_after = buy_token_client.balance(&contract_address);
        let split_out = buy_balance_after - buy_balance_before;

        if split_out < split.min_amount_out {
            log!(env, "Split swap output below min_amount_out; reverting");
            return Err(Error::SlippageExceeded);
        }

        env.events().publish(
            (
                Symbol::new(env, "swap_executed"),
                split.dex_address.clone(),
                sell_token.clone(),
                buy_token.clone(),
            ),
            (split_amount_in, split_out, split.min_amount_out),
        );

        total_out = total_out
            .checked_add(split_out)
            .ok_or(Error::LimitExceeded)?;
    }

    // Fee on aggregated output, then deliver to recipient
    let (fee_amount, remainder) =
        PaymentRouter::calculate_fee(total_out, effective_fee_bps, fee_cap);
    if fee_amount > 0 {
        buy_token_client.transfer(&contract_address, platform_treasury, &fee_amount);
    }
    if remainder > 0 {
        match buy_token_client.try_transfer(&contract_address, recipient, &remainder) {
            Ok(Ok(())) => {
                log!(env, "Split swapped remainder routed to recipient");
            }
            _ => {
                log!(
                    env,
                    "Recipient transfer failed; crediting sender refund balance"
                );
                PaymentRouter::credit_refund_balance(env, sender, buy_token, remainder);
            }
        }
    }

    env.events().publish(
        (
            symbol_short!("routed"),
            sender.clone(),
            recipient.clone(),
        ),
        remainder,
    );

    log!(env, "Payment routed through split DEX swaps");

    Ok(remainder)
}
