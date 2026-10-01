#![no_std]

pub mod test;

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    AlreadyClaimed = 2,
    StillLocked = 3,
    NotFound = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Escrow(u64), // id to Escrow mapping
    Counter,     // counter for escrow ids
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub depositor: Address,
    pub recipient: Address,
    pub token: Address,
    pub amount: i128,
    pub release_time: u64,
    pub claimed: bool,
}

#[contract]
pub struct TimelockEscrow;

#[contractimpl]
impl TimelockEscrow {
    /// Deposit funds into a timelocked escrow.
    /// Returns the escrow ID.
    pub fn deposit(
        env: Env,
        depositor: Address,
        recipient: Address,
        token: Address,
        amount: i128,
        release_time: u64,
    ) -> Result<u64, Error> {
        depositor.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        // Transfer funds to the contract
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&depositor, &env.current_contract_address(), &amount);

        // Generate escrow ID
        let mut id: u64 = env.storage().instance().get(&DataKey::Counter).unwrap_or(0);
        id += 1;
        env.storage().instance().set(&DataKey::Counter, &id);

        let escrow = Escrow {
            depositor,
            recipient,
            token,
            amount,
            release_time,
            claimed: false,
        };

        // Escrow can live longer, so use persistent storage
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(id), &escrow);

        Ok(id)
    }

    /// Claim funds from an escrow.
    pub fn claim(env: Env, id: u64) -> Result<(), Error> {
        let key = DataKey::Escrow(id);
        let mut escrow: Escrow = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;

        if escrow.claimed {
            return Err(Error::AlreadyClaimed);
        }

        let current_time = env.ledger().timestamp();
        if current_time < escrow.release_time {
            return Err(Error::StillLocked);
        }

        let token_client = token::Client::new(&env, &escrow.token);
        token_client.transfer(
            &env.current_contract_address(),
            &escrow.recipient,
            &escrow.amount,
        );

        escrow.claimed = true;
        env.storage().persistent().set(&key, &escrow);

        Ok(())
    }
}
