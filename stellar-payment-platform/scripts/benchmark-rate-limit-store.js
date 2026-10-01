'use strict';

const { MemorySlidingWindowStore } = require('../src/middleware/slidingWindowRateLimit');

async function main() {
  const distinctClients = 50_000;
  const windowMs = 60_000;
  const previousStore = new Map();
  const boundedStore = new MemorySlidingWindowStore({ maxKeys: 10_000 });

  for (let index = 0; index < distinctClients; index += 1) {
    const key = `client-${index}`;
    previousStore.set(key, [0]);
    await boundedStore.hit(key, 0, windowMs, 10);
  }

  const atCapacity = {
    previousEntries: previousStore.size,
    boundedEntries: boundedStore.requests.size,
  };

  await boundedStore.hit('new-client', windowMs + 1, windowMs, 10);
  const afterWindow = {
    previousEntries: previousStore.size,
    boundedEntries: boundedStore.requests.size,
  };

  process.stdout.write(`${JSON.stringify({ distinctClients, atCapacity, afterWindow }, null, 2)}\n`);
  if (atCapacity.boundedEntries > 10_000 || afterWindow.boundedEntries !== 1) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
