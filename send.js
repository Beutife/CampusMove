require('dotenv').config();
const admin = require('firebase-admin');

// Firebase setup FIRST (before other requires that depend on it)
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
   credential: admin.credential.cert(serviceAccount)
});

const { sendPayment, getBalance } = require('./stellarClient');
const { ngnToXlm, logConversion } = require('./utils/currencyConverter');
const { verifyPayment, storeReceipt } = require('./utils/verificationService');

const SECRET = process.env.STELLAR_SECRET;
const PUBLIC = process.env.STELLAR_PUBLIC

// Use a second testnet address as receiver (or send to yourself for testing)
const RECEIVER = 'GDM452LJBTOCIU4EDAY7XRHNYXBHWK3D3IQBS3YQX666LJKB34SWSGTV';

async function test() {
  console.log('💰 Checking balance...');
  const balance = await getBalance(PUBLIC);
  console.log(`Balance: ${balance} XLM`);

  const ngnAmount = 50;
  const xlmAmount = ngnToXlm(ngnAmount);
  logConversion(ngnAmount, xlmAmount);

  console.log('\n📤 Sending payment...');
  const result = await sendPayment(SECRET, RECEIVER, xlmAmount);
  console.log('Transaction hash:', result.txHash);
  console.log('Explorer URL:', result.explorerUrl);

  console.log('\n✅ Verifying payment...');
  const verified = await verifyPayment(result.txHash);
  
  if (verified.success) {
    console.log('Payment verified on blockchain!');
    const receipt = await storeReceipt('booking_demo_001', result.txHash, ngnAmount);
    console.log('\n📋 Receipt stored:', receipt);
  } else {
    console.log('❌ Verification failed:', verified.error);
  }
}

test().catch(console.error);