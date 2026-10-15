// routes/sis.js
// Student Information System — separate interface from the LMS
const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin, requireRole } = require('../middleware/auth');
const { auth: firebaseAuth } = require('../config/firebase');
const router = express.Router();

const guard = [requireLogin, requireRole('admin')];

// ============================================================
//                 SIS DASHBOARD
// ============================================================
router.get('/sis', guard, async (req, res) => {
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

  res.render('sis/dashboard', {
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
//                 STUDENT LIST
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

// ============================================================
//                 NEW STUDENT FORM
// ============================================================
router.get('/sis/students/new', guard, (req, res) => {
  res.render('sis/student-new', {
    title: 'Register Student',
    heading: 'Register New Student',
    subtitle: 'Create a new student record.',
    error: null,
    form: {},
  });
});

// ============================================================
//                 CREATE STUDENT
// ============================================================
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
      email,
      password,
      displayName: full_name,
      emailVerified: true,
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

// ============================================================
//                 STUDENT PROFILE
// ============================================================
router.get('/sis/students/:id', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);

  const student = await db.get(`
    SELECT u.id, u.username, u.full_name, u.email, u.is_active, u.created_at,
           sp.*
    FROM users u
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    WHERE u.id = $1 AND u.role = 'student'
  `, [id]);

  if (!student) {
    return res.status(404).render('errors/404');
  }

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
    student,
    attendance,
    payments,
    totalPaid: totalPaidRow.total,
  });
});

// ============================================================
//                 EDIT STUDENT
// ============================================================
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

// ============================================================
//                 DEACTIVATE / REACTIVATE
// ============================================================
router.post('/sis/students/:id/deactivate', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);

  await db.run(`UPDATE users SET is_active = 0 WHERE id = $1`, [id]);
  await db.run(
    `UPDATE student_profiles SET status = 'inactive', updated_at = NOW() WHERE user_id = $1`,
    [id]
  );

  req.flash('success', 'Student deactivated.');
  res.redirect('/sis/students');
});

router.post('/sis/students/:id/reactivate', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);

  await db.run(`UPDATE users SET is_active = 1 WHERE id = $1`, [id]);
  await db.run(
    `UPDATE student_profiles SET status = 'active', updated_at = NOW() WHERE user_id = $1`,
    [id]
  );

  req.flash('success', 'Student reactivated.');
  res.redirect('/sis/students/' + id);
});

module.exports = router;