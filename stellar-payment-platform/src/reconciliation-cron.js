const cron = require('node-cron');
const { logger } = require('./logger');
const {
  fetchTransaction,
  fetchPaymentsForTransaction,
  fetchPaymentsForAccount,
} = require('./services/stellarService');
const { appendEvent, PaymentEventTypes } = require('./services/eventStore');

// ---------------------------------------------------------------------------
// Event-driven ledger reconciliation of stale PENDING payments (issue #933)
//
// Under network partitions or server crashes a payment can be confirmed on
// the Stellar ledger while the local PostgreSQL row stays in PENDING, leaving
// the merchant order stuck. A second cron pass runs every 5 minutes: it
// re-queries Horizon for stale pending payments (by transaction hash first,
// falling back to an on-chain memo/payment-reference match) and drives the
// row to SUCCESS or FAILED, dispatching the corresponding settlement event
// so downstream consumers (SSE, webhooks, read models) react immediately.
// ---------------------------------------------------------------------------

/** Payments older than this many minutes are considered stale pending. */
const STALE_PENDING_MINUTES = parseInt(process.env.RECONCILE_STALE_MINUTES, 10) || 5;

/** Pending payments unseen on-chain for this long are marked FAILED. */
const FAIL_AFTER_MINUTES = parseInt(process.env.RECONCILE_FAIL_AFTER_MINUTES, 10) || 120;

/** Cron cadence for the stale-pending pass. */
const RECONCILE_CRON = '*/5 * * * *';

/** Max rows inspected per pass so a backlog cannot stall the loop. */
const RECONCILE_BATCH_LIMIT = parseInt(process.env.RECONCILE_BATCH_LIMIT, 10) || 200;

const PENDING_STATUSES = ['pending', 'PENDING', 'created', 'routed'];

const RECONCILED_STATUS = { SUCCESS: 'SUCCESS', FAILED: 'FAILED' };

const PAYMENT_OP_TYPES = new Set([
  'payment',
  'path_payment_strict_receive',
  'path_payment_strict_send',
]);

function isCircuitOpenError(err) {
  return err && err.name === 'CircuitBreakerOpenError';
}

function isNotFoundError(err) {
  return Boolean(err && err.response && err.response.status === 404);
}

function amountsMatch(a, b) {
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return false;
  return Math.abs(na - nb) < 0.0001;
}

/**
 * Updates the payment row and dispatches the matching settlement event.
 * The update is guarded on the row still being pending so the listener and
 * this cron never double-flip the same payment (and never emit two events).
 */
async function finalizePayment(prisma, payment, status, data, reason) {
  const updateData = { status };
  if (data && data.transactionHash) updateData.transactionHash = data.transactionHash;

  const { count } = await prisma.payment.updateMany({
    where: { id: payment.id, status: { in: PENDING_STATUSES } },
    data: updateData,
  });
  if (!count) {
    // Already settled by the listener / webhook path — skip the event.
    return false;
  }

  const eventType =
    status === RECONCILED_STATUS.SUCCESS
      ? PaymentEventTypes.PAYMENT_COMPLETED
      : PaymentEventTypes.PAYMENT_FAILED;

  try {
    await appendEvent({
      paymentId: payment.id,
      eventType,
      data: {
        paymentId: payment.id,
        status,
        previousStatus: payment.status,
        transactionHash: updateData.transactionHash || payment.transactionHash || null,
        reconciledBy: 'ledger-reconciliation-cron',
        reason,
      },
      metadata: { source: 'reconciliation-cron' },
    });
  } catch (err) {
    // The ledger state is already corrected; the event is retried by the
    // outbox/event consumers, so log loudly rather than roll back.
    logger.error(`[reconciliation-cron] Failed to dispatch ${eventType} for payment ${payment.id}:`, err.message);
  }

  logger.info(`[reconciliation-cron] Payment ${payment.id} reconciled ${payment.status} -> ${status} (${reason})`);
  return true;
}

/**
 * Reconcile a payment that already carries a transaction hash: ask Horizon
 * whether the transaction exists and whether it was successful.
 */
async function reconcileByTransactionHash(prisma, payment, failCutoff, stats) {
  let tx;
  try {
    tx = await fetchTransaction(payment.transactionHash);
  } catch (err) {
    if (isCircuitOpenError(err)) {
      logger.warn(`[reconciliation-cron] Circuit breaker open, skipping payment ${payment.id}`);
      stats.skipped++;
      return;
    }
    if (isNotFoundError(err)) {
      // Not visible on-chain yet. Only give up once the payment is far past
      // the fail-after window; otherwise leave it for the next pass.
      if (payment.createdAt <= failCutoff) {
        await finalizePayment(
          prisma,
          payment,
          RECONCILED_STATUS.FAILED,
          null,
          'Transaction hash never appeared on the Stellar ledger',
        );
        stats.failed++;
      } else {
        stats.pending++;
      }
      return;
    }
    logger.error(`[reconciliation-cron] Error fetching tx ${payment.transactionHash}:`, err.message);
    stats.errors++;
    return;
  }

  if (tx && tx.successful === false) {
    await finalizePayment(
      prisma,
      payment,
      RECONCILED_STATUS.FAILED,
      null,
      'Transaction found on-chain but was not successful',
    );
    stats.failed++;
    return;
  }

  await finalizePayment(
    prisma,
    payment,
    RECONCILED_STATUS.SUCCESS,
    { transactionHash: payment.transactionHash },
    'Transaction confirmed successful on the Stellar ledger',
  );
  stats.confirmed++;
}

/**
 * Reconcile a payment without a transaction hash: scan recent on-chain
 * payments for the recipient account and match on memo/payment reference
 * (when recorded) or from/to/amount.
 */
async function reconcileByMemoOrReference(prisma, payment, stats) {
  const memo = payment.memo || payment.paymentRef || null;
  try {
    const page = await fetchPaymentsForAccount({
      address: payment.toAddress,
      limit: 50,
      order: 'desc',
    });

    const records = (page && page.records) || [];
    for (const op of records) {
      if (!PAYMENT_OP_TYPES.has(op.type)) continue;
      if (op.to !== payment.toAddress || op.from !== payment.fromAddress) continue;
      if (!amountsMatch(op.amount, payment.amount)) continue;
      // When both sides carry a memo the memo must match; otherwise fall
      // back to the (from, to, amount) fingerprint.
      if (memo && op.memo && op.memo !== memo) continue;

      await finalizePayment(
        prisma,
        payment,
        RECONCILED_STATUS.SUCCESS,
        { transactionHash: op.transaction_hash || null },
        memo ? `Matched on-chain payment by memo/reference ${memo}` : 'Matched on-chain payment by from/to/amount',
      );
      stats.confirmed++;
      return;
    }

    // No match yet — leave pending; the hash path will hard-fail it after
    // the fail-after window only when a hash exists.
    stats.pending++;
  } catch (err) {
    if (isCircuitOpenError(err)) {
      logger.warn(`[reconciliation-cron] Circuit breaker open, skipping payment ${payment.id}`);
      stats.skipped++;
    } else {
      logger.error(`[reconciliation-cron] Error scanning on-chain payments for ${payment.toAddress}:`, err.message);
      stats.errors++;
    }
  }
}

/**
 * One pass of the stale-pending ledger reconciliation.
 *
 * @param {import('@prisma/client').PrismaClient} prisma - A Prisma client.
 * @returns {Promise<{scanned:number,confirmed:number,failed:number,pending:number,skipped:number,errors:number}>}
 */
async function runStalePendingReconciliation(prisma) {
  const now = Date.now();
  const cutoff = new Date(now - STALE_PENDING_MINUTES * 60 * 1000);
  const failCutoff = new Date(now - FAIL_AFTER_MINUTES * 60 * 1000);

  const payments = await prisma.payment.findMany({
    where: {
      status: { in: PENDING_STATUSES },
      deletedAt: null,
      createdAt: { lte: cutoff },
    },
    orderBy: { createdAt: 'asc' },
    take: RECONCILE_BATCH_LIMIT,
  });

  const stats = { scanned: payments.length, confirmed: 0, failed: 0, pending: 0, skipped: 0, errors: 0 };

  for (const payment of payments) {
    if (payment.transactionHash) {
      await reconcileByTransactionHash(prisma, payment, failCutoff, stats);
    } else {
      await reconcileByMemoOrReference(prisma, payment, stats);
    }
  }

  return stats;
}

/**
 * Registers the 5-minute stale-pending ledger reconciliation cron (issue #933).
 * Overlapping ticks are skipped so a slow Horizon scan never stacks up.
 *
 * @param {import('@prisma/client').PrismaClient} prisma - A Prisma client.
 */
function scheduleLedgerReconciliationJob(prisma) {
  let running = false;

  cron.schedule(RECONCILE_CRON, async () => {
    if (running) {
      logger.warn('[reconciliation-cron] Previous stale-pending pass still running, skipping tick');
      return;
    }
    running = true;
    logger.info('[reconciliation-cron] Starting stale-pending ledger reconciliation…');
    try {
      const stats = await runStalePendingReconciliation(prisma);
      logger.info(
        `[reconciliation-cron] Stale-pending pass done – scanned: ${stats.scanned}, ` +
          `settled: ${stats.confirmed}, failed: ${stats.failed}, still pending: ${stats.pending}, ` +
          `skipped: ${stats.skipped}, errors: ${stats.errors}`,
      );
      if (stats.failed > 0) {
        logger.warn(
          `[ALERT] Ops: ${stats.failed} pending payment(s) hard-failed during ledger reconciliation. Check stuck orders.`,
        );
      }
    } catch (err) {
      logger.error('[reconciliation-cron] Stale-pending reconciliation failed:', err.message);
    } finally {
      running = false;
    }
  });

  logger.info(`[reconciliation-cron] Stale-pending ledger reconciliation scheduled (${RECONCILE_CRON}).`);
}

/**
 * Runs the reconciliation logic against the provided Prisma client.
 *
 * @param {import('@prisma/client').PrismaClient} prisma - A Prisma client.
 */
async function runReconciliation(prisma) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 1); // last 24 hours

  // Get payments from the last 24 hours
  const payments = await prisma.payment.findMany({
    where: {
      createdAt: { gte: cutoff },
    },
  });

  let anomaliesCount = 0;

  for (const payment of payments) {
    if (!payment.transactionHash) {
      // Missing tx hash is an anomaly if status is completed
      if (payment.status === 'completed') {
        await prisma.reconciliationAnomaly.create({
          data: {
            paymentId: payment.id,
            discrepancyType: 'missing_tx_hash',
            details: 'Payment marked completed but has no transaction hash',
          },
        });
        anomaliesCount++;
      }
      continue;
    }

    try {
      // Check horizon
      const operations = await fetchPaymentsForTransaction(payment.transactionHash);
      
      let foundMatch = false;
      let diffDetails = null;

      if (operations && operations.records && operations.records.length > 0) {
        for (const op of operations.records) {
          if (op.type === 'payment' || op.type === 'path_payment_strict_receive' || op.type === 'path_payment_strict_send') {
            if (op.to === payment.toAddress && op.from === payment.fromAddress) {
              const opAmount = parseFloat(op.amount);
              const dbAmount = payment.amount;
              // Check if amount is roughly equal
              if (Math.abs(opAmount - dbAmount) < 0.0001) {
                foundMatch = true;
                break;
              } else {
                diffDetails = `Amount mismatch: DB ${dbAmount}, Horizon ${opAmount}`;
              }
            }
          }
        }
      }

      if (!foundMatch) {
        await prisma.reconciliationAnomaly.create({
          data: {
            paymentId: payment.id,
            transactionHash: payment.transactionHash,
            discrepancyType: diffDetails ? 'amount_mismatch' : 'missing_on_chain_or_mismatch',
            details: diffDetails || 'No matching payment operation found on chain for this transaction hash',
          },
        });
        anomaliesCount++;
      }

    } catch (err) {
      if (err.name === 'CircuitBreakerOpenError') {
        logger.warn(`[reconciliation-cron] Circuit breaker open, skipping payment ${payment.id}`);
      } else if (err.response && err.response.status === 404) {
        // Transaction not found on chain
        await prisma.reconciliationAnomaly.create({
          data: {
            paymentId: payment.id,
            transactionHash: payment.transactionHash,
            discrepancyType: 'missing_on_chain',
            details: 'Transaction hash not found on Stellar network',
          },
        });
        anomaliesCount++;
      } else {
        logger.error(`[reconciliation-cron] Error fetching tx ${payment.transactionHash}:`, err.message);
      }
    }
  }

  if (anomaliesCount > 0) {
    // Alert the finance team
    logger.warn(`[ALERT] Finance Team: Found ${anomaliesCount} reconciliation anomalies in the last 24 hours. Please check the admin dashboard.`);
  }

  return { processed: payments.length, anomalies: anomaliesCount };
}

/**
 * Registers a daily cron job (every day at midnight) that calls
 * `runReconciliation` and logs the results.
 *
 * @param {import('@prisma/client').PrismaClient} prisma - A Prisma client.
 */
function scheduleReconciliationJob(prisma) {
  // Cron expression: "0 0 * * *" → runs at 00:00 every day.
  cron.schedule('0 0 * * *', async () => {
    logger.info('[reconciliation-cron] Starting daily reconciliation…');
    try {
      const { processed, anomalies } = await runReconciliation(prisma);
      logger.info(
        `[reconciliation-cron] Reconciliation complete – processed: ${processed}, anomalies: ${anomalies}`,
      );
    } catch (err) {
      logger.error('[reconciliation-cron] Reconciliation failed:', err.message);
    }
  });

  logger.info('[reconciliation-cron] Daily reconciliation job scheduled (every midnight).');
}

module.exports = {
  scheduleReconciliationJob,
  runReconciliation,
  scheduleLedgerReconciliationJob,
  runStalePendingReconciliation,
  STALE_PENDING_MINUTES,
  FAIL_AFTER_MINUTES,
  RECONCILE_CRON,
  RECONCILED_STATUS,
  PENDING_STATUSES,
};
