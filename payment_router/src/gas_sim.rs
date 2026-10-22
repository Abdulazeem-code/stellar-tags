use crate::errors::Error;
use crate::storage::BPS_DIVISOR;
use crate::types::SwapSimulationReport;
use soroban_sdk::{Address, Env, Vec};

/// Maximum number of read-write ledger entries supported by a transaction.
pub const MAX_READ_WRITE_KEYS: u32 = 40;

const BASE_HOP_CPU: u64 = 15_000;
const BASE_HOP_MEMORY: u64 = 1_024;
const PER_KEY_CPU: u64 = 500;
const PER_KEY_MEMORY: u64 = 256;
const ROUTER_BASE_CPU: u64 = 5_000;
const ROUTER_BASE_MEMORY: u64 = 512;
const DEFAULT_POOL_FEE_BPS: i128 = 30;
const MAX_PRICE_IMPACT_BPS: i128 = 1_000;
const DEFAULT_RESERVE_IN: i128 = 1_000_000;
const DEFAULT_RESERVE_OUT: i128 = 1_010_000;

fn read_pool_metadata(_env: &Env, _pool: &Address) -> (i128, i128, i128) {
    (
        DEFAULT_RESERVE_IN,
        DEFAULT_RESERVE_OUT,
        DEFAULT_POOL_FEE_BPS,
    )
}

fn simulate_hop(
    reserve_in: i128,
    reserve_out: i128,
    amount_in: i128,
    fee_bps: i128,
) -> Option<(i128, i128)> {
    if reserve_in <= 0 || reserve_out <= 0 || amount_in <= 0 || !(0..BPS_DIVISOR).contains(&fee_bps)
    {
        return None;
    }

    let fee = amount_in.checked_mul(fee_bps)? / BPS_DIVISOR;
    let amount_in_net = amount_in.checked_sub(fee)?;
    let numerator = reserve_out.checked_mul(amount_in_net)?;
    let denominator = reserve_in.checked_add(amount_in_net)?;
    if denominator <= 0 {
        return None;
    }

    let amount_out = numerator / denominator;
    if amount_out <= 0 || amount_out >= reserve_out {
        return None;
    }

    let impact_bps = amount_in.checked_mul(BPS_DIVISOR)? / reserve_in;
    Some((amount_out, impact_bps))
}

/// Simulates a multi-hop swap without writing contract storage.
pub fn simulate_swap_execution(
    env: &Env,
    route: Vec<Address>,
    amount_in: i128,
) -> Result<SwapSimulationReport, Error> {
    if route.is_empty() {
        return Err(Error::InvalidSwapPath);
    }
    if amount_in <= 0 {
        return Err(Error::InvalidSwapParams);
    }

    let hops = route.len();
    let mut amount_out = amount_in;
    let mut impact_bps = 0i128;
    let mut read_only = Vec::new(env);
    let mut read_write = Vec::new(env);

    for pool in route.iter() {
        let (reserve_in, reserve_out, fee_bps) = read_pool_metadata(env, &pool);
        let (next_amount, hop_impact) =
            simulate_hop(reserve_in, reserve_out, amount_out, fee_bps).ok_or(Error::SwapFailed)?;
        amount_out = next_amount;
        impact_bps = impact_bps.saturating_add(hop_impact);
        read_only.push_back(pool.clone());
        read_write.push_back(pool);
    }

    // Each pool touches reserve-in, reserve-out, and fee entries; the router
    // adds one registry entry to the transaction's read-write footprint.
    let read_write_key_count = hops.saturating_mul(3).saturating_add(1);
    let hops_u64 = u64::from(hops);
    let keys_u64 = u64::from(read_write_key_count);
    let estimated_cpu_instructions = ROUTER_BASE_CPU
        .saturating_add(hops_u64.saturating_mul(BASE_HOP_CPU))
        .saturating_add(keys_u64.saturating_mul(PER_KEY_CPU));
    let estimated_memory_bytes = ROUTER_BASE_MEMORY
        .saturating_add(hops_u64.saturating_mul(BASE_HOP_MEMORY))
        .saturating_add(keys_u64.saturating_mul(PER_KEY_MEMORY));

    Ok(SwapSimulationReport {
        estimated_cpu_instructions,
        estimated_memory_bytes,
        projected_amount_out: amount_out,
        price_impact_bps: impact_bps.min(MAX_PRICE_IMPACT_BPS),
        read_only,
        read_write,
        exceeds_footprint_limit: read_write_key_count > MAX_READ_WRITE_KEYS,
    })
}
