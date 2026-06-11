const admin = require('firebase-admin');

/**
 * Store Paystack payment receipt in Firestore
 */
async function storeReceipt(bookingId, paymentReference, ngnAmount, paystackData = {}) {
  const receipt = {
    bookingId,
    paymentReference,
    ngnAmount,
    paymentMethod: 'paystack',
    timestamp: new Date().toISOString(),
    status: 'verified',
    ...paystackData,
  };

  try {
    const db = admin.firestore();
    await db.collection('receipts').doc(paymentReference).set(receipt);
    console.log(`📋 Receipt stored for booking ${bookingId}`);
    return receipt;
  } catch (error) {
    console.error('Error storing receipt:', error.message);
    return receipt;
  }
}

async function getReceipt(paymentReference) {
  try {
    const db = admin.firestore();
    const doc = await db.collection('receipts').doc(paymentReference).get();
    return doc.exists ? doc.data() : null;
  } catch (error) {
    console.error('Error retrieving receipt:', error.message);
    return null;
  }
}

module.exports = { storeReceipt, getReceipt };
