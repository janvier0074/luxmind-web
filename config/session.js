const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const isProd = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProd ? { rejectUnauthorized: false } : false,
});

function createSessionMiddleware() {
  return session({
    name: 'luxmind.sid',
    secret: process.env.SESSION_SECRET || 'luxmind-dev',
    resave: false,
    saveUninitialized: false,
    store: new PgStore({
      pool,
      tableName: 'session',
      createTableIfMissing: true,
    }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  });
}

module.exports = { createSessionMiddleware };