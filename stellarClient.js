const StellarSdk = require('stellar-sdk');

// Connect to testnet
const server = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');
const networkPassphrase = StellarSdk.Networks.TESTNET;

/**
 * Send XLM on Stellar testnet
 * @param {string} senderSecret  - S... secret key of the sender
 * @param {string} receiverPublic - G... public key of the receiver
 * @param {string} xlmAmount     - amount as string e.g. "0.10"
 * @returns {object} { txHash, explorerUrl }
 */
async function sendPayment(senderSecret, receiverPublic, xlmAmount) {
  const senderKeypair = StellarSdk.Keypair.fromSecret(senderSecret);
  const senderPublic  = senderKeypair.publicKey();

  // Load sender account (gets sequence number)
  const account = await server.loadAccount(senderPublic);

  const transaction = new StellarSdk.TransactionBuilder(account, {
    fee: await server.fetchBaseFee(),
    networkPassphrase,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: receiverPublic,
        asset: StellarSdk.Asset.native(), // XLM
        amount: xlmAmount,
      })
    )
    .setTimeout(30)
    .build();

  transaction.sign(senderKeypair);

  const result = await server.submitTransaction(transaction);

  const txHash = result.hash;
  const explorerUrl = `https://stellar.expert/explorer/testnet/tx/${txHash}`;

  console.log(`✅ Payment sent: ${xlmAmount} XLM`);
  console.log(`🔗 Explorer: ${explorerUrl}`);

  return { txHash, explorerUrl };
}

/**
 * Get wallet XLM balance
 * @param {string} publicKey
 */
async function getBalance(publicKey) {
  const account = await server.loadAccount(publicKey);
  const xlm = account.balances.find(b => b.asset_type === 'native');
  return xlm ? xlm.balance : '0';
}

/**
 * Get bot's testnet wallet details
 * @returns {object} { publicKey, balance }
 */
async function getBotWallet(publicKey) {
  const balance = await getBalance(publicKey);
  return { publicKey, balance };
}

module.exports = { sendPayment, getBalance, getBotWallet };