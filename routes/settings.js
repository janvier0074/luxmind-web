const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin } = require('../middleware/auth');
const { DEFAULT_SETTINGS } = require('../config/constants');
const router = express.Router();

// helper: get all settings for a user as an object
async function getSettings(db, userId) {
  const rows = await db.all('SELECT key, value FROM settings WHERE user_id = ?', [userId]);
  const map = { ...DEFAULT_SETTINGS };
  rows.forEach(r => { map[r.key] = r.value; });
  return map;
}

// helper: upsert one setting
async function setSetting(db, userId, key, value) {
  const existing = await db.get(
    'SELECT id FROM settings WHERE user_id = ? AND key = ?',
    [userId, key]
  );
  if (existing) {
    await db.run('UPDATE settings SET value = ? WHERE id = ?', [String(value), existing.id]);
  } else {
    await db.run(
      'INSERT INTO settings (user_id, key, value) VALUES (?,?,?)',
      [userId, key, String(value)]
    );
  }
}

// ---------- PAGE ----------
router.get('/settings', requireLogin, async (req, res) => {
  const db = getDB();
  const settings = await getSettings(db, req.session.user.id);
  const tab = req.query.tab || 'general';

  res.render('settings/index', {
    title: 'Settings',
    heading: 'Settings',
    subtitle: 'Customize how LuxMind works for you.',
    settings,
    tab,
  });
});

// ---------- SAVE ----------
router.post('/settings/general', requireLogin, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  await setSetting(db, uid, 'language', req.body.language || 'en');
  req.flash('success', 'General settings saved.');
  res.redirect('/settings?tab=general');
});

router.post('/settings/notifications', requireLogin, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const keys = ['email_notifications', 'push_notifications', 'course_updates', 'quiz_releases', 'messages'];
  for (const k of keys) {
    await setSetting(db, uid, k, req.body[k] ? 'true' : 'false');
  }
  req.flash('success', 'Notification preferences saved.');
  res.redirect('/settings?tab=notifications');
});

router.post('/settings/appearance', requireLogin, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  await setSetting(db, uid, 'theme', req.body.theme || 'light');
  req.flash('success', 'Appearance updated.');
  res.redirect('/settings?tab=appearance');
});

router.post('/settings/privacy', requireLogin, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  await setSetting(db, uid, 'profile_visibility', req.body.profile_visibility || 'classmates');
  req.flash('success', 'Privacy settings saved.');
  res.redirect('/settings?tab=privacy');
});

// ---------- DANGER: DELETE ACCOUNT ----------
router.post('/settings/delete', requireLogin, async (req, res) => {
  if (req.body.confirm !== 'DELETE') {
    req.flash('error', 'Type DELETE to confirm.');
    return res.redirect('/settings?tab=account');
  }
  const db = getDB();
  const uid = req.session.user.id;
  await db.run('DELETE FROM users WHERE id = ?', [uid]);
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;