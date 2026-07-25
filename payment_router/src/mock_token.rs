#![cfg(test)]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Allowance(Address, Address),
    Balance(Address),
    Admin,
}

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn initialize(e: Env, admin: Address) {
        e.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn mint(e: Env, to: Address, amount: i128) {
        let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        let mut balance: i128 = e.storage().persistent().get(&DataKey::Balance(to.clone())).unwrap_or(0);
        balance += amount;
        e.storage().persistent().set(&DataKey::Balance(to), &balance);
    }

    pub fn transfer(e: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let mut from_balance: i128 = e.storage().persistent().get(&DataKey::Balance(from.clone())).unwrap_or(0);
        if from_balance < amount {
            panic!("insufficient balance");
        }
        from_balance -= amount;
        e.storage().persistent().set(&DataKey::Balance(from), &from_balance);

        let mut to_balance: i128 = e.storage().persistent().get(&DataKey::Balance(to.clone())).unwrap_or(0);
        to_balance += amount;
        e.storage().persistent().set(&DataKey::Balance(to), &to_balance);
    }

    pub fn balance(e: Env, id: Address) -> i128 {
        e.storage().persistent().get(&DataKey::Balance(id)).unwrap_or(0)
    }

    pub fn decimals(_e: Env) -> u32 {
        7
    }

    pub fn name(e: Env) -> String {
        String::from_str(&e, "MockToken")
    }

    pub fn symbol(e: Env) -> String {
        String::from_str(&e, "MOCK")
    }
}
