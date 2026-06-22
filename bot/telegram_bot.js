/**
 * ╔════════════════════════════════════════════════════════════════════════════════╗
 * ║                  CAMPUSMOVE V3 — COMPLETE TELEGRAM BOT                        ║
 * ║                       Production-Ready Implementation                          ║
 * ║                                                                                ║
 * ║  MODEL: Demand-Driven (Students post → Drivers accept)                        ║
 * ║  PAYMENTS: Paystack with 10% commission                                       ║
 * ║  DATABASE: Firebase Firestore                                                 ║
 * ║  PLATFORM: Telegram (100% reliable)                                           ║
 * ╚════════════════════════════════════════════════════════════════════════════════╝
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');

const { buildPaymentMessage, verifyWebhookSignature } = require('../utils/paymentHandler');
const { storeReceipt } = require('../utils/verificationService');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ═══════════════════════════════════════════════════════════════════════════════════
// FIREBASE INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════════

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
    throw new Error('Missing Firebase credentials in .env file');
  }
  return admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
  });
}

if (!admin.apps.length) {
  admin.initializeApp({ credential: getFirebaseCredential() });
}
const db = admin.firestore();

// ═══════════════════════════════════════════════════════════════════════════════════
// EXPRESS SETUP
// ═══════════════════════════════════════════════════════════════════════════════════

const app = express();
app.use(express.urlencoded({ extended: false }));

// Paystack webhook (raw body required for signature verification)
app.post('/api/paystack/webhook',
  express.raw({ type: 'application/json' }),
  handlePaystackWebhook
);

app.use(express.json());

app.get('/', (_req, res) => res.json({
  status: 'ok',
  service: 'CampusMove V3',
  version: '3.0.0',
  model: 'Demand-Driven (Students post requests → Drivers accept)',
  features: ['Telegram bot', 'Paystack payments', '10% commission', 'Real-time notifications'],
}));

// ═══════════════════════════════════════════════════════════════════════════════════
// TELEGRAM BOT SETUP
// ═══════════════════════════════════════════════════════════════════════════════════

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) {
  throw new Error('Missing TELEGRAM_BOT_TOKEN in .env file');
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║        🚗 CAMPUSMOVE V3 — Telegram Bot Starting        ║');
console.log('║                  Demand-Driven Model                      ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');
console.log('✅ Firebase Connected');
console.log('✅ Telegram Bot Connected');
console.log(`📱 Bot: t.me/CampusMove_Bot`);
console.log('🚀 Ready to accept requests!\n');

// ═══════════════════════════════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════════

async function getSession(chatId) {
  const doc = await db.collection('telegram_sessions').doc(String(chatId)).get();
  if (doc.exists) return doc.data();
  return { chatId: String(chatId), state: 'HOME', tempData: {} };
}

async function saveSession(chatId, session) {
  session.chatId = String(chatId);
  session.updatedAt = Date.now();
  await db.collection('telegram_sessions').doc(String(chatId)).set(session);
}

async function clearSession(chatId) {
  await db.collection('telegram_sessions').doc(String(chatId)).set({
    chatId: String(chatId),
    state: 'HOME',
    tempData: {},
    updatedAt: Date.now(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════
// MESSAGING
// ═══════════════════════════════════════════════════════════════════════════════════

async function sendMsg(chatId, body) {
  try {
    // Split long messages (Telegram limit: 4096 chars)
    if (body.length > 4096) {
      const chunks = body.match(/[\s\S]{1,4096}/g) || [];
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
        await new Promise(r => setTimeout(r, 100)); // Rate limit
      }
    } else {
      await bot.sendMessage(chatId, body, { parse_mode: 'Markdown' });
    }
    console.log(`✅ Sent to ${chatId}`);
  } catch (err) {
    console.error(`❌ Failed to send to ${chatId}:`, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
// MAIN MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════════

async function handleIncoming(chatId, input, session) {
  try {
    const upper = input.toUpperCase();

    // Menu command
    if (upper === 'MENU' || upper === 'START' || upper === '/START') {
      await clearSession(chatId);
      await sendMsg(chatId, showMainMenu());
      const s = await getSession(chatId);
      s.state = 'MENU_CHOICE';
      await saveSession(chatId, s);
      return;
    }

    let reply = '';

    if (session.state === 'HOME' || session.state === 'MENU_CHOICE') {
      reply = await handleMenuChoice(chatId, input, session);
    } else {
      reply = await handleState(chatId, input, session);
    }

    if (reply) await sendMsg(chatId, reply).catch(err => {
      console.error(`Failed to send reply to ${chatId}:`, err.message);
    });

  } catch (err) {
    console.error('Handler error:', err);
    await sendMsg(chatId, '❌ Something went wrong.\n\nType *MENU* to restart.').catch(() => { });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
// MAIN MENU
// ═══════════════════════════════════════════════════════════════════════════════════

function showMainMenu() {
  return `👋 Welcome to *CampusMove!* 🚗

Your campus transport, sorted.

*STUDENTS:*
1️⃣  Post a ride request
3️⃣  My bookings
5️⃣  Rate a ride
6️⃣  My profile

*DRIVERS:*
2️⃣  Available requests (earn money!)
4️⃣  My earnings
6️⃣  My profile

7️⃣  Help

_Reply with 1–7_`;
}

async function handleMenuChoice(chatId, choice, session) {
  const c = choice.trim();

  // STUDENT: Post a request
  if (c === '1') {
    session.state = 'POST_REQUEST_FROM';
    session.tempData = {};
    await saveSession(chatId, session);
    return `📍 *Post a Ride Request*\n\nWhere are you leaving from?\n_(e.g. Main Gate, Oduduwa Hall, Fajuyi Hall)_`;
  }

  // DRIVER: See available requests
  if (c === '2') {
    return await viewAvailableRequests(chatId, session);
  }

  // STUDENT: My bookings
  if (c === '3') {
    session.state = 'MENU_CHOICE';
    await saveSession(chatId, session);
    return await showMyBookings(chatId);
  }

  // DRIVER: My earnings
  if (c === '4') {
    session.state = 'MENU_CHOICE';
    await saveSession(chatId, session);
    return await showDriverEarnings(chatId);
  }

  // Rate a ride
  if (c === '5') {
    return await showRidesToRate(chatId, session);
  }

  // Profile
  if (c === '6') {
    session.state = 'MENU_CHOICE';
    await saveSession(chatId, session);
    return await showProfile(chatId);
  }

  // Help
  if (c === '7') {
    session.state = 'MENU_CHOICE';
    await saveSession(chatId, session);
    return showHelp();
  }

  return `Please reply with a number 1–7.\n\n${showMainMenu()}`;
}

// ═══════════════════════════════════════════════════════════════════════════════════
// STATE MACHINE - STUDENT & DRIVER FLOWS
// ═══════════════════════════════════════════════════════════════════════════════════

async function handleState(chatId, input, session) {
  const state = session.state;
  const inp = input.trim();

  // ════ STUDENT: POST BOOKING REQUEST FLOW ════

  if (state === 'POST_REQUEST_FROM') {
    if (inp.length < 2) return 'Enter a valid location (min 2 characters).';
    session.tempData.from = inp;
    session.state = 'POST_REQUEST_TO';
    await saveSession(chatId, session);
    return `✅ From: *${inp}*\n\n📍 Where are you going to?\n_(e.g. Fajuyi Hall, Library, OAU Teaching Hospital)_`;
  }

  if (state === 'POST_REQUEST_TO') {
    if (inp.length < 2) return 'Enter a valid location (min 2 characters).';
    session.tempData.to = inp;
    session.state = 'POST_REQUEST_WHEN';
    await saveSession(chatId, session);
    return `✅ To: *${inp}*\n\n⏰ When do you need a ride?\n\n1️⃣ Now\n2️⃣ Today (later)\n3️⃣ Tomorrow\n4️⃣ This week\n\n_Reply 1–4_`;
  }

  if (state === 'POST_REQUEST_WHEN') {
    const timeMap = { '1': 'Now', '2': 'Today', '3': 'Tomorrow', '4': 'This week' };
    const when = timeMap[inp];
    if (!when) return 'Please reply 1, 2, 3, or 4.';
    
    session.tempData.when = when;
    session.state = 'POST_REQUEST_SEATS';
    await saveSession(chatId, session);
    return `⏰ Time: *${when}*\n\n🪑 How many seats do you need?\n_(Reply: 1, 2, 3, 4, 5, or 6)_`;
  }

  if (state === 'POST_REQUEST_SEATS') {
    const seats = parseInt(inp);
    if (isNaN(seats) || seats < 1 || seats > 6) return 'Please reply with 1–6 seats.';
    
    session.tempData.seats = seats;
    session.state = 'POST_REQUEST_BUDGET';
    await saveSession(chatId, session);
    return `🪑 Seats: *${seats}*\n\n💰 What's your budget per seat (₦)?\n_(e.g. 500, 600) or type "any" for flexible_`;
  }

  if (state === 'POST_REQUEST_BUDGET') {
    const skip = ['skip', 'any', '0', 'flexible'].includes(inp.toLowerCase());
    let budget = 0;
    
    if (!skip) {
      budget = parseInt(inp.replace(/[₦,]/g, ''));
      if (isNaN(budget) || budget <= 0) return 'Enter a valid amount (e.g. 500) or type "any".';
    }
    
    session.tempData.budget = budget;
    session.state = 'POST_REQUEST_CONFIRM';
    await saveSession(chatId, session);
    
    const d = session.tempData;
    let msg = `📋 *Review Your Request*\n\n`;
    msg += `From: ${d.from}\n`;
    msg += `To: ${d.to}\n`;
    msg += `When: ${d.when}\n`;
    msg += `Seats: ${d.seats}\n`;
    msg += `Budget: ${d.budget > 0 ? '₦' + d.budget + '/seat' : 'Flexible'}\n\n`;
    msg += `Confirm?\n`;
    msg += `A) Yes, post it\n`;
    msg += `B) Cancel\n\n`;
    msg += `_Reply A or B_`;
    
    return msg;
  }

  if (state === 'POST_REQUEST_CONFIRM') {
    const yes = ['a', 'yes'].includes(inp.toLowerCase());
    if (!yes) { await clearSession(chatId); return 'Request cancelled.\n\nType MENU to start over.'; }

    // Create booking request
    const requestData = {
      student_chatId: String(chatId),
      from: session.tempData.from,
      to: session.tempData.to,
      when: session.tempData.when,
      seats: session.tempData.seats,
      budget: session.tempData.budget,
      status: 'open',
      accepted_driver_chatId: null,
      accepted_price: null,
      created_at: Date.now(),
    };

    const ref = await db.collection('booking_requests').add(requestData);
    await clearSession(chatId);

    // Notify all drivers
    await notifyAllDrivers(ref.id, requestData);

    return `✅ *Request Posted!*\n\nRequest ID: \`${ref.id}\`\n\n🚗 Drivers can see your request.\n⏳ Waiting for responses...\n\nType MENU to check status or make another request.`;
  }

  if (state === 'WAITING_DRIVER_RESPONSE') {
    const requestId = session.tempData.requestId;
    const snap = await db.collection('booking_requests').doc(requestId).get();
    
    if (!snap.exists) {
      await clearSession(chatId);
      return 'Request not found. Type MENU to start over.';
    }

    const req = snap.data();

    // Driver accepted
    if (req.accepted_driver_chatId) {
      const driverSnap = await db.collection('drivers').doc(req.accepted_driver_chatId).get();
      const driverName = driverSnap.exists ? driverSnap.data().name : 'Your driver';
      const driverRating = driverSnap.exists ? (driverSnap.data().rating || 4.5) : 4.5;

      const totalCost = (req.accepted_price || 500) * req.seats;

      session.state = 'SHOW_PAYMENT';
      session.tempData.requestId = requestId;
      session.tempData.totalCost = totalCost;
      await saveSession(chatId, session);

      return `✅ *Driver Accepted!*\n\nDriver: *${driverName}*\n⭐ Rating: ${driverRating.toFixed(1)}/5\n\nPrice: ₦${req.accepted_price}/seat\nTotal: ₦${totalCost}\n\nRequest: \`${requestId}\`\n\n${buildPaymentMessage(requestId, totalCost)}`;
    }

    return `⏳ *Waiting for driver responses...*\n\nRequest: \`${requestId}\`\n\nDrivers are checking your request.\n\nType MENU to cancel or check status.`;
  }

  if (state === 'SHOW_PAYMENT') {
    if (inp.toLowerCase() === 'paid') {
      return `✅ Payment noted!\n\nWe're verifying with Paystack.\n\nYour driver will be notified soon.\n\nType MENU to continue.`;
    }
    return `Please complete payment using the link above.\n\nOnce paid, type: PAID`;
  }

  // ════ DRIVER: ACCEPT REQUEST FLOW ════

  if (state === 'VIEW_AVAILABLE_REQUESTS') {
    const idx = parseInt(inp) - 1;
    const requests = session.tempData.availableRequests || [];
    
    if (isNaN(idx) || idx < 0 || idx >= requests.length) {
      return `Please reply 1–${requests.length}`;
    }

    const selectedRequest = requests[idx];
    session.tempData.selectedRequest = selectedRequest;
    session.state = 'DRIVER_SET_PRICE';
    await saveSession(chatId, session);

    const r = selectedRequest;
    return `📋 *Request Details*\n\nStudent needs: ${r.seats} seat(s)\nFrom: ${r.from}\nTo: ${r.to}\nWhen: ${r.when}\nStudent budget: ${r.budget > 0 ? '₦' + r.budget + '/seat' : 'Flexible'}\n\n💰 What's your price per seat (₦)?\n_(e.g. 400, 500, 600)_`;
  }

  if (state === 'DRIVER_SET_PRICE') {
    const price = parseInt(inp.replace(/[₦,]/g, ''));
    if (isNaN(price) || price <= 0) return 'Please enter a valid price (e.g. 500).';

    session.tempData.pricePerSeat = price;
    session.state = 'DRIVER_CONFIRM_ACCEPT';
    await saveSession(chatId, session);

    const r = session.tempData.selectedRequest;
    const totalPrice = price * r.seats;

    return `✅ *Accept Request?*\n\nYour price: ₦${price}/seat\nSeats: ${r.seats}\nTotal earnings: ₦${totalPrice}\n\nRoute: ${r.from} → ${r.to}\nTime: ${r.when}\n\nA) Accept\nB) Decline\n\n_Reply A or B_`;
  }

  if (state === 'DRIVER_CONFIRM_ACCEPT') {
    const accept = ['a', 'accept', 'yes'].includes(inp.toLowerCase());
    
    if (!accept) {
      await clearSession(chatId);
      return 'Request declined.\n\nType MENU to see other requests.';
    }

    const requestId = session.tempData.selectedRequest.id;
    const studentChatId = session.tempData.selectedRequest.student_chatId;
    const totalPrice = session.tempData.pricePerSeat * session.tempData.selectedRequest.seats;

    // Get driver name
    const driverSnap = await db.collection('drivers').doc(String(chatId)).get();
    const driverName = driverSnap.exists ? driverSnap.data().name : 'Driver';

    // Mark as accepted
    await db.collection('booking_requests').doc(requestId).update({
      status: 'accepted',
      accepted_driver_chatId: String(chatId),
      accepted_price: session.tempData.pricePerSeat,
      accepted_at: Date.now(),
    });

    // Notify student
    await sendMsg(studentChatId, `✅ *Driver Found!*\n\nDriver: *${driverName}*\nPrice: ₦${session.tempData.pricePerSeat}/seat\nTotal: ₦${totalPrice}\n\nRequest: \`${requestId}\`\n\n${buildPaymentMessage(requestId, totalPrice)}`).catch(() => {});

    await clearSession(chatId);
    return `✅ *Request Accepted!*\n\n💰 You'll earn: ₦${totalPrice}\n\nStudent has been notified and will pay shortly.\n\nType MENU to accept more requests.`;
  }

  // ════ RATING ════

  if (state === 'RATE_RIDE') {
    const rating = parseInt(inp);
    if (![1, 2, 3, 4, 5].includes(rating)) return 'Please reply 1, 2, 3, 4, or 5.';

    const rideId = session.tempData.rideId;
    await db.collection('booking_requests').doc(rideId).update({
      student_rating: rating,
      rated_at: Date.now(),
    });

    await clearSession(chatId);
    return `🙏 *Thanks for rating!*\n\nYour feedback helps drivers improve.\n\nType MENU to continue.`;
  }

  await clearSession(chatId);
  return `Something went wrong. Type *MENU* to restart.`;
}

// ═══════════════════════════════════════════════════════════════════════════════════
// DRIVER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════════

async function viewAvailableRequests(chatId, session) {
  try {
    console.log(`\n🔍 [DRIVER ${chatId}] Fetching available requests...`);

    const driverSnap = await db.collection('drivers').doc(String(chatId)).get();
    
    if (!driverSnap.exists) {
      console.log(`   ℹ️ Driver not registered`);
      session.state = 'DRIVER_REGISTER_NAME';
      session.tempData = {};
      await saveSession(chatId, session);
      return `🚗 *Register as Driver*\n\nWhat's your name?`;
    }

    const driverName = driverSnap.data().name;
    console.log(`   ✅ Driver: ${driverName}`);

    let snap;
    try {
      console.log(`   🔄 Trying: booking_requests...`);
      snap = await db.collection('booking_requests')
        .where('status', '==', 'open')
        .orderBy('created_at', 'desc')
        .limit(20)
        .get();
    } catch (error1) {
      console.log(`   ⚠️ Trying: bookings (V2)...`);
      snap = await db.collection('bookings')
        .where('status', '==', 'pending')
        .orderBy('created_at', 'desc')
        .limit(20)
        .get();
    }

    console.log(`   📋 Found: ${snap.size}`);

    if (snap.empty) {
      session.state = 'MENU_CHOICE';
      await saveSession(chatId, session);
      return `😔 No available requests right now.\n\nType MENU to continue.`;
    }

    const requests = [];
    let msg = `🚗 *Available Requests* (${snap.size})\n\n`;

    snap.forEach((doc, i) => {
      const r = doc.data();
      const from = r.from || r.from_location || 'Pickup';
      const to = r.to || r.to_location || 'Dropoff';
      const when = r.when || 'ASAP';
      const seats = r.seats || 1;
      const budget = r.budget || 0;
      
      requests.push({ id: doc.id, ...r });
      
      msg += `*${i + 1}. ${from} → ${to}*\n`;
      msg += `   🪑 ${seats} seat(s) | ⏰ ${when}\n`;
      msg += `   Budget: ${budget > 0 ? '₦' + budget : 'Flexible'}\n\n`;
    });

    msg += `_Reply with number to accept_`;

    session.tempData.availableRequests = requests;
    session.state = 'VIEW_AVAILABLE_REQUESTS';
    await saveSession(chatId, session);

    console.log(`   ✅ Showing ${requests.length} requests`);
    return msg;

  } catch (err) {
    console.error(`❌ Error:`, err.message);
    return `❌ Error loading requests: ${err.message}\n\nType MENU to try again.`;
  }
}

async function notifyAllDrivers(requestId, requestData) {
  try {
    const snap = await db.collection('drivers').get();
    
    const msg = `🔔 *NEW RIDE REQUEST!*\n\n` +
      `📍 From: ${requestData.from}\n` +
      `📍 To: ${requestData.to}\n` +
      `🪑 Seats: ${requestData.seats}\n` +
      `⏰ When: ${requestData.when}\n` +
      `💰 Budget: ${requestData.budget > 0 ? '₦' + requestData.budget : 'Flexible'}\n\n` +
      `Request ID: \`${requestId}\`\n\n` +
      `Type MENU → 2 to see available requests!`;

    snap.forEach(doc => {
      sendMsg(doc.id, msg).catch(() => {});
    });
  } catch (err) {
    console.error('Notify drivers error:', err);
  }
}

async function showDriverEarnings(chatId) {
  try {
    const snap = await db.collection('booking_requests')
      .where('accepted_driver_chatId', '==', String(chatId))
      .where('status', '==', 'completed')
      .get();

    let totalEarnings = 0;
    snap.forEach(doc => {
      const r = doc.data();
      totalEarnings += (r.accepted_price || 0) * (r.seats || 1);
    });

    let msg = `💰 *Your Earnings*\n\n`;
    msg += `Completed rides: ${snap.size}\n`;
    msg += `Total earned: ₦${totalEarnings}\n\n`;

    if (totalEarnings > 0) {
      msg += `✅ Ready to withdraw!\n`;
      msg += `Contact support to set up payout.`;
    } else {
      msg += `Start accepting requests to earn money! 🚀`;
    }

    return msg;

  } catch (e) {
    return 'Error loading earnings. Type MENU to continue.';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════════

async function showMyBookings(chatId) {
  try {
    const snap = await db.collection('booking_requests')
      .where('student_chatId', '==', String(chatId))
      .orderBy('created_at', 'desc')
      .limit(5)
      .get();

    if (snap.empty) return '📋 No bookings yet.\n\nType MENU → 1 to post a request!';

    let msg = '📋 *Your Bookings*\n\n';
    snap.forEach((doc, i) => {
      const b = doc.data();
      const emoji = { open: '⏳', accepted: '✅', completed: '🏁' };
      msg += `*${i + 1}.* ${b.from} → ${b.to}\n   ${emoji[b.status] || '❓'} ${b.status.toUpperCase()}\n\n`;
    });

    return msg;
  } catch (e) {
    return 'Error loading bookings. Type MENU to continue.';
  }
}

async function showProfile(chatId) {
  try {
    const driverSnap = await db.collection('drivers').doc(String(chatId)).get();
    const bookingsSnap = await db.collection('booking_requests')
      .where('student_chatId', '==', String(chatId))
      .get();

    let msg = `👤 *Your Profile*\n\n`;
    msg += `🆔 User ID: ${chatId}\n`;
    msg += `Bookings: ${bookingsSnap.size}\n`;

    if (driverSnap.exists) {
      const d = driverSnap.data();
      msg += `\n🚗 *Driver Info*\n`;
      msg += `Name: ${d.name}\n`;
      msg += `Vehicle: ${d.vehicle_type}\n`;
      msg += `Completed rides: ${d.total_rides || 0}\n`;
      msg += `Rating: ${d.rating ? d.rating.toFixed(1) : 'New'}⭐\n`;
    }

    return msg;
  } catch (e) {
    return 'Error loading profile. Type MENU to continue.';
  }
}

async function showRidesToRate(chatId, session) {
  try {
    const snap = await db.collection('booking_requests')
      .where('student_chatId', '==', String(chatId))
      .where('status', '==', 'completed')
      .where('student_rating', '==', null)
      .orderBy('created_at', 'desc')
      .limit(1)
      .get();

    if (snap.empty) return '⭐ No rides to rate. Type MENU to continue.';

    const doc = snap.docs[0];
    const b = doc.data();
    session.tempData.rideId = doc.id;
    session.state = 'RATE_RIDE';
    await saveSession(chatId, session);

    return `⭐ *Rate Your Ride*\n\n${b.from} → ${b.to}\n\n1️⃣ ⭐ Poor\n2️⃣ ⭐⭐ Fair\n3️⃣ ⭐⭐⭐ Good\n4️⃣ ⭐⭐⭐⭐ Great\n5️⃣ ⭐⭐⭐⭐⭐ Excellent\n\n_Reply 1–5_`;
  } catch (e) {
    return 'Error loading rides. Type MENU to continue.';
  }
}

function showHelp() {
  return `❓ *CampusMove Help*

*STUDENTS:*
1. Post a request (from, to, when, budget)
2. Wait for drivers to respond
3. Pay via Paystack when driver accepts
4. Rate your driver

*DRIVERS:*
1. View available requests
2. Set your price for each request
3. Accept request
4. Get paid after student pays

📞 Support: ${process.env.SUPPORT_PHONE || 'Contact us'}
⏰ Available 7AM–10PM daily

Type MENU to go back.`;
}

// ═══════════════════════════════════════════════════════════════════════════════════
// PAYSTACK WEBHOOK - PAYMENT & COMMISSION
// ═══════════════════════════════════════════════════════════════════════════════════

async function handlePaystackWebhook(req, res) {
  try {
    const sig = req.headers['x-paystack-signature'];
    if (!verifyWebhookSignature(req.body, sig)) return res.sendStatus(401);

    const event = JSON.parse(req.body.toString());

    if (event.event === 'charge.success') {
      const { reference, amount } = event.data;
      const amountNaira = amount / 100;

      const snap = await db.collection('booking_requests').doc(reference).get();
      if (!snap.exists) return res.sendStatus(200);

      const booking = snap.data();
      if (booking.status !== 'accepted') return res.sendStatus(200);

      // ✅ COMMISSION CALCULATION
      const commission_rate = 0.10;  // 10% for CampusMove
      const campusmove_commission = amountNaira * commission_rate;
      const driver_receives = amountNaira - campusmove_commission;

      // Mark as completed
      await db.collection('booking_requests').doc(reference).update({
        status: 'completed',
        paid_at: Date.now(),
        payment_reference: reference,
      });

      // Record commission for revenue tracking
      await db.collection('campusmove_revenue').doc(reference).set({
        booking_id: reference,
        student_chatId: booking.student_chatId,
        driver_chatId: booking.accepted_driver_chatId,
        amount_paid: amountNaira,
        commission_rate: commission_rate,
        your_commission: campusmove_commission,
        driver_receives: driver_receives,
        created_at: Date.now(),
      });

      // Update driver wallet
      await db.collection('driver_wallet').doc(booking.accepted_driver_chatId).update({
        balance: admin.firestore.FieldValue.increment(driver_receives),
        total_earned: admin.firestore.FieldValue.increment(driver_receives),
      }).catch(() => {});

      // Update CampusMove revenue
      await db.collection('campusmove_wallet').doc('main').update({
        balance: admin.firestore.FieldValue.increment(campusmove_commission),
        monthly_revenue: admin.firestore.FieldValue.increment(campusmove_commission),
      }).catch(() => {});

      // Notify student
      await sendMsg(booking.student_chatId, 
        `✅ *Payment Confirmed!*\n\n₦${amountNaira}\nBooking: \`${reference}\`\n\nYour ride is confirmed! Your driver will contact you shortly.`
      ).catch(() => {});

      // Notify driver
      await sendMsg(booking.accepted_driver_chatId, 
        `💰 *Payment Received!*\n\nStudent paid ₦${amountNaira}\nYou receive: ₦${Math.round(driver_receives)}\nBooking: \`${reference}\``
      ).catch(() => {});
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Paystack webhook error:', err);
    res.sendStatus(500);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
// ADMIN HTTP ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/stats', async (_req, res) => {
  try {
    const [requests, drivers, revenue] = await Promise.all([
      db.collection('booking_requests').get(),
      db.collection('drivers').get(),
      db.collection('campusmove_revenue').get(),
    ]);

    let totalRevenue = 0;
    let totalPaymentAmount = 0;
    const byStatus = {};

    revenue.forEach(doc => {
      const r = doc.data();
      totalRevenue += r.your_commission || 0;
      totalPaymentAmount += r.amount_paid || 0;
    });

    requests.forEach(doc => {
      const r = doc.data();
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    });

    res.json({
      total_requests: requests.size,
      total_drivers: drivers.size,
      total_revenue_earned: totalRevenue,
      total_amount_processed: totalPaymentAmount,
      requests_by_status: byStatus,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════
// TELEGRAM MESSAGE LISTENER
// ═══════════════════════════════════════════════════════════════════════════════════

// DIAGNOSTIC ENDPOINT
app.get('/api/diagnose', async (req, res) => {
  const diagnosis = { collections: {} };
  
  for (const coll of ['booking_requests', 'bookings', 'drivers', 'campusmove_wallet']) {
    try {
      const snap = await db.collection(coll).limit(1).get();
      diagnosis.collections[coll] = { exists: true, docs: snap.size };
    } catch {
      diagnosis.collections[coll] = { exists: false };
    }
  }
  
  res.json(diagnosis);
});

bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    if (!text) return;

    console.log(`📨 ${chatId}: "${text}"`);

    const session = await getSession(chatId);
    await handleIncoming(chatId, text, session);

  } catch (err) {
    console.error('Message handler error:', err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n✅ Server running on port ${PORT}`);
  console.log(`📊 Stats: GET /api/admin/stats`);
  console.log(`🔔 Webhook: POST /api/paystack/webhook\n`);
});

module.exports = app;