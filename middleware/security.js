const rateLimit = require('express-rate-limit');

console.log('🔒 Security middleware loaded');

// Login: applies to ALL requests to /login (page + POST)
// Includes successful requests so page-refresh floods get blocked
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    console.log('🚫 LOGIN RATE LIMIT HIT — IP:', req.ip);
    res.status(429).send(
      '<html><body style="font-family:system-ui;padding:3rem;background:#f4f6fa;text-align:center">' +
      '<h1 style="color:#dc2626">Too many requests</h1>' +
      '<p>You have made too many requests to the login page. Please try again in 15 minutes.</p>' +
      '<a href="/" style="color:#6366f1">← Go home</a></body></html>'
    );
  },
});

// Register: 10 per hour
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log('🚫 REGISTER RATE LIMIT HIT — IP:', req.ip);
    res.status(429).send('<h1>Too many registration attempts</h1><p>Please try again later.</p>');
  },
});

// Forgot password: 10 per hour
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

// Global: 500 per 15 minutes per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 500,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { loginLimiter, registerLimiter, forgotLimiter, globalLimiter };