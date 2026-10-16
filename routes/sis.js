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



// ============================================================
//                 STUDENT — Timetable (their courses as a schedule)
// ============================================================
router.get('/sis/my/timetable', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  const courses = await db.all(`
    SELECT c.*,
      u.full_name AS teacher_name,
      (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS total_lessons,
      (SELECT COUNT(*) FROM progress p
        JOIN lessons l ON l.id = p.lesson_id
        WHERE l.course_id = c.id AND p.user_id = $1 AND p.completed = 1) AS done_lessons
    FROM courses c
    JOIN enrollments e ON e.course_id = c.id
    LEFT JOIN users u ON u.id = c.teacher_id
    WHERE e.user_id = $2
    ORDER BY c.title
  `, [uid, uid]);

  const deadlines = await db.all(`
    SELECT * FROM (
      SELECT 'assignment' AS kind, a.id, a.title, a.deadline AS event_at, c.title AS course
      FROM assignments a
      JOIN courses c ON c.id = a.course_id
      JOIN enrollments e ON e.course_id = c.id AND e.user_id = $1
      WHERE a.deadline IS NOT NULL
        AND a.deadline >= CURRENT_DATE
        AND a.id NOT IN (SELECT assignment_id FROM submissions WHERE user_id = $2)
      UNION ALL
      SELECT 'quiz' AS kind, q.id, q.title, q.release_at AS event_at, c.title AS course
      FROM quizzes q
      JOIN courses c ON c.id = q.course_id
      JOIN enrollments e ON e.course_id = c.id AND e.user_id = $3
      WHERE q.release_at IS NOT NULL
        AND q.release_at >= CURRENT_DATE
        AND q.id NOT IN (SELECT quiz_id FROM attempts WHERE user_id = $4)
    ) sub ORDER BY event_at ASC LIMIT 10
  `, [uid, uid, uid, uid]);

  res.render('sis/timetable', {
    title: 'My Timetable',
    heading: 'My Timetable',
    subtitle: 'Your courses and upcoming deadlines.',
    courses, deadlines,
  });
});

// ============================================================
//                 STUDENT — My Fees
// ============================================================
router.get('/sis/my/fees', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  const profile = await db.get(
    `SELECT * FROM student_profiles WHERE user_id = $1`, [uid]
  );

  const payments = await db.all(`
    SELECT * FROM payments WHERE student_id = $1
    ORDER BY paid_at DESC
  `, [uid]);

  const totalPaidRow = await db.get(
    `SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE student_id = $1`,
    [uid]
  );

  let fees = [];
  let totalOwed = 0;
  if (profile && profile.class_level) {
    const level = profile.class_level.replace(/[-\s].*$/, '').trim();
    fees = await db.all(`
      SELECT * FROM fee_structure
      WHERE class_level = $1
      ORDER BY term
    `, [level]);
    totalOwed = fees.reduce((sum, f) => sum + Number(f.amount), 0);
  }

  const totalPaid = Number(totalPaidRow.total || 0);
  const balance = totalOwed - totalPaid;

  res.render('sis/my-fees', {
    title: 'My Fees',
    heading: 'My Fees',
    subtitle: 'Your payment history and balance.',
    profile, payments, fees,
    totalPaid, totalOwed, balance,
  });
});


// ============================================================
//                 STUDENT — Transcript
// ============================================================
router.get('/sis/my/transcript', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  // Get student profile
  const profile = await db.get(`
    SELECT u.full_name, u.username, u.email, sp.admission_number, sp.class_level, sp.date_of_birth
    FROM users u
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    WHERE u.id = $1
  `, [uid]);

  // Get all courses with grades
  const quizRows = await db.all(`
    SELECT c.id AS course_id, c.title AS course_title,
           COALESCE(m.override_score, a.score) AS score,
           a.max_score
    FROM attempts a
    JOIN quizzes q ON q.id = a.quiz_id
    JOIN courses c ON c.id = q.course_id
    LEFT JOIN manual_grades m ON m.attempt_id = a.id
    WHERE a.user_id = $1 AND COALESCE(m.override_score, a.score) IS NOT NULL
  `, [uid]);

  const assRows = await db.all(`
    SELECT c.id AS course_id, c.title AS course_title,
           s.score, a.max_points AS max_score
    FROM submissions s
    JOIN assignments a ON a.id = s.assignment_id
    JOIN courses c ON c.id = a.course_id
    WHERE s.user_id = $1 AND s.score IS NOT NULL
  `, [uid]);

  const attendanceRows = await db.all(`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status='present') AS present
    FROM attendance WHERE student_id = $1
  `, [uid]);

  // Build per-course records
  const courseMap = {};
  const ensure = (id, title) => {
    if (!courseMap[id]) courseMap[id] = { id, title, score: 0, max: 0, quizCount: 0, assCount: 0 };
    return courseMap[id];
  };

  for (const r of quizRows) {
    const c = ensure(r.course_id, r.course_title);
    c.score += Number(r.score);
    c.max += Number(r.max_score);
    c.quizCount++;
  }
  for (const r of assRows) {
    const c = ensure(r.course_id, r.course_title);
    c.score += Number(r.score);
    c.max += Number(r.max_score);
    c.assCount++;
  }

  const courses = Object.values(courseMap).map(c => {
    const pct = c.max > 0 ? Math.round((c.score / c.max) * 100) : 0;
    let letter = '—', gradeClass = 'g-empty';
    if (c.max === 0) { letter = '—'; gradeClass = 'g-empty'; }
    else if (pct >= 90) { letter = 'A'; gradeClass = 'g-a'; }
    else if (pct >= 80) { letter = 'B'; gradeClass = 'g-b'; }
    else if (pct >= 70) { letter = 'C'; gradeClass = 'g-c'; }
    else if (pct >= 60) { letter = 'D'; gradeClass = 'g-d'; }
    else { letter = 'F'; gradeClass = 'g-f'; }

    // GPA points: A=4.0, B=3.0, C=2.0, D=1.0, F=0
    const gpaPoints = { A: 4.0, B: 3.0, C: 2.0, D: 1.0, F: 0 }[letter] || 0;

    return { ...c, pct, letter, gradeClass, gpaPoints };
  });

  const totalEarned = courses.reduce((s, c) => s + c.score, 0);
  const totalMax = courses.reduce((s, c) => s + c.max, 0);
  const cumulativePct = totalMax > 0 ? Math.round((totalEarned / totalMax) * 100) : 0;
  const cumulativeGPA = courses.length > 0
    ? (courses.reduce((s, c) => s + c.gpaPoints, 0) / courses.length).toFixed(2)
    : '0.00';

  const att = attendanceRows[0] || { total: 0, present: 0 };
  const attendancePct = att.total > 0 ? Math.round((att.present / att.total) * 100) : 0;

   res.render('sis/transcript', {
    title: 'Transcript',
    heading: 'Academic Transcript',
    subtitle: 'Your complete academic record.',
    profile, courses,
    cumulativePct, cumulativeGPA, attendancePct,
    totalEarned, totalMax,
  });
});


// ============================================================
//                 STUDENT — My Grades
// ============================================================
router.get('/sis/my/grades', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  // Fetch all quizzes + assignments with scores for this student
  const quizGrades = await db.all(`
    SELECT
      q.id,
      q.title,
      c.title AS course_title,
      c.id AS course_id,
      a.score,
      a.max_score,
      a.submitted_at,
      m.override_score,
      COALESCE(m.override_score, a.score) AS final_score
    FROM attempts a
    JOIN quizzes q ON q.id = a.quiz_id
    JOIN courses c ON c.id = q.course_id
    JOIN enrollments e ON e.course_id = c.id AND e.user_id = $1
    LEFT JOIN manual_grades m ON m.attempt_id = a.id
    WHERE a.user_id = $2 AND COALESCE(m.override_score, a.score) IS NOT NULL
    ORDER BY a.submitted_at DESC
  `, [uid, uid]);

  const assignmentGrades = await db.all(`
    SELECT
      s.id,
      a.title,
      c.title AS course_title,
      c.id AS course_id,
      s.score,
      a.max_points AS max_score,
      s.submitted_at
    FROM submissions s
    JOIN assignments a ON a.id = s.assignment_id
    JOIN courses c ON c.id = a.course_id
    JOIN enrollments e ON e.course_id = c.id AND e.user_id = $1
    WHERE s.user_id = $2 AND s.score IS NOT NULL
    ORDER BY s.submitted_at DESC
  `, [uid, uid]);

  // Combine into one stream for "recent grades"
  const recent = [
    ...quizGrades.map(q => ({
      type: 'Quiz',
      title: q.title,
      course: q.course_title,
      course_id: q.course_id,
      score: Number(q.final_score),
      max_score: Number(q.max_score),
      pct: q.max_score ? Math.round((Number(q.final_score) / Number(q.max_score)) * 100) : 0,
      submitted_at: q.submitted_at,
    })),
    ...assignmentGrades.map(a => ({
      type: 'Assignment',
      title: a.title,
      course: a.course_title,
      course_id: a.course_id,
      score: Number(a.score),
      max_score: Number(a.max_score),
      pct: a.max_score ? Math.round((Number(a.score) / Number(a.max_score)) * 100) : 0,
      submitted_at: a.submitted_at,
    })),
  ].sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at)).slice(0, 12);

  // Build per-course averages
  const byCourse = {};
  for (const q of quizGrades) {
    const key = q.course_id;
    if (!byCourse[key]) {
      byCourse[key] = { course_id: key, title: q.course_title, quizScores: [], assScores: [] };
    }
    byCourse[key].quizScores.push({
      score: Number(q.final_score),
      max: Number(q.max_score),
    });
  }
  for (const a of assignmentGrades) {
    const key = a.course_id;
    if (!byCourse[key]) {
      byCourse[key] = { course_id: key, title: a.course_title, quizScores: [], assScores: [] };
    }
    byCourse[key].assScores.push({
      score: Number(a.score),
      max: Number(a.max_score),
    });
  }

  const courses = Object.values(byCourse).map(c => {
    const quizTotal = c.quizScores.reduce((sum, x) => sum + x.score, 0);
    const quizMax = c.quizScores.reduce((sum, x) => sum + x.max, 0);
    const assTotal = c.assScores.reduce((sum, x) => sum + x.score, 0);
    const assMax = c.assScores.reduce((sum, x) => sum + x.max, 0);
    const quizPct = quizMax > 0 ? Math.round((quizTotal / quizMax) * 100) : null;
    const assPct = assMax > 0 ? Math.round((assTotal / assMax) * 100) : null;
    const totalScore = quizTotal + assTotal;
    const totalMax = quizMax + assMax;
    const overallPct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : null;

    let letter = '—';
    let gradeClass = 'sis-grade-empty';
    if (overallPct !== null) {
      if (overallPct >= 90) { letter = 'A'; gradeClass = 'sis-grade-a'; }
      else if (overallPct >= 80) { letter = 'B'; gradeClass = 'sis-grade-b'; }
      else if (overallPct >= 70) { letter = 'C'; gradeClass = 'sis-grade-c'; }
      else if (overallPct >= 60) { letter = 'D'; gradeClass = 'sis-grade-d'; }
      else { letter = 'F'; gradeClass = 'sis-grade-f'; }
    }

    return {
      ...c,
      quizPct,
      assPct,
      overallPct,
      letter,
      gradeClass,
      quizCount: c.quizScores.length,
      assCount: c.assScores.length,
    };
  });

  // Overall stats
  const allQuizzes = quizGrades.length;
  const allAss = assignmentGrades.length;
  const totalScore = [...quizGrades.map(q => Number(q.final_score)), ...assignmentGrades.map(a => Number(a.score))].reduce((s, x) => s + x, 0);
  const totalMax = [...quizGrades.map(q => Number(q.max_score)), ...assignmentGrades.map(a => Number(a.max_score))].reduce((s, x) => s + x, 0);
  const overallAverage = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;

  res.render('sis/my-grades', {
    title: 'My Grades',
    heading: 'My Grades',
    subtitle: 'Your academic performance across all courses.',
    courses,
    recent,
    stats: {
      overallAverage,
      quizzesTaken: allQuizzes,
      assignmentsGraded: allAss,
      totalGraded: allQuizzes + allAss,
    },
  });
});
// ============================================================
//                 COURSE REGISTRATION
// ============================================================

// Student — see available courses + their own registrations
router.get('/sis/my/registration', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  // Courses the student is NOT enrolled in yet
  const available = await db.all(`
    SELECT c.*,
           u.full_name AS teacher_name,
           (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS lesson_count,
           (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS student_count,
           cr.id AS reg_id,
           cr.status AS reg_status
    FROM courses c
    LEFT JOIN users u ON u.id = c.teacher_id
    LEFT JOIN course_registrations cr
      ON cr.course_id = c.id AND cr.student_id = $1
    WHERE c.id NOT IN (
      SELECT course_id FROM enrollments WHERE user_id = $2
    )
    ORDER BY c.title
  `, [uid, uid]);

  // Student's existing registrations (pending/rejected)
  const pending = await db.all(`
    SELECT cr.*, c.title AS course_title, c.id AS course_id
    FROM course_registrations cr
    JOIN courses c ON c.id = cr.course_id
    WHERE cr.student_id = $1
    ORDER BY cr.requested_at DESC
  `, [uid]);

  // Enrolled courses
  const enrolled = await db.all(`
    SELECT c.id, c.title, c.description,
           u.full_name AS teacher_name,
           (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS lesson_count
    FROM courses c
    JOIN enrollments e ON e.course_id = c.id
    LEFT JOIN users u ON u.id = c.teacher_id
    WHERE e.user_id = $1
    ORDER BY c.title
  `, [uid]);

  res.render('sis/my-registration', {
    title: 'Course Registration',
    heading: 'Course Registration',
    subtitle: 'Enroll in new courses or review your requests.',
    available, pending, enrolled,
  });
});

// Student — submit a registration request
router.post('/sis/my/registration/request', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const courseId = Number(req.body.course_id);

  if (!courseId) {
    req.flash('error', 'Please select a course.');
    return res.redirect('/sis/my/registration');
  }

  // Check already enrolled
  const alreadyIn = await db.get(
    `SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2`,
    [uid, courseId]
  );
  if (alreadyIn) {
    req.flash('error', 'You are already enrolled in this course.');
    return res.redirect('/sis/my/registration');
  }

  // Check existing request
  const existing = await db.get(
    `SELECT id, status FROM course_registrations WHERE student_id = $1 AND course_id = $2`,
    [uid, courseId]
  );
  if (existing) {
    if (existing.status === 'pending') {
      req.flash('error', 'You already have a pending request for this course.');
    } else if (existing.status === 'rejected') {
      // Allow re-request — update the row
      await db.run(
        `UPDATE course_registrations
         SET status = 'pending', requested_at = NOW(), reviewed_at = NULL, reviewed_by = NULL, notes = NULL
         WHERE id = $1`,
        [existing.id]
      );
      req.flash('success', 'Request resubmitted.');
    }
    return res.redirect('/sis/my/registration');
  }

  await db.run(
    `INSERT INTO course_registrations (student_id, course_id, status)
     VALUES ($1, $2, 'pending')`,
    [uid, courseId]
  );

  req.flash('success', 'Registration request submitted. Waiting for admin approval.');
  res.redirect('/sis/my/registration');
});

// Student — cancel a pending request
router.post('/sis/my/registration/cancel/:id', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  await db.run(
    `DELETE FROM course_registrations WHERE id = $1 AND student_id = $2 AND status = 'pending'`,
    [req.params.id, uid]
  );
  req.flash('success', 'Request cancelled.');
  res.redirect('/sis/my/registration');
});

// ============================================================
//                 ADMIN — review registrations
// ============================================================
router.get('/sis/admin/registrations', guard, async (req, res) => {
  const db = getDB();

  const pending = await db.all(`
    SELECT cr.*, c.title AS course_title,
           u.full_name AS student_name, u.username AS student_username,
           u.email AS student_email
    FROM course_registrations cr
    JOIN courses c ON c.id = cr.course_id
    JOIN users u ON u.id = cr.student_id
    WHERE cr.status = 'pending'
    ORDER BY cr.requested_at DESC
  `);

  const recentlyHandled = await db.all(`
    SELECT cr.*, c.title AS course_title,
           u.full_name AS student_name, u.username AS student_username
    FROM course_registrations cr
    JOIN courses c ON c.id = cr.course_id
    JOIN users u ON u.id = cr.student_id
    WHERE cr.status IN ('approved','rejected')
    ORDER BY cr.reviewed_at DESC
    LIMIT 20
  `);

  res.render('sis/admin-registrations', {
    title: 'Course Registrations',
    heading: 'Course Registrations',
    subtitle: 'Approve or reject student registration requests.',
    pending, recentlyHandled,
  });
});

router.post('/sis/admin/registrations/:id/approve', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);

  const reg = await db.get(`SELECT * FROM course_registrations WHERE id = $1`, [id]);
  if (!reg) {
    req.flash('error', 'Registration not found.');
    return res.redirect('/sis/admin/registrations');
  }

  // Enroll the student (skip if already enrolled)
  const already = await db.get(
    `SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2`,
    [reg.student_id, reg.course_id]
  );
  if (!already) {
    await db.run(
      `INSERT INTO enrollments (user_id, course_id) VALUES ($1, $2)`,
      [reg.student_id, reg.course_id]
    );
  }

  await db.run(
    `UPDATE course_registrations
     SET status = 'approved', reviewed_at = NOW(), reviewed_by = $1
     WHERE id = $2`,
    [req.session.user.id, id]
  );

  req.flash('success', 'Registration approved and student enrolled.');
  res.redirect('/sis/admin/registrations');
});

router.post('/sis/admin/registrations/:id/reject', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  const notes = req.body.notes || null;

  await db.run(
    `UPDATE course_registrations
     SET status = 'rejected', reviewed_at = NOW(), reviewed_by = $1, notes = $2
     WHERE id = $3`,
    [req.session.user.id, notes, id]
  );

  req.flash('success', 'Registration rejected.');
  res.redirect('/sis/admin/registrations');
});

// ============================================================
//                 STUDENT — My Profile
// ============================================================
router.get('/sis/my/profile', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  const profile = await db.get(`
    SELECT u.id, u.username, u.full_name, u.email, u.created_at, u.last_seen,
           sp.admission_number, sp.date_of_birth, sp.gender, sp.photo_url,
           sp.guardian_name, sp.guardian_phone, sp.guardian_email, sp.guardian_relationship,
           sp.home_address, sp.medical_notes, sp.class_level, sp.admission_date, sp.status
    FROM users u
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    WHERE u.id = $1
  `, [uid]);

  if (!profile) return res.status(404).render('errors/404');

  // Enrollment count
  const enrollRow = await db.get(
    `SELECT COUNT(*) c FROM enrollments WHERE user_id = $1`, [uid]
  );

  // Attendance summary
  const attRow = await db.get(`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status='present') AS present
    FROM attendance WHERE student_id = $1
  `, [uid]);

  const attendancePct = attRow.total > 0
    ? Math.round((attRow.present / attRow.total) * 100)
    : 0;

  res.render('sis/my-profile', {
    title: 'My Profile',
    heading: 'My Profile',
    subtitle: 'Your personal and academic information.',
    profile,
    enrolledCount: enrollRow.c,
    attendancePct,
  });
});

module.exports = router;