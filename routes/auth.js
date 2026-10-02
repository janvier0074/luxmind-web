const express = require('express');
const { getDB } = require('../config/database');
const { auth } = require('../config/firebase');

const path = require('path');
const fs = require('fs');

const router = express.Router();

// ---------- LOGIN PAGE ----------
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('auth/login');
});

// ---------- VERIFY FIREBASE TOKEN → SESSION (auto-creates if needed) ----------
router.post('/login', async (req, res) => {
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'Missing token' });

  try {
    const decoded = await auth.verifyIdToken(idToken);
    const email = (decoded.email || '').toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email missing in token.' });

    const db = getDB();
    let user = await db.get('SELECT * FROM users WHERE LOWER(email) = ?', [email]);

    // AUTO-CREATE if not in SQLite yet
    if (!user) {
      let baseUsername = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '') || 'user';
      let username = baseUsername;
      let counter = 1;
      while (await db.get('SELECT id FROM users WHERE username = ?', [username])) {
        username = baseUsername + counter++;
      }

      const fullName = decoded.name || username;

      const result = await db.run(
        'INSERT INTO users (username, email, password, role, full_name) VALUES (?, ?, ?, ?, ?)',
        [username, email, 'FIREBASE_AUTH', 'student', fullName]
      );

      // default settings
      try {
        const { DEFAULT_SETTINGS } = require('../config/constants');
        for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
          await db.run(
            'INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)',
            [result.lastID, k, v]
          );
        }
      } catch (e) { /* ignore */ }

      user = {
        id: result.lastID,
        username,
        full_name: fullName,
        role: 'student',
        email,
      };
      console.log('Auto-created SQLite user for: ' + email);
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      full_name: user.full_name || user.username,
      role: user.role,
      email: user.email,
      firebaseUid: decoded.uid,
    };

    return res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    console.error('Login failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired credentials.' });
  }
});

// ---------- REGISTER PAGE ----------
router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('auth/register');
});

// ---------- SERVER-SIDE REGISTER (called by register page) ----------
router.post('/register', async (req, res) => {
  const { idToken, full_name } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'Missing token' });

  try {
    const decoded = await auth.verifyIdToken(idToken);
    const email = (decoded.email || '').toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email missing.' });

    const db = getDB();
    let existing = await db.get('SELECT * FROM users WHERE LOWER(email) = ?', [email]);

    if (existing) {
      req.session.user = {
        id: existing.id,
        username: existing.username,
        full_name: existing.full_name || existing.username,
        role: existing.role,
        email: existing.email,
        firebaseUid: decoded.uid,
      };
      return res.json({ success: true, redirect: '/dashboard' });
    }

    let baseUsername = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '') || 'user';
    let username = baseUsername;
    let counter = 1;
    while (await db.get('SELECT id FROM users WHERE username = ?', [username])) {
      username = baseUsername + counter++;
    }

    const result = await db.run(
      'INSERT INTO users (username, email, password, role, full_name) VALUES (?, ?, ?, ?, ?)',
      [username, email, 'FIREBASE_AUTH', 'student', full_name || username]
    );

    try {
      const { DEFAULT_SETTINGS } = require('../config/constants');
      for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        await db.run(
          'INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)',
          [result.lastID, k, v]
        );
      }
    } catch (e) { /* ignore */ }

    req.session.user = {
      id: result.lastID,
      username,
      full_name: full_name || username,
      role: 'student',
      email,
      firebaseUid: decoded.uid,
    };

    return res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    console.error('Register failed:', err.message);
    return res.status(400).json({ error: 'Registration failed: ' + err.message });
  }
});

// ---------- LOGOUT ----------
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});
// ---------- FORGOT PASSWORD PAGE ----------
router.get('/forgot-password', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('auth/forgot-password');
});

// ---------- RESET PASSWORD PAGE (Firebase redirects here) ----------
router.get('/reset-password', (req, res) => {
  res.render('auth/reset-password', {
    oobCode: req.query.oobCode || '',
  });
});

module.exports = router;