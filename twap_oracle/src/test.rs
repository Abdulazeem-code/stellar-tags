#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::Env;

struct Setup {
    env: Env,
    admin: Address,
    base: Address,
    quote: Address,
    client: TwapOracleClient<'static>,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    // Put the ledger clock ahead of every timestamp used in the tests so that
    // the "not in the future" guard does not interfere with the fixtures.
    env.ledger().with_mut(|ledger| ledger.timestamp = 1_000_000);

    let admin = Address::generate(&env);
    let base = Address::generate(&env);
    let quote = Address::generate(&env);
    let id = env.register_contract(None, TwapOracle);
    let client = TwapOracleClient::new(&env, &id);
    client.initialize(&admin);

    Setup {
        env,
        admin,
        base,
        quote,
        client,
    }
}

fn set_time(env: &Env, timestamp: u64) {
    env.ledger().with_mut(|ledger| ledger.timestamp = timestamp);
}

/// 100 for 60s, then 105 for 60s, then 110. Each step is within the default
/// 1000 bps (10%) single-update deviation threshold. Segment integrals:
/// obs0.cumulative = 0, obs1.cumulative = 6_000, obs2.cumulative = 12_300.
fn seed_observations(setup: &Setup) {
    set_time(&setup.env, 1_000);
    let _ = setup
        .client
        .observe(&setup.base, &setup.quote, &100, &1_000);
    set_time(&setup.env, 1_060);
    let _ = setup
        .client
        .observe(&setup.base, &setup.quote, &200, &1_060);
    set_time(&setup.env, 1_120);
    let _ = setup
        .client
        .observe(&setup.base, &setup.quote, &300, &1_120);
}

#[test]
fn initialize_sets_admin_and_empty_history() {
    let setup = setup();

    assert_eq!(setup.client.admin(), Some(setup.admin.clone()));
    assert_eq!(
        setup.client.observation_count(&setup.base, &setup.quote),
        0
    );
    assert_eq!(
        setup.client.latest_observation(&setup.base, &setup.quote),
        None
    );
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

    let base = Address::generate(&env);
    let quote = Address::generate(&env);
    let id = env.register_contract(None, TwapOracle);
    let client = TwapOracleClient::new(&env, &id);

    assert_eq!(
        client.try_observe(&base, &quote, &100, &1_000),
        Err(Ok(Error::NotInitialized))
    );
}

#[test]
fn observe_appends_and_derives_cumulative_price() {
    let setup = setup();
    seed_observations(&setup);

    let observations = setup.client.observations(&setup.base, &setup.quote);
    assert_eq!(observations.len(), 3);
    assert_eq!(
        setup.client.observation_count(&setup.base, &setup.quote),
        3
    );

    let first = observations.get(0).unwrap();
    assert_eq!(first.timestamp, 1_000);
    assert_eq!(first.price, 100);
    assert_eq!(first.cumulative_price, u256::ZERO);

    let second = observations.get(1).unwrap();
    assert_eq!(second.cumulative_price, u256::from(6_000u64));

    let third = observations.get(2).unwrap();
    assert_eq!(third.cumulative_price, u256::from(18_000u64));

    let latest = setup
        .client
        .latest_observation(&setup.base, &setup.quote)
        .unwrap();
    assert_eq!(latest, third);
}

#[test]
fn observe_rejects_non_positive_and_out_of_range_prices() {
    let setup = setup();

    assert_eq!(
        setup
            .client
            .try_observe(&setup.base, &setup.quote, &0, &1_000),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        setup
            .client
            .try_observe(&setup.base, &setup.quote, &-1, &1_000),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        setup
            .client
            .try_observe(&setup.base, &setup.quote, &(MAX_PRICE + 1), &1_000),
        Err(Ok(Error::InvalidPrice))
    );
    // The upper bound itself is accepted.
    assert_eq!(
        setup
            .client
            .observe(&setup.base, &setup.quote, &MAX_PRICE, &1_000),
        1
    );
}

#[test]
fn observe_rejects_future_timestamps() {
    let setup = setup();

    set_time(&setup.env, 1_000);
    assert_eq!(
        setup
            .client
            .try_observe(&setup.base, &setup.quote, &100, &1_001),
        Err(Ok(Error::TimestampInFuture))
    );
}

#[test]
fn observe_rejects_non_monotonic_timestamps() {
    let setup = setup();
    seed_observations(&setup);

    // Equal to the previous timestamp.
    assert_eq!(
        setup
            .client
            .try_observe(&setup.base, &setup.quote, &150, &1_120),
        Err(Ok(Error::TimestampNotMonotonic))
    );
    // Older than the previous timestamp.
    assert_eq!(
        setup
            .client
            .try_observe(&setup.base, &setup.quote, &150, &1_100),
        Err(Ok(Error::TimestampNotMonotonic))
    );
}

#[test]
fn observe_enforces_the_minimum_interval() {
    let setup = setup();
    set_time(&setup.env, 1_000);
    let _ = setup
        .client
        .observe(&setup.base, &setup.quote, &100, &1_000);

    set_time(&setup.env, 1_059);
    assert_eq!(
        setup
            .client
            .try_observe(&setup.base, &setup.quote, &200, &1_059),
        Err(Ok(Error::ObservationTooSoon))
    );

    // Exactly MIN_INTERVAL_SECONDS later is accepted (5% drop <= 10% limit).
    set_time(&setup.env, 1_060);
    assert_eq!(
        setup
            .client
            .observe(&setup.base, &setup.quote, &200, &1_060),
        2
    );
}

#[test]
fn observe_prunes_the_oldest_observation_when_full() {
    let setup = setup();
    set_time(&setup.env, 1_000);

    let mut index = 0u64;
    while index < u64::from(MAX_OBSERVATIONS) + 1 {
        let timestamp = 1_000 + index * MIN_INTERVAL_SECONDS;
        set_time(&setup.env, timestamp);
        let _ = setup
            .client
            .observe(&setup.base, &setup.quote, &100, &timestamp);
        index += 1;
    }

    assert_eq!(
        setup.client.observation_count(&setup.base, &setup.quote),
        MAX_OBSERVATIONS
    );

    let observations = setup.client.observations(&setup.base, &setup.quote);
    assert_eq!(observations.len(), MAX_OBSERVATIONS);
    // The very first observation was dropped.
    assert_eq!(
        observations.get(0).unwrap().timestamp,
        1_000 + MIN_INTERVAL_SECONDS
    );
}

#[test]
fn observe_handles_high_price_elapsed_product_without_overflow() {
    let setup = setup();

    // Advance the ledger clock by an astronomically large gap with MAX_PRICE.
    // MAX_PRICE * elapsed exceeds i128::MAX, but u256 accumulator handles it seamlessly without panic.
    set_time(&setup.env, 1_000);
    let _ = setup
        .client
        .observe(&setup.base, &setup.quote, &MAX_PRICE, &1_000);

    set_time(&setup.env, 1_000 + 10_000_000);
    let count = setup
        .client
        .observe(&setup.base, &setup.quote, &MAX_PRICE, &(1_000 + 10_000_000));
    assert_eq!(count, 2);

    let latest = setup
        .client
        .latest_observation(&setup.base, &setup.quote)
        .unwrap();
    let expected_cum = u256::from(MAX_PRICE as u128) * u256::from(10_000_000u64);
    assert_eq!(latest.cumulative_price, expected_cum);

    // TWAP calculation over a window within this gap returns MAX_PRICE exactly.
    assert_eq!(
        setup.client.twap(&setup.base, &setup.quote, &60),
        MAX_PRICE
    );
}

// ── Single-Update Deviation Circuit Breaker ─────────────────────────────────

#[test]
fn observe_accepts_update_within_max_deviation() {
    let setup = setup();

    set_time(&setup.env, 1_000);
    let _ = setup.client.observe(&100, &1_000);

    // 5% drop (500 bps) is within the 1000 bps default threshold.
    set_time(&setup.env, 1_060);
    assert_eq!(setup.client.observe(&95, &1_060), 2);

    assert!(!setup.client.is_circuit_breaker_tripped());
    assert!(!setup
        .client
        .is_circuit_breaker_active(&setup.admin, &setup.admin));
}

#[test]
fn observe_excessive_single_block_deviation_trips_breaker() {
    let setup = setup();

    set_time(&setup.env, 1_000);
    let _ = setup.client.observe(&100, &1_000);

    // 15% instant crash (1500 bps) exceeds the 1000 bps (10%) threshold.
    // Returning Ok keeps the breaker state persisted; the flawed price is not
    // stored, so the observation count stays at 1.
    set_time(&setup.env, 1_060);
    assert_eq!(setup.client.try_observe(&85, &1_060), Ok(Ok(1)));

    // The pair is now frozen: the breaker is active and further updates are
    // rejected.
    assert!(setup.client.is_circuit_breaker_tripped());
    assert!(setup
        .client
        .is_circuit_breaker_active(&setup.admin, &setup.admin));

    set_time(&setup.env, 1_120);
    assert_eq!(
        setup.client.try_observe(&85, &1_120),
        Err(Ok(Error::CircuitBreakerTripped))
    );

    // Admin intervention restores operation.
    setup.client.reset_circuit_breaker();
    assert!(!setup.client.is_circuit_breaker_tripped());
    set_time(&setup.env, 1_180);
    // 95 is a 5% drop from the last stored price (100), within the 10% limit.
    assert_eq!(setup.client.observe(&95, &1_180), 2);
}

#[test]
fn is_circuit_breaker_active_view_matches_tripped_state() {
    let setup = setup();

    let base = Address::generate(&setup.env);
    let quote = Address::generate(&setup.env);

    assert!(!setup.client.is_circuit_breaker_active(&base, &quote));

    setup.client.trip_circuit_breaker();
    assert!(setup.client.is_circuit_breaker_active(&base, &quote));

    setup.client.reset_circuit_breaker();
    assert!(!setup.client.is_circuit_breaker_active(&base, &quote));
}

#[test]
fn twap_calculates_correctly_across_accumulator_wrap_boundary() {
    let setup = setup();

    // Directly seed storage with an observation whose cumulative_price is near u256::MAX.
    // Near 2^256 - 1:
    let base_cum = u256::MAX - u256::from(5_000u64);
    let mut initial_obs = Vec::new(&setup.env);
    initial_obs.push_back(Observation {
        timestamp: 1_000,
        price: 100,
        cumulative_price: base_cum,
    });
    setup.env.storage().instance().set(
        &DataKey::Pair(setup.base.clone(), setup.quote.clone()),
        &initial_obs,
    );

    // After 100 seconds at price 100, elapsed * price = 10_000.
    // Adding 10_000 to (u256::MAX - 5_000) wraps around modulo 2^256:
    // (u256::MAX - 5_000) + 10_000 = 4_999 (as u256::MAX + 1 = 0).
    set_time(&setup.env, 1_100);
    let count = setup
        .client
        .observe(&setup.base, &setup.quote, &200, &1_100);
    assert_eq!(count, 2);

    let latest = setup
        .client
        .latest_observation(&setup.base, &setup.quote)
        .unwrap();
    let expected_wrapped_cum = u256::from(4_999u64);
    assert_eq!(latest.cumulative_price, expected_wrapped_cum);
    assert!(latest.cumulative_price < base_cum);

    // TWAP over the full 100s window across the wrap boundary:
    // (4_999 - (u256::MAX - 5_000)) mod 2^256 = 10_000.
    // 10_000 / 100 = 100.
    assert_eq!(setup.client.twap(&setup.base, &setup.quote, &100), 100);

    // TWAP over a 50s window with interpolation across the wrap boundary:
    // Target timestamp = 1_100 - 50 = 1_050.
    // Interpolated cumulative at target = base_cum + 50 * 100 = base_cum + 5_000 = u256::MAX.
    // Difference = 4_999.wrapping_sub(u256::MAX) = 5_000.
    // 5_000 / 50 = 100.
    assert_eq!(setup.client.twap(&setup.base, &setup.quote, &50), 100);
}


#[test]
fn twap_averages_over_the_requested_window() {
    let setup = setup();
    seed_observations(&setup);

    // The full 120s of history: (100*60 + 200*60) / 120.
    assert_eq!(setup.client.twap(&setup.base, &setup.quote, &120), 150);
    // Only the last segment, exactly one observation wide.
    assert_eq!(setup.client.twap(&setup.base, &setup.quote, &60), 200);
}

#[test]
fn twap_interpolates_the_window_start() {
    let setup = setup();
    seed_observations(&setup);

    // Window starts inside the first segment: (100*30 + 200*60) / 90.
    assert_eq!(setup.client.twap(&setup.base, &setup.quote, &90), 166);
    // Window starts inside the second segment: (200*30 + 300*0) / 30.
    assert_eq!(setup.client.twap(&setup.base, &setup.quote, &30), 200);
}

#[test]
fn twap_validates_the_window_bounds() {
    let setup = setup();
    seed_observations(&setup);

    assert_eq!(
        setup.client.try_twap(&setup.base, &setup.quote, &0),
        Err(Ok(Error::InvalidWindow))
    );
    assert_eq!(
        setup
            .client
            .try_twap(&setup.base, &setup.quote, &(MAX_WINDOW_SECONDS + 1)),
        Err(Ok(Error::InvalidWindow))
    );
}

#[test]
fn twap_requires_enough_retained_history() {
    let setup = setup();
    seed_observations(&setup);

    // 200s back reaches before the first observation (1_000).
    assert_eq!(
        setup.client.try_twap(&setup.base, &setup.quote, &200),
        Err(Ok(Error::InsufficientHistory))
    );
}

#[test]
fn twap_without_observations_reports_no_data() {
    let setup = setup();

    assert_eq!(
        setup.client.try_twap(&setup.base, &setup.quote, &60),
        Err(Ok(Error::NoObservations))
    );
}

#[test]
fn twap_rejects_a_window_wider_than_history_with_one_observation() {
    let setup = setup();
    set_time(&setup.env, 1_000);
    let _ = setup
        .client
        .observe(&setup.base, &setup.quote, &100, &1_000);

    // A window wider than the available history is rejected rather than
    // returning the single spot price.
    assert_eq!(
        setup.client.try_twap(&setup.base, &setup.quote, &60),
        Err(Ok(Error::InsufficientHistory))
    );
}

#[test]
fn admin_configures_individual_staleness_thresholds_per_pair() {
    let setup = setup();

    let pair1_base = Address::generate(&setup.env);
    let pair1_quote = Address::generate(&setup.env);
    let pair2_base = Address::generate(&setup.env);
    let pair2_quote = Address::generate(&setup.env);

    // Default staleness
    assert_eq!(
        setup
            .client
            .get_max_staleness(&pair1_base, &pair1_quote),
        DEFAULT_MAX_STALENESS_SECONDS
    );

    // Configure pair 1 for 300 seconds (5 mins)
    setup
        .client
        .set_max_staleness(&pair1_base, &pair1_quote, &300);
    assert_eq!(
        setup
            .client
            .get_max_staleness(&pair1_base, &pair1_quote),
        300
    );

    // Configure pair 2 for 600 seconds (10 mins)
    setup
        .client
        .set_max_staleness(&pair2_base, &pair2_quote, &600);
    assert_eq!(
        setup
            .client
            .get_max_staleness(&pair2_base, &pair2_quote),
        600
    );

    // Ensure pair 1 threshold remains intact
    assert_eq!(
        setup
            .client
            .get_max_staleness(&pair1_base, &pair1_quote),
        300
    );
}

#[test]
fn consult_returns_error_price_stale_if_older_than_max_staleness() {
    let setup = setup();

    // Set pair custom staleness to 300s
    setup
        .client
        .set_max_staleness(&setup.base, &setup.quote, &300);

    // Seed observations: last observation is at t = 1_120
    seed_observations(&setup);

    // At t = 1_120 + 300 = 1_420, price is within threshold (300s elapsed)
    set_time(&setup.env, 1_420);
    assert_eq!(
        setup.client.consult(&setup.base, &setup.quote, &60),
        200
    );

    // At t = 1_421 (301s elapsed), price is stale
    set_time(&setup.env, 1_421);
    assert_eq!(
        setup.client.try_consult(&setup.base, &setup.quote, &60),
        Err(Ok(Error::PriceStale))
    );
}

#[test]
fn consult_uses_default_staleness_when_not_explicitly_configured() {
    let setup = setup();

    // Seed observations: last observation is at t = 1_120
    seed_observations(&setup);

    // DEFAULT_MAX_STALENESS_SECONDS = 3600
    // At t = 1_120 + 3600 = 4_720, price is fresh
    set_time(&setup.env, 4_720);
    assert_eq!(
        setup.client.consult(&setup.base, &setup.quote, &60),
        200
    );

    // At t = 4_721, price is stale
    set_time(&setup.env, 4_721);
    assert_eq!(
        setup.client.try_consult(&setup.base, &setup.quote, &60),
        Err(Ok(Error::PriceStale))
    );
}

#[test]
fn concurrent_tracking_of_five_distinct_token_pairs() {
    let setup = setup();

    // Setup 5 distinct pairs
    let pairs: [(Address, Address, i128); 5] = [
        (Address::generate(&setup.env), Address::generate(&setup.env), 100),
        (Address::generate(&setup.env), Address::generate(&setup.env), 200),
        (Address::generate(&setup.env), Address::generate(&setup.env), 300),
        (Address::generate(&setup.env), Address::generate(&setup.env), 400),
        (Address::generate(&setup.env), Address::generate(&setup.env), 500),
    ];

    // Seed observation 1 for all pairs at t = 1_000
    set_time(&setup.env, 1_000);
    for (base, quote, initial_price) in pairs.iter() {
        let count = setup.client.observe(base, quote, initial_price, &1_000);
        assert_eq!(count, 1);
    }

    // Seed observation 2 for all pairs at t = 1_060 with 2x initial price
    set_time(&setup.env, 1_060);
    for (base, quote, initial_price) in pairs.iter() {
        let new_price = initial_price * 2;
        let count = setup.client.observe(base, quote, &new_price, &1_060);
        assert_eq!(count, 2);
    }

    // Verify independent observations, observation counts, and twap for all 5 pairs
    set_time(&setup.env, 1_060);
    for (base, quote, initial_price) in pairs.iter() {
        assert_eq!(setup.client.observation_count(base, quote), 2);

        let latest = setup.client.latest_observation(base, quote).unwrap();
        assert_eq!(latest.price, initial_price * 2);
        assert_eq!(latest.timestamp, 1_060);
        assert_eq!(latest.cumulative_price, u256::from((*initial_price * 60) as u128));

        // twap over the 60s window should equal initial_price
        let twap = setup.client.twap(base, quote, &60);
        assert_eq!(twap, *initial_price);

        // consult over the 60s window should equal initial_price
        let consult_price = setup.client.consult(base, quote, &60);
        assert_eq!(consult_price, *initial_price);
    }
}

#[test]
fn consult_stops_routing_when_breaker_is_active() {
    let setup = setup();
    seed_observations(&setup);

    // 100 -> 200 -> 300; an 85 print is a ~71% crash, well over the 10% limit.
    set_time(&setup.env, 1_180);
    let _ = setup.client.try_observe(&85, &1_180);
    assert!(setup.client.is_circuit_breaker_tripped());

    // Routing is frozen while the breaker is active.
    assert_eq!(
        setup.client.try_consult(&60),
        Err(Ok(Error::CircuitBreakerTripped))
    );
}
