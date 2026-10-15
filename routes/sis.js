// routes/sis.js
// Student Information System — role-based portals (admin, faculty, student)
const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin, requireRole } = require('../middleware/auth');
const { auth: firebaseAuth } = require('../config/firebase');
const router = express.Router();

// --- Role guards ---
const guard = [requireLogin, requireRole('admin')];          // admin only
const staffGuard = [requireLogin, (req, res, next) => {       // admin OR teacher
  if (!req.session.user) return res.redirect('/login');
  const role = req.session.user.role;
  if (role !== 'admin' && role !== 'teacher') return res.status(403).render('errors/403');
  next();
}];
const studentGuard = [requireLogin, (req, res, next) => {     // student only
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'student') return res.status(403).render('errors/403');
  next();
}];

// ============================================================
//                 SIS ROOT — role-based router
// ============================================================
router.get('/sis', requireLogin, (req, res) => {
  const role = req.session.user.role;
  if (role === 'admin') return res.redirect('/sis/admin');
  if (role === 'teacher') return res.redirect('/sis/faculty');
  if (role === 'student') return res.redirect('/sis/my');
  // Others (parent, unknown) — send to LMS
  res.redirect('/dashboard');
});

// ============================================================
//                 ADMIN DASHBOARD
// ============================================================
router.get('/sis/admin', guard, async (req, res) => {
  const db = getDB();

  const studentsRow = await db.get(`SELECT COUNT(*) c FROM users WHERE role = 'student'`);
  const activeRow   = await db.get(`SELECT COUNT(*) c FROM student_profiles WHERE status = 'active'`);
  const classesRow  = await db.get(`SELECT COUNT(*) c FROM classes`);
  const teachersRow = await db.get(`SELECT COUNT(*) c FROM users WHERE role = 'teacher'`);

  const today = new Date().toISOString().slice(0, 10);
  const presentRow = await db.get(
    `SELECT COUNT(*) c FROM attendance WHERE attendance_date = $1 AND status = 'present'`, [today]
  );
  const absentRow = await db.get(
    `SELECT COUNT(*) c FROM attendance WHERE attendance_date = $1 AND status = 'absent'`, [today]
  );

  const monthStart = new Date();
  monthStart.setDate(1);
  const monthStartStr = monthStart.toISOString().slice(0, 10);
  const feesRow = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE paid_at >= $1`, [monthStartStr]
  );

  const recentStudents = await db.all(`
    SELECT u.id, u.username, u.full_name, u.created_at,
           sp.class_level, sp.admission_number
    FROM users u
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    WHERE u.role = 'student'
    ORDER BY u.created_at DESC
    LIMIT 8
  `);

  res.render('sis/admin-dashboard', {
    title: 'Overview',
    heading: 'School Overview',
    subtitle: 'A snapshot of the institution.',
    stats: {
      students: studentsRow.c,
      activeStudents: activeRow.c,
      classes: classesRow.c,
      teachers: teachersRow.c,
      presentToday: presentRow.c,
      absentToday: absentRow.c,
      feesThisMonth: feesRow.total,
    },
    recentStudents,
  });
});

// ============================================================
//                 FACULTY DASHBOARD
// ============================================================
router.get('/sis/faculty', staffGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const user = req.session.user;

  // Classes the teacher can access (for now: all classes; later: assigned only)
  const classRows = await db.all(`
    SELECT sp.class_level AS name,
           COUNT(*) FILTER (WHERE sp.status = 'active') AS student_count
    FROM student_profiles sp
    WHERE sp.class_level IS NOT NULL
    GROUP BY sp.class_level
    ORDER BY sp.class_level
  `);

  const totalStudentsRow = await db.get(
    `SELECT COUNT(*) c FROM student_profiles WHERE status = 'active'`
  );

  const today = new Date().toISOString().slice(0, 10);
  const markedTodayRow = await db.get(
    `SELECT COUNT(DISTINCT student_id) c FROM attendance WHERE attendance_date = $1`, [today]
  );

  // Recent attendance activity
  const recentRows = await db.all(`
    SELECT a.attendance_date, a.status, a.created_at,
           u.full_name AS student_name,
           sp.class_level
    FROM attendance a
    JOIN users u ON u.id = a.student_id
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    ORDER BY a.created_at DESC LIMIT 8
  `);

  res.render('sis/faculty-dashboard', {
    title: 'Faculty',
    heading: 'Welcome, ' + (user.full_name || user.username),
    subtitle: 'Your classes and attendance.',
    classRows,
    stats: {
      classes: classRows.length,
      students: totalStudentsRow.c,
      markedToday: markedTodayRow.c,
    },
    recentRows,
  });
});

// ============================================================
//                 STUDENT PORTAL — /sis/my
// ============================================================
router.get('/sis/my', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  // Attendance summary
  const attSummary = await db.get(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status='present') AS present,
      COUNT(*) FILTER (WHERE status='absent')  AS absent,
      COUNT(*) FILTER (WHERE status='late')    AS late,
      COUNT(*) FILTER (WHERE status='excused') AS excused
    FROM attendance WHERE student_id = $1
  `, [uid]);

  const pct = attSummary.total > 0
    ? Math.round((attSummary.present / attSummary.total) * 100)
    : 0;

  // Student's class info
  const profile = await db.get(
    `SELECT * FROM student_profiles WHERE user_id = $1`, [uid]
  );

  // Fees paid
  const paidRow = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE student_id = $1`,
    [uid]
  );

  // Recent attendance
  const recent = await db.all(`
    SELECT * FROM attendance WHERE student_id = $1
    ORDER BY attendance_date DESC LIMIT 10
  `, [uid]);

  res.render('sis/student-dashboard', {
    title: 'My SIS',
    heading: 'Welcome, ' + (req.session.user.full_name || req.session.user.username),
    subtitle: 'Your academic record.',
    attSummary: { ...attSummary, pct },
    profile,
    totalPaid: paidRow.total,
    recent,
  });
});

// ============================================================
//                 STUDENT — Attendance detail
// ============================================================
router.get('/sis/my/attendance', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  const records = await db.all(`
    SELECT * FROM attendance WHERE student_id = $1
    ORDER BY attendance_date DESC LIMIT 120
  `, [uid]);

  const summary = await db.get(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status='present') AS present,
      COUNT(*) FILTER (WHERE status='absent')  AS absent,
      COUNT(*) FILTER (WHERE status='late')    AS late,
      COUNT(*) FILTER (WHERE status='excused') AS excused
    FROM attendance WHERE student_id = $1
  `, [uid]);

  const pct = summary.total > 0
    ? Math.round((summary.present / summary.total) * 100)
    : 0;

  res.render('sis/my-attendance', {
    title: 'My Attendance',
    heading: 'My Attendance',
    subtitle: 'Your full attendance record.',
    records,
    summary: { ...summary, pct },
  });
});

// ============================================================
//                 STUDENT LIST (admin only)
// ============================================================
router.get('/sis/students', guard, async (req, res) => {
  const db = getDB();
  const q = (req.query.q || '').trim();
  const classFilter = req.query.class || '';

  let sql = `
    SELECT u.id, u.username, u.full_name, u.email, u.is_active, u.created_at,
           sp.admission_number, sp.class_level, sp.guardian_name, sp.guardian_phone,
           sp.photo_url, sp.status
    FROM users u
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    WHERE u.role = 'student'
  `;
  const params = [];

  if (q) {
    params.push('%' + q + '%');
    const idx = params.length;
    sql += ` AND (u.full_name ILIKE $${idx} OR u.username ILIKE $${idx} OR u.email ILIKE $${idx} OR sp.admission_number ILIKE $${idx})`;
  }
  if (classFilter) {
    params.push(classFilter);
    sql += ` AND sp.class_level = $${params.length}`;
  }

  sql += ` ORDER BY u.full_name ASC`;
  const students = await db.all(sql, params);

  const classList = await db.all(`
    SELECT DISTINCT class_level FROM student_profiles
    WHERE class_level IS NOT NULL ORDER BY class_level
  `);

  const totals = {
    all: (await db.get(`SELECT COUNT(*) c FROM users WHERE role='student'`)).c,
    active: (await db.get(`SELECT COUNT(*) c FROM student_profiles WHERE status='active'`)).c,
    inactive: (await db.get(`SELECT COUNT(*) c FROM student_profiles WHERE status='inactive'`)).c,
  };

  res.render('sis/students', {
    title: 'Students',
    heading: 'Student Registry',
    subtitle: 'All students enrolled in the institution.',
    students, totals, q, classFilter, classList,
  });
});

router.get('/sis/students/new', guard, (req, res) => {
  res.render('sis/student-new', {
    title: 'Register Student',
    heading: 'Register New Student',
    subtitle: 'Create a new student record.',
    error: null,
    form: {},
  });
});

router.post('/sis/students/new', guard, async (req, res) => {
  const db = getDB();
  const {
    full_name, username, email, password,
    admission_number, date_of_birth, gender,
    guardian_name, guardian_phone, guardian_email,
    home_address, class_level, medical_notes,
  } = req.body;

  if (!full_name || !username || !email || !password) {
    return res.render('sis/student-new', {
      title: 'Register Student',
      heading: 'Register New Student',
      subtitle: 'Create a new student record.',
      error: 'Full name, username, email and password are required.',
      form: req.body,
    });
  }

  let firebaseUser = null;
  try {
    firebaseUser = await firebaseAuth.createUser({
      email, password, displayName: full_name, emailVerified: true,
    });

    await db.run(
      `INSERT INTO users (username, email, password, role, full_name)
       VALUES ($1, $2, $3, 'student', $4)`,
      [username, email, 'FIREBASE_AUTH', full_name]
    );

    const row = await db.get('SELECT id FROM users WHERE username = $1', [username]);
    const userId = row.id;

    await db.run(
      `INSERT INTO student_profiles
       (user_id, admission_number, date_of_birth, gender,
        guardian_name, guardian_phone, guardian_email,
        home_address, medical_notes, class_level, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')`,
      [
        userId,
        admission_number || null,
        date_of_birth || null,
        gender || null,
        guardian_name || null,
        guardian_phone || null,
        guardian_email || null,
        home_address || null,
        medical_notes || null,
        class_level || null,
      ]
    );

    req.flash('success', 'Student registered: ' + full_name);
    res.redirect('/sis/students');
  } catch (e) {
    console.error('Create student error:', e);
    if (firebaseUser) {
      try { await firebaseAuth.deleteUser(firebaseUser.uid); } catch (_) {}
    }

    let msg = 'Could not register student.';
    if (e.code === 'auth/email-already-exists') msg = 'That email is already registered.';
    else if (e.code === '23505') msg = 'Username or admission number already exists.';

    res.render('sis/student-new', {
      title: 'Register Student',
      heading: 'Register New Student',
      subtitle: 'Create a new student record.',
      error: msg,
      form: req.body,
    });
  }
});

router.get('/sis/students/:id', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);

  const student = await db.get(`
    SELECT u.id, u.username, u.full_name, u.email, u.is_active, u.created_at, sp.*
    FROM users u
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    WHERE u.id = $1 AND u.role = 'student'
  `, [id]);

  if (!student) return res.status(404).render('errors/404');

  const attendance = await db.get(`
    SELECT 
      COUNT(*) FILTER (WHERE status='present') AS present_count,
      COUNT(*) FILTER (WHERE status='absent') AS absent_count,
      COUNT(*) FILTER (WHERE status='late') AS late_count,
      COUNT(*) AS total_days
    FROM attendance WHERE student_id = $1
  `, [id]);

  const payments = await db.all(`
    SELECT * FROM payments WHERE student_id = $1
    ORDER BY paid_at DESC LIMIT 20
  `, [id]);

  const totalPaidRow = await db.get(
    `SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE student_id = $1`,
    [id]
  );

  res.render('sis/student-profile', {
    title: student.full_name || 'Student',
    heading: student.full_name || student.username,
    subtitle: 'Student record',
    student, attendance, payments,
    totalPaid: totalPaidRow.total,
  });
});

router.post('/sis/students/:id/edit', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  const {
    full_name, admission_number, date_of_birth, gender,
    guardian_name, guardian_phone, guardian_email,
    home_address, class_level, medical_notes, status,
  } = req.body;

  await db.run(
    `UPDATE users SET full_name = $1 WHERE id = $2 AND role = 'student'`,
    [full_name, id]
  );

  const existing = await db.get('SELECT id FROM student_profiles WHERE user_id = $1', [id]);

  if (existing) {
    await db.run(
      `UPDATE student_profiles SET
        admission_number = $1, date_of_birth = $2, gender = $3,
        guardian_name = $4, guardian_phone = $5, guardian_email = $6,
        home_address = $7, class_level = $8, medical_notes = $9, status = $10,
        updated_at = NOW()
       WHERE user_id = $11`,
      [admission_number, date_of_birth || null, gender, guardian_name,
       guardian_phone, guardian_email, home_address, class_level,
       medical_notes, status, id]
    );
  } else {
    await db.run(
      `INSERT INTO student_profiles
       (user_id, admission_number, date_of_birth, gender,
        guardian_name, guardian_phone, guardian_email,
        home_address, class_level, medical_notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, admission_number, date_of_birth || null, gender, guardian_name,
       guardian_phone, guardian_email, home_address, class_level,
       medical_notes, status]
    );
  }

  req.flash('success', 'Student record updated.');
  res.redirect('/sis/students/' + id);
});

router.post('/sis/students/:id/deactivate', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  await db.run(`UPDATE users SET is_active = 0 WHERE id = $1`, [id]);
  await db.run(`UPDATE student_profiles SET status = 'inactive', updated_at = NOW() WHERE user_id = $1`, [id]);
  req.flash('success', 'Student deactivated.');
  res.redirect('/sis/students');
});

router.post('/sis/students/:id/reactivate', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  await db.run(`UPDATE users SET is_active = 1 WHERE id = $1`, [id]);
  await db.run(`UPDATE student_profiles SET status = 'active', updated_at = NOW() WHERE user_id = $1`, [id]);
  req.flash('success', 'Student reactivated.');
  res.redirect('/sis/students/' + id);
});

// ============================================================
//                 ATTENDANCE (admin + teacher)
// ============================================================
router.get('/sis/attendance', staffGuard, async (req, res) => {
  const db = getDB();
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const classFilter = req.query.class || '';

  const classList = await db.all(`
    SELECT DISTINCT class_level FROM student_profiles
    WHERE class_level IS NOT NULL AND status = 'active'
    ORDER BY class_level
  `);

  let students = [];
  if (classFilter) {
    students = await db.all(`
      SELECT u.id, u.username, u.full_name,
             a.status AS current_status, a.notes AS current_notes
      FROM users u
      JOIN student_profiles sp ON sp.user_id = u.id
      LEFT JOIN attendance a ON a.student_id = u.id
        AND a.attendance_date = $2 AND a.class_id IS NULL
      WHERE u.role = 'student' AND sp.class_level = $1 AND sp.status = 'active'
      ORDER BY u.full_name
    `, [classFilter, date]);
  }

  const summary = await db.get(`
    SELECT
      COUNT(*) FILTER (WHERE status='present') AS present,
      COUNT(*) FILTER (WHERE status='absent')  AS absent,
      COUNT(*) FILTER (WHERE status='late')    AS late,
      COUNT(*) FILTER (WHERE status='excused') AS excused,
      COUNT(*) AS total
    FROM attendance WHERE attendance_date = $1
  `, [date]);

  res.render('sis/attendance', {
    title: 'Attendance',
    heading: 'Attendance Register',
    subtitle: 'Mark daily attendance for a class.',
    date, classFilter, classList, students, summary,
  });
});

router.post('/sis/attendance', staffGuard, async (req, res) => {
  const db = getDB();
  const { date, class_level } = req.body;

  if (!date || !class_level) {
    req.flash('error', 'Please pick a date and class.');
    return res.redirect('/sis/attendance');
  }

  const students = await db.all(`
    SELECT u.id FROM users u
    JOIN student_profiles sp ON sp.user_id = u.id
    WHERE u.role = 'student' AND sp.class_level = $1 AND sp.status = 'active'
  `, [class_level]);

  const markedBy = req.session.user.id;
  let saved = 0;

  for (const s of students) {
    await db.run(
      `DELETE FROM attendance WHERE student_id = $1 AND attendance_date = $2 AND class_id IS NULL`,
      [s.id, date]
    );

    const status = req.body['status_' + s.id];
    if (!status) continue;

    const notes = req.body['notes_' + s.id] || null;
    await db.run(
      `INSERT INTO attendance (student_id, attendance_date, status, notes, marked_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [s.id, date, status, notes, markedBy]
    );
    saved++;
  }

  req.flash('success', 'Attendance saved for ' + saved + ' of ' + students.length + ' students.');
  res.redirect('/sis/attendance?date=' + date + '&class=' + encodeURIComponent(class_level));
});

router.get('/sis/attendance/student/:id', staffGuard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);

  const student = await db.get(`
    SELECT u.id, u.full_name, u.username, sp.class_level
    FROM users u
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    WHERE u.id = $1 AND u.role = 'student'
  `, [id]);

  if (!student) return res.status(404).render('errors/404');

  const records = await db.all(`
    SELECT * FROM attendance WHERE student_id = $1
    ORDER BY attendance_date DESC LIMIT 90
  `, [id]);

  const summary = await db.get(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status='present') AS present,
      COUNT(*) FILTER (WHERE status='absent')  AS absent,
      COUNT(*) FILTER (WHERE status='late')    AS late,
      COUNT(*) FILTER (WHERE status='excused') AS excused
    FROM attendance WHERE student_id = $1
  `, [id]);

  res.render('sis/attendance-student', {
    title: student.full_name + ' — Attendance',
    heading: student.full_name,
    subtitle: 'Attendance history',
    student, records, summary,
  });
});

module.exports = router;