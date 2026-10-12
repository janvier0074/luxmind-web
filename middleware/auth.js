const { getDB } = require('../config/database');

async function touchLastSeen(req) {
  if (!req.session || !req.session.user) return;
  try {
    const db = getDB();
    await db.run(
      'UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = $1',
      [req.session.user.id]
    );
  } catch (e) { /* ignore */ }
}

async function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');

  touchLastSeen(req);

  // Defaults so views don't crash
  res.locals.unreadAnnouncements = 0;
  res.locals.unreadMessages = 0;

  try {
    const db = getDB();
    const uid = req.session.user.id;

    // Unread messages — for every role
    const msgRow = await db.get(
      'SELECT COUNT(*) AS c FROM messages WHERE receiver_id = $1 AND is_read = 0',
      [uid]
    );
    res.locals.unreadMessages = msgRow.c || 0;

    // Unread announcements — students only
    if (req.session.user.role === 'student') {
      const annRow = await db.get(`
        SELECT COUNT(*) AS c
        FROM announcements a
        JOIN courses c ON c.id = a.course_id
        JOIN enrollments e ON e.course_id = c.id AND e.user_id = $1
        WHERE a.created_at > COALESCE(
          (SELECT announcements_seen_at FROM users WHERE id = $2),
          '1970-01-01'
        )
      `, [uid, uid]);
      res.locals.unreadAnnouncements = annRow.c || 0;
    }
  } catch (e) {
    console.error('Badge count error:', e.message);
  }

  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role !== role) {
      return res.status(403).render('errors/403');
    }
    next();
  };
}

module.exports = { requireLogin, requireRole };