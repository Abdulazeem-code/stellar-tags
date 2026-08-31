const fs = require('fs');

let c = fs.readFileSync('stellar-payment-platform/../payment_router/src/lib.rs', 'utf8');

c = c.replace(
`<<<<<<< HEAD
    contract, contracterror, contractimpl, contracttype, log, symbol_short, token, Address,
    Bytes, BytesN, Env, Vec, Symbol,
=======
    contract, contracterror, contractimpl, contracttype, log, symbol_short, token, Address, BytesN,
    Env, Symbol, Vec,
>>>>>>> origin/main`,
`    contract, contracterror, contractimpl, contracttype, log, symbol_short, token, Address,
    Bytes, BytesN, Env, Symbol, Vec,`
);

c = c.replace(
`<<<<<<< HEAD
    /// Memo field exceeds maximum allowed length.
    InvalidMemo = 10,
=======
    /// Requested refund withdrawal amount is zero or exceeds available refund balance.
    NoRefundAvailable = 10,
    /// An action is already pending in the timelock queue; it must be executed
    /// or cancelled before a duplicate can be queued (not currently enforced,
    /// but reserved for future deduplication logic).
    TimelockPending = 11,
    /// The 24-hour delay for the given timelock entry has not elapsed yet.
    TimelockNotReady = 12,
    /// No timelock entry exists for the supplied nonce ID.
    TimelockNotFound = 13,
    /// The contract is frozen; all payments and timelock executions are blocked.
    ContractFrozen = 14,
>>>>>>> origin/main`,
`    /// Memo field exceeds maximum allowed length.
    InvalidMemo = 10,
    /// Requested refund withdrawal amount is zero or exceeds available refund balance.
    NoRefundAvailable = 11,
    /// An action is already pending in the timelock queue; it must be executed
    /// or cancelled before a duplicate can be queued (not currently enforced,
    /// but reserved for future deduplication logic).
    TimelockPending = 12,
    /// The 24-hour delay for the given timelock entry has not elapsed yet.
    TimelockNotReady = 13,
    /// No timelock entry exists for the supplied nonce ID.
    TimelockNotFound = 14,
    /// The contract is frozen; all payments and timelock executions are blocked.
    ContractFrozen = 15,`
);

c = c.replace(
`<<<<<<< HEAD
        client.mock_all_auths().route_payment(&sender, &recipient, &token_address, &5_000, &soroban_sdk::Bytes::new(&env));
=======
        client
            .mock_all_auths()
            .route_payment(&sender, &recipient, &token_address, &5_000);
>>>>>>> origin/main`,
`        client
            .mock_all_auths()
            .route_payment(&sender, &recipient, &token_address, &5_000, &soroban_sdk::Bytes::new(&env));`
);

c = c.replace(
`<<<<<<< HEAD
        client.route_payment(&sender, &recipient, &token_address, &2000, &soroban_sdk::Bytes::new(&env));
        assert_eq!(
            token_client.balance(&recipient),
            (limit - 50) + (2000 - 10)
        );
=======
        client.route_payment(&sender, &recipient, &token_address, &2000);
        assert_eq!(token_client.balance(&recipient), (limit - 50) + (2000 - 10));
>>>>>>> origin/main`,
`        client.route_payment(&sender, &recipient, &token_address, &2000, &soroban_sdk::Bytes::new(&env));
        assert_eq!(token_client.balance(&recipient), (limit - 50) + (2000 - 10));`
);

c = c.replace(
`<<<<<<< HEAD
        client.mock_all_auths().route_payment(&sender, &recipient, &token_address, &1000, &soroban_sdk::Bytes::new(&env));
=======
        client
            .mock_all_auths()
            .route_payment(&sender, &recipient, &token_address, &1000);
>>>>>>> origin/main`,
`        client
            .mock_all_auths()
            .route_payment(&sender, &recipient, &token_address, &1000, &soroban_sdk::Bytes::new(&env));`
);

fs.writeFileSync('stellar-payment-platform/../payment_router/src/lib.rs', c);
