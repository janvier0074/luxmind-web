// server-sis.js
// Standalone LuxMind SIS server — separate app, same database.
require('dotenv').config();
const express = require('express');
const flash = require('connect-flash');
const path = require('path');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { globalLimiter } = require('./middleware/security');

const { connectDB } = require('./config/database');
const { createSessionMiddleware } = require('./config/session');
const { requireLogin, requireRole } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const sisRoutes = require('./routes/sis');

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(globalLimiter);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use('/static', express.static(path.join(__dirname, 'public')));

app.use(createSessionMiddleware());
app.use(flash());

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = { success: req.flash('success'), error: req.flash('error') };
  res.locals.currentPath = req.path;
  res.locals.isOnline = (ts) => !!ts && (Date.now() - new Date(ts).getTime() < 5 * 60 * 1000);
  res.locals.timeAgo = (ts) => { if (!ts) return '—'; const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s/60) + 'm ago'; if (s < 86400) return Math.floor(s/3600) + 'h ago'; if (s < 604800) return Math.floor(s/86400) + 'd ago'; return new Date(ts).toLocaleDateString(); };
  next();
});

// Auth routes (login, logout, register) — SIS has its own login screen
app.use('/', authRoutes);

// SIS routes
app.use('/', sisRoutes);

// Root — redirect to /sis (which routes based on role)
app.get('/', requireLogin, (req, res) => res.redirect('/sis'));

app.get('/health', (req, res) => res.json({ ok: true, app: 'LuxMind SIS' }));

// 404
app.use((req, res) => {
  if (req.session.user) return res.status(404).render('errors/404');
  res.status(404).send('404 - Not found');
});

// 500
app.use((err, req, res, next) => {
  console.error('💥', err);
  const isProd = process.env.NODE_ENV === 'production';
  const safeMessage = isProd ? 'Something went wrong.' : err.message;
  if (req.session && req.session.user) {
    return res.status(500).render('errors/500', { detail: safeMessage, showDetail: !isProd });
  }
  res.status(500).send('500 - Server error');
});

(async () => {
  try {
    await connectDB();
    console.log('Skipping migrations (handled by LMS server)');
    app.listen(PORT, () => {
      console.log('');
      console.log('LuxMind SIS -> http://localhost:' + PORT);
      console.log('');
    });
  } catch (e) {
    console.error('Start failed:', e);
    process.exit(1);
  }
})();