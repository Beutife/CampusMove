// ─────────────────────────────────────────────
// MESSAGING UTILITY — BAILEYS ONLY
// ─────────────────────────────────────────────

/**
 * Send WhatsApp message via Baileys (the same socket that listens)
 * @param {string} phone - Phone number (with or without +)
 * @param {string} body - Message text
 */
async function sendMsg(phone, body) {
    // Normalize phone: strip +, add @s.whatsapp.net
    const clean = String(phone).replace(/^\+/, '').replace(/^whatsapp:\+?/, '');
    const jid = `${clean}@s.whatsapp.net`;
  
    try {
      // Guard: ensure sock is connected
      if (!sock || sock.ws?.readyState !== 1) {
        console.error(`❌ sendMsg: WhatsApp socket not connected (state: ${sock?.ws?.readyState})`);
        throw new Error('WhatsApp socket disconnected');
      }
  
      // Send message
      await sock.sendMessage(jid, { text: body });
      console.log(`✅ Sent to ${phone}: "${body.substring(0, 50)}..."`);
      return jid;
  
    } catch (err) {
      console.error(`❌ Failed to send to ${phone}:`, err.message);
      throw err;
    }
  }
  
  module.exports = { sendMsg };