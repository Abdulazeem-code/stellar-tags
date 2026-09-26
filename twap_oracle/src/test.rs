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
    while index < (MAX_OBSERVATIONS as u64) + 1 {
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
