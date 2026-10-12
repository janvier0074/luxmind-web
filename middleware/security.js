const rateLimit = require('express-rate-limit');

console.log('🔒 Security middleware loaded');

// Basically no limits for real users — only blocks bots.
// A school with 200 students sharing one WiFi = 1 IP = OK.

// Login: 5000 requests per hour per IP (students can refresh freely)
const loginLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  limit: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only count FAILED logins toward limit
});

// Register: 500 per hour (plenty for a school)
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 500,
  standardHeaders: true,
  legacyHeaders: false,
});

// Forgot password: 100 per hour
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Global: essentially unlimited (500,000 per 15 min)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 500000,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { loginLimiter, registerLimiter, forgotLimiter, globalLimiter };