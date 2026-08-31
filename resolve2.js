const fs = require('fs');

function resolveFile(file, replacer) {
  let content = fs.readFileSync(file, 'utf8');
  content = replacer(content);
  fs.writeFileSync(file, content);
}

// 1. prismaClient.js
resolveFile('stellar-payment-platform/prismaClient.js', c => {
  const mergedMocks = `    webhookDLQ: {
      findMany: async () => [],
      findUnique: async () => null,
      create: async () => ({}),
      delete: async () => ({}),
      update: async () => ({}),
    },
    auditLog: {
      findMany: async () => [],
      findUnique: async () => null,
      findFirst: async () => null,
      create: async (args) => args.data || {},
      count: async () => 0,
    },
    payment: {
      findMany: async () => [],
      findUnique: async () => null,
      count: async () => 0,
    },
    webhook: {
      findUnique: async () => null,
      findFirst: async () => null,
      findMany: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      delete: async () => ({}),
      count: async () => 0,
    },
    paymentIntent: {
      create: async (args) => args.data || {},
      findMany: async () => [],
      findUnique: async () => null,`;
  return c.replace(/<<<<<<< HEAD\r?\n[\s\S]*?=======\r?\n[\s\S]*?>>>>>>> origin\/main\r?\n?/, mergedMocks + '\n');
});

// 2. index.js
resolveFile('stellar-payment-platform/src/routes/v1/index.js', c => {
  // First conflict:
  c = c.replace(/<<<<<<< HEAD\r?\nconst adminRoutesFn = require\('\.\\/adminRoutes'\);\r?\n=======\r?\nconst paymentRoutes = require\('\.\\/paymentRoutes'\);\r?\n>>>>>>> origin\/main\r?\n?/, 
  "const paymentRoutes = require('./paymentRoutes');\n");
  
  // Second conflict:
  c = c.replace(/<<<<<<< HEAD\r?\n  const adminRoutes = adminRoutesFn\(redisClient\);\r?\n=======\r?\n  const adminRoutes = require\('\.\\/adminRoutes'\)\(redisClient\);\r?\n>>>>>>> origin\/main\r?\n?/,
  "  const adminRoutes = require('./adminRoutes')(redisClient);\n");

  // Third conflict:
  c = c.replace(/<<<<<<< HEAD\r?\n  router\.use\('\\/', statsRoutes\);\r?\n  router\.use\('\\/', adminRoutes\);\r?\n=======\r?\n  router\.use\('\\/', webhookRoutes\);\r?\n  router\.use\('\\/', statsRoutes\(redisClient\)\);\r?\n  router\.use\('\\/', adminRoutes\);\r?\n  router\.use\('\\/', webhookRoutes\(redisClient\)\);\r?\n  router\.use\('\\/', paymentRoutes\(redisClient\)\);\r?\n>>>>>>> origin\/main\r?\n?/,
  "  router.use('/', statsRoutes(redisClient));\n  router.use('/', adminRoutes);\n  router.use('/', webhookRoutes(redisClient));\n  router.use('/', paymentRoutes(redisClient));\n");
  return c;
});
