// Fixed exchange rate: 500 ₦ = 1 XLM
const RATE = 500;

function ngnToXlm(ngnAmount) {
  // Convert ₦ to XLM and return as string with 7 decimals
  const xlmAmount = ngnAmount / RATE;
  return xlmAmount.toFixed(7);
}

function xlmToNgn(xlmAmount) {
  // Convert XLM back to ₦ for display/receipts
  const ngnAmount = xlmAmount * RATE;
  return Math.round(ngnAmount);
}

function logConversion(ngn, xlm) {
  console.log(`💱 ₦${ngn} → ${xlm} XLM`);
}

module.exports = { ngnToXlm, xlmToNgn, logConversion, RATE };
