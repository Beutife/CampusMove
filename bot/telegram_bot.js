/**
 * ╔════════════════════════════════════════════════════════════════════════════════╗
 * ║                  CAMPUSMOVE V3 — COMPLETE TELEGRAM BOT                        ║
 * ║                       Production-Ready Implementation                          ║
 * ║                                                                                ║
 * ║  MODEL: Demand-Driven (Students post → Drivers accept)                        ║
 * ║  PAYMENTS: Paystack with 10% commission (90% to driver, 10% to you)           ║
 * ║  DATABASE: Firebase Firestore                                                 ║
 * ║  PLATFORM: Telegram (100% reliable)                                           ║
 * ║  FIX: No index required, atomic transactions, readable dates                  ║
 * ╚════════════════════════════════════════════════════════════════════════════════╝
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ═══════════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════════

// Convert milliseconds to readable date
function formatDate(timestamp) {
  if (!timestamp) return 'Just now';
  const date = new Date(timestamp);
  const options = { 
    weekday: 'short', 
    day: 'numeric', 
    month: 'short', 
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  };
  return date.toLocaleDateString('en-US', options);
}

// Verify Paystack signature
function verifyPaystackSignature(body, signature) {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET || '')
    .update(body)
    .digest('hex');
  return hash === signature;
}

// Build Paystack payment message
function buildPaymentMessage(bookingId, amount) {
  const baseUrl = 'https://checkout.paystack.com/';
  return `💳 *Payment Required*\n\n` +
    `Amount: ₦${amount}\n` +
    `Reference: ${bookingId}\n\n` +
    `[Pay with Paystack](${baseUrl}?key=${process.env.PAYSTACK_PUBLIC_KEY || ''})\n\n` +
    `Or: Tap the link above to pay`;
}

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
// PAYSTACK SPLIT PAYMENT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════════

const axios = require('axios');

// Create driver subaccount on Paystack
async function createDriverSubaccount(driverName, bankCode, accountNumber, driverChatId) {
  try {
    console.log(`📝 Creating Paystack subaccount for ${driverName}...`);
    
    const response = await axios.post(
      'https://api.paystack.co/subaccount',
      {
        business_name: `Driver: ${driverName} (${driverChatId})`,
        settlement_bank: bankCode,       // e.g., "058" for GTBank
        account_number: accountNumber,   // 10-digit NUBAN
        percentage_charge: 10            // 10% to YOU, 90% to driver
      },
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
      }
    );

    const subaccountCode = response.data.data.subaccount_code;
    console.log(`✅ Subaccount created: ${subaccountCode}`);
    
    return subaccountCode;
  } catch (error) {
    console.error("❌ Subaccount creation failed:", error.response?.data || error.message);
    throw error;
  }
}

// Generate the payment link for a student
async function generatePaymentLink(bookingId, studentEmail, totalAmountNGN, driverChatId) {
  try {
    console.log(`💳 Generating payment link for booking ${bookingId}...`);
    
    // Fetch driver's subaccount code
    const driverDoc = await db.collection('drivers').doc(String(driverChatId)).get();
    
    if (!driverDoc.exists || !driverDoc.data().subaccount_code) {
      throw new Error("Driver does not have a linked Paystack subaccount.");
    }

    const driverSubaccount = driverDoc.data().subaccount_code;

    // Initialize payment on Paystack
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: studentEmail,
        amount: totalAmountNGN * 100,  // Convert to Kobo
        subaccount: driverSubaccount,
        bearer: "subaccount",          // Driver pays the gateway fee
        metadata: { booking_id: bookingId }
      },
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
      }
    );

    const paymentUrl = response.data.data.authorization_url;
    console.log(`✅ Payment link generated: ${paymentUrl}`);
    
    return paymentUrl;
  } catch (error) {
    console.error("❌ Payment link generation failed:", error.response?.data || error.message);
    throw error;
  }
}


// ═══════════════════════════════════════════════════════════════════════════════════
// EXPRESS SETUP
// ═══════════════════════════════════════════════════════════════════════════════════

const app = express();
app.use(express.urlencoded({ extended: false }));
app.post('/api/paystack/webhook', express.raw({ type: 'application/json' }), handlePaystackWebhook);
app.use(express.json());

app.get('/', (_req, res) => res.json({
  status: 'ok',
  service: 'CampusMove V3',
  version: '3.0.0',
  model: 'Demand-Driven',
  payment: '10% commission to CampusMove, 90% to driver',
}));


// ═══════════════════════════════════════════════════════════════════════════════════
// TELEGRAM BOT SETUP
// ═══════════════════════════════════════════════════════════════════════════════════

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in .env file');

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║        🚗 CAMPUSMOVE V3 — Telegram Bot Starting        ║');
console.log('║                  Demand-Driven Model                      ║');
console.log('║            10% Commission | 90% to Driver                 ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');
console.log('✅ Firebase Connected');
console.log('✅ Telegram Bot Connected');
console.log(`📱 Bot: t.me/CampusMove_Bot`);
console.log('🚀 Ready!\n');

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
    if (body.length > 4096) {
      const chunks = body.match(/[\s\S]{1,4096}/g) || [];
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown', disable_web_page_preview: true });
        await new Promise(r => setTimeout(r, 100));
      }
    } else {
      await bot.sendMessage(chatId, body, { parse_mode: 'Markdown', disable_web_page_preview: true });
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
2️⃣  Available requests (earn ₦)
4️⃣  My earnings
6️⃣  My profile

7️⃣  Help

_Reply with 1–7_`;
}

async function handleMenuChoice(chatId, choice, session) {
  const c = choice.trim();

  if (c === '1') {
    session.state = 'POST_REQUEST_FROM';
    session.tempData = {};
    await saveSession(chatId, session);
    return `📍 *Post a Ride Request*\n\nWhere are you leaving from?\n_(e.g. Main Gate, Oduduwa Hall)_`;
  }

  if (c === '2') {
    return await viewAvailableRequests(chatId, session);
  }

  if (c === '3') {
    session.state = 'MENU_CHOICE';
    await saveSession(chatId, session);
    return await showMyBookings(chatId);
  }

  if (c === '4') {
    session.state = 'MENU_CHOICE';
    await saveSession(chatId, session);
    return await showDriverEarnings(chatId);
  }

  if (c === '5') {
    return await showRidesToRate(chatId, session);
  }

  if (c === '6') {
    session.state = 'MENU_CHOICE';
    await saveSession(chatId, session);
    return await showProfile(chatId);
  }

  if (c === '7') {
    session.state = 'MENU_CHOICE';
    await saveSession(chatId, session);
    return showHelp();
  }

  return `Please reply with 1–7.\n\n${showMainMenu()}`;
}

// ═══════════════════════════════════════════════════════════════════════════════════
// STATE MACHINE - STUDENT FLOW
// ═══════════════════════════════════════════════════════════════════════════════════

async function handleState(chatId, input, session) {
  const state = session.state;
  const inp = input.trim();

  // STUDENT: POST REQUEST
  if (state === 'POST_REQUEST_FROM') {
    if (inp.length < 2) return 'Enter a valid location (min 2 chars).';
    session.tempData.from = inp;
    session.state = 'POST_REQUEST_TO';
    await saveSession(chatId, session);
    return `✅ From: *${inp}*\n\nWhere to?`;
  }

  if (state === 'POST_REQUEST_TO') {
    if (inp.length < 2) return 'Enter a valid location.';
    session.tempData.to = inp;
    session.state = 'POST_REQUEST_WHEN';
    await saveSession(chatId, session);
    return `✅ To: *${inp}*\n\nWhen?\n1️⃣ Now\n2️⃣ Today\n3️⃣ Tomorrow\n4️⃣ This week`;
  }

  if (state === 'POST_REQUEST_WHEN') {
    const timeMap = { '1': 'Now', '2': 'Today', '3': 'Tomorrow', '4': 'This week' };
    const when = timeMap[inp];
    if (!when) return 'Reply 1-4.';
    session.tempData.when = when;
    session.state = 'POST_REQUEST_SEATS';
    await saveSession(chatId, session);
    return `⏰ *${when}*\n\nSeats needed? (1-6)`;
  }

  if (state === 'POST_REQUEST_SEATS') {
    const seats = parseInt(inp);
    if (isNaN(seats) || seats < 1 || seats > 6) return 'Reply 1-6.';
    session.tempData.seats = seats;
    session.state = 'POST_REQUEST_BUDGET';
    await saveSession(chatId, session);
    return `🪑 *${seats} seat(s)*\n\nBudget per seat (₦)?\n_(e.g. 500) or "any"_`;
  }

  if (state === 'POST_REQUEST_BUDGET') {
    const skip = ['skip', 'any', '0', 'flexible'].includes(inp.toLowerCase());
    let budget = 0;
    if (!skip) {
      budget = parseInt(inp.replace(/[₦,]/g, ''));
      if (isNaN(budget) || budget <= 0) return 'Enter valid amount or "any".';
    }
    session.tempData.budget = budget;
    session.state = 'POST_REQUEST_CONFIRM';
    await saveSession(chatId, session);

    const d = session.tempData;
    let msg = `📋 *Review*\n\n`;
    msg += `${d.from} → ${d.to}\n`;
    msg += `${d.when} | ${d.seats} seats\n`;
    msg += `Budget: ${d.budget > 0 ? '₦' + d.budget : 'Flexible'}\n\n`;
    msg += `A) Post it\nB) Cancel`;
    return msg;
  }

  if (state === 'POST_REQUEST_CONFIRM') {
    if (!['a', 'yes'].includes(inp.toLowerCase())) {
      await clearSession(chatId);
      return 'Cancelled. Type MENU.';
    }

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
      created_at_readable: formatDate(Date.now()),
    };

    const ref = await db.collection('booking_requests').add(requestData);
    await clearSession(chatId);
    await notifyAllDrivers(ref.id, requestData);

    return `✅ *Posted!*\n\nRequest: \`${ref.id}\`\n\nWaiting for drivers...\n\nType MENU.`;
  }

  // RATING
  if (state === 'RATE_RIDE') {
    const rating = parseInt(inp);
    if (![1, 2, 3, 4, 5].includes(rating)) return 'Reply 1-5.';

    const rideId = session.tempData.rideId;
    await db.collection('booking_requests').doc(rideId).update({
      student_rating: rating,
      rated_at: Date.now(),
    });

    await clearSession(chatId);
    return `🙏 Thanks for rating!\n\nType MENU.`;
  }

  // DRIVER: SELECT RIDE

  if (state === 'DRIVER_REGISTER_NAME') {
    const name = inp.trim();
    if (name.length < 2) return 'Name too short.';
    
    session.tempData.driverName = name;
    session.state = 'DRIVER_REGISTER_BANK';
    await saveSession(chatId, session);
    
    return `✅ Name saved!\n\n🏦 *Link Your Bank Account*\n\n` +
      `Which bank?\n\n` +
      `1️⃣ GTBank (058)\n` +
      `2️⃣ Access Bank (044)\n` +
      `3️⃣ FirstBank (011)\n` +
      `4️⃣ UBA (033)\n` +
      `5️⃣ Zenith (050)\n\n` +
      `Reply 1-5 or type bank code`;
  }

if (state === 'DRIVER_REGISTER_BANK') {
    const bankMap = {
      '1': '058', '2': '044', '3': '011', '4': '033', '5': '050',
      'gtbank': '058', 'access': '044', 'firstbank': '011', 'uba': '033', 'zenith': '050'
    };
    
    const bankCode = bankMap[inp.toLowerCase()];
    if (!bankCode) return 'Invalid bank. Reply 1-5 or bank code.';
    
    session.tempData.bankCode = bankCode;
    session.state = 'DRIVER_REGISTER_ACCOUNT';
    await saveSession(chatId, session);
    
    return `💳 *Enter Account Number*\n\n10-digit NUBAN account number:\n_(e.g. 1234567890)_`;
  }

if (state === 'DRIVER_REGISTER_ACCOUNT') {
    const accountNumber = inp.replace(/\D/g, '');
    
    if (accountNumber.length !== 10) {
      return 'Account number must be exactly 10 digits.';
    }
    
    session.tempData.accountNumber = accountNumber;
    session.state = 'DRIVER_REGISTER_CONFIRM';
    await saveSession(chatId, session);
    
    return `✅ *Review Your Details*\n\n` +
      `Name: ${session.tempData.driverName}\n` +
      `Bank Code: ${session.tempData.bankCode}\n` +
      `Account: ${accountNumber}\n\n` +
      `A) Confirm\nB) Cancel`;
  }

if (state === 'DRIVER_REGISTER_CONFIRM') {
    if (!['a', 'yes', 'confirm'].includes(inp.toLowerCase())) {
      await clearSession(chatId);
      return 'Cancelled. Type MENU.';
    }
    
    try {
      // Create subaccount on Paystack
      const subaccountCode = await createDriverSubaccount(
        session.tempData.driverName,
        session.tempData.bankCode,
        session.tempData.accountNumber,
        chatId
      );
      
      // Save driver with subaccount code
      await db.collection('drivers').doc(String(chatId)).set({
        chatId: String(chatId),
        name: session.tempData.driverName,
        bank_code: session.tempData.bankCode,
        account_number: session.tempData.accountNumber,
        subaccount_code: subaccountCode,  // ← THIS IS CRITICAL
        vehicle_type: 'Not set',
        rating: 0,
        total_rides: 0,
        registered_at: Date.now(),
        registered_at_readable: formatDate(Date.now()),
      });
      
      await clearSession(chatId);
      return `🎉 *All Set!*\n\n✅ Registered as ${session.tempData.driverName}\n✅ Bank linked to Paystack\n\nYou'll get 90% of every ride payment automatically!\n\nType MENU to start accepting rides.`;
      
    } catch (error) {
      console.error('Registration error:', error);
      await clearSession(chatId);
      return `❌ Error linking bank: ${error.message}\n\nTry again. Type MENU.`;
    }
  }

    // DRIVER: SELECT RIDE
  if (state === 'DRIVER_SELECT_RIDE') {
    const idx = parseInt(inp) - 1;
    const requests = session.tempData.availableRequests || [];
    
    if (isNaN(idx) || idx < 0 || idx >= requests.length) {
      return `Reply 1–${requests.length}`;
    }

    const selectedRequest = requests[idx];
    session.tempData.selectedRequest = selectedRequest;
    session.state = 'DRIVER_SET_PRICE_V2';
    await saveSession(chatId, session);

    const r = selectedRequest;
    return `📋 *Ride Details*\n\n` +
      `${r.from} → ${r.to}\n` +
      `${r.seats} seats | ${r.when}\n` +
      `Budget: ₦${r.budget > 0 ? r.budget : 'Flexible'}\n\n` +
      `💰 Your price per seat (₦)?`;
  }

  if (state === 'DRIVER_SET_PRICE_V2') {
    const price = parseInt(inp.replace(/[₦,]/g, ''));
    if (isNaN(price) || price <= 0) return 'Enter valid price.';

    session.tempData.pricePerSeat = price;
    session.state = 'DRIVER_CONFIRM_V2';
    await saveSession(chatId, session);

    const r = session.tempData.selectedRequest;
    const totalEarning = price * r.seats;

    return `✅ *Confirm*\n\n` +
      `Price: ₦${price}/seat\n` +
      `Seats: ${r.seats}\n` +
      `You earn: ₦${totalEarning}\n\n` +
      `A) Accept\nB) Decline`;
  }

  if (state === 'DRIVER_CONFIRM_V2') {
    if (!['a', 'accept', 'yes'].includes(inp.toLowerCase())) {
      await clearSession(chatId);
      return 'Declined. Type MENU.';
    }

    const requestId = session.tempData.selectedRequest.id;
    const studentChatId = session.tempData.selectedRequest.student_chatId;
    const totalPrice = session.tempData.pricePerSeat * session.tempData.selectedRequest.seats;

    const driverSnap = await db.collection('drivers').doc(String(chatId)).get();
    const driverName = driverSnap.exists ? driverSnap.data().name : 'Driver';

    try {
      const result = await db.runTransaction(async (transaction) => {
        const rideRef = db.collection('booking_requests').doc(requestId);
        const rideDoc = await transaction.get(rideRef);

        if (!rideDoc.exists || rideDoc.data().status !== 'open') {
          return { success: false };
        }

        transaction.update(rideRef, {
          status: 'accepted',
          accepted_driver_chatId: String(chatId),
          accepted_price: session.tempData.pricePerSeat,
          accepted_at: Date.now(),
          accepted_at_readable: formatDate(Date.now()),
        });

        return { success: true, rideData: rideDoc.data() };
      });

      if (!result.success) {
        await clearSession(chatId);
        return `❌ Too late! Another driver got it.\n\nType MENU.`;
      }

      // ✨ PAYSTACK INTEGRATION STARTS HERE
      try {
        const studentEmail = result.rideData.student_email || `student_${studentChatId}@campusmove.io`;
        
        // Generate the payment link
        const paymentLink = await generatePaymentLink(
          requestId,
          studentEmail,
          totalPrice,
          chatId  // driver's chatId
        );

        // Send to student
        await sendMsg(studentChatId, 
          `✅ *Driver Found!*\n\n` +
          `Driver: *${driverName}*\n` +
          `Price: ₦${session.tempData.pricePerSeat}/seat\n` +
          `Total: ₦${totalPrice}\n\n` +
          `[💳 Pay Securely via Paystack](${paymentLink})\n\n` +
          `Tap above to complete payment. Once done, driver gets your location.`
        ).catch(() => {});

        // Send to driver
        await sendMsg(chatId,
          `🎉 *Ride Accepted!*\n\n` +
          `You'll earn: ₦${totalPrice}\n\n` +
          `Payment link sent to student.\n` +
          `Waiting for payment confirmation...`
        ).catch(() => {});

      } catch (payError) {
        console.error('Payment link error:', payError);
        await sendMsg(studentChatId, 
          `⚠️ Ride assigned but payment link failed.\n\n` +
          `Please contact support.`
        ).catch(() => {});
      }

      await clearSession(chatId);
      return `🎉 *Accepted!*\n\n` +
        `You'll earn: ₦${totalPrice}\n\n` +
        `Student notified. Waiting for payment...\n\nType MENU.`;

    } catch (err) {
      console.error('Transaction error:', err);
      return `❌ Error: ${err.message}\n\nType MENU.`;
    }
  }

  return 'Type *MENU* to go back to the main menu.';
}

// ═══════════════════════════════════════════════════════════════════════════════════
// DRIVER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════════

async function viewAvailableRequests(chatId, session) {
  try {
    console.log(`\n🔍 [DRIVER ${chatId}] Loading requests...`);

    // Check if driver registered
    const driverSnap = await db.collection('drivers').doc(String(chatId)).get();
    
    if (!driverSnap.exists) {
      console.log(`   ℹ️ Driver not registered`);
      session.state = 'DRIVER_REGISTER_NAME';
      session.tempData = {};
      await saveSession(chatId, session);
      return `🚗 *Register as Driver First*\n\nWhat's your name?`;
    }

    const driverName = driverSnap.data().name;
    console.log(`   ✅ Driver: ${driverName}`);

    // Get ALL open requests (NO INDEX NEEDED)
    let snap;
    try {
      snap = await db.collection('booking_requests')
        .where('status', '==', 'open')
        .get();
      console.log(`   ✅ Got ${snap.size} from booking_requests`);
    } catch {
      // Fallback
      snap = await db.collection('bookings')
        .where('status', '==', 'pending')
        .get();
      console.log(`   ⚠️ Fallback: Got ${snap.size} from bookings`);
    }

    // Sort by date in JavaScript (no index needed!)
    const docs = snap.docs.sort((a, b) => 
      (b.data().created_at || 0) - (a.data().created_at || 0)
    ).slice(0, 20);

    console.log(`   📋 After sort: ${docs.length}`);

    if (docs.length === 0) {
      session.state = 'MENU_CHOICE';
      await saveSession(chatId, session);
      return `😔 No available requests.\n\nCheck back soon!\n\nType MENU.`;
    }

    // Show requests
    let msg = `🚗 *Available Requests* (${docs.length})\n\n`;
    msg += `Reply with number to select!\n\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const r = doc.data();
      const from = r.from || 'Pickup';
      const to = r.to || 'Dropoff';
      const when = r.when || 'ASAP';
      const seats = r.seats || 1;
      const budget = r.budget || 0;
      const posted = formatDate(r.created_at);
      
      msg += `*${i + 1}. ${from} → ${to}*\n`;
      msg += `   ⏰ ${when} | 🪑 ${seats} seats\n`;
      msg += `   💰 Budget: ₦${budget > 0 ? budget : 'Flexible'}\n`;
      msg += `   Posted: ${posted}\n\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n_Reply 1–${docs.length}_`;

    session.tempData.availableRequests = docs.map(d => ({ id: d.id, ...d.data() }));
    session.state = 'DRIVER_SELECT_RIDE';
    await saveSession(chatId, session);

    console.log(`   ✅ Showing to ${driverName}`);
    return msg;

  } catch (err) {
    console.error(`❌ Error:`, err.message);
    return `❌ Error: ${err.message}\n\nType MENU.`;
  }
}

async function notifyAllDrivers(requestId, requestData) {
  try {
    const snap = await db.collection('drivers').get();
    
    const msg = `🔔 *NEW RIDE REQUEST!*\n\n` +
      `${requestData.from} → ${requestData.to}\n` +
      `${requestData.when} | ${requestData.seats} seats\n` +
      `Budget: ₦${requestData.budget > 0 ? requestData.budget : 'Flexible'}\n\n` +
      `Posted: ${formatDate(requestData.created_at)}\n\n` +
      `Type *MENU → 2* to see requests!`;

    snap.forEach(doc => {
      sendMsg(doc.id, msg).catch(() => {});
    });
    
    console.log(`✅ Notified ${snap.size} drivers`);
  } catch (err) {
    console.error('Notify error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════════

async function showMyBookings(chatId) {
  try {
    const snap = await db.collection('booking_requests')
      .where('student_chatId', '==', String(chatId))
      .get();

    if (snap.empty) return '📋 No bookings.\n\nType MENU → 1.';

    const bookings = snap.docs.sort((a, b) => 
      (b.data().created_at || 0) - (a.data().created_at || 0)
    ).slice(0, 5);

    let msg = '📋 *Your Bookings*\n\n';
    bookings.forEach((doc, i) => {
      const b = doc.data();
      const emoji = { open: '⏳', accepted: '✅', completed: '🏁' };
      const date = formatDate(b.created_at);
      msg += `*${i + 1}.* ${b.from} → ${b.to}\n   ${emoji[b.status] || '❓'} ${date}\n\n`;
    });

    return msg;
  } catch (e) {
    return 'Error. Type MENU.';
  }
}

async function showProfile(chatId) {
  try {
    const driverSnap = await db.collection('drivers').doc(String(chatId)).get();
    const bookingsSnap = await db.collection('booking_requests')
      .where('student_chatId', '==', String(chatId))
      .get();

    let msg = `👤 *Your Profile*\n\n`;
    msg += `ID: \`${chatId}\`\n`;
    msg += `Bookings: ${bookingsSnap.size}\n`;

    if (driverSnap.exists) {
      const d = driverSnap.data();
      msg += `\n🚗 *Driver*\n`;
      msg += `Name: ${d.name}\n`;
      msg += `Vehicle: ${d.vehicle_type || 'Not set'}\n`;
      msg += `Rides: ${d.total_rides || 0}\n`;
      msg += `Rating: ${d.rating ? d.rating.toFixed(1) : 'New'}⭐\n`;
    }

    return msg;
  } catch (e) {
    return 'Error. Type MENU.';
  }
}

async function showRidesToRate(chatId, session) {
  try {
    const snap = await db.collection('booking_requests')
      .where('student_chatId', '==', String(chatId))
      .where('status', '==', 'completed')
      .get();

    const unrated = snap.docs.filter(d => !d.data().student_rating);
    if (unrated.length === 0) return '⭐ No rides to rate. Type MENU.';

    const doc = unrated[0];
    const b = doc.data();
    session.tempData.rideId = doc.id;
    session.state = 'RATE_RIDE';
    await saveSession(chatId, session);

    return `⭐ *Rate This Ride*\n\n${b.from} → ${b.to}\n\n` +
      `1️⃣ Poor\n2️⃣ Fair\n3️⃣ Good\n4️⃣ Great\n5️⃣ Excellent`;
  } catch (e) {
    return 'Error. Type MENU.';
  }
}

async function showDriverEarnings(chatId) {
  try {
    const walletSnap = await db.collection('driver_wallet').doc(String(chatId)).get();
    const ridesSnap = await db.collection('booking_requests')
      .where('accepted_driver_chatId', '==', String(chatId))
      .where('status', '==', 'completed')
      .get();

    if (!walletSnap.exists) {
      return `💰 *Earnings*\n\nNo earnings yet.\n\nAccept rides to start earning!`;
    }

    const wallet = walletSnap.data();
    let msg = `💰 *Your Earnings*\n\n`;
    msg += `Balance: ₦${Math.round(wallet.balance || 0)}\n`;
    msg += `Total earned: ₦${Math.round(wallet.total_earned || 0)}\n`;
    msg += `Completed rides: ${ridesSnap.size}\n\n`;

    if (ridesSnap.size > 0) {
      msg += `📍 Latest:\n`;
      const latest = ridesSnap.docs[ridesSnap.docs.length - 1].data();
      msg += `${latest.from} → ${latest.to}\n`;
      msg += `Earned: ₦${latest.accepted_price * latest.seats}\n`;
    }

    return msg;
  } catch (e) {
    return `💰 *Earnings*\n\nNo data yet. Type MENU.`;
  }
}

function showHelp() {
  return `❓ *CampusMove Help*

*STUDENTS:*
Post request → Drivers accept → You pay → Done!

*DRIVERS:*
See requests → Pick one → Set price → Get paid!

*PAYMENT:*
Student pays ₦X
- You get: 90%
- CampusMove gets: 10%

📞 Support: ${process.env.SUPPORT_PHONE || 'support@campusmove'}

Type MENU.`;
}

// ═══════════════════════════════════════════════════════════════════════════════════
// PAYSTACK WEBHOOK - PAYMENT & COMMISSION SPLIT
// ═══════════════════════════════════════════════════════════════════════════════════

async function handlePaystackWebhook(req, res) {
  try {
    const sig = req.headers['x-paystack-signature'];
    const body = req.body.toString();
    
    if (!verifyPaystackSignature(body, sig)) {
      console.error('❌ Invalid signature');
      return res.sendStatus(401);
    }

    const event = JSON.parse(body);

    if (event.event === 'charge.success') {
      const { reference, amount } = event.data;
      const amountNaira = amount / 100;

      console.log(`\n💳 Payment received: ${reference} - ₦${amountNaira}`);

      const snap = await db.collection('booking_requests').doc(reference).get();
      if (!snap.exists) {
        console.log(`❌ Booking not found: ${reference}`);
        return res.sendStatus(200);
      }

      const booking = snap.data();
      if (booking.status !== 'accepted') {
        console.log(`⚠️ Booking not accepted`);
        return res.sendStatus(200);
      }

      // ✅ COMMISSION SPLIT
      const commission_rate = 0.10;  // 10% to CampusMove
      const campusmove_commission = amountNaira * commission_rate;
      const driver_receives = amountNaira - campusmove_commission;

      console.log(`   Student paid: ₦${amountNaira}`);
      console.log(`   Driver gets: ₦${driver_receives.toFixed(2)} (90%)`);
      console.log(`   You get: ₦${campusmove_commission.toFixed(2)} (10%)`);

      // Mark completed
      await db.collection('booking_requests').doc(reference).update({
        status: 'completed',
        paid_at: Date.now(),
        paid_at_readable: formatDate(Date.now()),
        payment_reference: reference,
      });

      // Record for your revenue tracking
      await db.collection('campusmove_revenue').doc(reference).set({
        booking_id: reference,
        student_chatId: booking.student_chatId,
        driver_chatId: booking.accepted_driver_chatId,
        amount_paid: amountNaira,
        commission_rate: commission_rate,
        your_commission: campusmove_commission,
        driver_receives: driver_receives,
        created_at: Date.now(),
        created_at_readable: formatDate(Date.now()),
      });

      // Update driver wallet (they get 90%)
      await db.collection('driver_wallet').doc(booking.accepted_driver_chatId).update({
        balance: admin.firestore.FieldValue.increment(driver_receives),
        total_earned: admin.firestore.FieldValue.increment(driver_receives),
        updated_at: Date.now(),
      }).catch(async () => {
        // Create if not exists
        await db.collection('driver_wallet').doc(booking.accepted_driver_chatId).set({
          balance: driver_receives,
          total_earned: driver_receives,
          created_at: Date.now(),
          updated_at: Date.now(),
        });
      });

      // Update YOUR wallet (you get 10%)
      await db.collection('campusmove_wallet').doc('main').update({
        balance: admin.firestore.FieldValue.increment(campusmove_commission),
        monthly_revenue: admin.firestore.FieldValue.increment(campusmove_commission),
        updated_at: Date.now(),
      }).catch(async () => {
        // Create if not exists
        await db.collection('campusmove_wallet').doc('main').set({
          balance: campusmove_commission,
          monthly_revenue: campusmove_commission,
          created_at: Date.now(),
          updated_at: Date.now(),
        });
      });

      // Notify student
      await sendMsg(booking.student_chatId, 
        `✅ *Payment Confirmed!*\n\n` +
        `₦${amountNaira} received\n` +
        `Request: \`${reference}\`\n\n` +
        `Your ride is confirmed!\n` +
        `Driver details incoming soon.\n\n` +
        `Type MENU.`
      ).catch(() => {});

      // Notify driver
      await sendMsg(booking.accepted_driver_chatId, 
        `💰 *Payment Received!*\n\n` +
        `You earn: ₦${Math.round(driver_receives)}\n` +
        `Request: \`${reference}\`\n\n` +
        `Payment completed! Head to pickup.\n\n` +
        `Type MENU.`
      ).catch(() => {});

      console.log(`✅ Payment processed successfully\n`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/stats', async (_req, res) => {
  try {
    const [requests, drivers, revenue, wallets] = await Promise.all([
      db.collection('booking_requests').get(),
      db.collection('drivers').get(),
      db.collection('campusmove_revenue').get(),
      db.collection('campusmove_wallet').doc('main').get(),
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

    const yourWallet = wallets.exists ? wallets.data() : { balance: 0, monthly_revenue: 0 };

    res.json({
      total_requests: requests.size,
      total_drivers: drivers.size,
      your_total_commission: totalRevenue,
      your_current_balance: yourWallet.balance,
      your_monthly_revenue: yourWallet.monthly_revenue,
      total_amount_processed: totalPaymentAmount,
      requests_by_status: byStatus,
      payment_split: {
        driver_percentage: 90,
        campusmove_percentage: 10,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/diagnose', async (req, res) => {
  const diagnosis = { collections: {}, timestamp: formatDate(Date.now()) };
  
  for (const coll of ['booking_requests', 'drivers', 'campusmove_wallet', 'campusmove_revenue', 'driver_wallet']) {
    try {
      const snap = await db.collection(coll).limit(1).get();
      diagnosis.collections[coll] = { exists: true, docs: snap.size };
    } catch {
      diagnosis.collections[coll] = { exists: false };
    }
  }
  
  res.json(diagnosis);
});

// ═══════════════════════════════════════════════════════════════════════════════════
// TELEGRAM MESSAGE LISTENER
// ═══════════════════════════════════════════════════════════════════════════════════

bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    if (!text) return;

    console.log(`📨 ${chatId}: "${text}"`);

    const session = await getSession(chatId);
    await handleIncoming(chatId, text, session);

  } catch (err) {
    console.error('Message error:', err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════
// DRIVER REGISTRATION (when registering as driver)
// ═══════════════════════════════════════════════════════════════════════════════════

// Add this to handleState for driver registration:
// if (state === 'DRIVER_REGISTER_NAME') {
//   const name = inp.trim();
//   if (name.length < 2) return 'Name too short.';
//   
//   await db.collection('drivers').doc(String(chatId)).set({
//     chatId: String(chatId),
//     name: name,
//     vehicle_type: 'Not set',
//     rating: 0,
//     total_rides: 0,
//     registered_at: Date.now(),
//     registered_at_readable: formatDate(Date.now()),
//   });
//   
//   await clearSession(chatId);
//   return `✅ Registered as ${name}!\n\nType MENU to start!`;
// }

// ═══════════════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ Server on port ${PORT}`);
  console.log(`📊 Stats: GET /api/admin/stats`);
  console.log(`🔍 Diagnose: GET /api/diagnose`);
  console.log(`💳 Webhook: POST /api/paystack/webhook\n`);
});

module.exports = app;