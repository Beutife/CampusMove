/**
 * CampusMove WhatsApp Bot - WITH DRIVER ACCEPT/REJECT
 * ✅ Drivers can accept or reject ride requests
 * ✅ Passengers get notifications
 * ✅ Full booking flow
 */

const express = require('express');
const twilio = require('twilio');
const admin = require('firebase-admin');
const { processPayment } = require('../utils/paymentHandler');
const { getBotWallet, getBalance } = require('../stellarClient');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Firebase setup
const serviceAccount = require('../serviceAccountKey.json');
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
// SESSION MANAGEMENT
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
    if (!incoming_msg) {
      return res.sendStatus(200);
    }

    const session = await initSession(student_phone);

    // Handle universal commands
    if (incoming_msg.toLowerCase() === 'menu') {
      session.state = 'HOME';
      session.tempData = {};
    }

    // Route to handler
    let response = '';

    if (session.state === 'HOME') {
      response = showMainMenu();
      session.state = 'MENU_CHOICE';
    } else if (session.state === 'MENU_CHOICE') {
      response = await handleMenuChoice(student_phone, incoming_msg, session);
    } else {
      response = await handleState(student_phone, incoming_msg, session);
    }

    if (response) {
      await sendWhatsAppMessage(from, response);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error:', error);
    await sendWhatsAppMessage(from, '❌ Oops! Something went wrong.\n\nType MENU to restart.').catch(e => console.error('Error sending error message:', e));
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
4️⃣ 🔔 Pending requests (driver)
5️⃣ ⭐ Rate a ride
6️⃣ 👤 My profile
7️⃣ ❓ Help

_Reply with 1-7_
  `.trim();
}

async function handleMenuChoice(phone, choice, session) {
  choice = String(choice).trim().toLowerCase();

  if (choice === '1') {
    session.tempData = {};
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
    session.tempData = {};
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
    session.state = 'MENU_CHOICE';
    return await showMyBookings(phone);
  }

  if (choice === '4') {
    session.state = 'MENU_CHOICE';
    return await showPendingRequests(phone, session);
  }

  if (choice === '5') {
    return await showRidesToRate(phone, session);
  }

  if (choice === '6') {
    session.state = 'MENU_CHOICE';
    return await showProfile(phone);
  }

  if (choice === '7') {
    session.state = 'MENU_CHOICE';
    return showHelp();
  }

  return 'Invalid choice. Please reply with 1-7.';
}

// ============================================
// FIND RIDE FLOW (STUDENT)
// ============================================

async function handleState(phone, input, session) {
  const state = session.state;
  input = String(input).trim();

  // ========== FIND RIDE FLOW ==========
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
    const timeMap = {
      '1': 'now', 'now': 'now', 'immediately': 'now',
      '2': 'today', 'today': 'today', 'later': 'today',
      '3': 'tomorrow', 'tomorrow': 'tomorrow',
      '4': 'thisweek', 'this week': 'thisweek', 'thisweek': 'thisweek'
    };

    const when = timeMap[input.toLowerCase()] || 'today';
    session.tempData.when = when;

    // Search for rides
    const rides = await searchRides(session.tempData.from, session.tempData.to, when);

    if (rides.length === 0) {
      session.state = 'HOME';
      session.tempData = {};
      return `
😔 *No rides found* for:
${session.tempData.from} → ${session.tempData.to}

Type MENU to search again or try a different location.
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
    const rides = session.tempData.searchResults || [];

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

    if (seats > (ride.seats_available || 0)) {
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
    const isYes = input.toLowerCase() === 'a' || input.toLowerCase() === 'yes';
    const isNo = input.toLowerCase() === 'b' || input.toLowerCase() === 'no' || input.toLowerCase() === 'cancel';

    if (!isYes && !isNo) {
      return 'Please reply with A or B.';
    }

    if (isNo) {
      session.state = 'HOME';
      session.tempData = {};
      return 'Booking cancelled.\n\nType MENU to start over.';
    }

    // Create booking in PENDING state
    const booking = await createBooking(phone, session.tempData);
    session.state = 'WAITING_DRIVER_ACCEPT';
    session.tempData.bookingId = booking.id;

    // Notify driver about the pending request
    const driver_phone = session.tempData.selectedRide.driver_phone;
    await notifyDriverPendingRequest(driver_phone, booking);

    return `
⏳ *Waiting for Driver Confirmation*

Booking ID: ${booking.id}

We've sent a request to ${session.tempData.selectedRide.driver_name}!

The driver will accept or reject your request.
We'll notify you when they respond.

⏱️ This usually takes less than 1 minute.

Type MENU if you want to search for other rides.
      `.trim();
  }

  if (state === 'WAITING_DRIVER_ACCEPT') {
    // Check if booking was accepted
    const bookingId = session.tempData.bookingId;
    try {
      const bookingSnap = await db.collection('bookings').doc(bookingId).get();
      const booking = bookingSnap.data();

      if (booking.status === 'accepted') {
        session.state = 'SHOW_PAYMENT';
        return `
✅ *Driver Accepted Your Request!*

Booking ID: ${booking.id}

Driver: ${session.tempData.selectedRide.driver_name}
Pickup: ${booking.from}
Dropoff: ${booking.to}
Time: ${session.tempData.selectedRide.departure_time}

💰 *Payment Required: ₦${session.tempData.totalCost}*

*Option 1: Bank Transfer*
Account: OAU Student Transport
Bank: First Bank
Amount: ₦${session.tempData.totalCost}
Reference: ${booking.id}

*Option 2: USSD*
Dial: *901*20*${booking.id}*1#

Reply "paid" when done!
        `.trim();
      }

      if (booking.status === 'rejected') {
        session.state = 'HOME';
        session.tempData = {};
        return `
❌ *Driver Rejected Your Request*

Sorry, the driver couldn't accept your ride.

Type MENU to find another ride.
        `.trim();
      }

      return 'Still waiting for driver response...\n\nType MENU if you want to cancel.';
    } catch (error) {
      console.error('Error checking booking:', error);
      return 'Error checking status. Type MENU to continue.';
    }
  }

  if (state === 'SHOW_PAYMENT') {
    if (input.toLowerCase() === 'paid') {
      const bookingId = session.tempData.bookingId;
      const rideId = session.tempData.selectedRide?.id;
      const seatsBooked = Number(session.tempData.seats || 0);

          await db.collection('bookings').doc(booking.id).update({
            status: 'confirmed',
            paid_at: new Date(),
            txHash: paymentResult.txHash,
            explorerUrl: paymentResult.explorerUrl
          });

      // Notify driver that payment is done
      const driver_phone = session.tempData.selectedRide.driver_phone;
      await sendWhatsAppMessage(`whatsapp:${driver_phone}`, `
✅ *Payment Confirmed for Booking ${bookingId}*

Passenger has paid ₦${session.tempData.totalCost}

Ready to pick them up at ${session.tempData.selectedRide.from}
Time: ${session.tempData.selectedRide.departure_time}
      `.trim());

      // Decrement available seats
      if (rideId && seatsBooked > 0) {
        try {
          await db.runTransaction(async (tx) => {
            const rideRef = db.collection('rides').doc(rideId);
            const rideSnap = await tx.get(rideRef);
            if (!rideSnap.exists) return;

            const ride = rideSnap.data() || {};
            const currentSeats = Number(ride.seats_available || 0);
            const newSeats = Math.max(currentSeats - seatsBooked, 0);

            tx.update(rideRef, {
              seats_available: newSeats,
              status: newSeats > 0 ? 'available' : 'unavailable'
            });
          });
        } catch (e) {
          console.error('Error updating seats:', e);
        }
      }

      session.state = 'HOME';
      session.tempData = {};

      return `
✅ *Payment Received!*

Your ride is confirmed! 

📍 *Pickup details:*
Look for ${session.tempData.selectedRide?.driver_name}
At: ${session.tempData.selectedRide?.from}
Time: ${session.tempData.selectedRide?.departure_time}

👋 Have a great ride!
Type MENU for more options.
      `.trim();
    }

    return 'Reply "paid" when you have completed payment.';
  }

  // ========== OFFER A RIDE (DRIVER) FLOW ==========
  if (state === 'OFFER_RIDE_CHECK') {
    const choice = input.toLowerCase();
    const isYes = choice === 'a' || choice === 'yes';
    const isNo = choice === 'b' || choice === 'no';

    if (!isYes && !isNo) {
      return 'Please reply with A or B.';
    }

    if (isYes) {
      const userDoc = await db.collection('users').doc(phone).get();
      const user = userDoc.data() || {};

      if (userDoc.exists && user.role === 'driver' && user.driver_name) {
        session.tempData.driver_name = user.driver_name;
        session.state = 'OFFER_RIDE_FROM';
        return `
✅ Welcome back, ${user.driver_name}!

📍 Where are you starting from?

🏠 Oduduwa
🚪 Main gate
🏬 Campus center
🏘️ Other (type the area)
        `.trim();
      }
    }

    session.state = 'OFFER_RIDE_REGISTER_NAME';
    return `
📍 *First-time Driver Registration*

What's your driver name? (what riders will see)

Example: Tunde, Blessing, Adekunle
    `.trim();
  }

  if (state === 'OFFER_RIDE_REGISTER_NAME') {
    const driver_name = input.trim();
    if (!driver_name || driver_name.length < 2) {
      return 'Please send a valid driver name (at least 2 characters).';
    }

    await db.collection('users').doc(phone).set({
      phone,
      role: 'driver',
      driver_name,
      created_at: new Date(),
      updated_at: new Date()
    }, { merge: true });

    session.tempData.driver_name = driver_name;
    session.state = 'OFFER_RIDE_FROM';

    return `
✅ Welcome, ${driver_name}!

📍 Where are you starting from?

🏠 Oduduwa
🚪 Main gate
🏬 Campus center
🏘️ Other (type the area)
    `.trim();
  }

  if (state === 'OFFER_RIDE_FROM') {
    const from = input.trim();
    if (!from || from.length < 2) {
      return 'Please send a valid pickup location.';
    }

    session.tempData.from = from;
    session.state = 'OFFER_RIDE_TO';

    return `
✅ *From:* ${from}

📍 Where are you going to?

🏠 Oduduwa
🚪 Main gate
🏬 Market
🎓 Faculty area
🌆 Other (type area)
    `.trim();
  }

  if (state === 'OFFER_RIDE_TO') {
    const to = input.trim();
    if (!to || to.length < 2) {
      return 'Please send a valid destination.';
    }

    session.tempData.to = to;
    session.state = 'OFFER_RIDE_WHEN';

    return `
✅ *To:* ${to}

⏰ When do you want to depart?

1️⃣ Now (immediately)
2️⃣ Today
3️⃣ Tomorrow
4️⃣ This week

_Reply 1-4_
    `.trim();
  }

  if (state === 'OFFER_RIDE_WHEN') {
    const timeMap = {
      '1': 'now', 'now': 'now', 'immediately': 'now',
      '2': 'today', 'today': 'today',
      '3': 'tomorrow', 'tomorrow': 'tomorrow',
      '4': 'thisweek', 'this week': 'thisweek', 'thisweek': 'thisweek'
    };

    const departure_time = timeMap[input.toLowerCase()];
    if (!departure_time) {
      return 'Please reply with 1, 2, 3, or 4.';
    }

    session.tempData.departure_time = departure_time;
    session.state = 'OFFER_RIDE_SEATS';

    return `
⏰ Departure: ${departure_time}

🪑 How many seats are available?

Reply with a number (1, 2, 3, 4, 5, etc.)
    `.trim();
  }

  if (state === 'OFFER_RIDE_SEATS') {
    const seats = parseInt(input);
    if (isNaN(seats) || seats < 1) {
      return 'Please reply with a valid number (1, 2, 3, etc.)';
    }

    session.tempData.seats = seats;
    session.state = 'OFFER_RIDE_COST';

    return `
🪑 Seats: ${seats}

💰 Cost per seat (₦)?

Reply with a number (e.g., 50, 100, 200)
    `.trim();
  }

  if (state === 'OFFER_RIDE_COST') {
    const cost_per_seat = parseFloat(input);
    if (isNaN(cost_per_seat) || cost_per_seat <= 0) {
      return 'Please reply with a valid cost (e.g., 50, 100, 200)';
    }

    session.tempData.cost_per_seat = cost_per_seat;
    session.state = 'OFFER_RIDE_CONFIRM';

    return `
🚗 *Confirm your offered ride*

Driver: ${session.tempData.driver_name}
${session.tempData.from} → ${session.tempData.to}
Departure: ${session.tempData.departure_time}
Seats: ${session.tempData.seats}
Cost/seat: ₦${session.tempData.cost_per_seat}

Reply:
A) Confirm
B) Cancel
    `.trim();
  }

  if (state === 'OFFER_RIDE_CONFIRM') {
    const choice = input.toLowerCase();
    const isConfirm = choice === 'a' || choice === 'yes' || choice === 'confirm';
    const isCancel = choice === 'b' || choice === 'no' || choice === 'cancel';

    if (!isConfirm && !isCancel) {
      return 'Please reply with A or B.';
    }

    if (isCancel) {
      session.state = 'HOME';
      session.tempData = {};
      return 'Ride offer cancelled. Type MENU to continue.';
    }

    // Create the ride
    const ride = {
      driver_name: session.tempData.driver_name,
      driver_phone: phone,
      from: session.tempData.from,
      to: session.tempData.to,
      departure_time: session.tempData.departure_time,
      seats_available: session.tempData.seats,
      cost_per_seat: session.tempData.cost_per_seat,
      status: 'available',
      type: 'carpool',
      created_at: new Date()
    };

    try {
      const docRef = await db.collection('rides').add(ride);
      session.state = 'HOME';
      session.tempData = {};

      return `
✅ *Ride Offered Successfully!*

Ride ID: ${docRef.id}
${ride.from} → ${ride.to}

Students can now book your ride!

Type MENU for more options.
      `.trim();
    } catch (error) {
      console.error('Error creating ride:', error);
      session.state = 'HOME';
      session.tempData = {};
      return 'Error creating ride. Type MENU to try again.';
    }
  }

  // ========== PENDING REQUESTS (DRIVER) ==========
  if (state === 'PENDING_REQUESTS_VIEW') {
    // Driver is viewing pending booking requests
    const bookingNum = parseInt(input) - 1;
    const pendingBookings = session.tempData.pendingBookings || [];

    if (isNaN(bookingNum) || bookingNum < 0 || bookingNum >= pendingBookings.length) {
      return `Invalid choice. Reply 1-${pendingBookings.length}`;
    }

    const selectedBooking = pendingBookings[bookingNum];
    session.tempData.currentBookingDecision = selectedBooking;
    session.state = 'ACCEPT_REJECT_BOOKING';

    return `
🔔 *Pending Request*

Passenger: +${selectedBooking.phone.slice(-10)}
From: ${selectedBooking.from}
To: ${selectedBooking.to}
Seats: ${selectedBooking.seats}
Cost: ₦${selectedBooking.total_cost}

Accept or Reject?
A) Accept
B) Reject

_Reply A or B_
    `.trim();
  }

  if (state === 'ACCEPT_REJECT_BOOKING') {
    const choice = input.toLowerCase();
    const isAccept = choice === 'a' || choice === 'accept' || choice === 'yes';
    const isReject = choice === 'b' || choice === 'reject' || choice === 'no';

    if (!isAccept && !isReject) {
      return 'Please reply with A or B.';
    }

    const booking = session.tempData.currentBookingDecision;
    const bookingId = booking.id;
    const passengerPhone = booking.phone;

    if (isAccept) {
      // Update booking to accepted
      await db.collection('bookings').doc(bookingId).update({
        status: 'accepted',
        accepted_at: new Date()
      });

      // Notify passenger
      await sendWhatsAppMessage(`whatsapp:+${passengerPhone}`, `
✅ *Your Ride is Confirmed!*

Driver has accepted your request!

Booking ID: ${bookingId}
Driver: ${session.tempData.driver_name}
Pickup: ${booking.from}
Dropoff: ${booking.to}

Proceed to payment.
      `.trim());

      session.state = 'HOME';
      session.tempData = {};

      return `
✅ *Booking Accepted!*

Passenger notified. They will proceed to payment.

Type MENU for more options.
      `.trim();
    }

    if (isReject) {
      // Update booking to rejected
      await db.collection('bookings').doc(bookingId).update({
        status: 'rejected',
        rejected_at: new Date()
      });

      // Notify passenger
      await sendWhatsAppMessage(`whatsapp:+${passengerPhone}`, `
❌ *Ride Rejected*

Sorry, the driver couldn't accept your ride.

Booking ID: ${bookingId}

Type MENU to search for another ride.
      `.trim());

      session.state = 'HOME';
      session.tempData = {};

      return `
✅ *Booking Rejected*

Passenger notified. 

Type MENU for more options.
      `.trim();
    }
  }

  // ========== RATE A RIDE FLOW ==========
  if (state === 'RATE_RIDE_LIST') {
    const rating = parseInt(input);
    if (![1, 2, 3, 4, 5].includes(rating)) {
      return 'Please reply with a rating: 1, 2, 3, 4, or 5.';
    }

    const bookingId = session.tempData.rateBookingId;
    if (!bookingId) {
      session.state = 'MENU_CHOICE';
      return 'No booking found to rate. Type MENU and try again.';
    }

    try {
      await db.collection('bookings').doc(bookingId).update({
        rider_rating: rating,
        rated_at: new Date(),
        status: 'completed'
      });

      session.state = 'HOME';
      session.tempData = {};

      return `
🙏 *Thanks for rating!*

Your rating has been saved.

Type MENU to continue.
      `.trim();
    } catch (error) {
      console.error('Error rating:', error);
      session.state = 'HOME';
      session.tempData = {};
      return 'Error saving rating. Type MENU to continue.';
    }
  }

  // Fallback
  session.state = 'HOME';
  session.tempData = {};
  return 'Something went wrong. Type MENU to restart.';
}

// ============================================
// HELPER FUNCTIONS
// ============================================

async function searchRides(from, to, when) {
  try {
    const snapshot = await db.collection('rides').where('status', '==', 'available').get();
    const rides = [];

    const fromQ = normalizeText(from);
    const toQ = normalizeText(to);

    snapshot.forEach(doc => {
      const ride = doc.data();
      const rideFrom = normalizeText(ride.from);
      const rideTo = normalizeText(ride.to);

      if (rideFrom.includes(fromQ) && rideTo.includes(toQ)) {
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

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function createBooking(phone, tempData) {
  const booking = {
    phone,
    ride_id: tempData.selectedRide?.id || '',
    seats: tempData.seats || 1,
    total_cost: tempData.totalCost || 0,
    status: 'pending', // Changed from 'pending' - now driver must accept
    from: tempData.from || '',
    to: tempData.to || '',
    created_at: new Date()
  };

  const docRef = await db.collection('bookings').add(booking);
  return { id: docRef.id, ...booking };
}

async function notifyDriverPendingRequest(driver_phone, booking) {
  const message = `
🔔 *New Ride Request*

Passenger: +${booking.phone.slice(-10)}
From: ${booking.from}
To: ${booking.to}
Seats: ${booking.seats}
Total: ₦${booking.total_cost}

Go to Menu → Option 4 to accept or reject!
  `.trim();

  await sendWhatsAppMessage(`whatsapp:+${driver_phone}`, message).catch(e => console.error('Error notifying driver:', e));
}

async function showPendingRequests(phone, session) {
  try {
    // Get rides offered by this driver
    const ridesSnapshot = await db.collection('rides')
      .where('driver_phone', '==', phone)
      .get();

    const rideIds = ridesSnapshot.docs.map(doc => doc.id);

    if (rideIds.length === 0) {
      return 'You haven\'t offered any rides yet. Type MENU and choose option 2 to offer a ride!';
    }

    // Get pending bookings for these rides
    const bookingsSnapshot = await db.collection('bookings')
      .where('ride_id', 'in', rideIds)
      .where('status', '==', 'pending')
      .get();

    if (bookingsSnapshot.empty) {
      return 'No pending requests at the moment.';
    }

    let response = `🔔 *Pending Requests* (${bookingsSnapshot.size})\n\n`;
    const pendingBookings = [];

    bookingsSnapshot.forEach((doc, i) => {
      const booking = doc.data();
      pendingBookings.push({ id: doc.id, ...booking });

      response += `${i + 1}. +${booking.phone.slice(-10)}
From: ${booking.from}
Seats: ${booking.seats} | ₦${booking.total_cost}
\n`;
    });

    response += `_Reply with number to accept/reject_`;

    session.tempData.pendingBookings = pendingBookings;
    session.state = 'PENDING_REQUESTS_VIEW';

    return response;
  } catch (error) {
    console.error('Error loading pending requests:', error);
    session.state = 'MENU_CHOICE';
    return 'Error loading requests. Type MENU to continue.';
  }
}

async function showMyBookings(phone) {
  try {
    const snapshot = await db.collection('bookings')
      .where('phone', '==', phone)
      .orderBy('created_at', 'desc')
      .limit(5)
      .get();

    if (snapshot.empty) {
      return '📋 No bookings yet. Type MENU and choose option 1 to find a ride!';
    }

    let response = '📋 *Your Recent Bookings*\n\n';

    snapshot.forEach((doc, i) => {
      const booking = doc.data();
      response += `${i + 1}. ${booking.from} → ${booking.to}\n`;
      response += `Status: ${booking.status.toUpperCase()} | ₦${booking.total_cost}\n\n`;
    });

    response += 'Type MENU to go back.';
    return response;
  } catch (error) {
    console.error('Error loading bookings:', error);
    return 'Error loading bookings. Type MENU to continue.';
  }
}

async function showProfile(phone) {
  try {
    const userDoc = await db.collection('users').doc(phone).get();
    const user = userDoc.data() || {};

    const bookingsSnapshot = await db.collection('bookings')
      .where('phone', '==', phone)
      .get();

    let profile = `👤 *Your Profile*\n\n`;
    profile += `📞 Phone: ${phone}\n`;
    profile += `🎫 Rides Booked: ${bookingsSnapshot.size}\n`;
    profile += `⭐ Rating: ${user.rating ? user.rating.toFixed(1) : 'N/A'}\n`;

    if (user.role === 'driver') {
      profile += `🚗 Driver Name: ${user.driver_name || 'N/A'}\n`;
      profile += `🚙 Rides Offered: ${user.rides_offered || 0}\n`;
    }

    profile += `📅 Member since: ${user.created_at ? new Date(user.created_at).toLocaleDateString() : 'New'}\n\n`;
    profile += 'Type MENU to go back.';

    return profile;
  } catch (error) {
    console.error('Error loading profile:', error);
    return 'Error loading profile. Type MENU to continue.';
  }
}

async function showRidesToRate(phone, session) {
  try {
    const snapshot = await db.collection('bookings')
      .where('phone', '==', phone)
      .where('status', '==', 'confirmed')
      .orderBy('created_at', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) {
      session.state = 'MENU_CHOICE';
      return '⭐ No confirmed rides to rate yet. Type MENU to continue.';
    }

    const bookingSnap = snapshot.docs[0];
    const booking = bookingSnap.data();

    session.tempData.rateBookingId = bookingSnap.id;
    session.state = 'RATE_RIDE_LIST';

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
    console.error('Error loading rides to rate:', error);
    session.state = 'MENU_CHOICE';
    return 'Error loading rides. Type MENU to continue.';
  }
}

function showHelp() {
  return `
❓ *Help & Support*

*Student:*
1️⃣ Find a ride → Menu → Option 1
2️⃣ Book and pay → Follow prompts
3️⃣ Driver accepts/rejects → Wait for notification

*Driver:*
1️⃣ Offer a ride → Menu → Option 2
2️⃣ Check requests → Menu → Option 4
3️⃣ Accept/Reject → Respond to pending requests

*Payment:*
- Bank transfer or USSD after booking

*Support:*
📞 Available 8AM - 8PM

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
    console.error('Admin endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const ridesSnapshot = await db.collection('rides').get();
    const bookingsSnapshot = await db.collection('bookings').get();
    const usersSnapshot = await db.collection('users').get();

    const totalRevenue = bookingsSnapshot.docs
      .filter(d => ['confirmed', 'completed'].includes((d.data().status || '').toLowerCase()))
      .reduce((sum, d) => sum + (Number(d.data().total_cost) || 0), 0);

    res.json({
      total_rides: ridesSnapshot.size,
      total_bookings: bookingsSnapshot.size,
      total_users: usersSnapshot.size,
      total_revenue: totalRevenue
    });
  } catch (error) {
    console.error('Stats endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// START SERVER
// ============================================

// Check if we are running on Vercel (Vercel sets the VERCEL environment variable)
if (process.env.NODE_ENV !== 'production') {
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
}

// CRITICAL: Vercel needs this line to work
module.exports = app;