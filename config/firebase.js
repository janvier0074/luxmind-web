const path = require('path');
const fs = require('fs');

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

let serviceAccount = null;

// Priority 1: environment variable (Base64-encoded) — for production
if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
  try {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
    serviceAccount = JSON.parse(decoded);
    console.log('Firebase: loaded from env variable');
  } catch (e) {
    console.error('Firebase: failed to parse FIREBASE_SERVICE_ACCOUNT_B64', e.message);
    process.exit(1);
  }
}

// Priority 2: local JSON file — for development
if (!serviceAccount) {
  const localPath = path.join(__dirname, '..', 'firebase-service-account.json');
  if (fs.existsSync(localPath)) {
    serviceAccount = require(localPath);
    console.log('Firebase: loaded from local file');
  }
}

if (!serviceAccount) {
  console.error('❌ Firebase credentials not found.');
  console.error('   Set FIREBASE_SERVICE_ACCOUNT_B64 env var, or provide firebase-service-account.json');
  process.exit(1);
}

if (getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount)
  });
  console.log('✅ Firebase Admin initialized');
}

const auth = getAuth();

module.exports = { auth };