const session = require('express-session');
function createSessionMiddleware() {
  return session({
    name: 'luxmind.sid',
    secret: process.env.SESSION_SECRET || 'luxmind-dev',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000*60*60*24*7 }
  });
}
module.exports = { createSessionMiddleware };