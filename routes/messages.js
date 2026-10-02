const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

// ---------- INBOX ----------
router.get('/messages', requireLogin, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  const inbox = await db.all(`
    SELECT m.*, u.full_name AS sender_name, u.username AS sender_username
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.receiver_id = ?
    ORDER BY m.created_at DESC
    LIMIT 100
  `, [uid]);

  const sent = await db.all(`
    SELECT m.*, u.full_name AS receiver_name, u.username AS receiver_username
    FROM messages m
    JOIN users u ON u.id = m.receiver_id
    WHERE m.sender_id = ?
    ORDER BY m.created_at DESC
    LIMIT 100
  `, [uid]);

  const unread = await db.get(
    'SELECT COUNT(*) c FROM messages WHERE receiver_id = ? AND is_read = 0',
    [uid]
  );

  res.render('messages/inbox', {
    title: 'Messages',
    heading: 'Messages',
    subtitle: 'Your conversations.',
    inbox, sent, unread: unread.c,
  });
});

// ---------- COMPOSE ----------
router.get('/messages/new', requireLogin, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  // pick recipients: teachers if student, students if teacher, everyone if admin
  let query;
  const role = req.session.user.role;
  if (role === 'student') {
    query = "SELECT id, username, full_name, role FROM users WHERE role IN ('teacher','admin') AND is_active = 1 ORDER BY full_name";
  } else if (role === 'teacher') {
    query = "SELECT id, username, full_name, role FROM users WHERE role IN ('student','admin') AND is_active = 1 ORDER BY full_name";
  } else {
    query = "SELECT id, username, full_name, role FROM users WHERE is_active = 1 ORDER BY full_name";
  }
  const recipients = await db.all(query);

  res.render('messages/compose', {
    title: 'New Message',
    heading: 'New Message',
    subtitle: 'Send a private message.',
    recipients,
    preset: req.query.to ? Number(req.query.to) : null,
  });
});

router.post('/messages/new', requireLogin, async (req, res) => {
  const db = getDB();
  const { receiver_id, body } = req.body;
  if (!receiver_id || !body || !body.trim()) {
    req.flash('error', 'Please pick a recipient and write a message.');
    return res.redirect('/messages/new');
  }
  if (Number(receiver_id) === req.session.user.id) {
    req.flash('error', 'You cannot message yourself.');
    return res.redirect('/messages/new');
  }
  await db.run(
    'INSERT INTO messages (sender_id, receiver_id, body) VALUES (?,?,?)',
    [req.session.user.id, Number(receiver_id), body.trim()]
  );
  // create a notification for the recipient
  const sender = await db.get('SELECT full_name, username FROM users WHERE id = ?', [req.session.user.id]);
  await db.run(
    'INSERT INTO notifications (user_id, title, body, link) VALUES (?,?,?,?)',
    [Number(receiver_id), 'New message from ' + (sender.full_name || sender.username), body.slice(0, 80), '/messages']
  );

  req.flash('success', 'Message sent.');
  res.redirect('/messages');
});

// ---------- MARK READ ----------
router.post('/messages/:id/read', requireLogin, async (req, res) => {
  const db = getDB();
  await db.run(
    'UPDATE messages SET is_read = 1 WHERE id = ? AND receiver_id = ?',
    [req.params.id, req.session.user.id]
  );
  res.json({ ok: true });
});

// ---------- DELETE ----------
router.post('/messages/:id/delete', requireLogin, async (req, res) => {
  const db = getDB();
  await db.run(
    'DELETE FROM messages WHERE id = ? AND (sender_id = ? OR receiver_id = ?)',
    [req.params.id, req.session.user.id, req.session.user.id]
  );
  req.flash('success', 'Message deleted.');
  res.redirect('/messages');
});


module.exports = router;