# 🚀 CampusMove
**The WhatsApp AI Agent Bridging the Last-Mile Transport Gap at OAU via Stellar Blockchain**

---

## 🛠️ The Problem & Innovation
Over 10,000 students at OAU face a daily struggle: buses stop at the main gates, leaving a 10–20 minute walk to faculty buildings in harsh weather. While private shuttles exist, they are often uncoordinated and rely on fragmented cash payments.

**CampusMove** solves this by turning WhatsApp into a transport marketplace powered by the Stellar Blockchain. We have created a **conversational agent** that is instant, transparent, and requires zero technical setup for the user. We built a working MVP that eliminates the "last-mile" gap using decentralized payments, ensuring students get to class on time while drivers fill empty seats efficiently.

---

## 🤖 The Agent Experience (Q&A Flow)
Unlike complex apps, CampusMove works through a simple **Question and Answer interaction**. The agent maintains user state to guide them through the process:

1. **The Trigger:** User texts "Hi" to the WhatsApp number.
2. **The Question:** The Agent asks: *"Are you looking for a ride or offering one?"*
3. **The Input:** The student provides their current location and faculty destination.
4. **The Match:** The Agent queries the database and returns available drivers: *"Driver [Name] is leaving soon. Book now?"*
5. **The Settlement:** Upon confirmation, the Agent triggers a Stellar transaction and sends a digital receipt.

---

## 🏗️ Technical Architecture
The system is optimized for high accessibility and low-data usage, ideal for a campus environment.

* **Messaging:** Twilio WhatsApp API provides a familiar, text-based conversational interface.
* **Backend:** Node.js + Express server managing session states and ride-matching logic.
* **Database:** Firebase Firestore for real-time synchronization of ride offers and student requests.
* **Payments & Currency:** * **Stellar Blockchain (Testnet):** For secure, low-fee peer-to-peer settlement.
    * **Naira Integration:** While the backend settles on-chain, the interface **displays all costs in Naira (₦)** to ensure a seamless experience for the OAU community.

---

## 📂 Repository Structure
```text
CampusMove/
├── index.js                # Main Agent Logic: Handles Twilio webhooks & conversational state
├── firebase.js             # Data Layer: Real-time Firestore listeners for ride matching
├── stellar.js              # Payment Layer: Wallet creation and transaction signing
├── .env.example            # Template for environment variables
├── .gitignore              # Security: Ensures API keys are not leaked
└── README.md               # Product and technical documentation
```

## 🚀 Setup & Installation

1. Clone the Repository:
```text
git clone https://github.com/Beutife/CampusMove.git
cd CampusMove
```
3. Install Dependencies:
```text
npm install express twilio firebase-admin stellar-sdk dotenv
```
5. Environment Setup:
Create a .env file in the root directory and populate it with your credentials:
PORT=3000
TWILIO_ACCOUNT_SID=your_sid
TWILIO_AUTH_TOKEN=your_token
TWILIO_PHONE_NUMBER=whatsapp:+14155238886
FIREBASE_SERVICE_ACCOUNT_KEY=path_to_your_json
STELLAR_NETWORK=TESTNET
STELLAR_SOURCE_SECRET=your_testnet_secret

6. Database & Blockchain Configuration:
- Firebase: Enable Cloud Firestore in the Firebase Console. Generate a Service Account JSON key, download it, and add the path to your .env file.
- Stellar: Create and fund a testnet account via the Stellar Laboratory to act as the funding source for transactions.

5. Local Testing:
- Start the server: node index.js
- Expose to Web: Use ngrok to tunnel your local port (e.g., 3000) to a public URL: ngrok http 3000
- Twilio Config: Copy your ngrok URL and paste it into the "A message comes in" field in your Twilio Sandbox settings.

---

## 🛡️ Security & Transparency
All payments are settled on the Stellar Testnet. Each successful ride booking generates a unique Transaction Hash, ensuring that both students and drivers have an immutable record of payment, reducing disputes and increasing trust within the campus community.

---

## 👥 The Team
Developed in a 5-day high-intensity sprint by:

* Beulah Ude: Blockchain Developer, Student of OAU
* Jennifer Scottbello (Jesdi): Project Manager & Smart Contract Developer
