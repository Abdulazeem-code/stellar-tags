#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, vec, Address, Bytes,
    Env, IntoVal, Symbol,
};

const BASE_FEE_BPS: i128 = 5;
const KINK_FEE_BPS: i128 = 10;
const MAX_FEE_BPS: i128 = 50;
const KINK_UTILIZATION_BPS: i128 = 8_000;
const BPS_DIVISOR: i128 = 10_000;

#[contracttype]
enum DataKey {
    ActiveLoan,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    InsufficientLiquidity = 2,
    LoanAlreadyActive = 3,
    ArithmeticOverflow = 4,
    RepaymentTooLow = 5,
}

#[contract]
pub struct FlashLoanProvider;

#[contractimpl]
impl FlashLoanProvider {
    /// Returns the fee for borrowing `amount` of `token_address` at current
    /// utilization. The reserve is the provider's current balance of that
    /// token, so callers must quote the same asset they intend to borrow.
    pub fn get_flash_loan_fee(
        env: Env,
        amount: i128,
        token_address: Address,
    ) -> Result<i128, Error> {
        let reserves =
            token::Client::new(&env, &token_address).balance(&env.current_contract_address());
        Self::calculate_fee(amount, reserves)
    }

    /// Legacy base-fee quote retained for clients using the original API.
    /// Use `get_flash_loan_fee` for the utilization-adjusted fee charged by
    /// `flash_loan`.
    pub fn flash_fee(amount: i128) -> Result<i128, Error> {
        Self::calculate_amount_fee(amount, BASE_FEE_BPS)
    }

    pub fn flash_loan(
        env: Env,
        initiator: Address,
        borrower: Address,
        token_address: Address,
        amount: i128,
        data: Bytes,
    ) -> Result<i128, Error> {
        initiator.require_auth();

        if env
            .storage()
            .instance()
            .get::<_, bool>(&DataKey::ActiveLoan)
            .unwrap_or(false)
        {
            return Err(Error::LoanAlreadyActive);
        }

        let provider = env.current_contract_address();
        let token_client = token::Client::new(&env, &token_address);
        let balance_before = token_client.balance(&provider);

        if balance_before < amount {
            return Err(Error::InsufficientLiquidity);
        }

        let fee = Self::calculate_fee(amount, balance_before)?;

        let required_balance = balance_before
            .checked_add(fee)
            .ok_or(Error::ArithmeticOverflow)?;

        env.storage().instance().set(&DataKey::ActiveLoan, &true);
        token_client.transfer(&provider, &borrower, &amount);

        env.invoke_contract::<()>(
            &borrower,
            &Symbol::new(&env, "on_flash_loan"),
            vec![
                &env,
                provider.clone().into_val(&env),
                initiator.clone().into_val(&env),
                token_address.clone().into_val(&env),
                amount.into_val(&env),
                fee.into_val(&env),
                data.into_val(&env),
            ],
        );

        if token_client.balance(&provider) < required_balance {
            return Err(Error::RepaymentTooLow);
        }

        env.storage().instance().set(&DataKey::ActiveLoan, &false);
        env.events().publish(
            (symbol_short!("flashloan"), borrower, token_address),
            (initiator, amount, fee),
        );

        Ok(fee)
    }

    fn calculate_fee(amount: i128, reserves: i128) -> Result<i128, Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        if reserves <= 0 || amount > reserves {
            return Err(Error::InsufficientLiquidity);
        }

        let utilization_bps = amount
            .checked_mul(BPS_DIVISOR)
            .and_then(|value| value.checked_add(reserves - 1))
            .map(|value| value / reserves)
            .ok_or(Error::ArithmeticOverflow)?;

        let fee_bps = if utilization_bps <= KINK_UTILIZATION_BPS {
            let increase = Self::ceil_div(
                BASE_FEE_BPS
                    .checked_mul(utilization_bps)
                    .ok_or(Error::ArithmeticOverflow)?,
                KINK_UTILIZATION_BPS,
            )?;
            BASE_FEE_BPS + increase
        } else {
            let above_kink = utilization_bps - KINK_UTILIZATION_BPS;
            let increase = Self::ceil_div(
                (MAX_FEE_BPS - KINK_FEE_BPS)
                    .checked_mul(above_kink)
                    .ok_or(Error::ArithmeticOverflow)?,
                BPS_DIVISOR - KINK_UTILIZATION_BPS,
            )?;
            KINK_FEE_BPS + increase
        }
        .min(MAX_FEE_BPS);

        Self::calculate_amount_fee(amount, fee_bps)
    }

    fn ceil_div(numerator: i128, denominator: i128) -> Result<i128, Error> {
        numerator
            .checked_add(denominator - 1)
            .map(|value| value / denominator)
            .ok_or(Error::ArithmeticOverflow)
    }

    fn calculate_amount_fee(amount: i128, fee_bps: i128) -> Result<i128, Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        amount
            .checked_mul(fee_bps)
            .and_then(|value| value.checked_add(BPS_DIVISOR - 1))
            .map(|value| value / BPS_DIVISOR)
            .ok_or(Error::ArithmeticOverflow)
    }
}

#[cfg(test)]
mod test;
