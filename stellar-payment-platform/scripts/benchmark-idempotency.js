'use strict';

const express = require('express');
const request = require('supertest');
const { idempotencyMiddleware } = require('../middleware/idempotency');

async function measure(protectedRoute) {
  const app = express();
  app.use(express.json());
  if (protectedRoute) app.use(idempotencyMiddleware(null));

  let executions = 0;
  app.post('/payments', async (_req, res) => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 100));
    res.status(201).json({ accepted: true });
  });
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(error.statusCode || 500).json({ error: error.code });
  });

  const started = process.hrtime.bigint();
  const responses = await Promise.all(Array.from({ length: 100 }, () =>
    request(app).post('/payments').set('Idempotency-Key', 'same-payment').send({ amount: 10 })));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;

  return {
    attempts: responses.length,
    handlerExecutions: executions,
    protectedAttempts: responses.length - executions,
    elapsedMs: Math.round(elapsedMs),
  };
}

async function main() {
  const withoutProtection = await measure(false);
  const withProtection = await measure(true);
  process.stdout.write(`${JSON.stringify({ withoutProtection, withProtection }, null, 2)}\n`);
  if (withProtection.handlerExecutions !== 1) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
