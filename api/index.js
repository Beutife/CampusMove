/**
 * CampusMove WhatsApp Bot — FIXED VERSION
 *
 * Changes from original:
 * ✅ sendMsg() now uses Baileys (not broken Twilio)
 * ✅ Removed unused /whatsapp POST endpoint (Twilio webhook)
 * ✅ Removed Twilio imports & references
 * ✅ Consistent messaging: Baileys in + Baileys out
 */

const fs   = require('fs');
const path = require('path');
const express = require('express');
const admin   = require('firebase-admin');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const { buildPaymentMessage, verifyWebhookSignature } = require('../utils/paymentHandler');
const { storeReceipt } = require('../utils/verificationService');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ─────────────────────────────────────────────
// FIREBASE INIT
// ─────────────────────────────────────────────
function normalizePrivateKey(key) {
  if (!key) return key;
  if (key.includes('-----BEGIN PRIVATE KEY-----\n')) return key;
  return key.replace(/\\n/g, '\n');
}

function getFirebaseCredential() {
  const p = path.join(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(p)) {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data && data.project_id) return admin.credential.cert(data);
  }
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error('Missing Firebase credentials.');
  }
  return admin.credential.cert({
    projectId:   FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey:  normalizePrivateKey(FIREBASE_PRIVATE_KEY),
  });
}

if (!admin.apps.length) {
  admin.initializeApp({ credential: getFirebaseCredential() });
}
const db = admin.firestore();

// ─────────────────────────────────────────────
// EXPRESS SETUP
// ─────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: false }));

// Paystack raw body BEFORE json middleware
app.post('/api/paystack/webhook',
  express.raw({ type: 'application/json' }),
  handlePaystackWebhook
);

app.use(express.json());

app.get('/', (_req, res) => res.json({
  status: 'ok',
  service: 'CampusMove Bot',
  version: '2.0.0',
}));

// ─────────────────────────────────────────────
// BAILEYS SETUP
// ─────────────────────────────────────────────
let sock; // global WhatsApp socket — set when startWhatsApp() connects

async function startWhatsApp() {
  const authDir = path.join(__dirname, '..', '.wa_auth');
  fs.mkdirSync(authDir, { recursive: true });
 
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
 
  // Fetch the latest WA version — required for Baileys v7+
  const { version } = await fetchLatestBaileysVersion();
 
  console.log(`📱 Baileys starting with WA v${version.join('.')}`);
 
  sock = makeWASocket({
    version,
    auth:  state,
    // Do NOT use printQRInTerminal — we render it ourselves below for reliability
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    // Use Baileys v7 standard browser fingerprint — fixes 405 Connection Failure
    browser: Browsers.appropriate('Chrome'),
    // Prevent premature disconnects
    connectTimeoutMs:    60_000,
    keepAliveIntervalMs: 25_000,
    retryRequestDelayMs: 2_000,
    maxMsgRetryCount: 5,
  });
 
  sock.ev.on('creds.update', saveCreds);
 
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    // QR code received — render it ourselves using qrcode-terminal
    if (qr) {
      console.log('\n📱 ══════════════════════════════════════════════');
      console.log('    SCAN THIS QR CODE IN WHATSAPP NOW');
      console.log('    WhatsApp → Settings → Linked Devices');
      console.log('    → Link a Device → scan the code below');
      console.log('════════════════════════════════════════════════\n');
      qrcode.generate(qr, { small: true });
      console.log('\n════════════════════════════════════════════════');
      console.log('    ☝️  Scan the QR above within 60 seconds');
      console.log('════════════════════════════════════════════════\n');
    }
 
    if (connection === 'open') {
      console.log('\n✅ ══════════════════════════════════');
      console.log('   WHATSAPP CONNECTED!');
      console.log('   CampusMove bot is LIVE 🚗');
      console.log('══════════════════════════════════\n');
    }
 
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason     = lastDisconnect?.error?.message || 'unknown';
 
      console.log(`❌ WA closed — code: ${statusCode}, reason: ${reason}`);
 
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('🔴 LOGGED OUT. Delete .wa_auth folder and restart to re-scan QR.');
        return; // don't reconnect
      }
 
      if (statusCode === 515 || statusCode === 405) {
        // Stream/connection error — clear bad auth and restart fresh
        console.log(`⚠️  Error ${statusCode} — clearing auth and restarting in 8s...`);
        try {
          fs.rmSync(authDir, { recursive: true, force: true });
          fs.mkdirSync(authDir, { recursive: true });
        } catch (e) {}
        setTimeout(startWhatsApp, 8000);
        return;
      }

      // Any other disconnect — reconnect after delay
      const delay = statusCode === 408 ? 10000 : 5000;
      console.log(`🔄 Reconnecting in ${delay/1000}s...`);
      setTimeout(startWhatsApp, delay);
    }
  });
 
  // ── INCOMING MESSAGE LISTENER ──────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;   // ignore messages the bot sent
      if (!msg.message)   continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us')) continue; // skip group chats

      const phone = jid.split('@')[0]; // bare number, no + prefix
      const body  = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ''
      ).trim();

      if (!body) continue;
      console.log(`📨 [${phone}]: ${body}`);

      try {
        await handleIncoming(phone, body);
      } catch (err) {
        console.error('❌ Message error:', err);
        await sendMsg(phone, '❌ Something went wrong.\n\nType *MENU* to restart.').catch(() => {});
      }
    }
  });
}

// ─────────────────────────────────────────────
// PHONE HELPERS
// ─────────────────────────────────────────────
function stripPlus(phone = '') {
  return String(phone).replace(/^\+/, '').replace(/^whatsapp:\+?/, '');
}

// ─────────────────────────────────────────────
// APPROVED DRIVER WHITELIST
// ─────────────────────────────────────────────
function getApprovedDrivers() {
  const raw = process.env.APPROVED_DRIVER_PHONES || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function isApprovedDriver(phone) {
  const list = getApprovedDrivers();
  if (list.length === 0) return true;
  return list.includes(stripPlus(phone));
}

function isAdmin(phone) {
  const list = (process.env.ADMIN_PHONES || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(stripPlus(phone));
}

// ─────────────────────────────────────────────
// FIRESTORE SESSION LAYER
// ─────────────────────────────────────────────
async function getSession(phone) {
  const clean = stripPlus(phone);
  const doc = await db.collection('sessions').doc(clean).get();
  if (doc.exists) return doc.data();
  return { phone: clean, state: 'HOME', tempData: {} };
}

async function saveSession(phone, session) {
  const clean = stripPlus(phone);
  session.phone = clean;
  session.updatedAt = Date.now();
  await db.collection('sessions').doc(clean).set(session);
}

async function clearSession(phone) {
  const clean = stripPlus(phone);
  await db.collection('sessions').doc(clean).set({
    phone: clean,
    state: 'HOME',
    tempData: {},
    updatedAt: Date.now(),
  });
}

// ─────────────────────────────────────────────
// MESSAGING UTILITY — BAILEYS ONLY (FIXED)
// ─────────────────────────────────────────────
/**
 * Send WhatsApp message via Baileys socket
 * @param {string} phone - Phone number (with or without +)
 * @param {string} body - Message text
 * @returns {Promise<string>} JID of message
 */
async function sendMsg(phone, body) {
  const clean = stripPlus(phone);
  const jid = `${clean}@s.whatsapp.net`;

  try {
    // Guard: ensure sock is connected
    if (!sock || sock.ws?.readyState !== 1) {
      console.error(`❌ sendMsg: WhatsApp socket not connected`);
      throw new Error('WhatsApp socket disconnected');
    }

    // Send message via Baileys
    await sock.sendMessage(jid, { text: body });
    console.log(`✅ Sent to ${phone}`);
    return jid;

  } catch (err) {
    console.error(`❌ Failed to send to ${phone}:`, err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────
// MAIN MESSAGE HANDLER
// ─────────────────────────────────────────────
async function handleIncoming(phone, input) {
  try {
    // ── Admin override ──────────────────────────
    if (isAdmin(phone) && input.startsWith('ADMIN:')) {
      await handleAdminCommand(phone, input.slice(6).trim());
      return;
    }

    // ── Universal driver commands ───────────────
    const upper = input.toUpperCase();

    if (upper.startsWith('CLOSE ')) {
      await handleDriverClose(phone, input.slice(6).trim());
      return;
    }
    if (upper.startsWith('CANCEL_BOOKING ')) {
      await handleDriverCancelBooking(phone, input.slice(15).trim());
      return;
    }

    // ── State machine ───────────────────────────
    const session = await getSession(phone);

    if (upper === 'MENU' || upper === 'HI' || upper === 'START' || upper === 'HELLO') {
      await clearSession(phone);
      await sendMsg(phone, showMainMenu());
      const s = await getSession(phone);
      s.state = 'MENU_CHOICE';
      await saveSession(phone, s);
      return;
    }

    let reply = '';

    if (session.state === 'HOME' || session.state === 'MENU_CHOICE') {
      reply = await handleMenuChoice(phone, input, session);
    } else {
      reply = await handleState(phone, input, session);
    }

    if (reply) await sendMsg(phone, reply).catch(err => {
      console.error(`Failed to send reply to ${phone}:`, err.message);
    });

  } catch (err) {
    console.error('❌ Handler error:', err);
    await sendMsg(phone, '❌ Something went wrong.\n\nType *MENU* to restart.').catch(() => {});
  }
}

// ─────────────────────────────────────────────
// ADMIN COMMANDS
// ─────────────────────────────────────────────
async function handleAdminCommand(adminPhone, cmd) {
  const parts = cmd.split(' ');
  const action = (parts[0] || '').toUpperCase();

  if (action === 'MSG' && parts.length >= 3) {
    const target = parts[1];
    const text   = parts.slice(2).join(' ');
    await sendMsg(target, `[CampusMove Admin]\n${text}`).catch(() => {});
    await sendMsg(adminPhone, `✅ Message sent to ${target}`).catch(() => {});

  } else if (action === 'STATUS' && parts[1]) {
    const snap = await db.collection('bookings').doc(parts[1]).get();
    if (!snap.exists) {
      await sendMsg(adminPhone, 'Booking not found.').catch(() => {});
      return;
    }
    const b = snap.data();
    await sendMsg(adminPhone, `📋 Booking ${parts[1]}\nStatus: ${b.status}\nPhone: ${b.phone}\nRoute: ${b.from} → ${b.to}\nCost: ₦${b.total_cost}`).catch(() => {});

  } else if (action === 'RESET' && parts[1]) {
    await clearSession(parts[1]);
    await sendMsg(adminPhone, `✅ Session reset for ${parts[1]}`).catch(() => {});

  } else if (action === 'REFUND' && parts[1]) {
    await db.collection('bookings').doc(parts[1]).update({ status: 'refunded', refunded_at: Date.now() });
    const snap = await db.collection('bookings').doc(parts[1]).get();
    const phone = snap.data()?.phone;
    if (phone) await sendMsg(phone, `✅ Your booking ${parts[1]} has been refunded.\n\nType MENU to book another ride.`).catch(() => {});
    await sendMsg(adminPhone, `✅ Refund issued for ${parts[1]}`).catch(() => {});

  } else {
    await sendMsg(adminPhone, `Admin commands:\nADMIN: MSG <phone> <text>\nADMIN: STATUS <bookingId>\nADMIN: RESET <phone>\nADMIN: REFUND <bookingId>`).catch(() => {});
  }
}

// ─────────────────────────────────────────────
// MAIN MENU
// ─────────────────────────────────────────────
function showMainMenu() {
  return `👋 Welcome to *CampusMove!* 🚗

Your campus transport, sorted.

1️⃣  Find a ride
2️⃣  Offer a ride (drivers)
3️⃣  My bookings
4️⃣  Pending requests (drivers)
5️⃣  Rate a ride
6️⃣  My profile
7️⃣  Help

_Reply with 1–7_`.trim();
}

async function handleMenuChoice(phone, choice, session) {
  const c = choice.trim();

  if (c === '1') {
    session.state = 'FIND_RIDE_FROM';
    session.tempData = {};
    await saveSession(phone, session);
    return `📍 *Find a Ride*\n\nWhere are you leaving from?\n\nType your pickup location\n_(e.g. Main Gate, Oduduwa Hall, Fajuyi Hall)_`;
  }

  if (c === '2') {
    if (!isApprovedDriver(phone)) {
      return `🚗 *Driver Registration*\n\nYour number is not yet approved as a driver.\n\nContact Campus Move to get verified:\n📞 ${process.env.SUPPORT_PHONE || 'our support line'}\n\nType MENU to go back.`;
    }
    session.tempData = {};
    session.state = 'OFFER_RIDE_CHECK';
    await saveSession(phone, session);
    return `🚗 *Offer a Ride*\n\nAre you already registered?\n\nA) Yes — take me straight to posting a ride\nB) No — register me first\n\n_Reply A or B_`;
  }

  if (c === '3') {
    session.state = 'MENU_CHOICE';
    await saveSession(phone, session);
    return await showMyBookings(phone);
  }

  if (c === '4') {
    return await showPendingRequests(phone, session);
  }

  if (c === '5') {
    return await showRidesToRate(phone, session);
  }

  if (c === '6') {
    session.state = 'MENU_CHOICE';
    await saveSession(phone, session);
    return await showProfile(phone);
  }

  if (c === '7') {
    session.state = 'MENU_CHOICE';
    await saveSession(phone, session);
    return showHelp();
  }

  return `Please reply with a number 1–7.\n\n${showMainMenu()}`;
}

// ─────────────────────────────────────────────
// STATE MACHINE — FIND RIDE FLOW
// ─────────────────────────────────────────────
async function handleState(phone, input, session) {
  const state = session.state;
  const inp   = input.trim();

  if (state === 'FIND_RIDE_FROM') {
    session.tempData.from = inp;
    session.state = 'FIND_RIDE_TO';
    await saveSession(phone, session);
    return `✅ From: *${inp}*\n\n📍 Where are you going?\n_(e.g. Fajuyi Hall, Moremi Hall, OAU Teaching Hospital)_`;
  }

  if (state === 'FIND_RIDE_TO') {
    session.tempData.to = inp;
    session.state = 'FIND_RIDE_WHEN';
    await saveSession(phone, session);
    return `✅ To: *${inp}*\n\n⏰ When do you want to leave?\n\n1️⃣ Now\n2️⃣ Today (later)\n3️⃣ Tomorrow\n4️⃣ This week\n\n_Reply 1–4_`;
  }

  if (state === 'FIND_RIDE_WHEN') {
    const timeMap = { '1':'now','now':'now','2':'today','today':'today','3':'tomorrow','tomorrow':'tomorrow','4':'thisweek','this week':'thisweek' };
    const when = timeMap[inp.toLowerCase()] || 'today';
    session.tempData.when = when;

    const rides = await searchRides(session.tempData.from, session.tempData.to, when);

    if (rides.length === 0) {
      session.state = 'HOME';
      await saveSession(phone, session);
      return `😔 *No rides found*\n\n${session.tempData.from} → ${session.tempData.to}\n\nTry a different location or time.\nType MENU to search again.`;
    }

    let msg = `🚗 *Available Rides* (${rides.length} found)\n\n`;
    rides.forEach((r, i) => {
      msg += `*${i+1}. ${r.provider_name || r.driver_name}*\n`;
      msg += `   🚐 ${r.vehicle_type || 'Car'}  |  🪑 ${r.seats_available} seats\n`;
      msg += `   💰 ₦${r.cost_per_seat}/seat  |  ⏰ ${r.departure_time}\n`;
      msg += `   ${r.from} → ${r.to}\n\n`;
    });
    msg += `_Reply with number to book_`;

    session.tempData.searchResults = rides;
    session.state = 'FIND_RIDE_SELECT';
    await saveSession(phone, session);
    return msg;
  }

  if (state === 'FIND_RIDE_SELECT') {
    const idx = parseInt(inp) - 1;
    const rides = session.tempData.searchResults || [];
    if (isNaN(idx) || idx < 0 || idx >= rides.length) {
      return `Please reply 1–${rides.length}`;
    }
    session.tempData.selectedRide = rides[idx];
    session.state = 'BOOK_RIDE_SEATS';
    await saveSession(phone, session);
    const r = rides[idx];
    return `✅ *${r.provider_name || r.driver_name}*\n${r.from} → ${r.to}\n⏰ ${r.departure_time}\n💰 ₦${r.cost_per_seat}/seat\n\n🪑 How many seats do you need?\n_(Reply: 1, 2, 3…)_`;
  }

  if (state === 'BOOK_RIDE_SEATS') {
    const seats = parseInt(inp);
    if (isNaN(seats) || seats < 1) return 'Please reply with a valid number (1, 2, 3…)';
    const ride = session.tempData.selectedRide;
    if (seats > (ride.seats_available || 0)) return `❌ Only ${ride.seats_available} seat(s) available.`;
    session.tempData.seats     = seats;
    session.tempData.totalCost = ride.cost_per_seat * seats;
    session.state = 'CONFIRM_BOOKING';
    await saveSession(phone, session);
    return `📊 *Booking Summary*\n\nFrom: ${ride.from}\nTo: ${ride.to}\nProvider: ${ride.provider_name || ride.driver_name}\nSeats: ${seats}\nTotal: ₦${session.tempData.totalCost}\n\nConfirm?\nA) Yes, book it\nB) Cancel\n\n_Reply A or B_`;
  }

  if (state === 'CONFIRM_BOOKING') {
    const yes = ['a','yes'].includes(inp.toLowerCase());
    const no  = ['b','no','cancel'].includes(inp.toLowerCase());
    if (!yes && !no) return 'Please reply A or B.';
    if (no) { await clearSession(phone); return 'Booking cancelled.\n\nType MENU to start over.'; }

    const booking = await createBooking(phone, session.tempData);
    session.state = 'WAITING_DRIVER_ACCEPT';
    session.tempData.bookingId = booking.id;
    session.tempData.requestedAt = Date.now();
    await saveSession(phone, session);

    const driverPhone = session.tempData.selectedRide.driver_phone;
    await notifyDriver(driverPhone, booking, session.tempData.selectedRide);

    scheduleBookingTimeout(booking.id, phone, driverPhone);

    return `⏳ *Request Sent!*\n\nBooking ID: \`${booking.id}\`\n\nWaiting for *${session.tempData.selectedRide.provider_name || session.tempData.selectedRide.driver_name}* to confirm.\n\n⏱️ They have 5 minutes to accept.\nWe'll notify you immediately.\n\nType MENU to cancel and search for another ride.`;
  }

  if (state === 'WAITING_DRIVER_ACCEPT') {
    const bookingId = session.tempData.bookingId;
    const snap = await db.collection('bookings').doc(bookingId).get();
    if (!snap.exists) { await clearSession(phone); return 'Booking not found. Type MENU to start over.'; }
    const bk = snap.data();

    if (bk.status === 'accepted') {
      session.state = 'SHOW_PAYMENT';
      await saveSession(phone, session);
      return `✅ *Driver Accepted!*\n\n${buildPaymentMessage(bookingId, session.tempData.totalCost)}`;
    }
    if (bk.status === 'rejected') {
      await clearSession(phone);
      return `❌ *Driver declined your request.*\n\nType MENU to find another ride.`;
    }
    if (bk.status === 'expired') {
      await clearSession(phone);
      return `⌛ *Request timed out.*\n\nNo response from the driver.\n\nType MENU to search again — we'll find you another ride.`;
    }
    if (inp.toLowerCase() === 'cancel') {
      await db.collection('bookings').doc(bookingId).update({ status: 'cancelled_by_student', cancelled_at: Date.now() });
      const driverPhone = session.tempData.selectedRide?.driver_phone;
      if (driverPhone) await sendMsg(driverPhone, `ℹ️ The student cancelled booking *${bookingId}* before you responded.`).catch(() => {});
      await clearSession(phone);
      return 'Booking cancelled.\n\nType MENU to search again.';
    }
    return `⏳ Still waiting for driver confirmation…\n\nBooking ID: \`${bookingId}\`\n\nType *CANCEL* to cancel this request, or *MENU* to search for a different ride.`;
  }

  if (state === 'SHOW_PAYMENT') {
    if (inp.toLowerCase() === 'paid') {
      return `✅ Payment noted!\n\nWe're verifying with Paystack. You'll get a confirmation shortly.\n\nIf you haven't paid yet:\n${buildPaymentMessage(session.tempData.bookingId, session.tempData.totalCost)}`;
    }
    return buildPaymentMessage(session.tempData.bookingId, session.tempData.totalCost);
  }

  if (state === 'WAITING_FOR_RIDE') {
    const lower = inp.toLowerCase();
    if (lower === 'arrived' || lower === 'yes') {
      const bookingId = session.tempData.bookingId;
      await db.collection('bookings').doc(bookingId).update({ status: 'completed', completed_at: Date.now() });
      session.state = 'RATE_RIDE_LIST';
      session.tempData.rateBookingId = bookingId;
      await saveSession(phone, session);
      return `🎉 *Ride completed!*\n\nHow was your experience?\n\n1️⃣ ⭐ Poor\n2️⃣ ⭐⭐ Fair\n3️⃣ ⭐⭐⭐ Good\n4️⃣ ⭐⭐⭐⭐ Great\n5️⃣ ⭐⭐⭐⭐⭐ Excellent\n\n_Reply 1–5_`;
    }
    if (lower === 'no' || lower === 'problem' || lower === 'issue') {
      session.state = 'REPORT_ISSUE';
      await saveSession(phone, session);
      return `😟 *Report an Issue*\n\nPlease describe what happened:\n_(e.g. "Driver didn't show up", "Wrong route", "Safety concern")_`;
    }
    return `Your ride is confirmed and paid for! 🚗\n\nWhen your ride is done, reply:\n✅ *ARRIVED* — to confirm completion\n❌ *PROBLEM* — to report an issue`;
  }

  if (state === 'REPORT_ISSUE') {
    const bookingId = session.tempData.bookingId || 'unknown';
    await db.collection('issues').add({
      phone,
      bookingId,
      issue: inp,
      reported_at: Date.now(),
      status: 'open',
    });
    const adminPhones = (process.env.ADMIN_PHONES || '').split(',').filter(Boolean);
    for (const ap of adminPhones) {
      await sendMsg(ap, `🚨 *Issue Report*\nBooking: ${bookingId}\nFrom: +${phone}\nIssue: ${inp}`).catch(() => {});
    }
    await clearSession(phone);
    return `✅ Issue reported. Our team will contact you within 30 minutes.\n\nBooking ID: \`${bookingId}\`\n\nType MENU to continue.`;
  }

  // ════ OFFER A RIDE — DRIVER FLOW ════
  if (state === 'OFFER_RIDE_CHECK') {
    const isYes = ['a','yes'].includes(inp.toLowerCase());
    if (isYes) {
      const userDoc = await db.collection('drivers').doc(stripPlus(phone)).get();
      if (userDoc.exists) {
        const driver = userDoc.data();
        session.tempData.driver_name   = driver.name;
        session.tempData.provider_id   = driver.provider_id;
        session.tempData.provider_name = driver.provider_name;
        session.tempData.vehicle_type  = driver.vehicle_type;
        session.state = 'OFFER_RIDE_FROM';
        await saveSession(phone, session);
        return `✅ Welcome back, *${driver.name}!*\n(${driver.provider_name || 'Independent Driver'})\n\n📍 Where are you starting from?`;
      }
    }
    session.state = 'OFFER_RIDE_REGISTER_NAME';
    await saveSession(phone, session);
    return `📋 *Driver Registration*\n\nWhat's your full name? _(passengers will see this)_`;
  }

  if (state === 'OFFER_RIDE_REGISTER_NAME') {
    if (inp.length < 2) return 'Please enter a valid name (at least 2 characters).';
    session.tempData.driver_name = inp;
    session.state = 'OFFER_RIDE_REGISTER_VEHICLE';
    await saveSession(phone, session);
    return `👋 Hi, *${inp}!*\n\nWhat type of vehicle do you drive?\n\n1️⃣ Car (sedan/saloon)\n2️⃣ Bus / Minibus\n3️⃣ Tricycle (Keke)\n4️⃣ Motorcycle (Okada)\n\n_Reply 1–4_`;
  }

  if (state === 'OFFER_RIDE_REGISTER_VEHICLE') {
    const vMap = { '1':'Car','2':'Bus','3':'Tricycle','4':'Motorcycle' };
    const vehicle = vMap[inp];
    if (!vehicle) return 'Please reply with 1, 2, 3, or 4.';
    session.tempData.vehicle_type = vehicle;
    session.state = 'OFFER_RIDE_REGISTER_PROVIDER';
    await saveSession(phone, session);

    const snap = await db.collection('providers').where('active', '==', true).get();
    let msg = `🏢 *Which company do you drive for?*\n\n`;
    const providers = [];
    snap.forEach((doc, i) => {
      providers.push({ id: doc.id, ...doc.data() });
      msg += `${providers.length}. ${doc.data().name}\n`;
    });
    msg += `${providers.length + 1}. Independent (no company)\n\n_Reply with a number_`;
    session.tempData._providersList = providers;
    await saveSession(phone, session);
    return msg;
  }

  if (state === 'OFFER_RIDE_REGISTER_PROVIDER') {
    const providers = session.tempData._providersList || [];
    const idx = parseInt(inp) - 1;
    if (isNaN(idx) || idx < 0 || idx > providers.length) return `Please reply 1–${providers.length + 1}`;

    if (idx === providers.length) {
      session.tempData.provider_id   = null;
      session.tempData.provider_name = 'Independent';
    } else {
      session.tempData.provider_id   = providers[idx].id;
      session.tempData.provider_name = providers[idx].name;
    }

    await db.collection('drivers').doc(stripPlus(phone)).set({
      phone:         stripPlus(phone),
      name:          session.tempData.driver_name,
      vehicle_type:  session.tempData.vehicle_type,
      provider_id:   session.tempData.provider_id,
      provider_name: session.tempData.provider_name,
      registered_at: Date.now(),
      rating:        5.0,
      total_rides:   0,
      verified:      false,
    }, { merge: true });

    session.state = 'OFFER_RIDE_FROM';
    delete session.tempData._providersList;
    await saveSession(phone, session);
    return `✅ Registered as *${session.tempData.driver_name}* (${session.tempData.provider_name})\n\n📍 Where are you starting from?`;
  }

  if (state === 'OFFER_RIDE_FROM') {
    if (inp.length < 2) return 'Please enter a valid pickup location.';
    session.tempData.from = inp;
    session.state = 'OFFER_RIDE_TO';
    await saveSession(phone, session);
    return `✅ From: *${inp}*\n\n📍 Where are you going to?`;
  }

  if (state === 'OFFER_RIDE_TO') {
    if (inp.length < 2) return 'Please enter a valid destination.';
    session.tempData.to = inp;
    session.state = 'OFFER_RIDE_WHEN';
    await saveSession(phone, session);
    return `✅ To: *${inp}*\n\n⏰ Departure time?\n\n1️⃣ Now\n2️⃣ Today (later)\n3️⃣ Tomorrow\n4️⃣ This week\n\n_Reply 1–4_`;
  }

  if (state === 'OFFER_RIDE_WHEN') {
    const tMap = { '1':'Now','2':'Today','3':'Tomorrow','4':'This week','now':'Now','today':'Today','tomorrow':'Tomorrow','thisweek':'This week','this week':'This week' };
    const dep = tMap[inp.toLowerCase()];
    if (!dep) return 'Please reply 1, 2, 3, or 4.';
    session.tempData.departure_time = dep;
    session.state = 'OFFER_RIDE_SEATS';
    await saveSession(phone, session);
    return `⏰ Departure: *${dep}*\n\n🪑 How many seats available?\n_(Reply with a number)_`;
  }

  if (state === 'OFFER_RIDE_SEATS') {
    const seats = parseInt(inp);
    if (isNaN(seats) || seats < 1) return 'Please reply with a valid number.';
    session.tempData.seats = seats;
    session.state = 'OFFER_RIDE_COST';
    await saveSession(phone, session);
    return `🪑 Seats: *${seats}*\n\n💰 Cost per seat (₦)?\n_(e.g. 100, 200, 300)_`;
  }

  if (state === 'OFFER_RIDE_COST') {
    const cost = parseFloat(inp.replace(/[₦,]/g, ''));
    if (isNaN(cost) || cost <= 0) return 'Please enter a valid amount (e.g. 200)';
    session.tempData.cost_per_seat = cost;
    session.state = 'OFFER_RIDE_CONFIRM';
    await saveSession(phone, session);
    const d = session.tempData;
    return `🚗 *Confirm Ride Offer*\n\nDriver: ${d.driver_name} (${d.provider_name || 'Independent'})\nVehicle: ${d.vehicle_type}\nRoute: ${d.from} → ${d.to}\nDeparts: ${d.departure_time}\nSeats: ${d.seats}\nCost/seat: ₦${d.cost_per_seat}\n\nA) Confirm ✅\nB) Cancel ❌\n\n_Reply A or B_`;
  }

  if (state === 'OFFER_RIDE_CONFIRM') {
    const yes = ['a','yes','confirm'].includes(inp.toLowerCase());
    const no  = ['b','no','cancel'].includes(inp.toLowerCase());
    if (!yes && !no) return 'Please reply A or B.';
    if (no) { await clearSession(phone); return 'Ride offer cancelled.\n\nType MENU to continue.'; }

    const d = session.tempData;
    const ride = {
      driver_name:     d.driver_name,
      driver_phone:    stripPlus(phone),
      provider_id:     d.provider_id   || null,
      provider_name:   d.provider_name || 'Independent',
      vehicle_type:    d.vehicle_type  || 'Car',
      from:            d.from,
      to:              d.to,
      departure_time:  d.departure_time,
      seats_available: d.seats,
      cost_per_seat:   d.cost_per_seat,
      status:          'available',
      created_at:      Date.now(),
    };

    const ref = await db.collection('rides').add(ride);
    await clearSession(phone);

    await db.collection('drivers').doc(stripPlus(phone)).update({
      total_rides: admin.firestore.FieldValue.increment(1),
    }).catch(() => {});

    return `✅ *Ride Posted!*\n\nRide ID: \`${ref.id}\`\n${ride.from} → ${ride.to}\nDeparts: ${ride.departure_time}\n\nStudents can now book your ride!\n\nType MENU for more options.`;
  }

  // ════ PENDING REQUESTS — DRIVER ════
  if (state === 'PENDING_REQUESTS_VIEW') {
    const idx = parseInt(inp) - 1;
    const bookings = session.tempData.pendingBookings || [];
    if (isNaN(idx) || idx < 0 || idx >= bookings.length) return `Please reply 1–${bookings.length}`;

    const selected = bookings[idx];
    session.tempData.currentBooking = selected;
    session.state = 'ACCEPT_REJECT_BOOKING';
    await saveSession(phone, session);

    return `🔔 *Request Details*\n\nPassenger: +${selected.phone.slice(-10)}\nFrom: ${selected.from}\nTo: ${selected.to}\nSeats: ${selected.seats}\nTotal: ₦${selected.total_cost}\n\nA) ✅ Accept\nB) ❌ Reject\n\n_Reply A or B_`;
  }

  if (state === 'ACCEPT_REJECT_BOOKING') {
    const accept = ['a','accept','yes'].includes(inp.toLowerCase());
    const reject = ['b','reject','no'].includes(inp.toLowerCase());
    if (!accept && !reject) return 'Please reply A or B.';

    const booking    = session.tempData.currentBooking;
    const bookingId  = booking.id;
    const passengerPhone = booking.phone;
    const driverName = session.tempData.driver_name || 'Your driver';

    if (accept) {
      await db.collection('bookings').doc(bookingId).update({
        status: 'accepted',
        accepted_at: Date.now(),
        driver_name: driverName,
      });

      const passengerSession = await getSession(passengerPhone);
      if (passengerSession.state === 'WAITING_DRIVER_ACCEPT') {
        passengerSession.state = 'SHOW_PAYMENT';
        await saveSession(passengerPhone, passengerSession);
      }

      await sendMsg(passengerPhone, `✅ *Driver Accepted Your Request!*\n\nDriver: *${driverName}*\nBooking: \`${bookingId}\`\n\n${buildPaymentMessage(bookingId, booking.total_cost)}`).catch(() => {});

      await clearSession(phone);
      return `✅ *Booking Accepted*\n\nPassenger has been sent the payment link.\n\nYou'll be notified when they pay.\n\nType MENU for more.`;
    }

    if (reject) {
      await db.collection('bookings').doc(bookingId).update({
        status: 'rejected',
        rejected_at: Date.now(),
      });
      await sendMsg(passengerPhone, `❌ *Request Declined*\n\nSorry — ${driverName} couldn't accept your ride.\n\nType MENU to search for another ride.`).catch(() => {});
      await clearSession(phone);
      return `✅ *Booking Rejected*\n\nPassenger has been notified.\n\nType MENU for more.`;
    }
  }

  // ════ RATE RIDE ════
  if (state === 'RATE_RIDE_LIST') {
    const rating = parseInt(inp);
    if (![1,2,3,4,5].includes(rating)) return 'Please reply 1, 2, 3, 4, or 5.';

    const bookingId = session.tempData.rateBookingId;
    await db.collection('bookings').doc(bookingId).update({
      rider_rating: rating,
      rated_at:     Date.now(),
      status:       'completed',
    });

    const bSnap = await db.collection('bookings').doc(bookingId).get();
    const dPhone = bSnap.data()?.driver_phone;
    if (dPhone) await updateDriverRating(dPhone, rating);

    await clearSession(phone);
    return `🙏 *Thanks for rating!*\n\nYour feedback helps keep Campus Move reliable.\n\nType MENU to continue.`;
  }

  await clearSession(phone);
  return `Something went wrong. Type *MENU* to restart.`;
}

// ─────────────────────────────────────────────
// DRIVER COMMANDS
// ─────────────────────────────────────────────
async function handleDriverClose(phone, bookingId) {
  const snap = await db.collection('bookings').doc(bookingId).get();
  if (!snap.exists) {
    await sendMsg(phone, `Booking ${bookingId} not found.`).catch(() => {});
    return;
  }
  const booking = snap.data();

  const driverSnap = await db.collection('drivers').doc(stripPlus(phone)).get();
  const driverName = driverSnap.exists ? driverSnap.data().name : 'Your driver';

  await sendMsg(booking.phone, `🚗 *Driver is nearby!*\n\n*${driverName}* is approaching your pickup point.\n\nPlease make your way outside now.\n\nBooking: \`${bookingId}\``).catch(() => {});
  await sendMsg(phone, `✅ Student notified for booking ${bookingId}`).catch(() => {});
}

async function handleDriverCancelBooking(phone, bookingId) {
  const snap = await db.collection('bookings').doc(bookingId).get();
  if (!snap.exists) {
    await sendMsg(phone, `Booking ${bookingId} not found.`).catch(() => {});
    return;
  }

  const booking = snap.data();
  if (!['accepted','confirmed'].includes(booking.status)) {
    await sendMsg(phone, `Cannot cancel — booking status is "${booking.status}".`).catch(() => {});
    return;
  }

  await db.collection('bookings').doc(bookingId).update({
    status: 'cancelled_by_driver',
    cancelled_at: Date.now(),
  });

  await sendMsg(booking.phone, `😔 *Ride Cancelled*\n\nSorry — your driver had to cancel booking \`${bookingId}\`.\n\nIf you were charged, a full refund will be processed within 1 hour.\n\nType MENU to find another ride.`).catch(() => {});

  const adminPhones = (process.env.ADMIN_PHONES || '').split(',').filter(Boolean);
  for (const ap of adminPhones) {
    await sendMsg(ap, `⚠️ Driver Cancellation\nBooking: ${bookingId}\nDriver: +${phone}\nStudent: +${booking.phone}\nStatus was: ${booking.status}`).catch(() => {});
  }

  await sendMsg(phone, `✅ Booking ${bookingId} cancelled. Student has been notified.\n\nType MENU to continue.`).catch(() => {});
}

// ─────────────────────────────────────────────
// BOOKING TIMEOUT
// ─────────────────────────────────────────────
function scheduleBookingTimeout(bookingId, studentPhone, driverPhone) {
  const TIMEOUT_MS = 5 * 60 * 1000;

  setTimeout(async () => {
    try {
      const snap = await db.collection('bookings').doc(bookingId).get();
      if (!snap.exists) return;
      const booking = snap.data();

      if (booking.status !== 'pending') return;

      await db.collection('bookings').doc(bookingId).update({
        status: 'expired',
        expired_at: Date.now(),
      });

      await sendMsg(studentPhone, `⌛ *Request timed out*\n\nThe driver didn't respond to booking \`${bookingId}\` in time.\n\nType MENU to find another ride — we have other options for you!`).catch(() => {});
      await sendMsg(driverPhone, `ℹ️ Booking *${bookingId}* expired — student waited 5 minutes with no response.`).catch(() => {});

    } catch (err) {
      console.error('Timeout handler error:', err);
    }
  }, TIMEOUT_MS);
}

// ─────────────────────────────────────────────
// POST-PAYMENT RIDE TRACKING
// ─────────────────────────────────────────────
async function startRideTracking(bookingId, studentPhone) {
  const CHECK_MS = 15 * 60 * 1000;

  setTimeout(async () => {
    try {
      const snap = await db.collection('bookings').doc(bookingId).get();
      if (!snap.exists) return;
      const b = snap.data();
      if (['completed','cancelled_by_driver','refunded'].includes(b.status)) return;

      const session = await getSession(studentPhone);
      if (session.state !== 'HOME' && session.state !== 'MENU_CHOICE') return;

      session.state = 'WAITING_FOR_RIDE';
      session.tempData.bookingId = bookingId;
      await saveSession(studentPhone, session);

      await sendMsg(studentPhone, `👋 *How's your ride going?*\n\nBooking: \`${bookingId}\`\n\nReply:\n✅ *ARRIVED* — ride completed\n❌ *PROBLEM* — something went wrong`).catch(() => {});
    } catch (err) {
      console.error('Ride tracking error:', err);
    }
  }, CHECK_MS);
}

// ─────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────

async function searchRides(from, to, _when) {
  try {
    const snap = await db.collection('rides').where('status', '==', 'available').get();
    const fq   = norm(from);
    const tq   = norm(to);
    const results = [];
    snap.forEach(doc => {
      const r = doc.data();
      if (norm(r.from).includes(fq) && norm(r.to).includes(tq)) {
        results.push({ id: doc.id, ...r });
      }
    });
    return results;
  } catch (e) {
    console.error('Search error:', e);
    return [];
  }
}

function norm(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

async function createBooking(phone, tempData) {
  const booking = {
    phone:       stripPlus(phone),
    ride_id:     tempData.selectedRide?.id    || '',
    driver_phone:tempData.selectedRide?.driver_phone || '',
    seats:       tempData.seats       || 1,
    total_cost:  tempData.totalCost   || 0,
    from:        tempData.from        || '',
    to:          tempData.to          || '',
    status:      'pending',
    created_at:  Date.now(),
  };
  const ref = await db.collection('bookings').add(booking);
  return { id: ref.id, ...booking };
}

async function notifyDriver(driverPhone, booking, ride) {
  const msg = `🔔 *New Ride Request!*\n\nPassenger: +${booking.phone.slice(-10)}\nFrom: ${booking.from}\nTo: ${booking.to}\nSeats: ${booking.seats}\nTotal: ₦${booking.total_cost}\nBooking: \`${booking.id}\`\n\nGo to Menu → *Option 4* to Accept or Reject\n⏱️ You have 5 minutes!`;
  await sendMsg(driverPhone, msg).catch(e => console.error('Driver notify error:', e));
}

async function batchInQuery(collection, field, values, ...conditions) {
  const CHUNK = 10;
  const results = [];
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK);
    let q = db.collection(collection).where(field, 'in', chunk);
    for (const [f, op, v] of conditions) q = q.where(f, op, v);
    const snap = await q.get();
    snap.forEach(doc => results.push({ id: doc.id, ...doc.data() }));
  }
  return results;
}

async function showPendingRequests(phone, session) {
  try {
    const ridesSnap = await db.collection('rides')
      .where('driver_phone', '==', stripPlus(phone)).get();

    const rideIds = ridesSnap.docs.map(d => d.id);
    if (rideIds.length === 0) {
      session.state = 'MENU_CHOICE';
      await saveSession(phone, session);
      return 'You haven\'t posted any rides yet.\n\nType MENU → Option 2 to offer a ride!';
    }

    const pending = await batchInQuery('bookings', 'ride_id', rideIds, ['status', '==', 'pending']);

    if (pending.length === 0) {
      session.state = 'MENU_CHOICE';
      await saveSession(phone, session);
      return 'No pending requests right now. 🎉\n\nType MENU for more options.';
    }

    let msg = `🔔 *Pending Requests* (${pending.length})\n\n`;
    pending.forEach((b, i) => {
      msg += `*${i+1}.* +${b.phone.slice(-10)}\n   ${b.from} → ${b.to} | ${b.seats} seat(s) | ₦${b.total_cost}\n\n`;
    });
    msg += `_Reply with number to review_`;

    const driverSnap = await db.collection('drivers').doc(stripPlus(phone)).get();
    if (driverSnap.exists) session.tempData.driver_name = driverSnap.data().name;

    session.tempData.pendingBookings = pending;
    session.state = 'PENDING_REQUESTS_VIEW';
    await saveSession(phone, session);
    return msg;
  } catch (err) {
    console.error('Pending requests error:', err);
    return 'Error loading requests. Type MENU to continue.';
  }
}

async function showMyBookings(phone) {
  try {
    const snap = await db.collection('bookings')
      .where('phone', '==', stripPlus(phone))
      .orderBy('created_at', 'desc')
      .limit(5).get();

    if (snap.empty) return '📋 No bookings yet.\n\nType MENU → Option 1 to find a ride!';

    let msg = '📋 *Your Recent Bookings*\n\n';
    snap.forEach((doc, i) => {
      const b = doc.data();
      const statusEmoji = { confirmed:'✅', pending:'⏳', rejected:'❌', expired:'⌛', completed:'🏁', cancelled_by_driver:'🔴', cancelled_by_student:'🔴' };
      msg += `*${i+1}.* ${b.from} → ${b.to}\n   ${statusEmoji[b.status] || '❓'} ${b.status.toUpperCase()} | ₦${b.total_cost}\n\n`;
    });
    msg += 'Type MENU to go back.';
    return msg;
  } catch (e) {
    return 'Error loading bookings. Type MENU to continue.';
  }
}

async function showProfile(phone) {
  try {
    const [driverSnap, bookingsSnap] = await Promise.all([
      db.collection('drivers').doc(stripPlus(phone)).get(),
      db.collection('bookings').where('phone', '==', stripPlus(phone)).get(),
    ]);

    let msg = `👤 *Your Profile*\n\n📞 ${phone}\n`;
    msg += `🎫 Rides Booked: ${bookingsSnap.size}\n`;

    if (driverSnap.exists) {
      const d = driverSnap.data();
      msg += `\n🚗 *Driver Account*\n`;
      msg += `Name: ${d.name}\n`;
      msg += `Vehicle: ${d.vehicle_type}\n`;
      msg += `Provider: ${d.provider_name || 'Independent'}\n`;
      msg += `Total Rides: ${d.total_rides || 0}\n`;
      msg += `Rating: ${d.rating ? d.rating.toFixed(1) : 'N/A'} ⭐\n`;
      msg += `Verified: ${d.verified ? '✅' : '⏳ Pending'}\n`;
    }

    msg += `\nType MENU to go back.`;
    return msg;
  } catch (e) {
    return 'Error loading profile. Type MENU to continue.';
  }
}

async function showRidesToRate(phone, session) {
  try {
    const snap = await db.collection('bookings')
      .where('phone', '==', stripPlus(phone))
      .where('status', '==', 'confirmed')
      .orderBy('created_at', 'desc')
      .limit(1).get();

    if (snap.empty) {
      session.state = 'MENU_CHOICE';
      await saveSession(phone, session);
      return '⭐ No rides to rate yet.\n\nType MENU to continue.';
    }

    const doc = snap.docs[0];
    const b   = doc.data();
    session.tempData.rateBookingId = doc.id;
    session.state = 'RATE_RIDE_LIST';
    await saveSession(phone, session);

    return `⭐ *Rate Your Ride*\n\n${b.from} → ${b.to}\n\n1️⃣ ⭐ Poor\n2️⃣ ⭐⭐ Fair\n3️⃣ ⭐⭐⭐ Good\n4️⃣ ⭐⭐⭐⭐ Great\n5️⃣ ⭐⭐⭐⭐⭐ Excellent\n\n_Reply 1–5_`;
  } catch (e) {
    return 'Error loading rides. Type MENU to continue.';
  }
}

async function updateDriverRating(driverPhone, newRating) {
  const ref = db.collection('drivers').doc(stripPlus(driverPhone));
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const d = snap.data();
      const total = (d.total_ratings || 0) + 1;
      const avg   = ((d.rating || 5) * (total - 1) + newRating) / total;
      tx.update(ref, { rating: Math.round(avg * 10) / 10, total_ratings: total });
    });
  } catch (e) {
    console.error('Rating update error:', e);
  }
}

function showHelp() {
  return `❓ *Campus Move Help*

*Students:*
• Menu → 1 to find & book a ride
• Menu → 3 to see your bookings
• Menu → 5 to rate a completed ride

*Drivers:*
• Menu → 2 to post a ride
• Menu → 4 to see pending requests
• Text: \`CLOSE <bookingID>\` when you're approaching pickup
• Text: \`CANCEL_BOOKING <bookingID>\` to cancel an accepted booking

*Payments:*
• Pay via Paystack link after driver accepts
• Refund issues? Contact support below

📞 Support: ${process.env.SUPPORT_PHONE || 'Contact admin'}
⏰ Available 7AM–10PM daily

Type MENU to go back.`.trim();
}

// ─────────────────────────────────────────────
// PAYSTACK WEBHOOK
// ─────────────────────────────────────────────
async function handlePaystackWebhook(req, res) {
  try {
    const sig = req.headers['x-paystack-signature'];
    if (!verifyWebhookSignature(req.body, sig)) {
      return res.sendStatus(401);
    }

    const event = JSON.parse(req.body.toString());

    if (event.event === 'charge.success') {
      const { reference, amount, channel, paid_at } = event.data;
      const amountNaira = amount / 100;

      const snap = await db.collection('bookings').doc(reference).get();
      if (!snap.exists) return res.sendStatus(200);

      const booking = snap.data();

      if (booking.status === 'confirmed') return res.sendStatus(200);

      if (booking.status !== 'accepted') {
        console.warn(`Payment for booking ${reference} but status is ${booking.status}`);
        return res.sendStatus(200);
      }

      const rideSnap = booking.ride_id ? await db.collection('rides').doc(booking.ride_id).get() : null;
      const ride     = rideSnap?.exists ? rideSnap.data() : {};

      await db.collection('bookings').doc(reference).update({
        status:            'confirmed',
        paid_at:           Date.now(),
        payment_method:    channel || 'paystack',
        payment_reference: reference,
        amount_paid:       amountNaira,
      });

      await storeReceipt(reference, reference, amountNaira, event.data).catch(() => {});

      if (booking.ride_id && booking.seats > 0) {
        await db.runTransaction(async tx => {
          const rRef  = db.collection('rides').doc(booking.ride_id);
          const rSnap = await tx.get(rRef);
          if (!rSnap.exists) return;
          const cur = Number(rSnap.data().seats_available || 0);
          const nxt = Math.max(cur - booking.seats, 0);
          tx.update(rRef, {
            seats_available: nxt,
            status: nxt > 0 ? 'available' : 'unavailable',
          });
        });
      }

      const studentPhone = booking.phone;
      await sendMsg(studentPhone, `✅ *Payment Confirmed! ₦${amountNaira}*\n\nBooking: \`${reference}\`\nDriver: ${ride.driver_name || 'Your driver'}\nPickup: ${booking.from}\n\nYour driver has been notified.\n\n💡 Tip: You'll get a check-in message in 15 minutes.`).catch(() => {});

      if (ride.driver_phone) {
        await sendMsg(ride.driver_phone, `💰 *Payment Received!*\n\nStudent paid ₦${amountNaira} for booking \`${reference}\`\n\nPickup: ${booking.from}\nDrop-off: ${booking.to}\nTime: ${ride.departure_time}\n\nWhen approaching pickup, text:\n*CLOSE ${reference}*`).catch(() => {});
      }

      startRideTracking(reference, studentPhone);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Paystack webhook error:', err);
    res.sendStatus(500);
  }
}

// ─────────────────────────────────────────────
// ADMIN HTTP ENDPOINTS
// ─────────────────────────────────────────────
app.post('/api/admin/add-ride', async (req, res) => {
  const { driver_name, driver_phone, provider_id, provider_name, vehicle_type, from, to, departure_time, seats, cost_per_seat } = req.body;
  try {
    const ref = await db.collection('rides').add({
      driver_name,
      driver_phone: stripPlus(driver_phone),
      provider_id:   provider_id   || null,
      provider_name: provider_name || 'Independent',
      vehicle_type:  vehicle_type  || 'Car',
      from, to, departure_time,
      seats_available: Number(seats),
      cost_per_seat:   Number(cost_per_seat),
      status:     'available',
      created_at: Date.now(),
    });
    res.json({ success: true, ride_id: ref.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/add-provider', async (req, res) => {
  const { id, name, type, contact_phone } = req.body;
  try {
    await db.collection('providers').doc(id).set({ name, type, contact_phone, active: true, created_at: Date.now() });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/stats', async (_req, res) => {
  try {
    const [rides, bookings, users, drivers] = await Promise.all([
      db.collection('rides').get(),
      db.collection('bookings').get(),
      db.collection('sessions').get(),
      db.collection('drivers').get(),
    ]);

    const byStatus = {};
    let revenue = 0;
    bookings.forEach(doc => {
      const b = doc.data();
      byStatus[b.status] = (byStatus[b.status] || 0) + 1;
      if (['confirmed','completed'].includes(b.status)) revenue += Number(b.total_cost || 0);
    });

    res.json({
      total_rides:    rides.size,
      total_bookings: bookings.size,
      total_sessions: users.size,
      total_drivers:  drivers.size,
      total_revenue:  revenue,
      bookings_by_status: byStatus,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// START SERVER & BOT
// ─────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  
  // Start bot
  startWhatsApp().catch(err => {
    console.error('❌ Failed to start WhatsApp bot:', err);
    process.exit(1);
  });

  // Start server
  app.listen(PORT, () => {
    console.log(`\n🚗 CampusMove Bot v2.0 running on :${PORT}\n`
      + `   Paystack: POST /api/paystack/webhook\n`
      + `   Stats:    GET  /api/admin/stats\n`
      + `\n   Scan QR above to connect WhatsApp\n`);
  });
}

module.exports = app;