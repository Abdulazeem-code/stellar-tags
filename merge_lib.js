const fs = require('fs');

const headFile = fs.readFileSync('payment_router/lib_head.rs', 'utf8');
const mainFile = fs.readFileSync('payment_router/lib_main.rs', 'utf8');

// The strategy: we will take mainFile and apply the memo additions.
// What did HEAD change?
// 1. Added `Bytes` to imports.
// 2. Added `InvalidMemo = 10` to Error enum.
// 3. Changed `route_payment` to `route_payment_with_memo`? No, wait!
// Let's check HEAD's route_payment signature!
