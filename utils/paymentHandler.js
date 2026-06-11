const crypto = require('crypto');

const PAYMENT_PAGE_URL =
  process.env.PAYSTACK_PAYMENT_PAGE_URL || 'https://paystack.shop/pay/1hmgcaheci';

function getPaymentPageUrl() {
  return PAYMENT_PAGE_URL;
}

function buildPaymentMessage(bookingId, amount) {
  return `
💰 *Payment Required: ₦${amount}*

Pay securely via Paystack:
${PAYMENT_PAGE_URL}

*Important:*
• Enter exactly *₦${amount}* as the amount
• Booking ID: *${bookingId}*

Reply *paid* when you have completed payment.
  `.trim();
}

function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || !signature) return false;

  const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  return hash === signature;
}

module.exports = {
  getPaymentPageUrl,
  buildPaymentMessage,
  verifyWebhookSignature,
};
