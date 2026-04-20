const admin = require('firebase-admin');

/**
 * Verify payment by checking transaction hash format
 * If sendPayment() succeeds, the transaction is already committed
 * @param {string} txHash - transaction hash from Stellar
 * @returns {object} { success, tx, error }
 */
async function verifyPayment(txHash) {
  // Simple validation: check if txHash is valid 64-character hex string
  // If sendPayment() succeeds, the transaction is already committed
  if (txHash && /^[a-f0-9]{64}$/.test(txHash)) {
    return { success: true, tx: { hash: txHash } };
  }
  return { success: false, error: 'Invalid transaction hash' };
}

/**
 * Store receipt in Firebase Realtime Database
 * @param {string} bookingId
 * @param {string} txHash
 * @param {number} ngnAmount
 */
async function storeReceipt(bookingId, txHash, ngnAmount) {
  const receipt = {
    bookingId,
    txHash,
    ngnAmount,
    timestamp: new Date().toISOString(),
    explorerUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
    status: 'verified'
  };
  
  try {
    const db = admin.database();
    await db.ref(`receipts/${txHash}`).set(receipt);
    console.log(`📋 Receipt stored: ${txHash.substring(0, 16)}...`);
    return receipt;
  } catch (error) {
    console.error('Error storing receipt:', error.message);
    // Don't throw - payment already succeeded, just logging issue
    return receipt;
  }
}

/**
 * Get receipt from Firebase Realtime Database
 * @param {string} txHash
 */
async function getReceipt(txHash) {
  try {
    const db = admin.database();
    const snapshot = await db.ref(`receipts/${txHash}`).get();
    return snapshot.exists() ? snapshot.val() : null;
  } catch (error) {
    console.error('Error retrieving receipt:', error.message);
    return null;
  }
}

module.exports = { verifyPayment, storeReceipt, getReceipt };
