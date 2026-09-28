'use strict';

const { prisma } = require('../../prismaClient');
const { logger } = require('../logger');

// Simulated exchange rates relative to a base currency (e.g., XLM)
const EXCHANGE_RATES = {
  'XLM': 1.0,
  'USDC': 0.15, // 1 XLM = 0.15 USDC
  'EURC': 0.14,
};

/**
 * Get all balances for a user, formatted as a nested currency object.
 */
async function getBalances(username) {
  const balances = await prisma.walletBalance.findMany({
    where: { username }
  });
  
  const result = {};
  for (const b of balances) {
    result[b.assetCode] = b.amount;
  }
  return result;
}

/**
 * Add or subtract from a user's specific asset balance.
 */
async function updateBalance(username, assetCode, amount) {
  return prisma.walletBalance.upsert({
    where: {
      username_assetCode: {
        username,
        assetCode,
      }
    },
    update: {
      amount: { increment: amount }
    },
    create: {
      username,
      assetCode,
      amount
    }
  });
}

/**
 * Handle cross-currency exchanges, mutating the target balance.
 */
async function convertAndAddBalance(username, fromAsset, toAsset, amount) {
  const rateFrom = EXCHANGE_RATES[fromAsset] || 1.0;
  const rateTo = EXCHANGE_RATES[toAsset] || 1.0;
  
  // Calculate converted amount
  const convertedAmount = amount * (rateTo / rateFrom);
  
  logger.info(`Converting ${amount} ${fromAsset} to ${convertedAmount} ${toAsset} for user ${username}`);
  
  return updateBalance(username, toAsset, convertedAmount);
}

module.exports = {
  getBalances,
  updateBalance,
  convertAndAddBalance,
};
