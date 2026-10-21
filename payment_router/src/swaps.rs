use soroban_sdk::{symbol_short, token, vec, Address, Env, Symbol, Vec};

use crate::{
    errors::Error,
    types::{PartialFillResult, PartialSwapPayment},
};

const BPS: i128 = 10_000;

pub fn validate_partial_swap(swap: &PartialSwapPayment, env: &Env) -> Result<(), Error> {
    if swap.sell_token == swap.buy_token {
        return Err(Error::InvalidSwapParams);
    }
    if swap.min_amount_out <= 0 || swap.min_fill_bps <= 0 || swap.min_fill_bps > BPS {
        return Err(Error::InvalidSwapParams);
    }
    if swap.deadline != 0 && env.ledger().timestamp() > swap.deadline {
        return Err(Error::SwapDeadlineExpired);
    }
    Ok(())
}

/// Invokes `swap_exact_tokens_for_tokens` on the DEX (which may return unused
/// input alongside the received output) and returns `(amount_received, unused_input)`.
fn invoke_partial_swap(
    env: &Env,
    swap: &PartialSwapPayment,
) -> Result<(i128, i128), Error> {
    use soroban_sdk::{Error as SdkError, InvokeError};

    let path: Vec<Address> = vec![env, swap.sell_token.clone(), swap.buy_token.clone()];
    let contract = env.current_contract_address();

    let result: Result<Result<Vec<i128>, SdkError>, Result<InvokeError, InvokeError>> =
        env.try_invoke_contract(
            &swap.dex,
            &Symbol::new(env, "swap_exact_tokens_for_tokens"),
            vec![
                env,
                swap.sell_token.clone().into_val(env),
                swap.buy_token.clone().into_val(env),
                swap.amount_in.into_val(env),
                swap.min_amount_out.into_val(env),
                path.into_val(env),
                contract.into_val(env),
            ],
        );

    match result {
        Ok(Ok(v)) if v.len() >= 2 => Ok((v.get(0).unwrap(), v.get(1).unwrap())),
        Ok(Ok(v)) if v.len() == 1 => Ok((v.get(0).unwrap(), 0)),
        _ => Err(Error::SwapFailed),
    }
}

pub fn execute_partial_fill(
    env: &Env,
    swap: &PartialSwapPayment,
    platform_treasury: &Address,
    effective_fee_bps: i128,
    fee_cap: i128,
    fee_fn: impl Fn(i128, i128, i128) -> (i128, i128),
    credit_refund_fn: impl Fn(&Env, &Address, &Address, i128),
) -> Result<PartialFillResult, Error> {
    let contract = env.current_contract_address();
    let sell = token::Client::new(env, &swap.sell_token);
    let buy = token::Client::new(env, &swap.buy_token);

    sell.transfer(&swap.sender, &contract, &swap.amount_in);
    sell.transfer(&contract, &swap.dex, &swap.amount_in);

    let (amount_received, unused_input) = invoke_partial_swap(env, swap)?;

    let min_fill_amount = swap.amount_in * swap.min_fill_bps / BPS;
    if amount_received < min_fill_amount {
        return Err(Error::MinFillNotMet);
    }

    let refunded_amount = if unused_input > 0 {
        sell.transfer(&swap.dex, &swap.sender, &unused_input);
        unused_input
    } else {
        0
    };

    let (fee_amount, remainder) = fee_fn(amount_received, effective_fee_bps, fee_cap);
    if fee_amount > 0 {
        buy.transfer(&contract, platform_treasury, &fee_amount);
    }
    if remainder > 0 {
        match buy.try_transfer(&contract, &swap.recipient, &remainder) {
            Ok(Ok(())) => {}
            _ => credit_refund_fn(env, &swap.sender, &swap.buy_token, remainder),
        }
    }

    env.events().publish(
        (
            Symbol::new(env, "partial_swap_executed"),
            swap.sender.clone(),
            swap.recipient.clone(),
        ),
        (
            amount_received,
            refunded_amount,
            swap.sell_token.clone(),
            swap.buy_token.clone(),
        ),
    );

    env.events().publish(
        (
            symbol_short!("routed"),
            swap.sender.clone(),
            swap.recipient.clone(),
        ),
        remainder,
    );

    Ok(PartialFillResult {
        filled_amount: remainder,
        refunded_amount,
    })
}
