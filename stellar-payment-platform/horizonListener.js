const { Horizon } = require('@stellar/stellar-sdk');
const { prisma } = require('./prismaClient');
const logger = require('./logger');

const NETWORK = process.env.HORIZON_NETWORK || 'testnet';

const HORIZON_URLS = {
  testnet: 'https://horizon-testnet.stellar.org',
  public: 'https://horizon.stellar.org',
};

const HORIZON_URL = HORIZON_URLS[NETWORK] || HORIZON_URLS.testnet;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS, 10) || 60000;

const horizon = new Horizon.Server(HORIZON_URL);
const activeStreams = new Map();

const formatPayment = (payment, trackedAccount) => {
  const direction = payment.to === trackedAccount ? 'INCOMING' : 'OUTGOING';
  const asset =
    payment.asset_type === 'native'
      ? 'XLM'
      : `${payment.asset_code}:${payment.asset_issuer}`;

  return {
    direction,
    account: trackedAccount,
    from: payment.from,
    to: payment.to,
    amount: payment.amount,
    asset,
    txHash: payment.transaction_hash,
    createdAt: payment.created_at,
  };
};

const watchAccount = (accountId) => {
  if (activeStreams.has(accountId)) return;

  logger.info({ accountId }, 'Watching payments');

  const closeStream = horizon
    .payments()
    .forAccount(accountId)
    .cursor('now')
    .stream({
      onmessage: (payment) => {
        if (payment.type === 'payment' || payment.type_i === 1) {
          logger.info({ payment: formatPayment(payment, accountId) }, 'Payment detected');
        }
      },
      onerror: (error) => {
        logger.error({ accountId, err: error?.message || error }, 'Stream error');
      },
    });

  activeStreams.set(accountId, closeStream);
};

const syncWatchedAccounts = async () => {
  try {
    const rows = await prisma.user.findMany({
      distinct: ['address'],
      select: { address: true },
    });

    const currentAddresses = new Set(rows.map((r) => r.address));

    for (const { address } of rows) {
      if (!activeStreams.has(address)) {
        watchAccount(address);
      }
    }

    for (const [address, closeFn] of activeStreams) {
      if (!currentAddresses.has(address)) {
        logger.info({ address }, 'Stopped watching removed account');
        if (typeof closeFn === 'function') closeFn();
        activeStreams.delete(address);
      }
    }

    logger.info({ count: activeStreams.size }, 'Actively monitoring accounts');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to sync watched accounts');
  }
};

const shutdown = async () => {
  logger.info('Shutting down Horizon listener');
  for (const [address, closeFn] of activeStreams) {
    if (typeof closeFn === 'function') closeFn();
    logger.info({ address }, 'Closed stream');
  }
  activeStreams.clear();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const main = async () => {
  logger.info({
    network: NETWORK.toUpperCase(),
    horizonUrl: HORIZON_URL,
    pollIntervalSec: POLL_INTERVAL_MS / 1000,
  }, 'Stellar Horizon Payment Listener starting');

  await syncWatchedAccounts();
  setInterval(syncWatchedAccounts, POLL_INTERVAL_MS);
};

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error starting Horizon listener');
  process.exit(1);
});
