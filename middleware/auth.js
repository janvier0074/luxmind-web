const { getDB } = require('../config/database');

// Middleware: update last_seen timestamp on every authenticated request
async function touchLastSeen(req) {
  if (!req.session || !req.session.user) return;
  try {
    const db = getDB();
    await db.run(
      'UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?',
      [req.session.user.id]
    );
  } catch (e) { /* ignore */ }
}

async function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  // fire-and-forget update
  touchLastSeen(req);
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