const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDB } = require('../config/database');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

// --- avatar upload config ---
const avatarDir = path.join(__dirname, '..', 'uploads', 'avatars');
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `user-${req.session.user.id}-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpg|jpeg|png|gif|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only images allowed'), ok);
  },
});

// ---------- VIEW ----------
router.get('/profile', requireLogin, async (req, res) => {
  const db = getDB();
  const user = await db.get(
    'SELECT id, username, email, role, full_name, bio, avatar_path, created_at FROM users WHERE id = ?',
    [req.session.user.id]
  );

  const stats = {
    enrollments: (await db.get('SELECT COUNT(*) c FROM enrollments WHERE user_id = ?', [user.id])).c,
    lessonsDone: (await db.get('SELECT COUNT(*) c FROM progress WHERE user_id = ? AND completed = 1', [user.id])).c,
    messages: (await db.get('SELECT COUNT(*) c FROM messages WHERE receiver_id = ?', [user.id])).c,
  };

  res.render('profile/view', {
    title: 'My Profile',
    heading: 'My Profile',
    subtitle: 'Your public identity on LuxMind.',
    profile: user,
    stats,
  });
});

// ---------- EDIT ----------
router.get('/profile/edit', requireLogin, async (req, res) => {
  const db = getDB();
  const user = await db.get(
    'SELECT id, username, email, role, full_name, bio, avatar_path FROM users WHERE id = ?',
    [req.session.user.id]
  );
  res.render('profile/edit', {
    title: 'Edit Profile',
    heading: 'Edit Profile',
    subtitle: 'Update your personal information.',
    profile: user,
  });
});

router.post('/profile/edit', requireLogin, upload.single('avatar'), async (req, res) => {
  const db = getDB();
  const { full_name, email, bio } = req.body;
  const uid = req.session.user.id;

  const current = await db.get('SELECT avatar_path FROM users WHERE id = ?', [uid]);
  let avatar = current.avatar_path;

  if (req.file) {
    // delete old avatar file if exists
    if (avatar) {
      const old = path.join(__dirname, '..', avatar.replace(/^\/+/, ''));
      if (fs.existsSync(old)) try { fs.unlinkSync(old); } catch (e) {}
    }
    // store relative path we can serve via /uploads/...
    avatar = '/uploads/avatars/' + req.file.filename;
  }

  await db.run(
    'UPDATE users SET full_name = ?, email = ?, bio = ?, avatar_path = ? WHERE id = ?',
    [full_name || null, email || null, bio || null, avatar, uid]
  );

  // update session display name
  req.session.user.full_name = full_name || req.session.user.username;

  req.flash('success', 'Profile updated.');
  res.redirect('/profile');
});

// ---------- CHANGE PASSWORD ----------
router.get('/profile/password', requireLogin, (req, res) => {
  res.render('profile/password', {
    title: 'Change Password',
    heading: 'Change Password',
    subtitle: 'Keep your account secure.',
  });
});

router.post('/profile/password', requireLogin, async (req, res) => {
  const { current, next, confirm } = req.body;
  const db = getDB();
  const uid = req.session.user.id;

  const user = await db.get('SELECT password FROM users WHERE id = ?', [uid]);

  if (!(await bcrypt.compare(current, user.password))) {
    req.flash('error', 'Current password is incorrect.');
    return res.redirect('/profile/password');
  }
  if (!next || next.length < 6) {
    req.flash('error', 'New password must be at least 6 characters.');
    return res.redirect('/profile/password');
  }
  if (next !== confirm) {
    req.flash('error', 'Passwords do not match.');
    return res.redirect('/profile/password');
  }

  const hash = await bcrypt.hash(next, 10);
  await db.run('UPDATE users SET password = ? WHERE id = ?', [hash, uid]);

  req.flash('success', 'Password changed successfully.');
  res.redirect('/profile');
});

module.exports = router;