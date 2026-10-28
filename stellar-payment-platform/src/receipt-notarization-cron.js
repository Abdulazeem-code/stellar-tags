'use strict';

const cron = require('node-cron');
const { logger } = require('./logger');
const { defaultSigner, isKmsEnabled } = require('./services/kmsSigner');
const { rpc, TransactionBuilder, Account, Keypair, Networks, xdr, BASE_FEE } = require('@stellar/stellar-sdk');
const { MerkleTree, canonicalJson } = require('./settlement/merkleTree');

const RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || (Networks && Networks.TESTNET) || 'Test SDF Network ; September 2015';

async function buildHourlyMerkleTree(prisma) {
  const now = new Date();
  const hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0);
  const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);

  const payments = await prisma.payment.findMany({
    where: {
      createdAt: { gte: hourStart, lt: hourEnd },
      status: 'completed',
      transactionHash: { not: null },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (payments.length === 0) {
    logger.info('[receipt-notarization] No completed payments in this hour, skipping');
    return null;
  }

  const batchId = `batch_${hourStart.toISOString().replace(/[-:]/g, '').slice(0, 13)}`;
  const batchTimestamp = hourStart.getTime();

  const leafData = payments.map((p, idx) => ({
    paymentId: p.id,
    transactionHash: p.transactionHash,
    from: p.fromAddress,
    to: p.toAddress,
    amount: p.amount,
    assetCode: p.assetCode || 'XLM',
    timestamp: p.createdAt.getTime(),
    index: idx,
  }));

  const merkleTree = new MerkleTree(leafData);
  const merkleRoot = merkleTree.getRootHex();

  const receipts = payments.map((payment, index) => {
    const proof = merkleTree.getProof(index);
    return {
      paymentId: payment.id,
      merkleRoot,
      leafIndex: index,
      proof,
      batchId,
      batchTimestamp: BigInt(batchTimestamp),
    };
  });

  await prisma.paymentReceipt.createMany({
    data: receipts,
    skipDuplicates: true,
  });

  logger.info(`[receipt-notarization] Built Merkle tree for batch ${batchId}: ${payments.length} payments, root: ${merkleRoot}`);

  return { batchId, merkleRoot, batchTimestamp, leafCount: payments.length, receipts };
}

async function anchorMerkleRootToStellar(merkleRoot, batchId, batchTimestamp, leafCount) {
  const server = new rpc.Server(RPC_URL);

  const sourceAccount = await defaultSigner.getPublicKey();
  const account = new Account(sourceAccount, '0');

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addMemo(xdr.Memo.memoHash(Buffer.from(merkleRoot, 'hex')))
    .setTimeout(180)
    .build();

  const signedTx = await defaultSigner.signTransaction(tx);
  const sendResult = await server.sendTransaction(signedTx);

  if (sendResult.status === 'PENDING' || sendResult.status === 'TRY_AGAIN_LATER') {
    let getResult = await server.getTransaction(sendResult.hash);
    while (getResult.status === 'NOT_FOUND') {
      await new Promise((r) => setTimeout(r, 2000));
      getResult = await server.getTransaction(sendResult.hash);
    }

    if (getResult.status === 'SUCCESS') {
      return { success: true, txHash: sendResult.hash };
    } else {
      const errorMsg = getResult.resultXdr ? getResult.resultXdr.toString() : 'Unknown error';
      return { success: false, txHash: sendResult.hash, error: errorMsg };
    }
  }

  return { success: false, error: sendResult.errorResultXdr?.toString() || 'Submission failed' };
}

async function runReceiptNotarization(prisma) {
  logger.info('[receipt-notarization] Starting hourly receipt notarization...');

  try {
    const treeResult = await buildHourlyMerkleTree(prisma);

    if (!treeResult) {
      return { status: 'skipped', reason: 'no payments' };
    }

    const existingAnchor = await prisma.receiptAnchor.findUnique({
      where: { batchId: treeResult.batchId },
    });

    if (existingAnchor) {
      logger.info(`[receipt-notarization] Batch ${treeResult.batchId} already anchored`);
      return { status: 'skipped', reason: 'already anchored', batchId: treeResult.batchId };
    }

    const anchorRecord = await prisma.receiptAnchor.create({
      data: {
        merkleRoot: treeResult.merkleRoot,
        batchId: treeResult.batchId,
        batchTimestamp: BigInt(treeResult.batchTimestamp),
        leafCount: treeResult.leafCount,
        status: 'pending',
      },
    });

    let anchorResult;
    if (isKmsEnabled() || process.env.STELLAR_SECRET_KEY) {
      anchorResult = await anchorMerkleRootToStellar(
        treeResult.merkleRoot,
        treeResult.batchId,
        treeResult.batchTimestamp,
        treeResult.leafCount
      );
    } else {
      logger.warn('[receipt-notarization] No signing credentials configured, skipping Stellar anchor');
      anchorResult = { success: false, error: 'No signing credentials' };
    }

    if (anchorResult.success) {
      await prisma.receiptAnchor.update({
        where: { id: anchorRecord.id },
        data: {
          anchorTxHash: anchorResult.txHash,
          status: 'confirmed',
          confirmedAt: new Date(),
        },
      });

      await prisma.paymentReceipt.updateMany({
        where: { batchId: treeResult.batchId },
        data: {
          anchorTxHash: anchorResult.txHash,
          anchorStatus: 'confirmed',
          confirmedAt: new Date(),
        },
      });

      logger.info(`[receipt-notarization] Successfully anchored batch ${treeResult.batchId} to Stellar: ${anchorResult.txHash}`);
      return { status: 'success', batchId: treeResult.batchId, anchorTxHash: anchorResult.txHash };
    } else {
      await prisma.receiptAnchor.update({
        where: { id: anchorRecord.id },
        data: {
          status: 'failed',
          attempts: { increment: 1 },
          lastError: anchorResult.error,
        },
      });

      logger.error(`[receipt-notarization] Failed to anchor batch ${treeResult.batchId}: ${anchorResult.error}`);
      return { status: 'failed', batchId: treeResult.batchId, error: anchorResult.error };
    }
  } catch (err) {
    logger.error('[receipt-notarization] Receipt notarization failed:', err.message);
    throw err;
  }
}

async function retryFailedAnchors(prisma) {
  const failedAnchors = await prisma.receiptAnchor.findMany({
    where: {
      status: 'failed',
      attempts: { lt: 3 },
    },
  });

  for (const anchor of failedAnchors) {
    try {
      logger.info(`[receipt-notarization] Retrying anchor for batch ${anchor.batchId} (attempt ${anchor.attempts + 1})`);

      const anchorResult = await anchorMerkleRootToStellar(
        anchor.merkleRoot,
        anchor.batchId,
        Number(anchor.batchTimestamp),
        anchor.leafCount
      );

      if (anchorResult.success) {
        await prisma.receiptAnchor.update({
          where: { id: anchor.id },
          data: {
            anchorTxHash: anchorResult.txHash,
            status: 'confirmed',
            confirmedAt: new Date(),
          },
        });

        await prisma.paymentReceipt.updateMany({
          where: { batchId: anchor.batchId },
          data: {
            anchorTxHash: anchorResult.txHash,
            anchorStatus: 'confirmed',
            confirmedAt: new Date(),
          },
        });

        logger.info(`[receipt-notarization] Retry successful for batch ${anchor.batchId}: ${anchorResult.txHash}`);
      } else {
        await prisma.receiptAnchor.update({
          where: { id: anchor.id },
          data: {
            attempts: { increment: 1 },
            lastError: anchorResult.error,
          },
        });
        logger.warn(`[receipt-notarization] Retry failed for batch ${anchor.batchId}: ${anchorResult.error}`);
      }
    } catch (err) {
      logger.error(`[receipt-notarization] Retry error for batch ${anchor.batchId}:`, err.message);
    }
  }
}

function scheduleReceiptNotarizationJob(prisma) {
  cron.schedule('0 * * * *', async () => {
    logger.info('[receipt-notarization] Starting scheduled hourly notarization...');
    try {
      await runReceiptNotarization(prisma);
      await retryFailedAnchors(prisma);
    } catch (err) {
      logger.error('[receipt-notarization] Scheduled job failed:', err.message);
    }
  });

  logger.info('[receipt-notarization] Hourly receipt notarization job scheduled (every hour at minute 0).');
}

module.exports = {
  scheduleReceiptNotarizationJob,
  runReceiptNotarization,
  retryFailedAnchors,
  buildHourlyMerkleTree,
  anchorMerkleRootToStellar,
};