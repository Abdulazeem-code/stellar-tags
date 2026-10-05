const fs = require('fs');

let u = fs.readFileSync('stellar-payment-platform/src/routes/v1/userRoutes.js', 'utf8');
u = u.replace(
  /const \{ asyncHandler \} = require\(['"]\.\.\/\.\.\/middleware\/asyncHandler['"]\);/,
  'const { asyncHandler } = require("../../middleware/asyncHandler");\nconst { createSignatureRateLimiter } = require("../../middleware/signatureRateLimit");'
);
u = u.replace(
  /const router = express\.Router\(\);/,
  'const router = express.Router();\n\nconst signatureRateLimiter = createSignatureRateLimiter();'
);
u = u.replace(
  /validateSchema\(\{ body: registerBodySchema \}\),\s*asyncHandler\(async \(req, res, next\) => \{/,
  'validateSchema({ body: registerBodySchema }),\n  signatureRateLimiter,\n  asyncHandler(async (req, res, next) => {'
);
fs.writeFileSync('stellar-payment-platform/src/routes/v1/userRoutes.js', u);

let w = fs.readFileSync('stellar-payment-platform/src/routes/v1/webhookRoutes.js', 'utf8');
w = w.replace(
  /const \{ ACTIVITY_ACTIONS, recordActivity \} = require\(['"]\.\.\/\.\.\/services\/activityService['"]\);/,
  'const { ACTIVITY_ACTIONS, recordActivity } = require("../../services/activityService");\nconst { createSignatureRateLimiter } = require("../../middleware/signatureRateLimit");'
);
w = w.replace(
  /router\.use\(idempotencyMiddleware\(redisClient\)\);/,
  'router.use(idempotencyMiddleware(redisClient));\n\n  const signatureRateLimiter = createSignatureRateLimiter();'
);
w = w.replace(
  /router\.post\(['"]\/webhooks['"], asyncHandler\(async \(req, res, next\) => \{/,
  'router.post("/webhooks", signatureRateLimiter, asyncHandler(async (req, res, next) => {'
);
fs.writeFileSync('stellar-payment-platform/src/routes/v1/webhookRoutes.js', w);

console.log("Fixes applied successfully.");
