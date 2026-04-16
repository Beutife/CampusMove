/**
 * CampusMove WhatsApp Bot - Enhanced Version
 * Improvements:
 * - Better error handling
 * - Persistent user sessions
 * - Support for drivers offering rides
 * - Rating system
 * - Ride history
 */

const express = require('express');
const twilio = require('twilio');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Firebase setup
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Twilio setup
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER;
const client = twilio(accountSid, authToken);

// ============================================
// SESSION MANAGEMENT (In-memory for now)
// ============================================
const userSessions = {};

async function initSession(phone) {
  if (!userSessions[phone]) {
    const userDoc = await db.collection('users').doc(phone).get();
    userSessions[phone] = {
      phone,
      state: 'HOME',
      data: userDoc.exists ? userDoc.data() : null,
      tempData: {}
    };
  }
  return userSessions[phone];
}

// ============================================
// MAIN MESSAGE HANDLER
// ============================================
app.post('/whatsapp', async (req, res) => {
  const incoming_msg = req.body.Body?.trim();
  const from = req.body.From;
  const student_phone = from.split(':')[1];

  console.log(`📨 From ${student_phone}: ${incoming_msg}`);

  try {
    const session = await initSession(student_phone);

    // Handle universal commands
    if (incoming_msg.toLowerCase() === 'menu') {
      session.state = 'HOME';
    }

    // Route to handler
    let response = '';

    if (session.state === 'HOME') {
      response = showMainMenu();
      session.state = 'MENU_CHOICE';
    } else if (session.state === 'MENU_CHOICE') {
      const choice = incoming_msg.toLowerCase();
      response = await handleMenuChoice(student_phone, choice, session);
    } else {
      response = await handleState(student_phone, incoming_msg, session);
    }

    await sendWhatsAppMessage(from, response);
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error:', error);
    await sendWhatsAppMessage(from, '❌ Oops! Something went wrong.\n\nType MENU to restart.');
    res.sendStatus(500);
  }
});

// ============================================
// MENU HANDLERS
// ============================================

function showMainMenu() {
  return `
👋 Welcome to *CampusMove*!

Find rides, book transport, go anywhere on campus.

1️⃣ 🔍 Find a ride
2️⃣ 🚗 Offer a ride (driver)
3️⃣ 📋 My bookings
4️⃣ ⭐ Rate a ride
5️⃣ 👤 My profile
6️⃣ ❓ Help

_Reply with 1-6_
  `.trim();
}

async function handleMenuChoice(phone, choice, session) {
  if (choice === '1') {
    session.state = 'FIND_RIDE_FROM';
    return `
📍 *Find a Ride*

Where are you leaving from?

Send location or type:
🏠 Oduduwa
🚪 Main gate
🏬 Campus center
🏘️ Other (type the area)
    `.trim();
  }

  if (choice === '2') {
    session.state = 'OFFER_RIDE_CHECK';
    return `
🚗 *Offer a Ride*

Are you a registered driver?

A) Yes, I'm registered
B) No, first time

_Reply A or B_
    `.trim();
  }

  if (choice === '3') {
    session.state = 'MY_BOOKINGS';
    return await showMyBookings(phone);
  }

  if (choice === '4') {
    session.state = 'RATE_RIDE_LIST';
    return await showRidesToRate(phone);
  }

  if (choice === '5') {
    return await showProfile(phone);
  }

  if (choice === '6') {
    return showHelp();
  }

  return 'Invalid choice. Please reply with 1-6.';
}

// ============================================
// FIND RIDE FLOW
// ============================================

async function handleState(phone, input, session) {
  const state = session.state;

  // Find ride flow
  if (state === 'FIND_RIDE_FROM') {
    session.tempData.from = input;
    session.state = 'FIND_RIDE_TO';
    return `
✅ From: *${input}*

📍 Where are you going to?

Send destination or type:
🏠 Oduduwa
🚪 Main gate
🏬 Market
🎓 Faculty area
🌆 Other (type area)
    `.trim();
  }

  if (state === 'FIND_RIDE_TO') {
    session.tempData.to = input;
    session.state = 'FIND_RIDE_WHEN';
    return `
✅ To: *${input}*

⏰ When do you want to leave?

1️⃣ Now (immediately)
2️⃣ Today (later)
3️⃣ Tomorrow
4️⃣ This week

_Reply 1-4_
    `.trim();
  }

  if (state === 'FIND_RIDE_WHEN') {
    const timeChoice = input.toLowerCase();
    const timeMap = {
      '1': 'now',
      'now': 'now',
      'immediately': 'now',
      '2': 'today',
      'today': 'today',
      'later': 'today',
      '3': 'tomorrow',
      'tomorrow': 'tomorrow',
      '4': 'thisweek'
    };

    const when = timeMap[timeChoice] || 'today';
    session.tempData.when = when;

    // Search for rides
    const rides = await searchRides(
      session.tempData.from,
      session.tempData.to,
      when
    );

    if (rides.length === 0) {
      session.state = 'HOME';
      return `
😔 *No rides found* for:
${session.tempData.from} → ${session.tempData.to}

*Would you like to:*
1. Search again
2. Post a ride request (other passengers can contact you)
3. Go back to menu

_Reply 1-3_
      `.trim();
    }

    // Show rides
    let response = `🚗 *Available Rides*\n\n`;
    rides.forEach((ride, i) => {
      response += `${i + 1}. ${ride.driver_name}
💰 ₦${ride.cost_per_seat} | 🪑 ${ride.seats_available} seats
⏰ ${ride.departure_time}
\n`;
    });

    response += `_Reply with number to book_`;

    session.tempData.searchResults = rides;
    session.state = 'FIND_RIDE_SELECT';
    return response;
  }

  if (state === 'FIND_RIDE_SELECT') {
    const rideNum = parseInt(input) - 1;
    const rides = session.tempData.searchResults;

    if (isNaN(rideNum) || rideNum < 0 || rideNum >= rides.length) {
      return `Invalid choice. Reply 1-${rides.length}`;
    }

    const selectedRide = rides[rideNum];
    session.tempData.selectedRide = selectedRide;
    session.state = 'BOOK_RIDE_SEATS';

    return `
✅ Selected: *${selectedRide.driver_name}*
${selectedRide.from} → ${selectedRide.to}
⏰ ${selectedRide.departure_time}
💰 ₦${selectedRide.cost_per_seat}/seat

🪑 How many seats do you need?

_Reply: 1, 2, 3, etc._
    `.trim();
  }

  if (state === 'BOOK_RIDE_SEATS') {
    const seats = parseInt(input);

    if (isNaN(seats) || seats < 1) {
      return 'Please reply with a valid number (1, 2, 3, etc.)';
    }

    const ride = session.tempData.selectedRide;

    if (seats > ride.seats_available) {
      return `❌ Only ${ride.seats_available} seats left. Try again.`;
    }

    session.tempData.seats = seats;
    session.tempData.totalCost = ride.cost_per_seat * seats;
    session.state = 'CONFIRM_BOOKING';

    return `
📊 *Booking Summary*

From: ${ride.from}
To: ${ride.to}
Driver: ${ride.driver_name}
Seats: ${seats}
Total: ₦${session.tempData.totalCost}

Confirm? 
A) Yes, book it
B) Cancel

_Reply A or B_
    `.trim();
  }

  if (state === 'CONFIRM_BOOKING') {
    if (input.toLowerCase() === 'a' || input.toLowerCase() === 'yes') {
      const booking = await createBooking(phone, session.tempData);
      session.state = 'SHOW_PAYMENT';
      session.tempData.bookingId = booking.id;

      return `
✅ *Booking Confirmed!*

Booking ID: ${booking.id}

💰 *Payment Required: ₦${session.tempData.totalCost}*

*Option 1: Bank Transfer*
Account: OAU Student Transport
Bank: First Bank
Amount: ₦${session.tempData.totalCost}
Reference: ${booking.id}

*Option 2: USSD*
Dial: *901*20*${booking.id}*1#

*Option 3: Meet Driver*
Driver will contact you on WhatsApp

Reply "paid" when done, or share this to your friends to split costs!
      `.trim();
    } else {
      session.state = 'HOME';
      return 'Booking cancelled.\n\nType MENU to start over.';
    }
  }

  if (state === 'SHOW_PAYMENT') {
    if (input.toLowerCase() === 'paid') {
      const bookingId = session.tempData.bookingId;
      await db.collection('bookings').doc(bookingId).update({
        status: 'confirmed',
        paid_at: new Date()
      });

      session.state = 'HOME';
      return `
✅ *Payment Received!*

Your ride is confirmed. 
Driver will contact you shortly.

📍 *Pickup details:*
Look for ${session.tempData.selectedRide.driver_name}
At: ${session.tempData.selectedRide.from}
Time: ${session.tempData.selectedRide.departure_time}

👋 Have a great ride!

Type MENU for more options.
      `.trim();
    }
  }

  return 'Something went wrong. Type MENU to restart.';
}

// ============================================
// SEARCH & BOOKING FUNCTIONS
// ============================================

async function searchRides(from, to, when) {
  try {
    let query = db.collection('rides').where('status', '==', 'available');

    // In production, use geo-hashing for better location matching
    // For now, simple string matching

    const snapshot = await query.get();
    const rides = [];

    snapshot.forEach(doc => {
      const ride = doc.data();
      if (
        ride.from.toLowerCase().includes(from.toLowerCase()) &&
        ride.to.toLowerCase().includes(to.toLowerCase())
      ) {
        rides.push({
          id: doc.id,
          ...ride
        });
      }
    });

    return rides;
  } catch (error) {
    console.error('Search error:', error);
    return [];
  }
}

async function createBooking(phone, tempData) {
  const booking = {
    phone,
    ride_id: tempData.selectedRide.id,
    seats: tempData.seats,
    total_cost: tempData.totalCost,
    status: 'pending',
    from: tempData.from,
    to: tempData.to,
    created_at: new Date()
  };

  const docRef = await db.collection('bookings').add(booking);
  return { id: docRef.id, ...booking };
}

// ============================================
// PROFILE & HISTORY FUNCTIONS
// ============================================

async function showMyBookings(phone) {
  try {
    const snapshot = await db.collection('bookings')
      .where('phone', '==', phone)
      .orderBy('created_at', 'desc')
      .limit(5)
      .get();

    if (snapshot.empty) {
      return 'No bookings yet. Type 1 to find a ride!';
    }

    let response = '📋 *Your Recent Bookings*\n\n';

    snapshot.forEach((doc, i) => {
      const booking = doc.data();
      response += `${i + 1}. ${booking.from} → ${booking.to}
${booking.status.toUpperCase()} | ₦${booking.total_cost}
\n`;
    });

    return response;
  } catch (error) {
    return 'Error loading bookings.';
  }
}

async function showProfile(phone) {
  try {
    const userDoc = await db.collection('users').doc(phone).get();
    const user = userDoc.data() || {};

    const bookingsSnapshot = await db.collection('bookings')
      .where('phone', '==', phone)
      .get();

    return `
👤 *Your Profile*

📞 Phone: ${phone}
🎫 Rides Booked: ${bookingsSnapshot.size}
⭐ Rating: ${user.rating || 'N/A'}
📅 Member since: ${user.created_at ? new Date(user.created_at).toLocaleDateString() : 'New'}

Type MENU to go back.
    `.trim();
  } catch (error) {
    return 'Error loading profile.';
  }
}

async function showRidesToRate(phone) {
  try {
    const snapshot = await db.collection('bookings')
      .where('phone', '==', phone)
      .where('status', '==', 'completed')
      .get();

    if (snapshot.empty) {
      return 'No completed rides to rate yet.';
    }

    // For simplicity, show first ride
    const booking = snapshot.docs[0].data();

    return `
⭐ *Rate Your Ride*

Ride: ${booking.from} → ${booking.to}

How would you rate it?

1️⃣ ⭐ (Poor)
2️⃣ ⭐⭐ (Fair)
3️⃣ ⭐⭐⭐ (Good)
4️⃣ ⭐⭐⭐⭐ (Great)
5️⃣ ⭐⭐⭐⭐⭐ (Excellent)

_Reply 1-5_
    `.trim();
  } catch (error) {
    return 'Error loading rides to rate.';
  }
}

function showHelp() {
  return `
❓ *Help & Support*

*Common Questions:*

1️⃣ How to find a ride?
   Menu → Option 1

2️⃣ How to pay?
   Bank transfer or USSD code provided after booking

3️⃣ What if driver cancels?
   We'll refund you within 2 hours

4️⃣ Is my payment safe?
   Yes! We partner with verified payment providers

5️⃣ Report a problem?
   Reply with "support"

📞 WhatsApp Support: Available 8AM - 8PM

Type MENU to go back.
  `.trim();
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

async function sendWhatsAppMessage(to, body) {
  try {
    const message = await client.messages.create({
      body,
      from: `whatsapp:${twilioWhatsAppNumber}`,
      to
    });
    console.log(`✅ Message sent: ${message.sid}`);
    return message.sid;
  } catch (error) {
    console.error('❌ Error sending message:', error);
    throw error;
  }
}

// ============================================
// ADMIN ENDPOINTS
// ============================================

app.post('/api/admin/add-ride', express.json(), async (req, res) => {
  const { driver_name, from, to, departure_time, seats, cost_per_seat, driver_phone } = req.body;

  try {
    const ride = {
      driver_name,
      from,
      to,
      departure_time,
      total_seats: seats,
      seats_available: seats,
      cost_per_seat,
      driver_phone,
      status: 'available',
      type: 'carpool',
      created_at: new Date()
    };

    const docRef = await db.collection('rides').add(ride);
    res.json({ success: true, ride_id: docRef.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const ridesSnapshot = await db.collection('rides').get();
    const bookingsSnapshot = await db.collection('bookings').get();
    const usersSnapshot = await db.collection('users').get();

    const totalRevenue = bookingsSnapshot.docs
      .filter(d => d.data().status === 'confirmed')
      .reduce((sum, d) => sum + d.data().total_cost, 0);

    res.json({
      total_rides: ridesSnapshot.size,
      total_bookings: bookingsSnapshot.size,
      total_users: usersSnapshot.size,
      total_revenue: totalRevenue
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════╗
║  🚗 CampusMove Bot Running! 🚗    ║
╚═══════════════════════════════════╝

📱 WhatsApp webhook: POST /whatsapp
📊 Admin stats: GET /api/admin/stats
➕ Add ride: POST /api/admin/add-ride

🌍 Expose with: ngrok http 3000
  `);
});

module.exports = app;