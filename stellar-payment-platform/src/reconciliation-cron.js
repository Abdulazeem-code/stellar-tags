const cron = require('node-cron');
const { logger } = require('./logger');
const { fetchTransaction, fetchPaymentsForTransaction } = require('./services/stellarService');

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

module.exports = { scheduleReconciliationJob, runReconciliation };
