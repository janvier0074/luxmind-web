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
const { scanContent } = require('./services/contentScanner-batch');
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
const gradebookRoutes = require('./routes/gradebook');
const bulkImportRoutes = require('./routes/bulk-import');
const teacherUploadRoutes = require('./routes/teacher-upload');

const app = express();
const PORT = process.env.PORT || 3000;

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
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(createSessionMiddleware());
app.use(flash());

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = { success: req.flash('success'), error: req.flash('error') };
  res.locals.currentPath = req.path;
  res.locals.isOnline     = (ts) => !!ts && (Date.now() - new Date(ts).getTime() < 5 * 60 * 1000);
     res.locals.timeAgo = (ts) => { if (!ts) return '—'; const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s/60) + 'm ago'; if (s < 86400) return Math.floor(s/3600) + 'h ago'; if (s < 604800) return Math.floor(s/86400) + 'd ago'; return new Date(ts).toLocaleDateString(); };
  next();
});

app.use('/login', loginLimiter);
app.use('/register', registerLimiter);
app.use('/forgot-password', forgotLimiter);

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
app.use('/', gradebookRoutes);
app.use('/', bulkImportRoutes);
app.use('/', teacherUploadRoutes);

app.get('/health', (req, res) => res.json({ ok: true, app: 'LuxMind' }));

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('landing');
});

app.get('/explore', async (req, res) => {
  try {
    const db = getDB();
    const courses = await db.all(`
      SELECT c.*,
        (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS lesson_count,
        (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS student_count
      FROM courses c
      ORDER BY c.title
    `);
    res.render('explore', { courses });
  } catch (e) {
    console.error('Explore error:', e);
    res.status(500).send('Error loading courses');
  }
});

app.get('/dashboard', requireLogin, (req, res) => {
  const r = req.session.user.role;
  if (r === 'admin') return res.redirect('/admin');
  if (r === 'teacher') return res.redirect('/teacher');
  return res.redirect('/student');
});

app.get('/student', requireLogin, requireRole('student'), async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const user = req.session.user;

  const courses = await db.all(`
    SELECT c.*,
      (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS total_lessons,
      (SELECT COUNT(*) FROM progress p
        JOIN lessons l ON l.id = p.lesson_id
        WHERE l.course_id = c.id AND p.user_id = $1 AND p.completed = 1) AS done_lessons,
      (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS student_count
    FROM courses c
    JOIN enrollments e ON e.course_id = c.id
    WHERE e.user_id = $2
    ORDER BY c.title
  `, [uid, uid]);

  const totalLessons = courses.reduce((s, c) => s + Number(c.total_lessons || 0), 0);
  const doneLessons = courses.reduce((s, c) => s + Number(c.done_lessons || 0), 0);
  const overallPct = totalLessons ? Math.round((doneLessons / totalLessons) * 100) : 0;

  const pendingQuizzes = await db.get(`
    SELECT COUNT(*) c FROM quizzes q
    JOIN enrollments e ON e.course_id = q.course_id
    WHERE e.user_id = $1 AND q.id NOT IN (SELECT quiz_id FROM attempts WHERE user_id = $2)
  `, [uid, uid]);

  const quizPoints = await db.get(`
    SELECT COALESCE(SUM(COALESCE(m.override_score, a.score)), 0) AS pts
    FROM attempts a
    LEFT JOIN manual_grades m ON m.attempt_id = a.id
    WHERE a.user_id = $1
  `, [uid]);

  const assignmentPoints = await db.get(`
    SELECT COALESCE(SUM(score), 0) AS pts
    FROM submissions WHERE user_id = $1 AND score IS NOT NULL
  `, [uid]);

  const totalPoints = Number(quizPoints.pts || 0) + Number(assignmentPoints.pts || 0);

  const days = await db.all(`
    SELECT DISTINCT date(completed_at) AS d
    FROM progress
    WHERE user_id = $1 AND completed = 1 AND completed_at IS NOT NULL
    ORDER BY d DESC LIMIT 60
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
        if ((prev - cur) / oneDay === 1) streak++;
        else break;
      }
    }
  }

  const deadlines = await db.all(`
    SELECT * FROM (
      SELECT 'assignment' AS kind, a.id, a.title, a.deadline AS event_at, c.title AS course
      FROM assignments a
      JOIN courses c ON c.id = a.course_id
      JOIN enrollments e ON e.course_id = c.id AND e.user_id = $1
      WHERE a.deadline IS NOT NULL
        AND a.id NOT IN (SELECT assignment_id FROM submissions WHERE user_id = $2)
      UNION ALL
      SELECT 'quiz' AS kind, q.id, q.title, q.release_at AS event_at, c.title AS course
      FROM quizzes q
      JOIN courses c ON c.id = q.course_id
      JOIN enrollments e ON e.course_id = c.id AND e.user_id = $3
      WHERE q.release_at IS NOT NULL
        AND q.id NOT IN (SELECT quiz_id FROM attempts WHERE user_id = $4)
    ) sub ORDER BY event_at ASC LIMIT 6
  `, [uid, uid, uid, uid]);

  const recentActivity = await db.all(`
    SELECT * FROM (
      SELECT 'lesson' AS kind, l.title AS title, p.completed_at AS at, c.title AS course
      FROM progress p
      JOIN lessons l ON l.id = p.lesson_id
      JOIN courses c ON c.id = l.course_id
      WHERE p.user_id = $1 AND p.completed = 1 AND p.completed_at IS NOT NULL
      UNION ALL
      SELECT 'quiz' AS kind, q.title AS title, a.submitted_at AS at, c.title AS course
      FROM attempts a
      JOIN quizzes q ON q.id = a.quiz_id
      JOIN courses c ON c.id = q.course_id
      WHERE a.user_id = $2
    ) sub ORDER BY at DESC LIMIT 6
  `, [uid, uid]);

  const announcements = await db.all(`
    SELECT a.*, c.title AS course_title, u.full_name AS author_name
    FROM announcements a
    JOIN courses c ON c.id = a.course_id
    JOIN enrollments e ON e.course_id = c.id AND e.user_id = $1
    LEFT JOIN users u ON u.id = a.author_id
    ORDER BY a.created_at DESC LIMIT 3
  `, [uid]);

  const continueCourse = courses.find(c => Number(c.done_lessons) < Number(c.total_lessons)) || courses[0] || null;

  const QUOTES = [
    { text: 'The beautiful thing about learning is that no one can take it away from you.', author: 'B.B. King' },
    { text: 'Education is the most powerful weapon you can use to change the world.', author: 'Nelson Mandela' },
    { text: 'Live as if you were to die tomorrow. Learn as if you were to live forever.', author: 'Mahatma Gandhi' },
    { text: 'An investment in knowledge pays the best interest.', author: 'Benjamin Franklin' },
    { text: 'The more that you read, the more things you will know.', author: 'Dr. Seuss' },
  ];
  const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];

  const achievements = [];
  if (doneLessons >= 1)    achievements.push({ name: 'First Steps',     icon: '👣', desc: 'Completed your first lesson' });
  if (doneLessons >= 5)    achievements.push({ name: 'Getting Started', icon: '📖', desc: 'Completed 5 lessons' });
  if (doneLessons >= 20)   achievements.push({ name: 'Bookworm',        icon: '📚', desc: 'Completed 20 lessons' });
  if (overallPct >= 50)    achievements.push({ name: 'Halfway There',   icon: '⛰️', desc: 'Reached 50% overall progress' });
  if (overallPct >= 100)   achievements.push({ name: 'Course Complete', icon: '🏆', desc: 'Finished every lesson' });
  if (streak >= 3)         achievements.push({ name: 'On a Roll',       icon: '🔥', desc: '3-day learning streak' });
  if (streak >= 7)         achievements.push({ name: 'Unstoppable',     icon: '⚡', desc: '7-day learning streak' });
  if (totalPoints >= 100)  achievements.push({ name: 'Point Collector', icon: '⭐', desc: 'Earned 100+ points' });
  if (totalPoints >= 1000) achievements.push({ name: 'High Scorer',     icon: '💎', desc: 'Earned 1000+ points' });

  res.render('student/dashboard', {
    title: 'Dashboard',
    heading: 'Welcome, ' + (user.full_name || user.username),
    subtitle: 'Here is your learning snapshot.',
    continueCourse,
    achievements,
    quote,
    courses, announcements,
    deadlines, recentActivity,
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

app.get('/teacher', requireLogin, requireRole('teacher'), async (req, res) => {
  const db = getDB();
  const tid = req.session.user.id;

  const courses = await db.all(`
    SELECT c.*,
      (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS lesson_count,
      (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS student_count
    FROM courses c WHERE c.teacher_id = $1
  `, [tid]);

  const totalStudents = await db.get(`
    SELECT COUNT(DISTINCT e.user_id) as c FROM enrollments e
    JOIN courses c ON c.id = e.course_id
    WHERE c.teacher_id = $1
  `, [tid]);

  const quizCount = await db.get(`
    SELECT COUNT(*) as c FROM quizzes q
    JOIN courses c ON c.id = q.course_id
    WHERE c.teacher_id = $1
  `, [tid]);

  const pending = await db.get(`
    SELECT COUNT(*) as c FROM attempts a
    JOIN quizzes q ON q.id = a.quiz_id
    JOIN courses c ON c.id = q.course_id
    LEFT JOIN manual_grades m ON m.attempt_id = a.id
    WHERE c.teacher_id = $1 AND m.attempt_id IS NULL
  `, [tid]);

  const submissions = await db.all(`
    SELECT a.*, u.full_name AS student_name, q.title AS quiz_title
    FROM attempts a
    JOIN users u ON u.id = a.user_id
    JOIN quizzes q ON q.id = a.quiz_id
    JOIN courses c ON c.id = q.course_id
    WHERE c.teacher_id = $1
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

app.use((req, res) => {
  if (req.session.user) return res.status(404).render('errors/404');
  res.status(404).send('404 - Not found');
});

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

    // Apply question types migration
    try {
      const db = getDB();
      await db.run("ALTER TABLE questions ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'mc'");
      await db.run("ALTER TABLE questions ALTER COLUMN option_c DROP NOT NULL");
      await db.run("ALTER TABLE questions ALTER COLUMN option_d DROP NOT NULL");
      await db.run("ALTER TABLE questions ALTER COLUMN correct DROP NOT NULL");
      console.log('Question types migration applied');
    } catch (e) {
      console.error('Migration error:', e.message);
    }

    console.log('Skipping content scan (data already in Supabase)');
    app.listen(PORT, () => {
      console.log('');
      console.log('LuxMind -> http://localhost:' + PORT);
      console.log('');
    });
  } catch (e) {
    console.error('Start failed:', e);
    process.exit(1);
  }
})();