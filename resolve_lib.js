const fs = require('fs');

const path = 'payment_router/src/lib.rs';
let c = fs.readFileSync(path, 'utf8');

const HEAD_MARKER = '<<<<<<< HEAD\n';
const MID_MARKER = '=======\n';
const END_MARKER = '>>>>>>> origin/main\n';

let chunks = c.split(HEAD_MARKER);
let finalCode = chunks[0];

for (let i = 1; i < chunks.length; i++) {
    let chunk = chunks[i];
    let parts = chunk.split(MID_MARKER);
    let headPart = parts[0];
    let tailParts = parts[1].split(END_MARKER);
    let mainPart = tailParts[0];
    let rest = tailParts.slice(1).join(END_MARKER);

    if (headPart.includes('contract, contracterror, contractimpl, contracttype, log, symbol_short, token, Address,')) {
        // Imports
        finalCode += `    contract, contracterror, contractimpl, contracttype, log, symbol_short, token, Address,
    Bytes, BytesN, Env, Symbol, Vec,\n`;
    } 
    else if (headPart.includes('InvalidMemo = 10,')) {
        // Errors
        finalCode += `    /// Memo field exceeds maximum allowed length.
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
    ContractFrozen = 15,\n`;
    }
    else {
        // For all test conflicts:
        // We see that HEAD modified route_payment to add memo.
        // We also know HEAD added a test, and main added tests.
        // If we just take HEAD and then append main, we keep both.
        // BUT main calls route_payment without the memo! So we must fix main's route_payment calls!
        
        let fixedMainPart = mainPart.replace(
            /\.route_payment\(([^)]+)\);/g, 
            '.route_payment($1, &soroban_sdk::Bytes::new(&env));'
        );
        
        // Wait, if both HEAD and main modify the EXACT same line (e.g. replacing a single route_payment call), 
        // appending both will cause duplicate code!
        // Let's check if headPart and mainPart are just the same test being modified.
        // If headPart contains route_payment and mainPart contains route_payment, and they are short, they are just the same line modified!
        
        if (headPart.trim().startsWith('client') && mainPart.trim().startsWith('client') && headPart.split('\\n').length <= 10) {
            // This is just a modified route_payment call. We keep HEAD, because HEAD has the new param!
            finalCode += headPart;
        } else {
            // This is a bigger block (e.g. tests added).
            // We concatenate them. 
            // Wait, if it's the big block where they both added tests, the setup code at the top was identical.
            // But they start from `client.initialize(...)` ?
            // Let's look at the big block. If we just concatenate HEAD and fixedMain, we'll get duplicate `client.initialize`!
            // In the big block, HEAD's headPart starts with `client.initialize(&admin, &platform_treasury, ...)`
            // mainPart starts with `// Reset budget before initialization`
            
            // To be completely safe and correct, we can just use HEAD's setup, and then for main's test, we need to extract the test logic.
            // Wait, mainPart is NOT a full test. It's the INSIDE of `test_routes_multiple_distinct_assets`?
            // Actually, let me write the parts to files so I can manually inspect and assemble the big block.
            fs.writeFileSync(`chunk_${i}_head.rs`, headPart);
            fs.writeFileSync(`chunk_${i}_main.rs`, fixedMainPart);
            
            // For now, I'll just append them, but I will manually fix the big block after.
            finalCode += headPart + '\\n// --- MAIN PART STARTS HERE ---\\n' + fixedMainPart;
        }
    }
    finalCode += rest;
}

fs.writeFileSync(path, finalCode);
console.log('Done replacing chunks. Review chunk files.');
