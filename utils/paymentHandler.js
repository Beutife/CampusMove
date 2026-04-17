const { sendPayment, getBalance } = require('../stellarClient');
const { ngnToXlm, logConversion } = require('./currencyConverter');
const { verifyPayment } = require('./verificationService');

/**
 * Handle complete payment flow
 * @param {string} senderSecret - S... secret key
 * @param {string} receiverPublic - G... public key
 * @param {number} ngnAmount - Amount in ₦
 * @returns {object} { success, txHash, explorerUrl, error }
 */
async function processPayment(senderSecret, receiverPublic, ngnAmount) {
  try {
    const xlmAmount = ngnToXlm(ngnAmount);
    logConversion(ngnAmount, xlmAmount);

    const result = await sendPayment(senderSecret, receiverPublic, xlmAmount);
    const verified = await verifyPayment(result.txHash);

    if (verified.success) {
      return {
        success: true,
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
        ngnAmount,
        xlmAmount
      };
    } else {
      return {
        success: false,
        error: 'Payment verification failed'
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = { processPayment };
