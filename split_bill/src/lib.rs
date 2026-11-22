#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Map,
};

#[cfg(test)]
mod test;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    Unauthorized = 2,
    NotOpen = 3,
    InvalidShare = 4,
    EmptyShares = 5,
    NotParticipant = 6,
    AlreadyPaid = 7,
    DeadlineNotPassed = 8,
    AlreadyHasPayments = 9,
    InvalidDeadline = 10,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum BillStatus {
    Open = 0,
    Completed = 1,
    Refunded = 2,
    Cancelled = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Counter,
    Bill(u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bill {
    pub id: u64,
    pub organiser: Address,
    pub recipient: Address,
    pub token: Address,
    pub shares: Map<Address, i128>,
    pub paid: Map<Address, bool>,
    pub paid_count: u32,
    pub total_amount: i128,
    pub deadline: u64,
    pub status: BillStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BillView {
    pub id: u64,
    pub organiser: Address,
    pub recipient: Address,
    pub token: Address,
    pub shares: Map<Address, i128>,
    pub paid: Map<Address, bool>,
    pub deadline: u64,
    pub status: BillStatus,
}

#[contract]
pub struct SplitBillContract;

#[contractimpl]
impl SplitBillContract {
    /// Creates a split bill escrow. Each participant's share is fixed up front.
    pub fn create(
        env: Env,
        organiser: Address,
        recipient: Address,
        token: Address,
        shares: Map<Address, i128>,
        deadline: u64,
    ) -> Result<u64, Error> {
        organiser.require_auth();

        if shares.is_empty() {
            return Err(Error::EmptyShares);
        }
        if deadline <= env.ledger().timestamp() {
            return Err(Error::InvalidDeadline);
        }

        let mut paid: Map<Address, bool> = Map::new(&env);
        let mut total_amount: i128 = 0;
        for (participant, amount) in shares.iter() {
            if amount <= 0 {
                return Err(Error::InvalidShare);
            }
            total_amount = total_amount
                .checked_add(amount)
                .ok_or(Error::InvalidShare)?;
            paid.set(participant, false);
        }

        let mut id: u64 = env.storage().instance().get(&DataKey::Counter).unwrap_or(0);
        id += 1;
        env.storage().instance().set(&DataKey::Counter, &id);

        let bill = Bill {
            id,
            organiser: organiser.clone(),
            recipient: recipient.clone(),
            token: token.clone(),
            shares: shares.clone(),
            paid,
            paid_count: 0,
            total_amount,
            deadline,
            status: BillStatus::Open,
        };
        env.storage().persistent().set(&DataKey::Bill(id), &bill);

        env.events().publish(
            (symbol_short!("created"), id),
            (organiser, recipient, token, deadline),
        );

        Ok(id)
    }

    /// Pays a participant's exact share into the escrow.
    /// When all shares are paid, releases the full amount to the recipient.
    pub fn pay(env: Env, id: u64, participant: Address) -> Result<(), Error> {
        participant.require_auth();

        let key = DataKey::Bill(id);
        let mut bill: Bill = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if bill.status != BillStatus::Open {
            return Err(Error::NotOpen);
        }

        let share = bill
            .shares
            .get(participant.clone())
            .ok_or(Error::NotParticipant)?;
        if bill.paid.get(participant.clone()).unwrap_or(false) {
            return Err(Error::AlreadyPaid);
        }

        let token_client = token::Client::new(&env, &bill.token);
        token_client.transfer(&participant, &env.current_contract_address(), &share);

        bill.paid.set(participant.clone(), true);
        bill.paid_count += 1;
        env.events()
            .publish((symbol_short!("paid"), id), (participant, share));

        if bill.paid_count == bill.shares.len() {
            token_client.transfer(
                &env.current_contract_address(),
                &bill.recipient,
                &bill.total_amount,
            );
            bill.status = BillStatus::Completed;
            env.events()
                .publish((symbol_short!("released"), id), bill.total_amount);
        }

        env.storage().persistent().set(&key, &bill);
        Ok(())
    }

    /// Refunds all paid shares after the deadline if the bill is not fully paid.
    /// Callable by anyone.
    pub fn refund(env: Env, id: u64) -> Result<(), Error> {
        let key = DataKey::Bill(id);
        let mut bill: Bill = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if bill.status != BillStatus::Open {
            return Err(Error::NotOpen);
        }
        if env.ledger().timestamp() <= bill.deadline {
            return Err(Error::DeadlineNotPassed);
        }

        let token_client = token::Client::new(&env, &bill.token);
        for (participant, share) in bill.shares.iter() {
            if bill.paid.get(participant.clone()).unwrap_or(false) {
                token_client.transfer(&env.current_contract_address(), &participant, &share);
                env.events()
                    .publish((symbol_short!("refunded"), id), (participant, share));
            }
        }

        bill.status = BillStatus::Refunded;
        env.storage().persistent().set(&key, &bill);
        env.events()
            .publish((symbol_short!("closed"), id), symbol_short!("refunded"));

        Ok(())
    }

    /// Cancels a bill. Organiser only, and only before anyone has paid.
    pub fn cancel(env: Env, caller: Address, id: u64) -> Result<(), Error> {
        caller.require_auth();

        let key = DataKey::Bill(id);
        let mut bill: Bill = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if caller != bill.organiser {
            return Err(Error::Unauthorized);
        }
        if bill.status != BillStatus::Open {
            return Err(Error::NotOpen);
        }
        if bill.paid_count > 0 {
            return Err(Error::AlreadyHasPayments);
        }

        bill.status = BillStatus::Cancelled;
        env.storage().persistent().set(&key, &bill);
        env.events()
            .publish((symbol_short!("canceled"), id), caller);

        Ok(())
    }

    /// Returns the bill details: shares, who has paid, and status.
    pub fn get(env: Env, id: u64) -> Option<BillView> {
        let bill: Bill = env.storage().persistent().get(&DataKey::Bill(id))?;
        Some(BillView {
            id: bill.id,
            organiser: bill.organiser,
            recipient: bill.recipient,
            token: bill.token,
            shares: bill.shares,
            paid: bill.paid,
            deadline: bill.deadline,
            status: bill.status,
        })
    }
}
