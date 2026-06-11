# 🚀 CampusMove
**The WhatsApp AI Agent Bridging the Last-Mile Transport Gap at OAU via Paystack**

---

## 🛠️ The Problem & Innovation
Over 10,000 students at OAU face a daily struggle: buses stop at the main gates, leaving a 10–20 minute walk to faculty buildings in harsh weather. While private shuttles exist, they are often uncoordinated and rely on fragmented cash payments.

**CampusMove** solves this by turning WhatsApp into a transport marketplace powered by **Paystack**. We have created a **conversational agent** that is instant, transparent, and requires zero technical setup for the user. We built a working MVP that eliminates the "last-mile" gap using secure digital payments, ensuring students get to class on time while drivers fill empty seats efficiently.

---

## 🤖 The Agent Experience (Q&A Flow)
Unlike complex apps, CampusMove works through a simple **Question and Answer interaction**. The agent maintains user state to guide them through the process:

1. **The Trigger:** User texts "Hi" to the WhatsApp number.
2. **The Question:** The Agent asks: *"Are you looking for a ride or offering one?"*
3. **The Input:** The student provides their current location and faculty destination.
4. **The Match:** The Agent queries the database and returns available drivers: *"Driver [Name] is leaving soon. Book now?"*
5. **The Settlement:** Upon driver acceptance, the passenger pays via Paystack and the booking is confirmed.

---

## 🏗️ Technical Architecture
The system is optimized for high accessibility and low-data usage, ideal for a campus environment.

* **Messaging:** Twilio WhatsApp API provides a familiar, text-based conversational interface.
* **Backend:** Node.js + Express server managing session states and ride-matching logic.
* **Database:** Firebase Firestore for real-time synchronization of ride offers and student requests.
* **Payments:** Paystack payment page for secure Naira (₦) checkout.

---

## 📂 Repository Structure
```text
CampusMove/
├── api/index.js            # Main Agent Logic: Twilio webhooks, booking flow, Paystack webhook
├── utils/paymentHandler.js # Paystack payment link and webhook verification
├── utils/verificationService.js # Payment receipt storage in Firestore
├── .env                    # Environment variables (not committed)
├── .gitignore              # Security: Ensures API keys are not leaked
└── README.md               # Product and technical documentation
```

## 🚀 Setup & Installation

1. Clone the Repository:
```text
git clone https://github.com/Beutife/CampusMove.git
cd CampusMove
```
2. Install Dependencies:
```text
npm install
```
3. Environment Setup:
Create a `.env` file in the root directory:
```text
PORT=3000
TWILIO_ACCOUNT_SID=your_sid
TWILIO_AUTH_TOKEN=your_token
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_CLIENT_EMAIL=your_service_account_email
FIREBASE_PRIVATE_KEY=your_private_key
PAYSTACK_PAYMENT_PAGE_URL=https://paystack.shop/pay/1hmgcaheci
PAYSTACK_SECRET_KEY=your_paystack_secret_key
```

4. Database & Payment Configuration:
- **Firebase:** Enable Cloud Firestore in the Firebase Console. Add service account credentials to your `.env`.
- **Paystack:** Use your [Paystack payment page](https://paystack.shop/pay/1hmgcaheci). Add your secret key and set the webhook URL in the Paystack dashboard to `https://your-domain/api/paystack/webhook`.

5. Local Testing:
- Start the server: `node api/index.js`
- Expose to Web: Use ngrok to tunnel your local port (e.g., 3000) to a public URL: `ngrok http 3000`
- Twilio Config: Copy your ngrok URL and paste it into the "A message comes in" field in your Twilio Sandbox settings.

---

## 🛡️ Security & Transparency
All payments are processed through Paystack. Each successful ride booking stores a payment reference in Firestore, giving both students and drivers a clear record of payment and reducing disputes within the campus community.

---

## 👥 The Team
Developed in a 5-day high-intensity sprint by:

* Beulah Ude: Developer, Student of OAU
* Jennifer Scottbello (Jesdi): Project Manager
