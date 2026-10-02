const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

router.get('/notifications', requireLogin, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  const list = await db.all(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 60',
    [uid]
  );

  const unread = await db.get(
    'SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0',
    [uid]
  );

  await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [uid]);

  res.render('notifications/list', {
    title: 'Notifications',
    heading: 'Notifications',
    subtitle: 'Recent activity.',
    list,
    unreadCount: unread.c,
  });
});

router.post('/notifications/clear', requireLogin, async (req, res) => {
  await getDB().run('DELETE FROM notifications WHERE user_id = ?', [req.session.user.id]);
  req.flash('success', 'Notifications cleared.');
  res.redirect('/notifications');
});

module.exports = router;