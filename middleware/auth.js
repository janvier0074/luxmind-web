const { getDB } = require('../config/database');

async function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
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