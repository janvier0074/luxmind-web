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

  // Fetch all instructors for each course (multi-teacher support)
  const allCourseTeachers = await db.all(`
    SELECT ct.course_id, ct.role, ct.section,
           u.id, u.full_name, u.username
    FROM course_teachers ct
    JOIN users u ON u.id = ct.teacher_id
    ORDER BY ct.course_id, ct.role
  `);

  // Group instructors by course_id
  const teachersByCourse = {};
  for (const row of allCourseTeachers) {
    if (!teachersByCourse[row.course_id]) teachersByCourse[row.course_id] = [];
    teachersByCourse[row.course_id].push({
      id: row.id,
      full_name: row.full_name,
      username: row.username,
      role: row.role,
      section: row.section,
    });
  }

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
    courses, deadlines, teachersByCourse,
  });
});

// ============================================================
//                 STUDENT — My Fees
// ============================================================
router.get('/sis/my/fees', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  // 1. Get Student Profile
  const profile = await db.get(`SELECT * FROM student_profiles WHERE user_id = $1`, [uid]);
  
  let level = '';
  if (profile && profile.class_level) {
    // Extract "Form 1" from "Form 1A"
    level = profile.class_level.replace(/[-\s].*$/, '').trim();
  }

  // 2. Fetch Charges (Invoices)
  let charges = [];
  if (level) {
    charges = await db.all(`
      SELECT id, term, academic_year, amount, description, 'Invoice' as type, NOW() as date 
      FROM fee_structure 
      WHERE class_level = $1
    `, [level]);
  }

  // 3. Fetch Payments (Credits)
  const payments = await db.all(`
    SELECT id, term, amount, method as description, 'Payment' as type, paid_at as date, receipt_number 
    FROM payments 
    WHERE student_id = $1
  `, [uid]);

  // 4. Combine into a single Ledger
  const ledger = [
    ...charges.map(c => ({
      date: new Date(c.date), // In real life, you'd use the invoice creation date
      type: 'Invoice',
      description: `${c.description || 'Tuition'} (${c.term})`,
      charge: Number(c.amount),
      credit: 0,
      installment: '1. Installment'
    })),
    ...payments.map(p => ({
      date: new Date(p.date),
      type: 'Payment',
      description: `${p.description.toUpperCase()} - ${p.receipt_number || ''}`,
      charge: 0,
      credit: Number(p.amount),
      installment: '-'
    }))
  ].sort((a, b) => b.date - a.date);

  // 5. Calculate Totals
  const totalOwed = charges.reduce((sum, c) => sum + Number(c.amount), 0);
  const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const balance = totalOwed - totalPaid;

  // Hardcoded limits based on your CIU screenshot
  const fullAccessLimit = 200;
  const approachingDebt = balance + 200;

  res.render('sis/my-fees', {
    title: 'Accounting',
    heading: 'Accounting',
    subtitle: 'View your invoices, payments, and financial status.',
    profile, level, ledger, totalOwed, totalPaid, balance, fullAccessLimit, approachingDebt
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

// ============================================================
//                 DOCUMENT REQUESTS
// ============================================================

const DOC_TYPES = [
  { value: 'enrollment_certificate', label: 'Enrollment Certificate' },
  { value: 'transcript',             label: 'Official Transcript' },
  { value: 'student_id_card',        label: 'Student ID Card' },
  { value: 'recommendation_letter',  label: 'Recommendation Letter' },
  { value: 'attendance_certificate', label: 'Attendance Certificate' },
  { value: 'graduation_letter',      label: 'Graduation Letter' },
  { value: 'other',                  label: 'Other (specify below)' },
];

// Student — see list + submit new
router.get('/sis/my/documents', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  const requests = await db.all(`
    SELECT * FROM document_requests
    WHERE student_id = $1
    ORDER BY requested_at DESC
  `, [uid]);

  res.render('sis/my-documents', {
    title: 'Document Requests',
    heading: 'Document Requests',
    subtitle: 'Request official documents from the registrar.',
    requests,
    docTypes: DOC_TYPES,
  });
});

router.post('/sis/my/documents/request', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const { document_type, reason } = req.body;

  if (!document_type) {
    req.flash('error', 'Please choose a document type.');
    return res.redirect('/sis/my/documents');
  }

  const label = (DOC_TYPES.find(d => d.value === document_type) || {}).label || document_type;

  await db.run(
    `INSERT INTO document_requests (student_id, document_type, reason, status)
     VALUES ($1, $2, $3, 'pending')`,
    [uid, label, reason || null]
  );

  req.flash('success', 'Request submitted. You will be notified once ready.');
  res.redirect('/sis/my/documents');
});

router.post('/sis/my/documents/cancel/:id', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  await db.run(
    `DELETE FROM document_requests WHERE id = $1 AND student_id = $2 AND status = 'pending'`,
    [req.params.id, uid]
  );
  req.flash('success', 'Request cancelled.');
  res.redirect('/sis/my/documents');
});

// Admin — review
router.get('/sis/admin/documents', guard, async (req, res) => {
  const db = getDB();

  const pending = await db.all(`
    SELECT dr.*, u.full_name AS student_name, u.username AS student_username,
           u.email AS student_email
    FROM document_requests dr
    JOIN users u ON u.id = dr.student_id
    WHERE dr.status = 'pending'
    ORDER BY dr.requested_at ASC
  `);

  const handled = await db.all(`
    SELECT dr.*, u.full_name AS student_name, u.username AS student_username
    FROM document_requests dr
    JOIN users u ON u.id = dr.student_id
    WHERE dr.status IN ('ready','rejected')
    ORDER BY dr.reviewed_at DESC
    LIMIT 30
  `);

  res.render('sis/admin-documents', {
    title: 'Document Requests',
    heading: 'Document Requests',
    subtitle: 'Mark student document requests as ready or rejected.',
    pending, handled,
  });
});

router.post('/sis/admin/documents/:id/ready', guard, async (req, res) => {
  const db = getDB();
  await db.run(
    `UPDATE document_requests
     SET status = 'ready', reviewed_at = NOW(), reviewed_by = $1, admin_notes = $2
     WHERE id = $3`,
    [req.session.user.id, req.body.admin_notes || null, req.params.id]
  );
  req.flash('success', 'Marked as ready.');
  res.redirect('/sis/admin/documents');
});

router.post('/sis/admin/documents/:id/reject', guard, async (req, res) => {
  const db = getDB();
  await db.run(
    `UPDATE document_requests
     SET status = 'rejected', reviewed_at = NOW(), reviewed_by = $1, admin_notes = $2
     WHERE id = $3`,
    [req.session.user.id, req.body.admin_notes || null, req.params.id]
  );
  req.flash('success', 'Request rejected.');
  res.redirect('/sis/admin/documents');
});


// ============================================================
//                 CGPA CALCULATOR
// ============================================================

const GPA_MAP = {
  'A+': 4.0, 'A': 4.0, 'A-': 3.7,
  'B+': 3.3, 'B': 3.0, 'B-': 2.7,
  'C+': 2.3, 'C': 2.0, 'C-': 1.7,
  'D+': 1.3, 'D': 1.0, 'F': 0.0,
};
const GRADE_OPTIONS = Object.keys(GPA_MAP);

router.get('/sis/my/cgpa', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  const entries = await db.all(`
    SELECT * FROM cgpa_entries
    WHERE student_id = $1
    ORDER BY created_at DESC
  `, [uid]);

  // Group by semester
  const bySemester = {};
  let totalPoints = 0;
  let totalCredits = 0;

  for (const e of entries) {
    const sem = e.semester || 'Unsorted';
    if (!bySemester[sem]) bySemester[sem] = [];
    bySemester[sem].push(e);
    const gpa = GPA_MAP[e.grade] || 0;
    totalPoints += gpa * Number(e.credits);
    totalCredits += Number(e.credits);
  }

  const cgpa = totalCredits > 0 ? (totalPoints / totalCredits).toFixed(2) : '0.00';

  // Semester GPAs
  const semesterStats = Object.keys(bySemester).map(sem => {
    const list = bySemester[sem];
    let pts = 0, cr = 0;
    for (const e of list) {
      pts += (GPA_MAP[e.grade] || 0) * Number(e.credits);
      cr += Number(e.credits);
    }
    return {
      name: sem,
      gpa: cr > 0 ? (pts / cr).toFixed(2) : '0.00',
      credits: cr,
      count: list.length,
    };
  });

  // What you need next term — target CGPA scenarios
  // Assume next semester = 15 credits (typical)
  const nextCredits = 15;
  const targets = [2.0, 2.5, 3.0, 3.5, 4.0].map(target => {
    // (totalPoints + x * nextCredits) / (totalCredits + nextCredits) = target
    // x = (target * (totalCredits + nextCredits) - totalPoints) / nextCredits
    const x = (target * (totalCredits + nextCredits) - totalPoints) / nextCredits;
    let achievable = x <= 4.0 && x >= 0;
    let needed = x > 4.0 ? 'Not possible' : (x < 0 ? 'Already guaranteed' : x.toFixed(2));
    return { target, needed, achievable };
  });

    res.render('sis/my-cgpa', {
    title: 'CGPA Calculator',
    heading: 'CGPA Calculator',
    subtitle: 'Track your GPA and plan your next semester.',
    entries,
    bySemester,
    semesterStats,
    cgpa,
    totalCredits,
    totalPoints,
    gradeOptions: GRADE_OPTIONS,
    targets,
    nextCredits,
    GPA_MAP,
  });
});

router.post('/sis/my/cgpa/add', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const { course_name, credits, grade, semester } = req.body;

  if (!course_name || !credits || !grade) {
    req.flash('error', 'Course name, credits, and grade are required.');
    return res.redirect('/sis/my/cgpa');
  }

  if (!GPA_MAP[grade]) {
    req.flash('error', 'Invalid grade.');
    return res.redirect('/sis/my/cgpa');
  }

  await db.run(
    `INSERT INTO cgpa_entries (student_id, course_name, credits, grade, semester)
     VALUES ($1, $2, $3, $4, $5)`,
    [uid, course_name.trim(), Number(credits), grade, semester ? semester.trim() : null]
  );

  req.flash('success', 'Course added.');
  res.redirect('/sis/my/cgpa');
});

router.post('/sis/my/cgpa/delete/:id', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  await db.run(
    `DELETE FROM cgpa_entries WHERE id = $1 AND student_id = $2`,
    [req.params.id, uid]
  );
  req.flash('success', 'Entry removed.');
  res.redirect('/sis/my/cgpa');
});

router.post('/sis/my/cgpa/clear', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  await db.run(`DELETE FROM cgpa_entries WHERE student_id = $1`, [uid]);
  req.flash('success', 'All entries cleared.');
  res.redirect('/sis/my/cgpa');
});

// ============================================================
//                 ADMIN — CLASSES MANAGEMENT
// ============================================================

// List + create form
router.get('/sis/admin/classes', staffGuard, async (req, res) => {
  const db = getDB();
  const isTeacher = req.session.user.role === 'teacher';
  const uid = req.session.user.id;

  let classes;
  if (isTeacher) {
    classes = await db.all(`
      SELECT c.*,
             u.full_name AS teacher_name, u.username AS teacher_username,
             (SELECT COUNT(*) FROM class_students WHERE class_id = c.id) AS student_count,
             (SELECT COUNT(*) FROM student_profiles WHERE class_level = c.name) AS profile_count
      FROM classes c
      LEFT JOIN users u ON u.id = c.teacher_id
      WHERE c.teacher_id = $1
      ORDER BY c.name
    `, [uid]);
  } else {
    classes = await db.all(`
      SELECT c.*,
             u.full_name AS teacher_name, u.username AS teacher_username,
             (SELECT COUNT(*) FROM class_students WHERE class_id = c.id) AS student_count,
             (SELECT COUNT(*) FROM student_profiles WHERE class_level = c.name) AS profile_count
      FROM classes c
      LEFT JOIN users u ON u.id = c.teacher_id
      ORDER BY c.name
    `);
  }

  const teachers = await db.all(`
    SELECT id, full_name, username FROM users
    WHERE role = 'teacher' AND is_active = 1
    ORDER BY full_name
  `);

  res.render('sis/admin-classes', {
    title: 'Classes',
    heading: isTeacher ? 'My Classes' : 'Class Management',
    subtitle: isTeacher ? 'The classes assigned to you.' : 'Create and organize classes for the institution.',
    classes, teachers,
    isTeacher,
  });
});

// Create
router.post('/sis/admin/classes/new', guard, async (req, res) => {
  const db = getDB();
  const { name, level, room, capacity, teacher_id } = req.body;

  if (!name || !name.trim()) {
    req.flash('error', 'Class name is required.');
    return res.redirect('/sis/admin/classes');
  }

  try {
    await db.run(
      `INSERT INTO classes (name, level, room, capacity, teacher_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        name.trim(),
        level ? level.trim() : null,
        room ? room.trim() : null,
        capacity ? Number(capacity) : null,
        teacher_id ? Number(teacher_id) : null,
      ]
    );
    req.flash('success', 'Class created: ' + name.trim());
  } catch (e) {
    if (e.code === '23505') req.flash('error', 'A class with that name already exists.');
    else req.flash('error', 'Could not create class.');
  }
  res.redirect('/sis/admin/classes');
});

// Detail
router.get('/sis/admin/classes/:id', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);

  const cls = await db.get(`
    SELECT c.*, u.full_name AS teacher_name, u.username AS teacher_username, u.email AS teacher_email
    FROM classes c
    LEFT JOIN users u ON u.id = c.teacher_id
    WHERE c.id = $1
  `, [id]);

  if (!cls) return res.status(404).render('errors/404');

  // Students already in this class (via class_students)
  const enrolled = await db.all(`
    SELECT u.id, u.full_name, u.username, u.email,
           sp.admission_number, sp.guardian_name, sp.guardian_phone, sp.status,
           cs.enrolled_at
    FROM class_students cs
    JOIN users u ON u.id = cs.student_id
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    WHERE cs.class_id = $1
    ORDER BY u.full_name
  `, [id]);

  // Students NOT in this class (candidates to add)
  const candidates = await db.all(`
    SELECT u.id, u.full_name, u.username, u.email,
           sp.admission_number, sp.class_level
    FROM users u
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    WHERE u.role = 'student'
      AND u.is_active = 1
      AND u.id NOT IN (SELECT student_id FROM class_students WHERE class_id = $1)
    ORDER BY u.full_name
  `, [id]);

  const teachers = await db.all(`
    SELECT id, full_name, username FROM users
    WHERE role = 'teacher' AND is_active = 1
    ORDER BY full_name
  `);

  res.render('sis/admin-class-detail', {
    title: cls.name,
    heading: cls.name,
    subtitle: 'Class details and student roster.',
    cls, enrolled, candidates, teachers,
  });
});

// Update
router.post('/sis/admin/classes/:id/edit', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  const { name, level, room, capacity, teacher_id } = req.body;

  try {
    await db.run(
      `UPDATE classes SET name = $1, level = $2, room = $3, capacity = $4, teacher_id = $5
       WHERE id = $6`,
      [
        name.trim(),
        level ? level.trim() : null,
        room ? room.trim() : null,
        capacity ? Number(capacity) : null,
        teacher_id ? Number(teacher_id) : null,
        id,
      ]
    );
    req.flash('success', 'Class updated.');
  } catch (e) {
    req.flash('error', 'Could not update class.');
  }
  res.redirect('/sis/admin/classes/' + id);
});

// Delete
router.post('/sis/admin/classes/:id/delete', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  await db.run(`DELETE FROM classes WHERE id = $1`, [id]);
  req.flash('success', 'Class deleted.');
  res.redirect('/sis/admin/classes');
});

// Assign student
router.post('/sis/admin/classes/:id/assign', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  const ids = Array.isArray(req.body.student_ids)
    ? req.body.student_ids
    : (req.body.student_ids ? [req.body.student_ids] : []);

  if (ids.length === 0) {
    req.flash('error', 'Select at least one student.');
    return res.redirect('/sis/admin/classes/' + id);
  }

  const cls = await db.get(`SELECT name FROM classes WHERE id = $1`, [id]);

  for (const sid of ids) {
    try {
      await db.run(
        `INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)
         ON CONFLICT (class_id, student_id) DO NOTHING`,
        [id, Number(sid)]
      );
      // Also set the student's class_level in student_profiles
      if (cls && cls.name) {
        await db.run(
          `UPDATE student_profiles SET class_level = $1, updated_at = NOW() WHERE user_id = $2`,
          [cls.name, Number(sid)]
        );
      }
    } catch (e) { /* ignore */ }
  }

  req.flash('success', ids.length + ' student(s) added to ' + (cls ? cls.name : 'class') + '.');
  res.redirect('/sis/admin/classes/' + id);
});

// Remove student
router.post('/sis/admin/classes/:id/remove/:studentId', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  const sid = Number(req.params.studentId);

  await db.run(
    `DELETE FROM class_students WHERE class_id = $1 AND student_id = $2`,
    [id, sid]
  );

  req.flash('success', 'Student removed from class.');
  res.redirect('/sis/admin/classes/' + id);
});

// ============================================================
//                 EXAMS
// ============================================================

// Student — Exam Program (upcoming + past)
router.get('/sis/my/exams', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  const exams = await db.all(`
    SELECT e.*, c.title AS course_title, u.full_name AS teacher_name,
           r.score, r.grade
    FROM exams e
    JOIN courses c ON c.id = e.course_id
    JOIN enrollments en ON en.course_id = c.id AND en.user_id = $1
    LEFT JOIN users u ON u.id = c.teacher_id
    LEFT JOIN exam_results r ON r.exam_id = e.id AND r.student_id = $2
    ORDER BY e.exam_date ASC
  `, [uid, uid]);

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = exams.filter(e => e.exam_date >= today);
  const past = exams.filter(e => e.exam_date < today);

  res.render('sis/my-exams', {
    title: 'Exam Program',
    heading: 'Exam Program',
    subtitle: 'Your exam schedule and results.',
    upcoming, past,
  });
});

// Student — Exam Result
router.get('/sis/my/exams/results', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  const results = await db.all(`
    SELECT e.title, e.exam_date, e.max_score, c.title AS course_title,
           r.score, r.grade, r.notes, r.recorded_at
    FROM exam_results r
    JOIN exams e ON e.id = r.exam_id
    JOIN courses c ON c.id = e.course_id
    WHERE r.student_id = $1
    ORDER BY e.exam_date DESC
  `, [uid]);

  // Average
  let totalPct = 0, cnt = 0;
  for (const r of results) {
    if (r.score !== null && r.max_score > 0) {
      totalPct += (Number(r.score) / Number(r.max_score)) * 100;
      cnt++;
    }
  }
  const avgPct = cnt > 0 ? Math.round(totalPct / cnt) : 0;

  res.render('sis/my-exam-results', {
    title: 'Exam Result',
    heading: 'Exam Results',
    subtitle: 'Your exam scores and grades.',
    results, avgPct,
  });
});

// ============================================================
//                 ADMIN — EXAMS
// ============================================================
// ============================================================
//                 EXAMS (admin + teacher)
// ============================================================

// Who can access exam routes — admin and teacher
function examStaffFilter(req) {
  // Returns { teacherOnly: true } if the caller is a teacher
  return req.session.user.role === 'teacher' ? { teacherOnly: true, uid: req.session.user.id } : { teacherOnly: false };
}

router.get('/sis/admin/exams', staffGuard, async (req, res) => {
  const db = getDB();
  const f = examStaffFilter(req);
  const isTeacher = f.teacherOnly;

  let exams;
  let courses;

  if (isTeacher) {
    exams = await db.all(`
      SELECT e.*, c.title AS course_title,
             (SELECT COUNT(*) FROM exam_results WHERE exam_id = e.id) AS result_count,
             (SELECT COUNT(*) FROM enrollments WHERE course_id = e.course_id) AS student_count
      FROM exams e
      JOIN courses c ON c.id = e.course_id
      WHERE c.teacher_id = $1
      ORDER BY e.exam_date DESC
    `, [f.uid]);

    courses = await db.all(
      `SELECT id, title FROM courses WHERE teacher_id = $1 ORDER BY title`,
      [f.uid]
    );
  } else {
    exams = await db.all(`
      SELECT e.*, c.title AS course_title,
             (SELECT COUNT(*) FROM exam_results WHERE exam_id = e.id) AS result_count,
             (SELECT COUNT(*) FROM enrollments WHERE course_id = e.course_id) AS student_count
      FROM exams e
      JOIN courses c ON c.id = e.course_id
      ORDER BY e.exam_date DESC
    `);
    courses = await db.all(`SELECT id, title FROM courses ORDER BY title`);
  }

  res.render('sis/admin-exams', {
    title: 'Exams',
    heading: isTeacher ? 'My Exams' : 'Exam Management',
    subtitle: isTeacher ? 'Schedule exams and enter results for your courses.' : 'Schedule exams and record results.',
    exams, courses,
    isTeacher,
  });
});

router.post('/sis/admin/exams/new', staffGuard, async (req, res) => {
  const db = getDB();
  const f = examStaffFilter(req);
  const { course_id, title, exam_date, start_time, duration_minutes, room, max_score } = req.body;

  if (!course_id || !title || !exam_date) {
    req.flash('error', 'Course, title, and date are required.');
    return res.redirect('/sis/admin/exams');
  }

  // If teacher: verify they own this course
  if (f.teacherOnly) {
    const owns = await db.get(
      `SELECT id FROM courses WHERE id = $1 AND teacher_id = $2`,
      [Number(course_id), f.uid]
    );
    if (!owns) {
      req.flash('error', 'You can only create exams for your own courses.');
      return res.redirect('/sis/admin/exams');
    }
  }

  await db.run(
    `INSERT INTO exams (course_id, title, exam_date, start_time, duration_minutes, room, max_score, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      Number(course_id),
      title.trim(),
      exam_date,
      start_time || null,
      duration_minutes ? Number(duration_minutes) : 60,
      room || null,
      max_score ? Number(max_score) : 100,
      req.session.user.id,
    ]
  );

  req.flash('success', 'Exam created.');
  res.redirect('/sis/admin/exams');
});

router.get('/sis/admin/exams/:id', staffGuard, async (req, res) => {
  const db = getDB();
  const f = examStaffFilter(req);
  const id = Number(req.params.id);

  const exam = await db.get(`
    SELECT e.*, c.title AS course_title, c.teacher_id
    FROM exams e JOIN courses c ON c.id = e.course_id
    WHERE e.id = $1
  `, [id]);

  if (!exam) return res.status(404).render('errors/404');

  // Teacher can only access own courses
  if (f.teacherOnly && exam.teacher_id !== f.uid) {
    return res.status(403).render('errors/403');
  }

  const students = await db.all(`
    SELECT u.id, u.full_name, u.username, sp.admission_number,
           r.score, r.grade, r.notes
    FROM enrollments en
    JOIN users u ON u.id = en.user_id
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    LEFT JOIN exam_results r ON r.exam_id = $1 AND r.student_id = u.id
    WHERE en.course_id = $2
    ORDER BY u.full_name
  `, [id, exam.course_id]);

  res.render('sis/admin-exam-detail', {
    title: exam.title,
    heading: exam.title,
    subtitle: exam.course_title,
    exam, students,
    isTeacher: f.teacherOnly,
  });
});

router.post('/sis/admin/exams/:id/results', staffGuard, async (req, res) => {
  const db = getDB();
  const f = examStaffFilter(req);
  const id = Number(req.params.id);

  const exam = await db.get(`
    SELECT e.max_score, c.teacher_id
    FROM exams e JOIN courses c ON c.id = e.course_id
    WHERE e.id = $1
  `, [id]);

  if (!exam) return res.status(404).render('errors/404');
  if (f.teacherOnly && exam.teacher_id !== f.uid) {
    return res.status(403).render('errors/403');
  }

  for (const key of Object.keys(req.body)) {
    const m = key.match(/^score_(\d+)$/);
    if (!m) continue;
    const studentId = Number(m[1]);
    const rawScore = req.body[key];

    if (rawScore === '' || rawScore === null || rawScore === undefined) {
      await db.run(`DELETE FROM exam_results WHERE exam_id = $1 AND student_id = $2`, [id, studentId]);
      continue;
    }

    const score = Number(rawScore);
    const pct = Number(exam.max_score) > 0 ? (score / Number(exam.max_score)) * 100 : 0;
    let grade = 'F';
    if (pct >= 90) grade = 'A';
    else if (pct >= 80) grade = 'B';
    else if (pct >= 70) grade = 'C';
    else if (pct >= 60) grade = 'D';

    const notes = req.body['notes_' + studentId] || null;

    await db.run(
      `INSERT INTO exam_results (exam_id, student_id, score, grade, notes, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (exam_id, student_id)
       DO UPDATE SET score = $3, grade = $4, notes = $5, recorded_by = $6, recorded_at = NOW()`,
      [id, studentId, score, grade, notes, req.session.user.id]
    );
  }

  req.flash('success', 'Results saved.');
  res.redirect('/sis/admin/exams/' + id);
});

router.post('/sis/admin/exams/:id/delete', staffGuard, async (req, res) => {
  const db = getDB();
  const f = examStaffFilter(req);
  const id = Number(req.params.id);

  if (f.teacherOnly) {
    // Only delete if teacher owns the course
    const owns = await db.get(`
      SELECT e.id FROM exams e JOIN courses c ON c.id = e.course_id
      WHERE e.id = $1 AND c.teacher_id = $2
    `, [id, f.uid]);
    if (!owns) {
      req.flash('error', 'Not authorized.');
      return res.redirect('/sis/admin/exams');
    }
  }

  await db.run(`DELETE FROM exams WHERE id = $1`, [id]);
  req.flash('success', 'Exam deleted.');
  res.redirect('/sis/admin/exams');
});
// ============================================================
//                 ADMIN — MANAGE COURSE TEACHERS
// ============================================================

// List courses + their teachers
router.get('/sis/admin/course-teachers', guard, async (req, res) => {
  const db = getDB();

  const courses = await db.all(`
    SELECT c.id, c.title, c.description
    FROM courses c
    ORDER BY c.title
  `);

  const allLinks = await db.all(`
    SELECT ct.course_id, ct.role, ct.section,
           u.id AS teacher_id, u.full_name, u.username, u.email
    FROM course_teachers ct
    JOIN users u ON u.id = ct.teacher_id
    ORDER BY ct.course_id, ct.role
  `);

  const teachersByCourse = {};
  for (const l of allLinks) {
    if (!teachersByCourse[l.course_id]) teachersByCourse[l.course_id] = [];
    teachersByCourse[l.course_id].push(l);
  }

  const teachers = await db.all(`
    SELECT id, full_name, username, email FROM users
    WHERE role = 'teacher' AND is_active = 1
    ORDER BY full_name
  `);

  res.render('sis/admin-course-teachers', {
    title: 'Course Teachers',
    heading: 'Course Teachers',
    subtitle: 'Assign multiple instructors to each course.',
    courses, teachersByCourse, teachers,
  });
});

// Assign teacher to a course
router.post('/sis/admin/course-teachers/:courseId/add', guard, async (req, res) => {
  const db = getDB();
  const courseId = Number(req.params.courseId);
  const { teacher_id, role, section } = req.body;

  if (!teacher_id) {
    req.flash('error', 'Pick a teacher.');
    return res.redirect('/sis/admin/course-teachers');
  }

  try {
    await db.run(
      `INSERT INTO course_teachers (course_id, teacher_id, role, section)
       VALUES ($1, $2, $3, $4)`,
      [
        courseId,
        Number(teacher_id),
        role || 'instructor',
        section ? section.trim() : null,
      ]
    );
    req.flash('success', 'Teacher assigned.');
  } catch (e) {
    if (e.code === '23505') req.flash('error', 'That teacher is already assigned to this course.');
    else req.flash('error', 'Could not assign teacher.');
  }
  res.redirect('/sis/admin/course-teachers');
});

// Remove teacher from course
router.post('/sis/admin/course-teachers/:courseId/remove/:teacherId', guard, async (req, res) => {
  const db = getDB();
  await db.run(
    `DELETE FROM course_teachers WHERE course_id = $1 AND teacher_id = $2`,
    [Number(req.params.courseId), Number(req.params.teacherId)]
  );
  req.flash('success', 'Teacher removed from course.');
  res.redirect('/sis/admin/course-teachers');
});

// Change role
router.post('/sis/admin/course-teachers/:courseId/role/:teacherId', guard, async (req, res) => {
  const db = getDB();
  const { role, section } = req.body;
  await db.run(
    `UPDATE course_teachers SET role = $1, section = $2
     WHERE course_id = $3 AND teacher_id = $4`,
    [
      role || 'instructor',
      section ? section.trim() : null,
      Number(req.params.courseId),
      Number(req.params.teacherId),
    ]
  );
  req.flash('success', 'Role updated.');
  res.redirect('/sis/admin/course-teachers');
});


// ============================================================
//                 COURSE WITHDRAWAL
// ============================================================

// Student — view enrolled courses & request withdrawal
router.get('/sis/my/withdrawal', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  const enrolled = await db.all(`
    SELECT c.id, c.title, c.description, u.full_name AS teacher_name,
           (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS lesson_count
    FROM courses c
    JOIN enrollments e ON e.course_id = c.id
    LEFT JOIN users u ON u.id = c.teacher_id
    WHERE e.user_id = $1
    ORDER BY c.title
  `, [uid]);

  const requests = await db.all(`
    SELECT cr.*, c.title AS course_title
    FROM course_withdrawals cr
    JOIN courses c ON c.id = cr.course_id
    WHERE cr.student_id = $1
    ORDER BY cr.requested_at DESC
  `, [uid]);

  const pendingCourseIds = requests
    .filter(r => r.status === 'pending')
    .map(r => r.course_id);

  res.render('sis/my-withdrawal', {
    title: 'Course Withdrawal',
    heading: 'Course Withdrawal',
    subtitle: 'Request to drop a course from your current schedule.',
    enrolled, requests, pendingCourseIds,
  });
});

// Student — submit request
router.post('/sis/my/withdrawal/request', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const { course_id, reason } = req.body;

  if (!course_id || !reason || !reason.trim()) {
    req.flash('error', 'Course and reason are required.');
    return res.redirect('/sis/my/withdrawal');
  }

  // Check already enrolled
  const enrolled = await db.get(
    `SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2`,
    [uid, Number(course_id)]
  );
  if (!enrolled) {
    req.flash('error', 'You are not enrolled in this course.');
    return res.redirect('/sis/my/withdrawal');
  }

  // Check for existing pending request
  const existing = await db.get(
    `SELECT id FROM course_withdrawals WHERE student_id = $1 AND course_id = $2 AND status = 'pending'`,
    [uid, Number(course_id)]
  );
  if (existing) {
    req.flash('error', 'You already have a pending withdrawal request for this course.');
    return res.redirect('/sis/my/withdrawal');
  }

  await db.run(
    `INSERT INTO course_withdrawals (student_id, course_id, reason, status)
     VALUES ($1, $2, $3, 'pending')`,
    [uid, Number(course_id), reason.trim()]
  );

  req.flash('success', 'Withdrawal request submitted for approval.');
  res.redirect('/sis/my/withdrawal');
});

// Student — cancel request
router.post('/sis/my/withdrawal/cancel/:id', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  await db.run(
    `DELETE FROM course_withdrawals WHERE id = $1 AND student_id = $2 AND status = 'pending'`,
    [req.params.id, uid]
  );
  req.flash('success', 'Withdrawal request cancelled.');
  res.redirect('/sis/my/withdrawal');
});

// ============================================================
//                 ADMIN — Review withdrawals
// ============================================================
router.get('/sis/admin/withdrawals', guard, async (req, res) => {
  const db = getDB();

  const pending = await db.all(`
    SELECT cw.*, c.title AS course_title,
           u.full_name AS student_name, u.username AS student_username,
           u.email AS student_email
    FROM course_withdrawals cw
    JOIN courses c ON c.id = cw.course_id
    JOIN users u ON u.id = cw.student_id
    WHERE cw.status = 'pending'
    ORDER BY cw.requested_at ASC
  `);

  const handled = await db.all(`
    SELECT cw.*, c.title AS course_title,
           u.full_name AS student_name, u.username AS student_username
    FROM course_withdrawals cw
    JOIN courses c ON c.id = cw.course_id
    JOIN users u ON u.id = cw.student_id
    WHERE cw.status IN ('approved','rejected')
    ORDER BY cw.reviewed_at DESC
    LIMIT 30
  `);

  res.render('sis/admin-withdrawals', {
    title: 'Course Withdrawals',
    heading: 'Course Withdrawals',
    subtitle: 'Approve or reject student withdrawal requests.',
    pending, handled,
  });
});

// Admin — approve
router.post('/sis/admin/withdrawals/:id/approve', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);

  const reqRow = await db.get(`SELECT * FROM course_withdrawals WHERE id = $1`, [id]);
  if (!reqRow) {
    req.flash('error', 'Request not found.');
    return res.redirect('/sis/admin/withdrawals');
  }

  // Remove the enrollment
  await db.run(
    `DELETE FROM enrollments WHERE user_id = $1 AND course_id = $2`,
    [reqRow.student_id, reqRow.course_id]
  );

  await db.run(
    `UPDATE course_withdrawals
     SET status = 'approved', reviewed_at = NOW(), reviewed_by = $1
     WHERE id = $2`,
    [req.session.user.id, id]
  );

  req.flash('success', 'Withdrawal approved. Student removed from course.');
  res.redirect('/sis/admin/withdrawals');
});

// Admin — reject
router.post('/sis/admin/withdrawals/:id/reject', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  const notes = req.body.admin_notes || null;

  await db.run(
    `UPDATE course_withdrawals
     SET status = 'rejected', reviewed_at = NOW(), reviewed_by = $1, admin_notes = $2
     WHERE id = $3`,
    [req.session.user.id, notes, id]
  );

  req.flash('success', 'Withdrawal request rejected.');
  res.redirect('/sis/admin/withdrawals');
});

// ============================================================
//                 ADMIN — FEE STRUCTURE
// ============================================================

router.get('/sis/admin/fees', guard, async (req, res) => {
  const db = getDB();

  const structures = await db.all(`
    SELECT * FROM fee_structure
    ORDER BY class_level, term
  `);

  const recentPayments = await db.all(`
    SELECT p.*, u.full_name AS student_name, u.username
    FROM payments p
    JOIN users u ON u.id = p.student_id
    ORDER BY p.paid_at DESC
    LIMIT 5
  `);

  res.render('sis/admin-fees', {
    title: 'Fees Management',
    heading: 'Fee Structure',
    subtitle: 'Manage tuition fees per class and term.',
    structures, recentPayments,
  });
});

router.post('/sis/admin/fees/structure/new', guard, async (req, res) => {
  const db = getDB();
  const { class_level, term, amount, academic_year, description } = req.body;

  if (!class_level || !term || !amount) {
    req.flash('error', 'Class, term, and amount are required.');
    return res.redirect('/sis/admin/fees');
  }

  try {
    await db.run(
      `INSERT INTO fee_structure (class_level, term, amount, academic_year, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [class_level.trim(), term.trim(), Number(amount), academic_year || '2026', description || 'Tuition']
    );
    req.flash('success', 'Fee structure added.');
  } catch (e) {
    if (e.code === '23505') req.flash('error', 'Fee for this class/term already exists.');
    else req.flash('error', 'Could not add fee.');
  }
  res.redirect('/sis/admin/fees');
});

router.post('/sis/admin/fees/structure/:id/delete', guard, async (req, res) => {
  const db = getDB();
  await db.run(`DELETE FROM fee_structure WHERE id = $1`, [req.params.id]);
  req.flash('success', 'Fee structure deleted.');
  res.redirect('/sis/admin/fees');
});

// ============================================================
//                 ADMIN — RECORD PAYMENTS
// ============================================================

router.get('/sis/admin/fees/payments', guard, async (req, res) => {
  const db = getDB();

  const students = await db.all(`
    SELECT u.id, u.full_name, u.username, sp.class_level
    FROM users u
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    WHERE u.role = 'student' AND u.is_active = 1
    ORDER BY u.full_name
  `);

  const payments = await db.all(`
    SELECT p.*, u.full_name AS student_name, u.username
    FROM payments p
    JOIN users u ON u.id = p.student_id
    ORDER BY p.paid_at DESC LIMIT 50
  `);

  res.render('sis/admin-payments', {
    title: 'Record Payment',
    heading: 'Payments',
    subtitle: 'Record student payments and view history.',
    students, payments,
  });
});

router.post('/sis/admin/fees/payments/new', guard, async (req, res) => {
  const db = getDB();
  const { student_id, amount, term, method, receipt_number, paid_at } = req.body;

  if (!student_id || !amount) {
    req.flash('error', 'Student and amount are required.');
    return res.redirect('/sis/admin/fees/payments');
  }

  const receipt = receipt_number && receipt_number.trim()
    ? receipt_number.trim()
    : 'RCPT-' + Date.now().toString().slice(-6);

  try {
    await db.run(
      `INSERT INTO payments (student_id, amount, term, method, receipt_number, paid_at, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        Number(student_id),
        Number(amount),
        term || null,
        method || 'cash',
        receipt,
        paid_at || new Date().toISOString().slice(0, 10),
        req.session.user.id,
      ]
    );
    req.flash('success', 'Payment recorded. Receipt: ' + receipt);
  } catch (e) {
    if (e.code === '23505') req.flash('error', 'Receipt number already exists.');
    else req.flash('error', 'Could not record payment.');
  }
  res.redirect('/sis/admin/fees/payments');
});

// ============================================================
//                 ADMIN — STUDENT BALANCES
// ============================================================

router.get('/sis/admin/fees/balances', guard, async (req, res) => {
  const db = getDB();

  const raw = await db.all(`
    SELECT u.id, u.full_name, u.username,
           sp.class_level,
           COALESCE((SELECT SUM(amount) FROM fee_structure fs WHERE fs.class_level = sp.class_level), 0) AS total_owed,
           COALESCE((SELECT SUM(amount) FROM payments p WHERE p.student_id = u.id), 0) AS total_paid
    FROM users u
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    WHERE u.role = 'student' AND u.is_active = 1
    ORDER BY u.full_name
  `);

  const students = raw.map(s => ({
    ...s,
    balance: Number(s.total_owed) - Number(s.total_paid),
  }));

  const totals = {
    owed: students.reduce((sum, s) => sum + Number(s.total_owed), 0),
    paid: students.reduce((sum, s) => sum + Number(s.total_paid), 0),
    balance: students.reduce((sum, s) => sum + s.balance, 0),
  };

  res.render('sis/admin-balances', {
    title: 'Student Balances',
    heading: 'Student Balances',
    subtitle: 'Track who has paid and who owes.',
    students, totals,
  });
});

// ============================================================
//                 TEMPORARY PAYMENT SIMULATOR
// ============================================================

// 1. Student clicks "Pay Now" -> Redirect to fake bank
router.post('/sis/my/fees/pay', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  
  // Calculate the exact balance to pay
  const profile = await db.get(`SELECT class_level FROM student_profiles WHERE user_id = $1`, [uid]);
  if (!profile || !profile.class_level) return res.redirect('/sis/my/fees');

  const level = profile.class_level.replace(/[-\s].*$/, '').trim();
  const owedRow = await db.get(`SELECT COALESCE(SUM(amount),0) as total FROM fee_structure WHERE class_level = $1`, [level]);
  const paidRow = await db.get(`SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE student_id = $1`, [uid]);
  const balance = Number(owedRow.total) - Number(paidRow.total);

  if (balance <= 0) return res.redirect('/sis/my/fees');

  // Generate a fake transaction reference
  const ref = 'SIM-' + Date.now().toString().slice(-6);

  // Redirect to the mock bank page
  res.redirect(`/sis/payment-simulator?amount=${balance}&ref=${ref}`);
});

// 2. The Fake Bank Page (shows the "Payment Gateway")
router.get('/sis/payment-simulator', studentGuard, (req, res) => {
  res.render('sis/payment-simulator', {
    amount: req.query.amount,
    ref: req.query.ref
  });
});

// 3. Student clicks "Confirm" -> Simulate Bank Webhook
router.post('/sis/payment-simulator/confirm', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const { amount, ref } = req.body;

  try {
    // THIS IS EXACTLY WHAT THE REAL WEBHOOK WILL DO
    await db.run(
      `INSERT INTO payments (student_id, amount, term, method, receipt_number, paid_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [uid, Number(amount), 'Simulated Payment', 'bank_transfer', ref]
    );

    req.flash('success', 'Payment confirmed by Bank! Your balance has been cleared.');
    res.redirect('/sis/my/fees');
  } catch (e) {
    console.error('Simulator Error:', e);
    req.flash('error', 'Payment simulation failed.');
    res.redirect('/sis/my/fees');
  }
});
// ============================================================
//                 CURRICULUM
// ============================================================

// Admin — Manage Curriculum
router.get('/sis/admin/curriculum', guard, async (req, res) => {
  const db = getDB();
  
  const courses = await db.all(`
    SELECT * FROM curriculum 
    ORDER BY program_level, semester, course_name
  `);

  // Group by program_level
  const grouped = {};
  courses.forEach(c => {
    if (!grouped[c.program_level]) grouped[c.program_level] = [];
    grouped[c.program_level].push(c);
  });

  res.render('sis/admin-curriculum', {
    title: 'Curriculum',
    heading: 'Curriculum Management',
    subtitle: 'Define required and elective courses per program level.',
    grouped
  });
});

router.post('/sis/admin/curriculum/new', guard, async (req, res) => {
  const db = getDB();
  const { program_level, semester, course_code, course_name, credits, type } = req.body;

  if (!program_level || !course_name) {
    req.flash('error', 'Program Level and Course Name are required.');
    return res.redirect('/sis/admin/curriculum');
  }

  await db.run(
    `INSERT INTO curriculum (program_level, semester, course_code, course_name, credits, type)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [program_level.trim(), semester || 'All Terms', course_code || 'N/A', course_name.trim(), Number(credits) || 3, type || 'Required']
  );

  req.flash('success', 'Course added to curriculum.');
  res.redirect('/sis/admin/curriculum');
});

router.post('/sis/admin/curriculum/:id/delete', guard, async (req, res) => {
  const db = getDB();
  await db.run(`DELETE FROM curriculum WHERE id = $1`, [req.params.id]);
  req.flash('success', 'Course removed from curriculum.');
  res.redirect('/sis/admin/curriculum');
});

// Student — View Curriculum
router.get('/sis/my/curriculum', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  const profile = await db.get(`SELECT class_level FROM student_profiles WHERE user_id = $1`, [uid]);
  
  let level = 'Not Assigned';
  if (profile && profile.class_level) {
    level = profile.class_level.replace(/[-\s].*$/, '').trim(); // e.g., "Form 1A" -> "Form 1"
  }

  const courses = await db.all(`
    SELECT * FROM curriculum 
    WHERE program_level = $1 
    ORDER BY semester, type, course_name
  `, [level]);

  // Group by semester
  const bySemester = {};
  courses.forEach(c => {
    if (!bySemester[c.semester]) bySemester[c.semester] = [];
    bySemester[c.semester].push(c);
  });

  res.render('sis/my-curriculum', {
    title: 'Curriculum',
    heading: 'My Curriculum',
    subtitle: 'Your required and elective courses.',
    level, bySemester, hasCourses: courses.length > 0
  });
});

// ============================================================
//                 STUDENT — MY GRADUATION
// ============================================================
router.get('/sis/my/graduation', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;

  // 1. Get Student Level
  const profile = await db.get(`SELECT class_level FROM student_profiles WHERE user_id = $1`, [uid]);
  let level = 'Not Assigned';
  if (profile && profile.class_level) {
    level = profile.class_level.replace(/[-\s].*$/, '').trim();
  }

  // 2. Fetch Curriculum for this level
  const curriculum = await db.all(`
    SELECT * FROM curriculum 
    WHERE program_level = $1
    ORDER BY semester, type
  `, [level]);

  // 3. Fetch Student's Course Grades (Quizzes only for simplicity)
  const grades = await db.all(`
    SELECT c.title AS course_name,
           COALESCE(SUM(COALESCE(m.override_score, a.score)), 0) AS earned,
           COALESCE(SUM(a.max_score), 0) AS total
    FROM courses c
    JOIN enrollments e ON e.course_id = c.id AND e.user_id = $1
    LEFT JOIN quizzes q ON q.course_id = c.id
    LEFT JOIN attempts a ON a.quiz_id = q.id AND a.user_id = $2
    LEFT JOIN manual_grades m ON m.attempt_id = a.id
    GROUP BY c.id, c.title
  `, [uid, uid]);

  // 4. Match Curriculum to Grades to determine Status
  let totalRequiredCredits = 0;
  let totalEarnedCredits = 0;

  const checklist = curriculum.map(curr => {
    totalRequiredCredits += Number(curr.credits);
    
    // Find matching enrolled course
    const matchedGrade = grades.find(g => 
      g.course_name.toLowerCase().includes(curr.course_name.toLowerCase()) || 
      curr.course_name.toLowerCase().includes(g.course_name.toLowerCase())
    );

    let status = 'Not Started';
    let pct = 0;

    if (matchedGrade) {
      pct = matchedGrade.total > 0 ? (matchedGrade.earned / matchedGrade.total) * 100 : 0;
      if (pct >= 60) {
        status = 'Completed';
        totalEarnedCredits += Number(curr.credits);
      } else if (pct > 0 || matchedGrade.earned > 0) {
        status = 'In Progress';
      } else {
        status = 'Enrolled';
      }
    }

    return { ...curr, status, pct: Math.round(pct) };
  });

  // Calculate overall progress
  const progressPct = totalRequiredCredits > 0 
    ? Math.round((totalEarnedCredits / totalRequiredCredits) * 100) 
    : 0;

  res.render('sis/my-graduation', {
    title: 'My Graduation',
    heading: 'My Graduation',
    subtitle: 'Track your progress towards graduation.',
    level, checklist, totalRequiredCredits, totalEarnedCredits, progressPct
  });
});

module.exports = router;