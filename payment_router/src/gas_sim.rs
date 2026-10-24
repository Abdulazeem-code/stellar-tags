//! Read-only predictive gas & slippage simulation (issue #881).
//!
//! The simulation engine itself lives in [`crate::fees`]; this module exposes
//! it under the `gas_sim` namespace that the contract entry point
//! `PaymentRouter::simulate_swap_execution` delegates to.  Re-exporting the
//! same items keeps `pub use gas_sim::*` and `pub use fees::*` in
//! [`crate`] pointing at one shared definition.

pub use crate::fees::{simulate_swap_execution, SwapSimulationReport};
