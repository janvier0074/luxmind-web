require('dotenv').config();
const express = require('express');
const flash = require('connect-flash');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { loginLimiter, registerLimiter, forgotLimiter, globalLimiter } = require('./middleware/security');





const { connectDB, getDB } = require('./config/database');
const { createSessionMiddleware } = require('./config/session');
const { scanContent } = require('./services/contentScanner');
const { requireLogin, requireRole } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const settingsRoutes = require('./routes/settings');
const courseRoutes = require('./routes/courses');
const lessonRoutes = require('./routes/lessons');
const quizRoutes = require('./routes/quizzes');
const adminRoutes = require('./routes/admin');
const announcementRoutes = require('./routes/announcements');
const messageRoutes = require('./routes/messages');
const assignmentRoutes = require('./routes/assignments');
const calendarRoutes = require('./routes/calendar');
const searchRoutes = require('./routes/search');
const gradeRoutes = require('./routes/grades');
const notifRoutes = require('./routes/notifications');
const forumRoutes = require('./routes/forums');
const certificateRoutes = require('./routes/certificates');
const teacherRoutes = require('./routes/teacher');
const teacherUploadRoutes = require('./routes/teacher-upload');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // disable CSP because we use inline styles + Firebase CDN
  crossOriginEmbedderPolicy: false,
}));

// Global rate limit
app.use(globalLimiter);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(createSessionMiddleware());
app.use(flash());

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = { success: req.flash('success'), error: req.flash('error') };
  res.locals.currentPath = req.path;
res.locals.timeAgo = function(dateStr) {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr.replace(' ', 'T') + 'Z');
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 172800) return 'yesterday';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return d.toLocaleDateString();
};
res.locals.isOnline = function(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr.replace(' ', 'T') + 'Z');
  return (Date.now() - d.getTime()) < 5 * 60 * 1000;
};


  next();
});

// Auth with stricter rate limits
app.use('/login', loginLimiter);
app.use('/register', registerLimiter);
app.use('/forgot-password', forgotLimiter);

app.use('/', authRoutes);

app.use('/register', registerLimiter);

app.use('/', authRoutes);
app.use('/', profileRoutes);
app.use('/', settingsRoutes);
app.use('/', courseRoutes);
app.use('/', lessonRoutes);
app.use('/', quizRoutes);
app.use('/', adminRoutes);
app.use('/', announcementRoutes);
app.use('/', messageRoutes);
app.use('/', assignmentRoutes);
app.use('/', calendarRoutes);
app.use('/', searchRoutes);
app.use('/', gradeRoutes);
app.use('/', notifRoutes);
app.use('/', forumRoutes);
app.use('/', certificateRoutes);
app.use('/', teacherRoutes);
app.use('/', teacherUploadRoutes);




app.get('/health', (req, res) => res.json({ ok: true, app: 'LuxMind' }));
app.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard' : '/login'));

app.get('/dashboard', requireLogin, (req, res) => {
  const r = req.session.user.role;
  if (r === 'admin') return res.redirect('/admin');
  if (r === 'teacher') return res.redirect('/teacher');
  return res.redirect('/student');
});

// ============ STUDENT DASHBOARD ============
app.get('/student', requireLogin, requireRole('student'), async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const user = req.session.user;

  const courses = await db.all(`
    SELECT c.*,
      (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS total_lessons,
      (SELECT COUNT(*) FROM progress p
        JOIN lessons l ON l.id = p.lesson_id
        WHERE l.course_id = c.id AND p.user_id = ? AND p.completed = 1) AS done_lessons,
      (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS student_count
    FROM courses c
    JOIN enrollments e ON e.course_id = c.id
    WHERE e.user_id = ?
    ORDER BY c.title
  `, [uid, uid]);

  const totalLessons = courses.reduce((s, c) => s + c.total_lessons, 0);
  const doneLessons = courses.reduce((s, c) => s + c.done_lessons, 0);
  const overallPct = totalLessons ? Math.round((doneLessons / totalLessons) * 100) : 0;

  const pendingQuizzes = await db.get(`
    SELECT COUNT(*) c FROM quizzes q
    JOIN enrollments e ON e.course_id = q.course_id
    WHERE e.user_id = ? AND q.id NOT IN (SELECT quiz_id FROM attempts WHERE user_id = ?)
  `, [uid, uid]);

  const quizPoints = await db.get(`
    SELECT COALESCE(SUM(COALESCE(m.override_score, a.score)), 0) AS pts
    FROM attempts a
    LEFT JOIN manual_grades m ON m.attempt_id = a.id
    WHERE a.user_id = ?
  `, [uid]);
  const assignmentPoints = await db.get(`
    SELECT COALESCE(SUM(score), 0) AS pts
    FROM submissions WHERE user_id = ? AND score IS NOT NULL
  `, [uid]);
  const totalPoints = (quizPoints.pts || 0) + (assignmentPoints.pts || 0);

  const days = await db.all(`
    SELECT DISTINCT date(completed_at) AS d
    FROM progress
    WHERE user_id = ? AND completed = 1 AND completed_at IS NOT NULL
    ORDER BY d DESC
    LIMIT 60
  `, [uid]);
  let streak = 0;
  if (days.length > 0) {
    const today = new Date();
    const oneDay = 86400000;
    const todayStr = today.toISOString().slice(0, 10);
    const yesterdayStr = new Date(today - oneDay).toISOString().slice(0, 10);
    if (days[0].d === todayStr || days[0].d === yesterdayStr) {
      streak = 1;
      for (let i = 1; i < days.length; i++) {
        const prev = new Date(days[i - 1].d + 'T00:00:00');
        const cur = new Date(days[i].d + 'T00:00:00');
        const diff = (prev - cur) / oneDay;
        if (diff === 1) streak++;
        else break;
      }
    }
  }

  const deadlines = await db.all(`
    SELECT * FROM (
      SELECT 'assignment' AS kind, a.id, a.title, a.deadline AS event_at, c.title AS course
      FROM assignments a
      JOIN courses c ON c.id = a.course_id
      JOIN enrollments e ON e.course_id = c.id AND e.user_id = ?
      WHERE a.deadline IS NOT NULL
        AND a.id NOT IN (SELECT assignment_id FROM submissions WHERE user_id = ?)
      UNION ALL
      SELECT 'quiz' AS kind, q.id, q.title, q.release_at AS event_at, c.title AS course
      FROM quizzes q
      JOIN courses c ON c.id = q.course_id
      JOIN enrollments e ON e.course_id = c.id AND e.user_id = ?
      WHERE q.release_at IS NOT NULL
        AND q.id NOT IN (SELECT quiz_id FROM attempts WHERE user_id = ?)
    ) ORDER BY event_at ASC LIMIT 6
  `, [uid, uid, uid, uid]);

  const recentActivity = await db.all(`
    SELECT * FROM (
      SELECT 'lesson' AS kind, l.title AS title, p.completed_at AS at, c.title AS course
      FROM progress p
      JOIN lessons l ON l.id = p.lesson_id
      JOIN courses c ON c.id = l.course_id
      WHERE p.user_id = ? AND p.completed = 1 AND p.completed_at IS NOT NULL
      UNION ALL
      SELECT 'quiz' AS kind, q.title AS title, a.submitted_at AS at, c.title AS course
      FROM attempts a
      JOIN quizzes q ON q.id = a.quiz_id
      JOIN courses c ON c.id = q.course_id
      WHERE a.user_id = ?
    ) ORDER BY at DESC LIMIT 6
  `, [uid, uid]);

  const announcements = await db.all(`
    SELECT a.*, c.title AS course_title, u.full_name AS author_name
    FROM announcements a
    JOIN courses c ON c.id = a.course_id
    JOIN enrollments e ON e.course_id = c.id AND e.user_id = ?
    LEFT JOIN users u ON u.id = a.author_id
    ORDER BY a.created_at DESC LIMIT 3
  `, [uid]);

  const achievements = [];
  if (totalLessons > 0 && doneLessons > 0) achievements.push({ icon: '🎯', name: 'First Step', desc: 'Completed a lesson' });
  if (doneLessons >= 10) achievements.push({ icon: '📚', name: 'Bookworm', desc: '10 lessons done' });
  if (doneLessons >= 25) achievements.push({ icon: '🔥', name: 'On Fire', desc: '25 lessons done' });
  if (doneLessons >= 50) achievements.push({ icon: '🧠', name: 'Scholar', desc: '50 lessons done' });
  if (totalPoints >= 100) achievements.push({ icon: '💎', name: 'Century', desc: '100 points earned' });
  if (streak >= 3) achievements.push({ icon: '⚡', name: 'Streak x' + streak, desc: streak + ' days in a row' });
  if (courses.length >= 3) achievements.push({ icon: '🌟', name: 'Explorer', desc: 'Enrolled in ' + courses.length + ' courses' });
  if (pendingQuizzes.c === 0 && courses.length > 0) achievements.push({ icon: '✅', name: 'All Caught Up', desc: 'No pending quizzes' });

  const continueCourse = courses.find(c => c.done_lessons < c.total_lessons) || courses[0] || null;

  const quotes = [
    { text: 'The expert in anything was once a beginner.', author: 'Helen Hayes' },
    { text: 'Learning never exhausts the mind.', author: 'Leonardo da Vinci' },
    { text: 'The beautiful thing about learning is that no one can take it away from you.', author: 'B.B. King' },
    { text: 'Success is the sum of small efforts repeated day in and day out.', author: 'Robert Collier' },
    { text: 'Education is the most powerful weapon you can use to change the world.', author: 'Nelson Mandela' },
    { text: 'The more that you read, the more things you will know.', author: 'Dr. Seuss' },
    { text: "Don't watch the clock; do what it does. Keep going.", author: 'Sam Levenson' },
    { text: "Believe you can and you're halfway there.", author: 'Theodore Roosevelt' },
  ];
  const quote = quotes[Math.floor(Math.random() * quotes.length)];

  const hour = new Date().getHours();
  let greeting = 'Welcome back';
  let emoji = '👋';
  if (hour < 12) { greeting = 'Good morning'; emoji = '☀️'; }
  else if (hour < 18) { greeting = 'Good afternoon'; emoji = '🌤️'; }
  else { greeting = 'Good evening'; emoji = '🌙'; }

  res.render('student/dashboard', {
    title: 'Dashboard',
    heading: greeting + ', ' + (user.full_name || user.username).split(' ')[0] + ' ' + emoji,
    subtitle: 'Here is your learning snapshot.',
    courses, announcements,
    deadlines, recentActivity,
    achievements, quote,
    continueCourse,
    stats: {
      courses: courses.length,
      lessons: totalLessons,
      completed: doneLessons,
      pendingQuizzes: pendingQuizzes.c,
      points: totalPoints,
      streak,
      overallPct,
    },
  });
});

// ============ TEACHER DASHBOARD ============
app.get('/teacher', requireLogin, requireRole('teacher'), async (req, res) => {
  const db = getDB();
  const tid = req.session.user.id;

  const courses = await db.all(`
    SELECT c.*,
      (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS lesson_count,
      (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS student_count
    FROM courses c WHERE c.teacher_id = ?
  `, [tid]);

  const totalStudents = await db.get(`
    SELECT COUNT(DISTINCT e.user_id) as c FROM enrollments e
    JOIN courses c ON c.id = e.course_id
    WHERE c.teacher_id = ?
  `, [tid]);

  const quizCount = await db.get(`
    SELECT COUNT(*) as c FROM quizzes q
    JOIN courses c ON c.id = q.course_id
    WHERE c.teacher_id = ?
  `, [tid]);

  const pending = await db.get(`
    SELECT COUNT(*) as c FROM attempts a
    JOIN quizzes q ON q.id = a.quiz_id
    JOIN courses c ON c.id = q.course_id
    LEFT JOIN manual_grades m ON m.attempt_id = a.id
    WHERE c.teacher_id = ? AND m.attempt_id IS NULL
  `, [tid]);

  const submissions = await db.all(`
    SELECT a.*, u.full_name AS student_name, q.title AS quiz_title
    FROM attempts a
    JOIN users u ON u.id = a.user_id
    JOIN quizzes q ON q.id = a.quiz_id
    JOIN courses c ON c.id = q.course_id
    WHERE c.teacher_id = ?
    ORDER BY a.submitted_at DESC LIMIT 5
  `, [tid]);

  res.render('teacher/dashboard', {
    title: 'Teacher Dashboard',
    heading: 'Welcome, ' + req.session.user.full_name,
    courses,
    submissions,
    stats: {
      courses: courses.length,
      students: totalStudents.c,
      quizzes: quizCount.c,
      pending: pending.c,
    },
  });
});

// ============ ADMIN DASHBOARD ============
app.get('/admin', requireLogin, requireRole('admin'), async (req, res) => {
  const db = getDB();

  const u = await db.get('SELECT COUNT(*) as c FROM users');
  const t = await db.get("SELECT COUNT(*) as c FROM users WHERE role='teacher'");
  const s = await db.get("SELECT COUNT(*) as c FROM users WHERE role='student'");
  const c = await db.get('SELECT COUNT(*) as c FROM courses');

  const recentUsers = await db.all('SELECT * FROM users ORDER BY created_at DESC LIMIT 5');

  const courses = await db.all(`
    SELECT c.*, u.full_name AS teacher_name,
      (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS lesson_count
    FROM courses c
    LEFT JOIN users u ON u.id = c.teacher_id
    ORDER BY c.created_at DESC
  `);

  res.render('admin/dashboard', {
    title: 'Admin',
    heading: 'Admin Control Center',
    recentUsers,
    courses,
    stats: { users: u.c, teachers: t.c, students: s.c, courses: c.c },
  });
});

// ============ 404 / 500 ============
app.use((req, res) => {
  if (req.session.user) return res.status(404).render('errors/404');
  res.status(404).send('404 - Not found');
});

app.use((err, req, res, next) => {
  // Always log internally
  console.error('💥', err);

  // In production, never leak internal details
  const isProd = process.env.NODE_ENV === 'production';
  const safeMessage = isProd ? 'Something went wrong.' : err.message;

  if (req.session && req.session.user) {
    return res.status(500).render('errors/500', { detail: safeMessage, showDetail: !isProd });
  }
  res.status(500).send('500 - Server error');
});

// ============ BOOT ============
(async () => {
  try {
    await connectDB();

    const sp = path.join(__dirname, 'database', 'schema.sql');
    if (fs.existsSync(sp)) await getDB().exec(fs.readFileSync(sp, 'utf8'));

    const ap = path.join(__dirname, 'database', 'add-assignments.sql');
    if (fs.existsSync(ap)) await getDB().exec(fs.readFileSync(ap, 'utf8'));

    const fp = path.join(__dirname, 'database', 'add-forums.sql');
    if (fs.existsSync(fp)) await getDB().exec(fs.readFileSync(fp, 'utf8'));

    const cp = path.join(__dirname, 'database', 'add-certificates.sql');
    if (fs.existsSync(cp)) await getDB().exec(fs.readFileSync(cp, 'utf8'));

    try {
      await getDB().run('ALTER TABLE progress ADD COLUMN completed_at TEXT');
    } catch (e) { /* already exists */ }

    await scanContent();

    app.listen(PORT, () => {
      console.log('');
console.log('Environment: ' + (process.env.NODE_ENV || 'development'));
console.log('Session secret: ' + (process.env.SESSION_SECRET ? 'set (' + process.env.SESSION_SECRET.length + ' chars)' : 'MISSING'));
      console.log('LuxMind -> http://localhost:' + PORT);
      console.log('');
    });
  } catch (e) {
    console.error('Start failed:', e);
    process.exit(1);
  }
})();