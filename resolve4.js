const fs = require('fs');

let c = fs.readFileSync('stellar-payment-platform/../payment_router/src/lib.rs', 'utf8');
c = c.replace(/\r\n/g, '\n');

// 1. Imports
c = c.replace(
/<<<<<<< HEAD\n    contract, contracterror, contractimpl, contracttype, log, symbol_short, token, Address,\n    Bytes, BytesN, Env, Vec, Symbol,\n=======\n    contract, contracterror, contractimpl, contracttype, log, symbol_short, token, Address, BytesN,\n    Env, Symbol, Vec,\n>>>>>>> origin\/main/g,
`    contract, contracterror, contractimpl, contracttype, log, symbol_short, token, Address,
    Bytes, BytesN, Env, Symbol, Vec,`
);

// 2. Errors
c = c.replace(
/<<<<<<< HEAD\n    \/\/\/ Memo field exceeds maximum allowed length\.\n    InvalidMemo = 10,\n=======\n    \/\/\/ Requested refund withdrawal amount is zero or exceeds available refund balance\.\n    NoRefundAvailable = 10,\n    \/\/\/ An action is already pending in the timelock queue; it must be executed\n    \/\/\/ or cancelled before a duplicate can be queued \(not currently enforced,\n    \/\/\/ but reserved for future deduplication logic\)\.\n    TimelockPending = 11,\n    \/\/\/ The 24-hour delay for the given timelock entry has not elapsed yet\.\n    TimelockNotReady = 12,\n    \/\/\/ No timelock entry exists for the supplied nonce ID\.\n    TimelockNotFound = 13,\n    \/\/\/ The contract is frozen; all payments and timelock executions are blocked\.\n    ContractFrozen = 14,\n>>>>>>> origin\/main/g,
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

// 3. test 1
c = c.replace(
/<<<<<<< HEAD\n        client\.mock_all_auths\(\)\.route_payment\(&sender, &recipient, &token_address, &5_000, &soroban_sdk::Bytes::new\(&env\)\);\n=======\n        client\n            \.mock_all_auths\(\)\n            \.route_payment\(&sender, &recipient, &token_address, &5_000\);\n>>>>>>> origin\/main/g,
`        client
            .mock_all_auths()
            .route_payment(&sender, &recipient, &token_address, &5_000, &soroban_sdk::Bytes::new(&env));`
);

// 4. test 2
c = c.replace(
/<<<<<<< HEAD\n        client\.route_payment\(&sender, &recipient, &token_address, &2000, &soroban_sdk::Bytes::new\(&env\)\);\n        assert_eq!\(\n            token_client\.balance\(&recipient\),\n            \(limit - 50\) \+ \(2000 - 10\)\n        \);\n=======\n        client\.route_payment\(&sender, &recipient, &token_address, &2000\);\n        assert_eq!\(token_client\.balance\(&recipient\), \(limit - 50\) \+ \(2000 - 10\)\);\n>>>>>>> origin\/main/g,
`        client.route_payment(&sender, &recipient, &token_address, &2000, &soroban_sdk::Bytes::new(&env));
        assert_eq!(token_client.balance(&recipient), (limit - 50) + (2000 - 10));`
);

// 5. test 3
c = c.replace(
/<<<<<<< HEAD\n        client\.mock_all_auths\(\)\.route_payment\(&sender, &recipient, &token_address, &1000, &soroban_sdk::Bytes::new\(&env\)\);\n=======\n        client\n            \.mock_all_auths\(\)\n            \.route_payment\(&sender, &recipient, &token_address, &1000\);\n>>>>>>> origin\/main/g,
`        client
            .mock_all_auths()
            .route_payment(&sender, &recipient, &token_address, &1000, &soroban_sdk::Bytes::new(&env));`
);

// 6 & 7 & 8 - Wait, let me just replace the remaining chunks manually via a split.
let chunks = c.split('<<<<<<< HEAD\n');
if (chunks.length > 1) {
    let finalCode = chunks[0];
    for (let i = 1; i < chunks.length; i++) {
        let chunk = chunks[i];
        let parts = chunk.split('=======\n');
        let headPart = parts[0];
        let tailPart = parts[1].split('>>>>>>> origin/main\n');
        let mainPart = tailPart[0];
        let rest = tailPart[1];
        
        // This is a naive merge: we'll just keep HEAD and append origin/main
        // Wait, for tests we should probably just keep both! 
        finalCode += headPart + mainPart + rest;
    }
    c = finalCode;
}

fs.writeFileSync('stellar-payment-platform/../payment_router/src/lib.rs', c);
console.log("Merged");
