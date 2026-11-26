const QRCode = require('qrcode');

/**
 * Generates a PNG Buffer QR code for a given text or URI.
 * @param {string} text
 * @returns {Promise<Buffer>}
 */
async function generateQrBuffer(text) {
  return await QRCode.toBuffer(text, {
    errorCorrectionLevel: 'M',
    type: 'png',
    margin: 2,
    width: 350,
  });
}

module.exports = {
  generateQrBuffer,
};
