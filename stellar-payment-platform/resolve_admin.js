const fs = require('fs');

const path = 'stellar-payment-platform/src/routes/v1/adminRoutes.js';
let c = fs.readFileSync(path, 'utf8');

// The conflict starts with:
// <<<<<<< HEAD
//   // Authenticate + authorize. Support/Viewer cannot mutate.
//   const adminRbac = requireRole();
// =======

// And ends with:
//       await invalidateStatsCache(redisClient);
// >>>>>>> origin/main

let match = c.match(/<<<<<<< HEAD\r?\n\s*\/\/ Authenticate \+ authorize.*?>>>>>>> origin\/main\r?\n/s);
if (match) {
    let block = match[0];
    let mainCode = block.split(/=======\r?\n/)[1].replace(/>>>>>>> origin\/main\r?\n/, '');
    
    // In mainCode, we have adminAuth definition, /admin/export, and /admin/block (partial).
    // We want to KEEP /admin/export (and change adminAuth to adminRbac).
    // We want to DELETE adminAuth definition.
    // We want to DELETE /admin/block from mainCode.
    
    // Find where /admin/block starts in mainCode
    let exportRoute = mainCode.split(/router\.post\('\/admin\/block', adminAuth/)[0];
    
    // Replace adminAuth with adminRbac in exportRoute
    exportRoute = exportRoute.replace(/adminAuth/g, 'adminRbac');
    // Also remove the adminAuth definition from the top of mainCode
    exportRoute = exportRoute.replace(/\s*const adminAuth = \(req, res, next\) => \{[\s\S]*?next\(\);\r?\n\s*\};\r?\n/, '');
    
    let resolvedBlock = `  // Authenticate + authorize. Support/Viewer cannot mutate.
  const adminRbac = requireRole();
` + exportRoute;
    
    c = c.replace(match[0], resolvedBlock);
}

// Now we need to add invalidateStatsCache to the HEAD's /admin/block
// Look for:
// await invalidateFederationCache(redisClient, updatedUser.address, updatedUser.username);
c = c.replace(
    /await invalidateFederationCache\(redisClient, updatedUser\.address, updatedUser\.username\);/g,
    `await invalidateFederationCache(redisClient, updatedUser.address, updatedUser.username);\n        await invalidateStatsCache(redisClient);`
);

// We also have trailing whitespace conflicts from git diff --check:
c = c.replace(/[ \t]+(\r?\n)/g, '$1');

fs.writeFileSync(path, c);
