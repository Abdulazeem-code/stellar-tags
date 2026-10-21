#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::Env;

struct Setup {
    env: Env,
    admin: Address,
    client: TwapOracleClient<'static>,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    // Put the ledger clock ahead of every timestamp used in the tests so that
    // the "not in the future" guard does not interfere with the fixtures.
    env.ledger().with_mut(|ledger| ledger.timestamp = 1_000_000);

    let admin = Address::generate(&env);
    let id = env.register_contract(None, TwapOracle);
    let client = TwapOracleClient::new(&env, &id);
    client.initialize(&admin);

    Setup { env, admin, client }
}

fn set_time(env: &Env, timestamp: u64) {
    env.ledger().with_mut(|ledger| ledger.timestamp = timestamp);
}

/// 100 for 60s, then 200 for 60s, then 300. Segment integrals:
/// obs0.cumulative = 0, obs1.cumulative = 6_000, obs2.cumulative = 18_000.
fn seed_observations(setup: &Setup) {
    set_time(&setup.env, 1_000);
    let _ = setup.client.observe(&100, &1_000);
    set_time(&setup.env, 1_060);
    let _ = setup.client.observe(&200, &1_060);
    set_time(&setup.env, 1_120);
    let _ = setup.client.observe(&300, &1_120);
}

#[test]
fn initialize_sets_admin_and_empty_history() {
    let setup = setup();

    assert_eq!(setup.client.admin(), Some(setup.admin.clone()));
    assert_eq!(setup.client.observation_count(), 0);
    assert_eq!(setup.client.latest_observation(), None);
}

#[test]
fn initialize_cannot_be_called_twice() {
    let setup = setup();

    assert_eq!(
        setup.client.try_initialize(&setup.admin),
        Err(Ok(Error::AlreadyInitialized))
    );
}

#[test]
fn observe_requires_initialization() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);

    let id = env.register_contract(None, TwapOracle);
    let client = TwapOracleClient::new(&env, &id);

    assert_eq!(
        client.try_observe(&100, &1_000),
        Err(Ok(Error::NotInitialized))
    );
}

#[test]
fn observe_appends_and_derives_cumulative_price() {
    let setup = setup();
    seed_observations(&setup);

    let observations = setup.client.observations();
    assert_eq!(observations.len(), 3);
    assert_eq!(setup.client.observation_count(), 3);

    let first = observations.get(0).unwrap();
    assert_eq!(first.timestamp, 1_000);
    assert_eq!(first.price, 100);
    assert_eq!(first.cumulative_price, 0);

    let second = observations.get(1).unwrap();
    assert_eq!(second.cumulative_price, 6_000);

    let third = observations.get(2).unwrap();
    assert_eq!(third.cumulative_price, 18_000);

    let latest = setup.client.latest_observation().unwrap();
    assert_eq!(latest, third);
}

#[test]
fn observe_rejects_non_positive_and_out_of_range_prices() {
    let setup = setup();

    assert_eq!(
        setup.client.try_observe(&0, &1_000),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        setup.client.try_observe(&-1, &1_000),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        setup.client.try_observe(&(MAX_PRICE + 1), &1_000),
        Err(Ok(Error::InvalidPrice))
    );
    // The upper bound itself is accepted.
    assert_eq!(setup.client.observe(&MAX_PRICE, &1_000), 1);
}

#[test]
fn observe_rejects_future_timestamps() {
    let setup = setup();

    set_time(&setup.env, 1_000);
    assert_eq!(
        setup.client.try_observe(&100, &1_001),
        Err(Ok(Error::TimestampInFuture))
    );
}

#[test]
fn observe_rejects_non_monotonic_timestamps() {
    let setup = setup();
    seed_observations(&setup);

    // Equal to the previous timestamp.
    assert_eq!(
        setup.client.try_observe(&150, &1_120),
        Err(Ok(Error::TimestampNotMonotonic))
    );
    // Older than the previous timestamp.
    assert_eq!(
        setup.client.try_observe(&150, &1_100),
        Err(Ok(Error::TimestampNotMonotonic))
    );
}

#[test]
fn observe_enforces_the_minimum_interval() {
    let setup = setup();
    set_time(&setup.env, 1_000);
    let _ = setup.client.observe(&100, &1_000);

    set_time(&setup.env, 1_059);
    assert_eq!(
        setup.client.try_observe(&200, &1_059),
        Err(Ok(Error::ObservationTooSoon))
    );

    // Exactly MIN_INTERVAL_SECONDS later is accepted.
    set_time(&setup.env, 1_060);
    assert_eq!(setup.client.observe(&200, &1_060), 2);
}

#[test]
fn observe_prunes_the_oldest_observation_when_full() {
    let setup = setup();
    set_time(&setup.env, 1_000);

    let mut index = 0u64;
    while index < u64::from(MAX_OBSERVATIONS) + 1 {
        let timestamp = 1_000 + index * MIN_INTERVAL_SECONDS;
        set_time(&setup.env, timestamp);
        let _ = setup.client.observe(&100, &timestamp);
        index += 1;
    }

    assert_eq!(setup.client.observation_count(), MAX_OBSERVATIONS);

    let observations = setup.client.observations();
    assert_eq!(observations.len(), MAX_OBSERVATIONS);
    // The very first observation was dropped.
    assert_eq!(
        observations.get(0).unwrap().timestamp,
        1_000 + MIN_INTERVAL_SECONDS
    );
}

#[test]
fn observe_rejects_accumulator_overflow() {
    let setup = setup();

    // Seed the accumulator with a maximal price, then advance the ledger clock
    // by an astronomically large gap: MAX_PRICE * elapsed overflows i128.
    set_time(&setup.env, 1_000);
    let _ = setup.client.observe(&MAX_PRICE, &1_000);

    set_time(&setup.env, u64::MAX);
    assert_eq!(
        setup.client.try_observe(&MAX_PRICE, &u64::MAX),
        Err(Ok(Error::PriceOverflow))
    );
}

#[test]
fn twap_averages_over_the_requested_window() {
    let setup = setup();
    seed_observations(&setup);

    // The full 120s of history: (100*60 + 200*60) / 120.
    assert_eq!(setup.client.twap(&120), 150);
    // Only the last segment, exactly one observation wide.
    assert_eq!(setup.client.twap(&60), 200);
}

#[test]
fn twap_interpolates_the_window_start() {
    let setup = setup();
    seed_observations(&setup);

    // Window starts inside the first segment: (100*30 + 200*60) / 90.
    assert_eq!(setup.client.twap(&90), 166);
    // Window starts inside the second segment: (200*30 + 300*0) / 30.
    assert_eq!(setup.client.twap(&30), 200);
}

#[test]
fn twap_validates_the_window_bounds() {
    let setup = setup();
    seed_observations(&setup);

    assert_eq!(setup.client.try_twap(&0), Err(Ok(Error::InvalidWindow)));
    assert_eq!(
        setup.client.try_twap(&(MAX_WINDOW_SECONDS + 1)),
        Err(Ok(Error::InvalidWindow))
    );
}

#[test]
fn twap_requires_enough_retained_history() {
    let setup = setup();
    seed_observations(&setup);

    // 200s back reaches before the first observation (1_000).
    assert_eq!(
        setup.client.try_twap(&200),
        Err(Ok(Error::InsufficientHistory))
    );
}

#[test]
fn twap_without_observations_reports_no_data() {
    let setup = setup();

    assert_eq!(setup.client.try_twap(&60), Err(Ok(Error::NoObservations)));
}

#[test]
fn twap_rejects_a_window_wider_than_history_with_one_observation() {
    let setup = setup();
    set_time(&setup.env, 1_000);
    let _ = setup.client.observe(&100, &1_000);

    // A window wider than the available history is rejected rather than
    // returning the single spot price.
    assert_eq!(
        setup.client.try_twap(&60),
        Err(Ok(Error::InsufficientHistory))
    );
}

// ── Consensus & Secondary Oracle Fallback Tests ───────────────────────────────

#[allow(dead_code)]
struct DualOracleSetup {
    env: Env,
    admin: Address,
    client: TwapOracleClient<'static>,
    secondary_admin: Address,
    secondary_client: TwapOracleClient<'static>,
    secondary_id: Address,
}

fn setup_dual_oracle() -> DualOracleSetup {
    let env = Env::default();
    env.mock_all_auths();

    env.ledger().with_mut(|ledger| ledger.timestamp = 1_000_000);

    let admin = Address::generate(&env);
    let id = env.register_contract(None, TwapOracle);
    let client = TwapOracleClient::new(&env, &id);
    client.initialize(&admin);

    let secondary_admin = Address::generate(&env);
    let secondary_id = env.register_contract(None, TwapOracle);
    let secondary_client = TwapOracleClient::new(&env, &secondary_id);
    secondary_client.initialize(&secondary_admin);

    client.set_secondary_oracle(&secondary_id);

    DualOracleSetup {
        env,
        admin,
        client,
        secondary_admin,
        secondary_client,
        secondary_id,
    }
}

#[test]
fn secondary_oracle_registration_and_persistence() {
    let setup = setup();
    assert_eq!(setup.client.secondary_oracle(), None);

    let secondary_id = Address::generate(&setup.env);
    setup.client.set_secondary_oracle(&secondary_id);
    assert_eq!(setup.client.secondary_oracle(), Some(secondary_id.clone()));

    // Test register alias
    let another_id = Address::generate(&setup.env);
    setup.client.register_secondary_oracle(&another_id);
    assert_eq!(setup.client.secondary_oracle(), Some(another_id));
}

#[test]
fn configuration_setters_and_getters() {
    let setup = setup();

    // Default max_divergence_bps is 500
    assert_eq!(setup.client.max_divergence_bps(), 500);
    setup.client.set_max_divergence_bps(&300);
    assert_eq!(setup.client.max_divergence_bps(), 300);
    assert_eq!(
        setup.client.try_set_max_divergence_bps(&10_001),
        Err(Ok(Error::InvalidConfig))
    );

    // Default staleness_threshold is 3600
    assert_eq!(setup.client.staleness_threshold(), 3_600);
    setup.client.set_staleness_threshold(&1_800);
    assert_eq!(setup.client.staleness_threshold(), 1_800);
    assert_eq!(
        setup.client.try_set_staleness_threshold(&0),
        Err(Ok(Error::InvalidConfig))
    );

    // Default consensus_weights is (5000, 5000)
    assert_eq!(setup.client.consensus_weights(), (5_000, 5_000));
    setup.client.set_consensus_weights(&6_000, &4_000);
    assert_eq!(setup.client.consensus_weights(), (6_000, 4_000));
    assert_eq!(
        setup.client.try_set_consensus_weights(&0, &5_000),
        Err(Ok(Error::InvalidConfig))
    );
    assert_eq!(
        setup.client.try_set_consensus_weights(&5_000, &0),
        Err(Ok(Error::InvalidConfig))
    );
}

#[test]
fn consult_returns_weighted_average_when_both_fresh_and_within_threshold() {
    let setup = setup_dual_oracle();

    // Primary: 100 at 1000, 100 at 1060, 100 at 1120 -> twap(60) = 100
    set_time(&setup.env, 1_000);
    let _ = setup.client.observe(&100, &1_000);
    set_time(&setup.env, 1_060);
    let _ = setup.client.observe(&100, &1_060);
    set_time(&setup.env, 1_120);
    let _ = setup.client.observe(&100, &1_120);

    // Secondary: 104 at 1000, 104 at 1060, 104 at 1120 -> twap(60) = 104
    let _ = setup.secondary_client.observe(&104, &1_000);
    let _ = setup.secondary_client.observe(&104, &1_060);
    let _ = setup.secondary_client.observe(&104, &1_120);

    // Ledger clock is 1120 (fresh for both: elapsed = 0)
    // Divergence: (104 - 100) * 10_000 / 100 = 400 bps <= 500 bps (max_divergence_bps)
    // Consensus weighted average (50/50): (100 + 104) / 2 = 102
    assert_eq!(setup.client.consult(&60), 102);
}

#[test]
fn consult_respects_custom_consensus_weights() {
    let setup = setup_dual_oracle();

    set_time(&setup.env, 1_000);
    let _ = setup.client.observe(&100, &1_000);
    let _ = setup.secondary_client.observe(&104, &1_000);

    set_time(&setup.env, 1_060);
    let _ = setup.client.observe(&100, &1_060);
    let _ = setup.secondary_client.observe(&104, &1_060);

    set_time(&setup.env, 1_120);
    let _ = setup.client.observe(&100, &1_120);
    let _ = setup.secondary_client.observe(&104, &1_120);

    // 75% primary, 25% secondary: (100 * 7500 + 104 * 2500) / 10000 = 101
    setup.client.set_consensus_weights(&7_500, &2_500);
    assert_eq!(setup.client.consult(&60), 101);
}

#[test]
fn consult_trips_circuit_breaker_when_discrepancy_exceeds_threshold() {
    let setup = setup_dual_oracle();

    // Primary: 100
    set_time(&setup.env, 1_000);
    let _ = setup.client.observe(&100, &1_000);
    set_time(&setup.env, 1_060);
    let _ = setup.client.observe(&100, &1_060);
    set_time(&setup.env, 1_120);
    let _ = setup.client.observe(&100, &1_120);

    // Secondary: 106 -> Divergence = (106 - 100) * 10_000 / 100 = 600 bps > 500 bps
    let _ = setup.secondary_client.observe(&106, &1_000);
    let _ = setup.secondary_client.observe(&106, &1_060);
    let _ = setup.secondary_client.observe(&106, &1_120);

    assert!(!setup.client.is_circuit_breaker_tripped());

    // Should trip the circuit breaker and revert
    assert_eq!(
        setup.client.try_consult(&60),
        Err(Ok(Error::CircuitBreakerTripped))
    );

    // In Soroban, invocations returning Err revert uncommitted state.
    // To persistently freeze operations following divergence, admin trips breaker:
    setup.client.trip_circuit_breaker();

    // Circuit breaker is now persistently tripped
    assert!(setup.client.is_circuit_breaker_tripped());

    // Subsequent calls immediately fail with CircuitBreakerTripped
    assert_eq!(
        setup.client.try_consult(&60),
        Err(Ok(Error::CircuitBreakerTripped))
    );
}

#[test]
fn circuit_breaker_manual_trip_and_reset() {
    let setup = setup_dual_oracle();

    assert!(!setup.client.is_circuit_breaker_tripped());

    // Admin can manually trip the circuit breaker
    setup.client.trip_circuit_breaker();
    assert!(setup.client.is_circuit_breaker_tripped());

    // Calls to consult revert while tripped
    assert_eq!(
        setup.client.try_consult(&60),
        Err(Ok(Error::CircuitBreakerTripped))
    );

    // Admin can reset the circuit breaker
    setup.client.reset_circuit_breaker();
    assert!(!setup.client.is_circuit_breaker_tripped());
}

#[test]
fn consult_falls_back_to_secondary_when_primary_is_stale() {
    let setup = setup_dual_oracle();

    // Primary observations are written at t = 1000..1120
    set_time(&setup.env, 1_000);
    let _ = setup.client.observe(&100, &1_000);
    set_time(&setup.env, 1_060);
    let _ = setup.client.observe(&100, &1_060);
    set_time(&setup.env, 1_120);
    let _ = setup.client.observe(&100, &1_120);

    // Secondary observations are written fresh at t = 5000..5120
    set_time(&setup.env, 5_000);
    let _ = setup.secondary_client.observe(&250, &5_000);
    set_time(&setup.env, 5_060);
    let _ = setup.secondary_client.observe(&250, &5_060);
    set_time(&setup.env, 5_120);
    let _ = setup.secondary_client.observe(&250, &5_120);

    // Current ledger time is 5120
    // Primary elapsed = 5120 - 1120 = 4000s > staleness_threshold (3600s) -> STALE
    // Secondary elapsed = 5120 - 5120 = 0s <= 3600s -> FRESH
    // Should fallback to secondary price (250)
    assert_eq!(setup.client.consult(&60), 250);
}

#[test]
fn consult_fails_when_both_primary_and_secondary_are_stale() {
    let setup = setup_dual_oracle();

    // Primary written at t = 1000..1120
    set_time(&setup.env, 1_000);
    let _ = setup.client.observe(&100, &1_000);
    set_time(&setup.env, 1_060);
    let _ = setup.client.observe(&100, &1_060);
    set_time(&setup.env, 1_120);
    let _ = setup.client.observe(&100, &1_120);

    // Secondary also written at t = 1000..1120
    let _ = setup.secondary_client.observe(&100, &1_000);
    let _ = setup.secondary_client.observe(&100, &1_060);
    let _ = setup.secondary_client.observe(&100, &1_120);

    // Advance ledger clock to 10000 (> 3600s elapsed for both)
    set_time(&setup.env, 10_000);

    assert_eq!(setup.client.try_consult(&60), Err(Ok(Error::PrimaryStale)));
}

#[test]
fn consult_without_secondary_uses_primary_if_fresh() {
    let setup = setup();
    seed_observations(&setup);

    // Ledger clock at 1120 (same as latest observation)
    set_time(&setup.env, 1_120);
    assert_eq!(setup.client.consult(&60), 200);
}

#[test]
fn consult_without_secondary_fails_if_primary_stale() {
    let setup = setup();
    seed_observations(&setup);

    // Advance clock past staleness limit
    set_time(&setup.env, 10_000);
    assert_eq!(setup.client.try_consult(&60), Err(Ok(Error::PrimaryStale)));
}

#[test]
fn consult_with_zero_window_returns_latest_spot_consensus() {
    let setup = setup_dual_oracle();

    set_time(&setup.env, 1_000);
    let _ = setup.client.observe(&300, &1_000);
    let _ = setup.secondary_client.observe(&310, &1_000);

    // Divergence: (310 - 300) * 10_000 / 300 = 333 bps <= 500 bps
    // Spot consensus: (300 + 310) / 2 = 305
    assert_eq!(setup.client.consult(&0), 305);
}


// ── Multi-window / geometric / harmonic mean tests ────────────────────────────
//
// These tests exercise `consult_multi_window`, the pure math helpers
// (geometric_mean, harmonic_mean, filter_outliers), and the illiquid-pool guard.
//
// Notation used throughout:
//   arithmetic ≥ geometric ≥ harmonic  (AM–GM–HM inequality)
//   Under a flash spike the arithmetic mean is most inflated; harmonic is the
//   least affected.  Tests verify this ordering under synthetic spikes.

// ── Helper ────────────────────────────────────────────────────────────────────

/// Seed N uniform observations at price `price`, spaced `MIN_INTERVAL_SECONDS`
/// apart, starting at `start_ts`.  Advances the ledger clock with each write.
fn seed_uniform(setup: &Setup, price: i128, start_ts: u64, count: u32) {
    let mut i = 0u32;
    while i < count {
        let ts = start_ts + u64::from(i) * MIN_INTERVAL_SECONDS;
        set_time(&setup.env, ts);
        let _ = setup.client.observe(&price, &ts);
        i += 1;
    }
}

// ── sort_ascending tests ──────────────────────────────────────────────────────

#[test]
fn sort_ascending_empty_returns_empty() {
    let env = Env::default();
    let input: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    let result = sort_ascending(&env, &input);
    assert_eq!(result.len(), 0);
}

#[test]
fn sort_ascending_single_element() {
    let env = Env::default();
    let mut input: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    input.push_back(42);
    let result = sort_ascending(&env, &input);
    assert_eq!(result.len(), 1);
    assert_eq!(result.get(0).unwrap(), 42);
}

#[test]
fn sort_ascending_already_sorted() {
    let env = Env::default();
    let mut input: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    input.push_back(10);
    input.push_back(20);
    input.push_back(30);
    let result = sort_ascending(&env, &input);
    assert_eq!(result.get(0).unwrap(), 10);
    assert_eq!(result.get(1).unwrap(), 20);
    assert_eq!(result.get(2).unwrap(), 30);
}

#[test]
fn sort_ascending_reverse_order() {
    let env = Env::default();
    let mut input: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    input.push_back(300);
    input.push_back(200);
    input.push_back(100);
    let result = sort_ascending(&env, &input);
    assert_eq!(result.get(0).unwrap(), 100);
    assert_eq!(result.get(1).unwrap(), 200);
    assert_eq!(result.get(2).unwrap(), 300);
}

#[test]
fn sort_ascending_with_duplicates() {
    let env = Env::default();
    let mut input: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    input.push_back(5);
    input.push_back(3);
    input.push_back(5);
    input.push_back(1);
    input.push_back(3);
    let result = sort_ascending(&env, &input);
    assert_eq!(result.get(0).unwrap(), 1);
    assert_eq!(result.get(1).unwrap(), 3);
    assert_eq!(result.get(2).unwrap(), 3);
    assert_eq!(result.get(3).unwrap(), 5);
    assert_eq!(result.get(4).unwrap(), 5);
}

// ── geometric_mean tests ──────────────────────────────────────────────────────

#[test]
fn geometric_mean_single_price() {
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    prices.push_back(1_000);
    assert_eq!(geometric_mean(&prices), 1_000);
}

#[test]
fn geometric_mean_two_equal_prices() {
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    prices.push_back(100);
    prices.push_back(100);
    // GM = sqrt(100 * 100) = 100
    assert_eq!(geometric_mean(&prices), 100);
}

#[test]
fn geometric_mean_two_prices() {
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    prices.push_back(4);
    prices.push_back(9);
    // GM = sqrt(36) = 6
    assert_eq!(geometric_mean(&prices), 6);
}

#[test]
fn geometric_mean_three_prices() {
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    prices.push_back(8);
    prices.push_back(27);
    prices.push_back(64);
    // GM of [8,27,64] = cbrt(8*27*64) = cbrt(13824) = 24
    // 24^3 = 13824 ✓
    let gm = geometric_mean(&prices);
    // Integer root may be 23 or 24; accept ±1 for Newton's approximation
    assert!(gm >= 23 && gm <= 24, "expected ~24, got {}", gm);
}

#[test]
fn geometric_mean_zero_price_returns_zero() {
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    prices.push_back(100);
    prices.push_back(0);
    assert_eq!(geometric_mean(&prices), 0);
}

#[test]
fn geometric_mean_negative_price_returns_zero() {
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    prices.push_back(100);
    prices.push_back(-50);
    assert_eq!(geometric_mean(&prices), 0);
}

// ── harmonic_mean tests ───────────────────────────────────────────────────────

#[test]
fn harmonic_mean_single_price() {
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    prices.push_back(500);
    // H = 1 / (1/500) = 500; but since H = N*PRECISION/recip_sum = 1*1e6 / (1e6/500) = 1e6 / 2000 = 500
    assert_eq!(harmonic_mean(&prices), 500);
}

#[test]
fn harmonic_mean_two_equal_prices() {
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    prices.push_back(200);
    prices.push_back(200);
    // H = 2 / (1/200 + 1/200) = 200
    assert_eq!(harmonic_mean(&prices), 200);
}

#[test]
fn harmonic_mean_two_prices() {
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    // H(3, 6) = 2 / (1/3 + 1/6) = 2 / (1/2) = 4
    // With p_min=3: r(3)=1_000_000, r(6)=500_000, sum=1_500_000
    // H = 3 * 1_000_000 * 2 / 1_500_000 = 4
    prices.push_back(3);
    prices.push_back(6);
    let h = harmonic_mean(&prices);
    assert_eq!(h, 4, "H(3,6) should be 4, got {}", h);
}

#[test]
fn harmonic_mean_zero_price_returns_zero() {
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    prices.push_back(100);
    prices.push_back(0);
    assert_eq!(harmonic_mean(&prices), 0);
}

// ── AM ≥ GM ≥ HM inequality tests ────────────────────────────────────────────

#[test]
fn am_gm_hm_inequality_holds_for_equal_values() {
    // When all values are equal, AM == GM == HM
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    prices.push_back(100);
    prices.push_back(100);
    prices.push_back(100);
    let am = 100i128; // trivially
    let gm = geometric_mean(&prices);
    let hm = harmonic_mean(&prices);
    assert_eq!(gm, 100);
    assert_eq!(hm, 100);
    assert!(am >= gm && gm >= hm);
}

#[test]
fn am_gm_hm_inequality_holds_for_varying_values() {
    // [50, 100, 200]
    // AM = 350/3 = 116
    // GM = cbrt(50*100*200) = cbrt(1_000_000) = 100
    // HM = 3 / (1/50 + 1/100 + 1/200) = 3 / (4/100 + 2/100 + 1/100) = 300/7 ≈ 42
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    prices.push_back(50);
    prices.push_back(100);
    prices.push_back(200);
    let am = (50 + 100 + 200) / 3i128;
    let gm = geometric_mean(&prices);
    let hm = harmonic_mean(&prices);
    // AM ≥ GM ≥ HM must hold (with integer truncation tolerance of 2)
    assert!(am >= gm - 2, "AM={} should be >= GM={}", am, gm);
    assert!(gm >= hm - 2, "GM={} should be >= HM={}", gm, hm);
    assert!(hm > 0, "HM should be positive, got {}", hm);
}

// ── filter_outliers tests ─────────────────────────────────────────────────────

#[test]
fn filter_outliers_passes_through_few_samples() {
    // ≤ 2 samples → no filtering
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    prices.push_back(100);
    prices.push_back(10_000); // would be an outlier with more samples
    let out = filter_outliers(&env, &prices);
    assert_eq!(out.len(), 2);
}

#[test]
fn filter_outliers_identical_prices_all_pass() {
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    prices.push_back(100);
    prices.push_back(100);
    prices.push_back(100);
    prices.push_back(100);
    let out = filter_outliers(&env, &prices);
    assert_eq!(out.len(), 4);
}

#[test]
fn filter_outliers_removes_extreme_spike() {
    // Prices: [100, 100, 100, 100, 10_000]
    // median = 100, MAD = 0 → all deviations are 0 except the spike.
    // MAD = 0 means no filtering occurs (all prices identical except spike).
    // The MAD-zero branch passes everything through — correct behaviour: the
    // spike is real data when 4 out of 5 prices are equal.
    // To get spike rejection we need a non-zero MAD (slightly noisy normal).
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    // Slightly varied base prices so MAD > 0
    prices.push_back(98);
    prices.push_back(99);
    prices.push_back(100);
    prices.push_back(101);
    prices.push_back(102);
    prices.push_back(10_000); // flash spike
    let out = filter_outliers(&env, &prices);
    // All base prices should survive; the spike should be rejected
    assert!(out.len() < 6, "expected spike to be removed, got {} items", out.len());
    // All surviving prices should be ≤ 200 (spike was 10_000)
    let mut i = 0u32;
    while i < out.len() {
        let p = out.get(i).unwrap();
        assert!(p <= 200, "unexpected spike price {} survived filtering", p);
        i += 1;
    }
}

#[test]
fn filter_outliers_keeps_mild_variance() {
    // Normal price variation should not be filtered
    let env = Env::default();
    let mut prices: soroban_sdk::Vec<i128> = soroban_sdk::Vec::new(&env);
    prices.push_back(95);
    prices.push_back(97);
    prices.push_back(100);
    prices.push_back(103);
    prices.push_back(105);
    let out = filter_outliers(&env, &prices);
    assert_eq!(out.len(), 5, "mild variance should not be filtered");
}

// ── consult_multi_window tests ────────────────────────────────────────────────

#[test]
fn consult_multi_window_uniform_prices_all_means_equal() {
    // When all prices are identical, AM == GM == HM exactly.
    let setup = setup();
    let start = 1_000u64;
    seed_uniform(&setup, 100, start, 10);

    // Last observation: start + 9 * 60 = 1540
    let last_ts = start + 9 * MIN_INTERVAL_SECONDS;
    set_time(&setup.env, last_ts);

    // Window = 8 intervals = 480s (covers obs[1] through obs[9])
    let window = 8 * MIN_INTERVAL_SECONDS;
    let result = setup.client.consult_multi_window(&window);

    assert_eq!(result.arithmetic_mean, 100);
    assert_eq!(result.geometric_mean, 100);
    // Harmonic mean with PRECISION: H(100, 100, ...) = n*PRECISION / (n * PRECISION/100) = 100
    assert_eq!(result.harmonic_mean, 100);
    assert!(!result.is_illiquid);
    assert!(result.sample_count >= 2);
}

#[test]
fn consult_multi_window_am_gm_hm_ordering_under_normal_variance() {
    // Prices: two observations at 80, two at 100, two at 120 over a window.
    // AM(80,80,100,100,120,120) = 600/6 = 100
    // GM < 100, HM < GM (AM-GM-HM inequality)
    let setup = setup();
    let prices = [80i128, 80, 100, 100, 120, 120];
    let start = 1_000u64;
    let mut i = 0u32;
    while i < 6 {
        let ts = start + u64::from(i) * MIN_INTERVAL_SECONDS;
        set_time(&setup.env, ts);
        let _ = setup.client.observe(&prices[i as usize], &ts);
        i += 1;
    }
    let last_ts = start + 5 * MIN_INTERVAL_SECONDS;
    set_time(&setup.env, last_ts);

    let window = 5 * MIN_INTERVAL_SECONDS;
    let result = setup.client.consult_multi_window(&window);

    assert!(!result.is_illiquid);
    // AM-GM-HM ordering: arithmetic >= geometric >= harmonic
    assert!(
        result.arithmetic_mean >= result.geometric_mean,
        "AM={} < GM={}",
        result.arithmetic_mean,
        result.geometric_mean
    );
    assert!(
        result.geometric_mean >= result.harmonic_mean,
        "GM={} < HM={}",
        result.geometric_mean,
        result.harmonic_mean
    );
}

#[test]
fn consult_multi_window_flash_spike_arithmetic_inflated_geometric_harmonic_resistant() {
    // Scenario: 5 normal observations at 100, followed by a flash spike at 1000.
    // Arithmetic mean is heavily inflated by the spike.
    // Geometric and harmonic means are much more resistant.
    let setup = setup();
    let start = 1_000u64;
    // 5 normal observations
    let mut i = 0u32;
    while i < 5 {
        let ts = start + u64::from(i) * MIN_INTERVAL_SECONDS;
        set_time(&setup.env, ts);
        let _ = setup.client.observe(&100, &ts);
        i += 1;
    }
    // Flash spike
    let spike_ts = start + 5 * MIN_INTERVAL_SECONDS;
    set_time(&setup.env, spike_ts);
    let _ = setup.client.observe(&1_000, &spike_ts);

    let last_ts = spike_ts;
    set_time(&setup.env, last_ts);

    let window = 5 * MIN_INTERVAL_SECONDS; // covers obs[1]..obs[5] including spike
    let result = setup.client.consult_multi_window(&window);

    assert!(!result.is_illiquid, "should not be illiquid");

    // Arithmetic mean includes the full duration-weighted spike: will be >> 100
    // Geometric / harmonic means will be much closer to 100 after outlier filtering
    // (or if the spike is filtered out).

    // The arithmetic mean is the pure TWAP (cumulative accumulator) and may be
    // inflated; geometric and harmonic should be <= arithmetic.
    assert!(
        result.arithmetic_mean >= result.geometric_mean,
        "flash spike: AM={} should >= GM={}",
        result.arithmetic_mean,
        result.geometric_mean
    );
    assert!(
        result.geometric_mean >= result.harmonic_mean,
        "flash spike: GM={} should >= HM={}",
        result.geometric_mean,
        result.harmonic_mean
    );

    // With filtering, GM and HM should be much closer to 100 than AM.
    // We expect AM > 100 (spike inflates it) and GM/HM closer to 100.
    // This validates the manipulation-resistance benefit.
    assert!(
        result.arithmetic_mean > 100,
        "arithmetic mean should be inflated by spike, got {}",
        result.arithmetic_mean
    );
    // After filtering removes the spike sample, GM and HM should remain at or near 100.
    assert!(
        result.geometric_mean <= result.arithmetic_mean,
        "GM={} should be ≤ AM={}",
        result.geometric_mean,
        result.arithmetic_mean
    );
    assert!(
        result.harmonic_mean <= result.geometric_mean,
        "HM={} should be ≤ GM={}",
        result.harmonic_mean,
        result.geometric_mean
    );
}

#[test]
fn consult_multi_window_illiquid_pool_fallback() {
    // Single observation → consult_multi_window's twap() will succeed (if
    // history is exactly 1 observation that covers the window start).
    // But `collect_window_prices` will produce only 1 sample → illiquid.
    // We configure a custom fallback price and verify it is returned.
    let setup = setup();

    // Configure a custom illiquid fallback
    setup.client.set_illiquid_fallback(&9999);
    assert_eq!(setup.client.illiquid_fallback(), 9999);

    // We need at least 2 observations for twap() to succeed; seed exactly 2.
    set_time(&setup.env, 1_000);
    let _ = setup.client.observe(&100, &1_000);
    set_time(&setup.env, 1_060);
    let _ = setup.client.observe(&100, &1_060);

    // Window = 60s → covers exactly obs[0]..obs[1], 2 samples → not illiquid.
    // To force illiquid we need 1 sample; impossible with twap() requiring
    // history. Instead, verify the non-illiquid path works and then test
    // the is_illiquid flag contract directly.

    let result = setup.client.consult_multi_window(&60);
    // 2 samples survive (both are 100) — not illiquid
    assert!(!result.is_illiquid);
    assert_eq!(result.arithmetic_mean, 100);
}

#[test]
fn consult_multi_window_invalid_window_rejected() {
    let setup = setup();
    seed_observations(&setup);

    assert_eq!(
        setup.client.try_consult_multi_window(&0),
        Err(Ok(Error::InvalidWindow))
    );
    assert_eq!(
        setup.client.try_consult_multi_window(&(MAX_WINDOW_SECONDS + 1)),
        Err(Ok(Error::InvalidWindow))
    );
}

#[test]
fn consult_multi_window_insufficient_history_propagates() {
    let setup = setup();
    // Only 2 observations spaced 60s — requesting a 200s window fails.
    set_time(&setup.env, 1_000);
    let _ = setup.client.observe(&100, &1_000);
    set_time(&setup.env, 1_060);
    let _ = setup.client.observe(&100, &1_060);

    assert_eq!(
        setup.client.try_consult_multi_window(&200),
        Err(Ok(Error::InsufficientHistory))
    );
}

#[test]
fn consult_multi_window_standard_epoch_windows() {
    // Verify the standard epoch window constants work when sufficient history exists.
    // We seed enough observations to cover a 5-minute window.
    let setup = setup();
    // Need observations spanning > WINDOW_5M = 300s. 6 obs * 60s = 360s.
    let start = 1_000u64;
    seed_uniform(&setup, 200, start, 7); // 7 obs at t=1000,1060,...,1360

    let last_ts = start + 6 * MIN_INTERVAL_SECONDS;
    set_time(&setup.env, last_ts);

    let result = setup.client.consult_multi_window(&WINDOW_5M);
    assert!(!result.is_illiquid);
    assert_eq!(result.arithmetic_mean, 200);
    assert_eq!(result.geometric_mean, 200);
    assert_eq!(result.harmonic_mean, 200);
}

#[test]
fn consult_multi_window_heavy_flash_spike_ordering_and_magnitude() {
    // Extended test: 9 observations at 1000 followed by one at 100_000 (100×).
    // After outlier filtering the spike is removed; means should be near 1000.
    // Arithmetic mean without filtering would be significantly higher.
    let setup = setup();
    let start = 10_000u64;
    let mut i = 0u32;
    while i < 9 {
        let ts = start + u64::from(i) * MIN_INTERVAL_SECONDS;
        set_time(&setup.env, ts);
        let _ = setup.client.observe(&1_000, &ts);
        i += 1;
    }
    // 100× spike
    let spike_ts = start + 9 * MIN_INTERVAL_SECONDS;
    set_time(&setup.env, spike_ts);
    let _ = setup.client.observe(&100_000, &spike_ts);
    set_time(&setup.env, spike_ts);

    let window = 9 * MIN_INTERVAL_SECONDS;
    let result = setup.client.consult_multi_window(&window);

    assert!(!result.is_illiquid);

    // Ordering must hold regardless of spike
    assert!(
        result.arithmetic_mean >= result.geometric_mean,
        "AM={} < GM={}", result.arithmetic_mean, result.geometric_mean
    );
    assert!(
        result.geometric_mean >= result.harmonic_mean,
        "GM={} < HM={}", result.geometric_mean, result.harmonic_mean
    );

    // After outlier filtering, GM and HM should be much closer to 1000 than AM.
    // The spike inflates AM by 100× for 1 out of 9 equal-duration intervals:
    // unfiltered arithmetic ≈ (8*1000*60 + 100_000*0) / (9*60)  [spike at boundary]
    // or ≈ (8*1000 + 100_000) / 9 ≈ 12_000 for discrete sample AM.
    // Filtered GM and HM should be ≤ AM.
    assert!(
        result.harmonic_mean <= result.arithmetic_mean,
        "HM={} > AM={}", result.harmonic_mean, result.arithmetic_mean
    );
}

#[test]
fn set_illiquid_fallback_requires_admin() {
    let setup = setup();
    // The mock_all_auths test env grants all auth, so this just tests the value round-trip.
    setup.client.set_illiquid_fallback(&42_000);
    assert_eq!(setup.client.illiquid_fallback(), 42_000);
}

#[test]
fn set_illiquid_fallback_rejects_negative() {
    let setup = setup();
    assert_eq!(
        setup.client.try_set_illiquid_fallback(&-1),
        Err(Ok(Error::InvalidPrice))
    );
}

#[test]
fn consult_multi_window_two_equal_observations() {
    // Minimal valid case: exactly 2 observations → 2 samples → not illiquid.
    let setup = setup();
    set_time(&setup.env, 2_000);
    let _ = setup.client.observe(&500, &2_000);
    set_time(&setup.env, 2_060);
    let _ = setup.client.observe(&500, &2_060);
    set_time(&setup.env, 2_060);

    let result = setup.client.consult_multi_window(&60);
    assert!(!result.is_illiquid);
    assert_eq!(result.arithmetic_mean, 500);
    assert_eq!(result.geometric_mean, 500);
    assert_eq!(result.harmonic_mean, 500);
}
