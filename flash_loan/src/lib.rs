#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, vec, Address, Bytes,
    Env, IntoVal, Symbol,
};

const FEE_BPS: i128 = 5;
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
    pub fn flash_fee(amount: i128) -> Result<i128, Error> {
        Self::calculate_fee(amount)
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

        let fee = Self::calculate_fee(amount)?;
        let provider = env.current_contract_address();
        let token_client = token::Client::new(&env, &token_address);
        let balance_before = token_client.balance(&provider);

        if balance_before < amount {
            return Err(Error::InsufficientLiquidity);
        }

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

    fn calculate_fee(amount: i128) -> Result<i128, Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        amount
            .checked_mul(FEE_BPS)
            .and_then(|value| value.checked_add(BPS_DIVISOR - 1))
            .map(|value| value / BPS_DIVISOR)
            .ok_or(Error::ArithmeticOverflow)
    }
}

#[cfg(test)]
mod test;
