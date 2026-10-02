const express = require('express');
const bcrypt = require('bcrypt');
const { getDB } = require('../config/database');
const { requireLogin, requireRole } = require('../middleware/auth');
const router = express.Router();

const guard = [requireLogin, requireRole('admin')];

// ============================================================
//                     USERS
// ============================================================

router.get('/admin/users', guard, async (req, res) => {
  const db = getDB();
  const q = (req.query.q || '').trim();
  const role = req.query.role || '';

 let sql = 'SELECT id, username, email, role, full_name, is_active, created_at, last_seen FROM users WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND (username LIKE ? OR full_name LIKE ? OR email LIKE ?)'; params.push('%'+q+'%','%'+q+'%','%'+q+'%'); }
  if (role) { sql += ' AND role = ?'; params.push(role); }
  sql += ' ORDER BY created_at DESC';

  const users = await db.all(sql, params);

  // counts
  const totals = {
    all: (await db.get('SELECT COUNT(*) c FROM users')).c,
    admin: (await db.get('SELECT COUNT(*) c FROM users WHERE role="admin"')).c,
    teacher: (await db.get('SELECT COUNT(*) c FROM users WHERE role="teacher"')).c,
    student: (await db.get('SELECT COUNT(*) c FROM users WHERE role="student"')).c,
  };

  res.render('admin/users', {
    title: 'Users',
    heading: 'User Management',
    subtitle: 'Create, edit, and manage all accounts.',
    users, totals, q, role,
  });
});

router.get('/admin/users/new', guard, (req, res) => {
  res.render('admin/user-edit', {
    title: 'New User',
    heading: 'Create User',
    subtitle: 'Add a new account to LuxMind.',
    editUser: null,
  });
});

router.post('/admin/users/new', guard, async (req, res) => {
  const db = getDB();
  const { username, email, password, role, full_name } = req.body;
  if (!username || !password) {
    req.flash('error', 'Username and password are required.');
    return res.redirect('/admin/users/new');
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.run(
      'INSERT INTO users (username, email, password, role, full_name) VALUES (?,?,?,?,?)',
      [username, email || null, hash, role || 'student', full_name || null]
    );
    req.flash('success', 'User created.');
    res.redirect('/admin/users');
  } catch (e) {
    req.flash('error', 'Username already taken.');
    res.redirect('/admin/users/new');
  }
});

router.get('/admin/users/:id/edit', guard, async (req, res) => {
  const db = getDB();
  const editUser = await db.get(
    'SELECT id, username, email, role, full_name, is_active, created_at FROM users WHERE id = ?',
    [req.params.id]
  );
  if (!editUser) return res.status(404).send('User not found');
  res.render('admin/user-edit', {
    title: 'Edit User',
    heading: 'Edit User',
    subtitle: editUser.username,
    editUser,
  });
});

router.post('/admin/users/:id/edit', guard, async (req, res) => {
  const db = getDB();
  const { email, role, full_name, is_active, new_password } = req.body;
  const id = req.params.id;

  await db.run(
    'UPDATE users SET email = ?, role = ?, full_name = ?, is_active = ? WHERE id = ?',
    [email || null, role || 'student', full_name || null, is_active ? 1 : 0, id]
  );

  if (new_password && new_password.length >= 6) {
    const hash = await bcrypt.hash(new_password, 10);
    await db.run('UPDATE users SET password = ? WHERE id = ?', [hash, id]);
  }

  req.flash('success', 'User updated.');
  res.redirect('/admin/users');
});

router.post('/admin/users/:id/delete', guard, async (req, res) => {
  const db = getDB();
  const id = req.params.id;
  if (Number(id) === req.session.user.id) {
    req.flash('error', 'You cannot delete your own account.');
    return res.redirect('/admin/users');
  }
  await db.run('DELETE FROM users WHERE id = ?', [id]);
  req.flash('success', 'User deleted.');
  res.redirect('/admin/users');
});

router.post('/admin/users/:id/role', guard, async (req, res) => {
  const db = getDB();
  const id = req.params.id;
  const role = req.body.role;
  if (!['admin','teacher','student'].includes(role)) {
    req.flash('error', 'Invalid role.');
    return res.redirect('/admin/users');
  }
  await db.run('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  req.flash('success', 'Role updated.');
  res.redirect('/admin/users');
});

// ============================================================
//                     COURSES
// ============================================================

router.get('/admin/courses', guard, async (req, res) => {
  const db = getDB();

  const courses = await db.all(`
    SELECT c.*,
      u.full_name AS teacher_name,
      (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS lesson_count,
      (SELECT COUNT(*) FROM resources r JOIN lessons l ON l.id = r.lesson_id WHERE l.course_id = c.id) AS resource_count,
      (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS student_count
    FROM courses c
    LEFT JOIN users u ON u.id = c.teacher_id
    ORDER BY c.created_at DESC
  `);

  const teachers = await db.all("SELECT id, full_name, username FROM users WHERE role='teacher' ORDER BY full_name");

  res.render('admin/courses', {
    title: 'Courses',
    heading: 'Course Management',
    subtitle: 'Assign teachers, review, delete.',
    courses, teachers,
  });
});

router.post('/admin/courses/:id/teacher', guard, async (req, res) => {
  const db = getDB();
  const teacherId = req.body.teacher_id ? Number(req.body.teacher_id) : null;
  await db.run('UPDATE courses SET teacher_id = ? WHERE id = ?', [teacherId, req.params.id]);
  req.flash('success', 'Teacher assigned.');
  res.redirect('/admin/courses');
});

router.post('/admin/courses/:id/delete', guard, async (req, res) => {
  const db = getDB();
  await db.run('DELETE FROM courses WHERE id = ?', [req.params.id]);
  req.flash('success', 'Course deleted.');
  res.redirect('/admin/courses');
});

// ============================================================
//                     REPORTS / ANALYTICS
// ============================================================

router.get('/admin/reports', guard, async (req, res) => {
  const db = getDB();

  const stats = {
    users: (await db.get('SELECT COUNT(*) c FROM users')).c,
    teachers: (await db.get("SELECT COUNT(*) c FROM users WHERE role='teacher'")).c,
    students: (await db.get("SELECT COUNT(*) c FROM users WHERE role='student'")).c,
    courses: (await db.get('SELECT COUNT(*) c FROM courses')).c,
    lessons: (await db.get('SELECT COUNT(*) c FROM lessons')).c,
    enrollments: (await db.get('SELECT COUNT(*) c FROM enrollments')).c,
    quizzes: (await db.get('SELECT COUNT(*) c FROM quizzes')).c,
    attempts: (await db.get('SELECT COUNT(*) c FROM attempts')).c,
  };

  // top courses by enrollment
  const topCourses = await db.all(`
    SELECT c.id, c.title, COUNT(e.id) AS enrolls
    FROM courses c
    LEFT JOIN enrollments e ON e.course_id = c.id
    GROUP BY c.id
    ORDER BY enrolls DESC
    LIMIT 8
  `);

  // most active students
  const topStudents = await db.all(`
    SELECT u.id, u.full_name, u.username,
      (SELECT COUNT(*) FROM progress WHERE user_id = u.id AND completed = 1) AS done,
      (SELECT COUNT(*) FROM attempts WHERE user_id = u.id) AS quizzes
    FROM users u
    WHERE u.role = 'student'
    ORDER BY done DESC
    LIMIT 8
  `);

  // users created last 7 days
  const signups = await db.all(`
    SELECT date(created_at) AS d, COUNT(*) AS c
    FROM users
    WHERE created_at >= date('now', '-7 days')
    GROUP BY d
    ORDER BY d
  `);

  res.render('admin/reports', {
    title: 'Reports',
    heading: 'Analytics & Reports',
    subtitle: 'System-wide overview.',
    stats, topCourses, topStudents, signups,
  });
});

// ============================================================
//                     SITE SETTINGS
// ============================================================

router.get('/admin/settings', guard, async (req, res) => {
  const db = getDB();
  const rows = await db.all("SELECT key, value FROM settings WHERE user_id = 0");
  const map = { site_name: 'LuxMind', site_tagline: 'Learn · Teach · Grow', allow_registration: 'true' };
  rows.forEach(r => { map[r.key] = r.value; });

  res.render('admin/settings', {
    title: 'Site Settings',
    heading: 'Site Settings',
    subtitle: 'Configure LuxMind.',
    settings: map,
  });
});

router.post('/admin/settings', guard, async (req, res) => {
  const db = getDB();
  const pairs = {
    site_name: req.body.site_name || 'LuxMind',
    site_tagline: req.body.site_tagline || '',
    allow_registration: req.body.allow_registration ? 'true' : 'false',
  };
  for (const [k, v] of Object.entries(pairs)) {
    const existing = await db.get("SELECT id FROM settings WHERE user_id = 0 AND key = ?", [k]);
    if (existing) await db.run("UPDATE settings SET value = ? WHERE id = ?", [v, existing.id]);
    else await db.run("INSERT INTO settings (user_id, key, value) VALUES (0, ?, ?)", [k, v]);
  }
  req.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
});

module.exports = router;