const fs = require('fs');

const path = 'payment_router/src/lib.rs';
const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
let outLines = [];
let inConflict = false;
let headLines = [];
let mainLines = [];
let conflictPhase = 0; // 1 = HEAD, 2 = main

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith('<<<<<<< HEAD')) {
        inConflict = true;
        headLines = [];
        mainLines = [];
        conflictPhase = 1;
        continue;
    }
    
    if (inConflict && line.startsWith('=======')) {
        conflictPhase = 2;
        continue;
    }
    
    if (inConflict && line.startsWith('>>>>>>> origin/main')) {
        inConflict = false;
        
        // Now resolve the conflict based on headLines and mainLines
        const headStr = headLines.join('\\n').trim();
        const mainStr = mainLines.join('\\n').trim();
        
        if (headStr.includes('Bytes, BytesN, Env, Vec, Symbol,')) {
            outLines.push('    contract, contracterror, contractimpl, contracttype, log, symbol_short, token, Address,');
            outLines.push('    Bytes, BytesN, Env, Symbol, Vec,');
        } 
        else if (headStr.includes('InvalidMemo = 10,')) {
            outLines.push('    /// Memo field exceeds maximum allowed length.');
            outLines.push('    InvalidMemo = 10,');
            outLines.push('    /// Requested refund withdrawal amount is zero or exceeds available refund balance.');
            outLines.push('    NoRefundAvailable = 11,');
            outLines.push('    /// An action is already pending in the timelock queue; it must be executed');
            outLines.push('    /// or cancelled before a duplicate can be queued (not currently enforced,');
            outLines.push('    /// but reserved for future deduplication logic).');
            outLines.push('    TimelockPending = 12,');
            outLines.push('    /// The 24-hour delay for the given timelock entry has not elapsed yet.');
            outLines.push('    TimelockNotReady = 13,');
            outLines.push('    /// No timelock entry exists for the supplied nonce ID.');
            outLines.push('    TimelockNotFound = 14,');
            outLines.push('    /// The contract is frozen; all payments and timelock executions are blocked.');
            outLines.push('    ContractFrozen = 15,');
        }
        else if (headStr.includes('client.mock_all_auths().route_payment(&sender, &recipient, &token_address, &5_000, &soroban_sdk::Bytes::new(&env));')) {
            outLines.push('        client');
            outLines.push('            .mock_all_auths()');
            outLines.push('            .route_payment(&sender, &recipient, &token_address, &5_000, &soroban_sdk::Bytes::new(&env));');
        }
        else if (headStr.includes('token_client.balance(&recipient),') && headStr.includes('(limit - 50) + (2000 - 10)')) {
            outLines.push('        client.route_payment(&sender, &recipient, &token_address, &2000, &soroban_sdk::Bytes::new(&env));');
            outLines.push('        assert_eq!(token_client.balance(&recipient), (limit - 50) + (2000 - 10));');
        }
        else if (headStr.includes('client.mock_all_auths().route_payment(&sender, &recipient, &token_address, &1000, &soroban_sdk::Bytes::new(&env));')) {
            outLines.push('        client');
            outLines.push('            .mock_all_auths()');
            outLines.push('            .route_payment(&sender, &recipient, &token_address, &1000, &soroban_sdk::Bytes::new(&env));');
        }
        else if (headStr.includes('let expected_fee = 400_000i128;')) {
            // This is the big block! test_route_payment_with_memo and gas reports
            outLines.push(...headLines);
            // After HEAD (which contains the end of test_route_payment_with_memo and test_route_payment_with_invalid_memo),
            // wait, HEAD's block doesn't contain the full tests?
            // Wait, headLines contains what was between <<<<<<< HEAD and =======.
            // mainLines contains what was between ======= and >>>>>>> origin/main.
            
            // We should just keep BOTH.
            // But we must fix route_payment calls in mainLines to include the memo.
            const fixedMainLines = mainLines.map(l => {
                if (l.includes('.route_payment(')) {
                    return l.replace(/\\.route_payment\\(([^)]+)\\);/, '.route_payment($1, &soroban_sdk::Bytes::new(&env));');
                }
                return l;
            });
            outLines.push(...fixedMainLines);
        }
        else {
            console.log('Unrecognized block:');
            console.log(headStr);
            console.log('---');
            console.log(mainStr);
            // just keep both
            outLines.push(...headLines);
            outLines.push(...mainLines);
        }
        
        continue;
    }
    
    if (inConflict) {
        if (conflictPhase === 1) {
            headLines.push(line);
        } else {
            mainLines.push(line);
        }
    } else {
        outLines.push(line);
    }
}

fs.writeFileSync(path, outLines.join('\\n') + '\\n');
console.log('Resolved!');
