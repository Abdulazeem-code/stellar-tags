const express = require('express');
const { getContractStatus } = require('../../services/contractService');

const router = express.Router();

router.get('/contract/status', async (req, res) => {
  try {
    const status = await getContractStatus();
    return res.status(200).json(status);
  } catch (error) {
    console.error('Error fetching contract status:', error);
    if (error.message.includes('not set')) {
      return res.status(500).json({ error: 'Contract configuration is missing' });
    }
    return res.status(500).json({ error: 'Failed to fetch contract status' });
  }
});

module.exports = router;
