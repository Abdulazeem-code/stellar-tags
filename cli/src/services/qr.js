const qrcodeTerminal = require('qrcode-terminal');

/**
 * Renders a terminal-friendly QR code string.
 * @param {string} text
 * @returns {Promise<string>}
 */
function renderTerminalQr(text) {
  return new Promise((resolve) => {
    qrcodeTerminal.generate(text, { small: true }, (qrcode) => {
      resolve(qrcode);
    });
  });
}

module.exports = {
  renderTerminalQr,
};
