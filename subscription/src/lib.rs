#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol,
    Vec,
};

#[cfg(test)]
mod test;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    NotActive = 2,
    TooEarly = 3,
    MaxPeriodsReached = 4,
    Unauthorized = 5,
    InvalidAmount = 6,
    InvalidPeriod = 7,
    InvalidMaxPeriods = 8,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Counter,
    Subscription(u64),
    PayerSubs(Address),
    MerchantSubs(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Subscription {
    pub id: u64,
    pub payer: Address,
    pub merchant: Address,
    pub token: Address,
    pub amount_per_period: i128,
    pub period_seconds: u64,
    pub max_periods: u32,
    pub charged_count: u32,
    pub last_charged_at: u64,
    pub active: bool,
}

#[contract]
pub struct SubscriptionContract;

#[contractimpl]
impl SubscriptionContract {
    /// Creates a recurring payment subscription.
    ///
    /// The payer must authorize the call. The payer is also responsible for
    /// approving the subscription contract to spend `amount_per_period` on the
    /// token contract before charges can succeed.
    pub fn create(
        env: Env,
        payer: Address,
        merchant: Address,
        token: Address,
        amount_per_period: i128,
        period_seconds: u64,
        max_periods: u32,
    ) -> Result<u64, Error> {
        payer.require_auth();

        if amount_per_period <= 0 {
            return Err(Error::InvalidAmount);
        }
        if period_seconds == 0 {
            return Err(Error::InvalidPeriod);
        }
        if max_periods == 0 {
            return Err(Error::InvalidMaxPeriods);
        }

        let mut id: u64 = env.storage().instance().get(&DataKey::Counter).unwrap_or(0);
        id += 1;
        env.storage().instance().set(&DataKey::Counter, &id);

        let now = env.ledger().timestamp();
        let subscription = Subscription {
            id,
            payer: payer.clone(),
            merchant: merchant.clone(),
            token: token.clone(),
            amount_per_period,
            period_seconds,
            max_periods,
            charged_count: 0,
            last_charged_at: now,
            active: true,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Subscription(id), &subscription);
        Self::append_id(&env, DataKey::PayerSubs(payer.clone()), id);
        Self::append_id(&env, DataKey::MerchantSubs(merchant.clone()), id);

        env.events().publish(
            (symbol_short!("created"), id),
            (
                payer,
                merchant,
                token,
                amount_per_period,
                period_seconds,
                max_periods,
            ),
        );

        Ok(id)
    }

    /// Charges due subscription periods.
    ///
    /// Callable by anyone. Transfers `amount_per_period` from the payer to the
    /// merchant for each due period using `transfer_from`. Missed periods are
    /// caught up in the same call, up to `max_periods` total.
    ///
    /// If a token transfer fails because of insufficient balance or allowance,
    /// a `charge_failed` event is emitted and the call does not panic. Any
    /// periods already charged in the same call remain charged.
    pub fn charge(env: Env, id: u64) -> Result<u32, Error> {
        let key = DataKey::Subscription(id);
        let mut sub: Subscription = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if !sub.active {
            return Err(Error::NotActive);
        }
        if sub.charged_count >= sub.max_periods {
            return Err(Error::MaxPeriodsReached);
        }

        let now = env.ledger().timestamp();
        if now < sub.last_charged_at.saturating_add(sub.period_seconds) {
            return Err(Error::TooEarly);
        }

        let elapsed = now - sub.last_charged_at;
        let remaining = sub.max_periods - sub.charged_count;
        let due_periods = elapsed / sub.period_seconds;
        let to_charge = u32::try_from(due_periods.min(u64::from(remaining))).unwrap_or(remaining);
        if to_charge == 0 {
            return Err(Error::TooEarly);
        }

        let token_client = token::Client::new(&env, &sub.token);
        let spender = env.current_contract_address();
        let mut charged_now: u32 = 0;

        for _ in 0..to_charge {
            let transfer = token_client.try_transfer_from(
                &spender,
                &sub.payer,
                &sub.merchant,
                &sub.amount_per_period,
            );
            match transfer {
                Ok(Ok(())) => {
                    sub.charged_count += 1;
                    sub.last_charged_at = sub.last_charged_at.saturating_add(sub.period_seconds);
                    charged_now += 1;
                    env.events().publish(
                        (symbol_short!("charged"), id),
                        (sub.charged_count, sub.amount_per_period),
                    );
                }
                _ => {
                    env.events().publish(
                        (Symbol::new(&env, "charge_failed"), id),
                        (sub.charged_count, sub.amount_per_period),
                    );
                    break;
                }
            }
        }

        env.storage().persistent().set(&key, &sub);
        Ok(charged_now)
    }

    /// Cancels a subscription. Either the payer or the merchant may cancel.
    pub fn cancel(env: Env, caller: Address, id: u64) -> Result<(), Error> {
        caller.require_auth();

        let key = DataKey::Subscription(id);
        let mut sub: Subscription = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if caller != sub.payer && caller != sub.merchant {
            return Err(Error::Unauthorized);
        }
        if !sub.active {
            return Err(Error::NotActive);
        }

        sub.active = false;
        env.storage().persistent().set(&key, &sub);
        env.events()
            .publish((Symbol::new(&env, "cancelled"), id), caller);

        Ok(())
    }

    /// Returns a subscription by id, if it exists.
    pub fn get(env: Env, id: u64) -> Option<Subscription> {
        env.storage().persistent().get(&DataKey::Subscription(id))
    }

    /// Lists subscription ids created for a payer.
    pub fn list_by_payer(env: Env, payer: Address) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::PayerSubs(payer))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Lists subscription ids created for a merchant.
    pub fn list_by_merchant(env: Env, merchant: Address) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::MerchantSubs(merchant))
            .unwrap_or_else(|| Vec::new(&env))
    }

    fn append_id(env: &Env, key: DataKey, id: u64) {
        let mut ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(env));
        ids.push_back(id);
        env.storage().persistent().set(&key, &ids);
    }
}
