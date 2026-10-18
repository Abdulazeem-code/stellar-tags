#![no_std]

pub mod storage;

use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct PausableToken;

#[contractimpl]
impl PausableToken {
    pub fn initialize(_env: Env, _admin: Address) {}
}
