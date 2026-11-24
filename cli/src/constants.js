/**
 * CLI Constants and Exit Codes
 */

const EXIT_CODES = {
  SUCCESS: 0,
  USER_ERROR: 1,
  NETWORK_ERROR: 2,
};

function getNetworkPassphrase(network) {
  if (network && network.toLowerCase() === 'public') {
    return 'Public Global Stellar Network ; September 2015';
  }
  return 'Test SDF Network ; September 2015';
}

function getHorizonUrl(network) {
  if (network && network.toLowerCase() === 'public') {
    return 'https://horizon.stellar.org';
  }
  return 'https://horizon-testnet.stellar.org';
}

module.exports = {
  EXIT_CODES,
  getNetworkPassphrase,
  getHorizonUrl,
};
