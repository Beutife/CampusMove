/**
 * scripts/seed.js
 * Run once to seed Firestore with providers and a test ride.
 *
 * Usage:
 *   node scripts/seed.js
 */

const path  = require('path');
const admin = require('firebase-admin');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function getCredential() {
  const p = path.join(__dirname, '..', 'serviceAccountKey.json');
  const fs = require('fs');
  if (fs.existsSync(p)) {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data.project_id) return admin.credential.cert(data);
  }
  return admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  });
}

if (!admin.apps.length) admin.initializeApp({ credential: getCredential() });
const db = admin.firestore();

async function seed() {
  console.log('🌱 Seeding Firestore...\n');

  // ── Providers ────────────────────────────────
  const providers = [
    { id: 'campus_shuttles',   name: 'Campus Shuttles',       type: 'shuttle',   contact_phone: '08012345678' },
    { id: 'ife_express',       name: 'Ife Express',           type: 'taxi',      contact_phone: '08023456789' },
    { id: 'oau_keke_union',    name: 'OAU Keke Union',        type: 'tricycle',  contact_phone: '08034567890' },
    { id: 'student_cab_co',    name: 'Student Cab Co',        type: 'carpool',   contact_phone: '08045678901' },
    { id: 'independent',       name: 'Independent Driver',    type: 'various',   contact_phone: '' },
  ];

  for (const p of providers) {
    await db.collection('providers').doc(p.id).set({ ...p, active: true, created_at: Date.now() });
    console.log(`✅ Provider: ${p.name}`);
  }

  // ── Sample rides ─────────────────────────────
  const rides = [
    {
      driver_name:     'Tunde A.',
      driver_phone:    '2348012345678',
      provider_id:     'campus_shuttles',
      provider_name:   'Campus Shuttles',
      vehicle_type:    'Bus',
      from:            'Main Gate',
      to:              'Faculty Area',
      departure_time:  '7:30am',
      seats_available: 8,
      cost_per_seat:   150,
      status:          'available',
      created_at:      Date.now(),
    },
    {
      driver_name:     'Blessing O.',
      driver_phone:    '2348099887766',
      provider_id:     'student_cab_co',
      provider_name:   'Student Cab Co',
      vehicle_type:    'Car',
      from:            'Moremi Hall',
      to:              'Main Gate',
      departure_time:  'Now',
      seats_available: 3,
      cost_per_seat:   200,
      status:          'available',
      created_at:      Date.now(),
    },
  ];

  for (const r of rides) {
    const ref = await db.collection('rides').add(r);
    console.log(`✅ Ride: ${r.from} → ${r.to} (${ref.id})`);
  }

  console.log('\n🎉 Seed complete!');
  process.exit(0);
}

seed().catch(err => { console.error(' Seed error:', err); process.exit(1); });