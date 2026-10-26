// Verify batch_actions_executed event was emitted with the list of nonces
    let events = env.events().all();
    let last_event = events.last().unwrap();
    assert_eq!(
        last_event.0.get(0).unwrap(),
        Symbol::new(&env, "batch_actions_executed").into()
    );
}

#[test]
fn test_batch_execution_fails_if_any_action_fails() {
    let (env, client, _) = setup_env();
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &100, &1000, &PaymentRouter::MAX_AMOUNT);

    // Queue one valid action and one invalid/non-existent nonce
    let n1 = client.queue_action(&ActionType::SetFeeBps(200));
    let nonces = vec![&env, n1, 9999u64];

    advance_time(&env, PaymentRouter::SECONDS_IN_24H + 1);

    // The entire batch must fail atomically and roll back state changes
    let res = client.try_execute_batch_actions(&nonces);
    assert!(res.is_err());

    // Fee must remain unchanged due to atomic rollback
    assert_eq!(client.get_fee(), 100);
}

/// Helper function to advance the ledger timestamp by a given duration.
fn advance_time(env: &Env, duration_secs: u64) {
    let current_time = env.ledger().timestamp();
    env.ledger().set(LedgerInfo {
        timestamp: current_time + duration_secs,
        protocol_version: env.ledger().protocol_version(),
        sequence_number: env.ledger().sequence(),
        network_id: env.ledger().network_id().into(),
        base_reserve: 100,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 4096,
        max_entry_ttl: 6312000,
    });
client.grant_role(&admin, &second, &Role::Pauser);

    assert!(!client.has_role(&first, &Role::Pauser));
    assert!(client.has_role(&second, &Role::Pauser));
    assert_eq!(client.get_role_member(&Role::Pauser), Some(second));
}
