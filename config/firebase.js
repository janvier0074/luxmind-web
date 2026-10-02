const path = require('path');
const fs = require('fs');

const serviceAccountPath = path.join(__dirname, '..', 'firebase-service-account.json');

if (!fs.existsSync(serviceAccountPath)) {
  console.error('Missing file:', serviceAccountPath);
  process.exit(1);
}

const serviceAccount = require(serviceAccountPath);

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

if (getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount)
  });
  console.log('Firebase Admin initialized');
}

const auth = getAuth();

module.exports = { auth };
