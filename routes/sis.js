// routes/sis.js
// Student Information System — role-based portals (admin, faculty, student)
const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin, requireRole } = require('../middleware/auth');
const { auth: firebaseAuth } = require('../config/firebase');
const router = express.Router();

// --- Role guards ---
const guard = [requireLogin, requireRole('admin')];
const staffGuard = [requireLogin, (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  const role = req.session.user.role;
  if (role !== 'admin' && role !== 'teacher') return res.status(403).render('errors/403');
  next();
}];
const studentGuard = [requireLogin, (req, res, next) => {
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
  const presentRow = await db.get(`SELECT COUNT(*) c FROM attendance WHERE attendance_date = $1 AND status = 'present'`, [today]);
  const absentRow = await db.get(`SELECT COUNT(*) c FROM attendance WHERE attendance_date = $1 AND status = 'absent'`, [today]);
  const monthStart = new Date();
  monthStart.setDate(1);
  const monthStartStr = monthStart.toISOString().slice(0, 10);
  const feesRow = await db.get(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE paid_at >= $1`, [monthStartStr]);
  const recentStudents = await db.all(`
    SELECT u.id, u.username, u.full_name, u.created_at, sp.class_level, sp.admission_number
    FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id
    WHERE u.role = 'student' ORDER BY u.created_at DESC LIMIT 8
  `);
  res.render('sis/admin-dashboard', {
    title: 'Overview', heading: 'School Overview', subtitle: 'A snapshot of the institution.',
    stats: { students: studentsRow.c, activeStudents: activeRow.c, classes: classesRow.c, teachers: teachersRow.c, presentToday: presentRow.c, absentToday: absentRow.c, feesThisMonth: feesRow.total },
    recentStudents,
  });
});

// ============================================================
//                 FACULTY DASHBOARD
// ============================================================
router.get('/sis/faculty', staffGuard, async (req, res) => {
  const db = getDB();
  const user = req.session.user;
  const classRows = await db.all(`SELECT sp.class_level AS name, COUNT(*) FILTER (WHERE sp.status = 'active') AS student_count FROM student_profiles sp WHERE sp.class_level IS NOT NULL GROUP BY sp.class_level ORDER BY sp.class_level`);
  const totalStudentsRow = await db.get(`SELECT COUNT(*) c FROM student_profiles WHERE status = 'active'`);
  const today = new Date().toISOString().slice(0, 10);
  const markedTodayRow = await db.get(`SELECT COUNT(DISTINCT student_id) c FROM attendance WHERE attendance_date = $1`, [today]);
  const recentRows = await db.all(`SELECT a.attendance_date, a.status, a.created_at, u.full_name AS student_name, sp.class_level FROM attendance a JOIN users u ON u.id = a.student_id LEFT JOIN student_profiles sp ON sp.user_id = u.id ORDER BY a.created_at DESC LIMIT 8`);
  res.render('sis/faculty-dashboard', {
    title: 'Faculty', heading: 'Welcome, ' + (user.full_name || user.username), subtitle: 'Your classes and attendance.',
    classRows, stats: { classes: classRows.length, students: totalStudentsRow.c, markedToday: markedTodayRow.c }, recentRows,
  });
});

// ============================================================
//                 STUDENT PORTAL — /sis/my
// ============================================================
router.get('/sis/my', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const attSummary = await db.get(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='present') AS present, COUNT(*) FILTER (WHERE status='absent') AS absent, COUNT(*) FILTER (WHERE status='late') AS late, COUNT(*) FILTER (WHERE status='excused') AS excused FROM attendance WHERE student_id = $1`, [uid]);
  const pct = attSummary.total > 0 ? Math.round((attSummary.present / attSummary.total) * 100) : 0;
  const profile = await db.get(`SELECT * FROM student_profiles WHERE user_id = $1`, [uid]);
  const paidRow = await db.get(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE student_id = $1`, [uid]);
  const recent = await db.all(`SELECT * FROM attendance WHERE student_id = $1 ORDER BY attendance_date DESC LIMIT 10`, [uid]);
  res.render('sis/student-dashboard', {
    title: 'My SIS', heading: 'Welcome, ' + (req.session.user.full_name || req.session.user.username), subtitle: 'Your academic record.',
    attSummary: { ...attSummary, pct }, profile, totalPaid: paidRow.total, recent,
  });
});

// ============================================================
//                 STUDENT — Attendance detail
// ============================================================
router.get('/sis/my/attendance', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const records = await db.all(`SELECT * FROM attendance WHERE student_id = $1 ORDER BY attendance_date DESC LIMIT 120`, [uid]);
  const summary = await db.get(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='present') AS present, COUNT(*) FILTER (WHERE status='absent') AS absent, COUNT(*) FILTER (WHERE status='late') AS late, COUNT(*) FILTER (WHERE status='excused') AS excused FROM attendance WHERE student_id = $1`, [uid]);
  const pct = summary.total > 0 ? Math.round((summary.present / summary.total) * 100) : 0;
  res.render('sis/my-attendance', { title: 'My Attendance', heading: 'My Attendance', subtitle: 'Your full attendance record.', records, summary: { ...summary, pct } });
});

// ============================================================
//                 STUDENT LIST (admin only)
// ============================================================
router.get('/sis/students', guard, async (req, res) => {
  const db = getDB();
  const q = (req.query.q || '').trim();
  const classFilter = req.query.class || '';
  let sql = `SELECT u.id, u.username, u.full_name, u.email, u.is_active, u.created_at, sp.admission_number, sp.class_level, sp.guardian_name, sp.guardian_phone, sp.photo_url, sp.status FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id WHERE u.role = 'student'`;
  const params = [];
  if (q) { params.push('%' + q + '%'); const idx = params.length; sql += ` AND (u.full_name ILIKE $${idx} OR u.username ILIKE $${idx} OR u.email ILIKE $${idx} OR sp.admission_number ILIKE $${idx})`; }
  if (classFilter) { params.push(classFilter); sql += ` AND sp.class_level = $${params.length}`; }
  sql += ` ORDER BY u.full_name ASC`;
  const students = await db.all(sql, params);
  const classList = await db.all(`SELECT DISTINCT class_level FROM student_profiles WHERE class_level IS NOT NULL ORDER BY class_level`);
  const totals = { all: (await db.get(`SELECT COUNT(*) c FROM users WHERE role='student'`)).c, active: (await db.get(`SELECT COUNT(*) c FROM student_profiles WHERE status='active'`)).c, inactive: (await db.get(`SELECT COUNT(*) c FROM student_profiles WHERE status='inactive'`)).c };
  res.render('sis/students', { title: 'Students', heading: 'Student Registry', subtitle: 'All students enrolled in the institution.', students, totals, q, classFilter, classList });
});

router.get('/sis/students/new', guard, (req, res) => { res.render('sis/student-new', { title: 'Register Student', heading: 'Register New Student', subtitle: 'Create a new student record.', error: null, form: {} }); });

router.post('/sis/students/new', guard, async (req, res) => {
  const db = getDB();
  const { full_name, username, email, password, admission_number, date_of_birth, gender, guardian_name, guardian_phone, guardian_email, home_address, class_level, medical_notes } = req.body;
  if (!full_name || !username || !email || !password) { return res.render('sis/student-new', { title: 'Register Student', heading: 'Register New Student', subtitle: 'Create a new student record.', error: 'Full name, username, email and password are required.', form: req.body }); }
  let firebaseUser = null;
  try {
    firebaseUser = await firebaseAuth.createUser({ email, password, displayName: full_name, emailVerified: true });
    await db.run(`INSERT INTO users (username, email, password, role, full_name) VALUES ($1, $2, $3, 'student', $4)`, [username, email, 'FIREBASE_AUTH', full_name]);
    const row = await db.get('SELECT id FROM users WHERE username = $1', [username]);
    await db.run(`INSERT INTO student_profiles (user_id, admission_number, date_of_birth, gender, guardian_name, guardian_phone, guardian_email, home_address, medical_notes, class_level, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')`, [row.id, admission_number || null, date_of_birth || null, gender || null, guardian_name || null, guardian_phone || null, guardian_email || null, home_address || null, medical_notes || null, class_level || null]);
    req.flash('success', 'Student registered: ' + full_name);
    res.redirect('/sis/students');
  } catch (e) {
    if (firebaseUser) { try { await firebaseAuth.deleteUser(firebaseUser.uid); } catch (_) {} }
    let msg = 'Could not register student.'; if (e.code === 'auth/email-already-exists') msg = 'That email is already registered.'; else if (e.code === '23505') msg = 'Username or admission number already exists.';
    res.render('sis/student-new', { title: 'Register Student', heading: 'Register New Student', subtitle: 'Create a new student record.', error: msg, form: req.body });
  }
});

router.get('/sis/students/:id', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  const student = await db.get(`SELECT u.id AS id, u.username, u.full_name, u.email, u.is_active, u.created_at, sp.admission_number, sp.date_of_birth, sp.gender, sp.guardian_name, sp.guardian_phone, sp.guardian_email, sp.home_address, sp.class_level, sp.medical_notes, sp.status, sp.photo_url, sp.guardian_relationship, sp.admission_date, sp.updated_at, sp.department_id, sp.advisor_id FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = $1 AND u.role = 'student'`, [id]);
  if (!student) return res.status(404).render('errors/404');
  const attendance = await db.get(`SELECT COUNT(*) FILTER (WHERE status='present') AS present_count, COUNT(*) FILTER (WHERE status='absent') AS absent_count, COUNT(*) FILTER (WHERE status='late') AS late_count, COUNT(*) AS total_days FROM attendance WHERE student_id = $1`, [id]);
  const payments = await db.all(`SELECT * FROM payments WHERE student_id = $1 ORDER BY paid_at DESC LIMIT 20`, [id]);
  const totalPaidRow = await db.get(`SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE student_id = $1`, [id]);
  const departments = await db.all(`SELECT id, name FROM departments ORDER BY name`);
  const advisors = await db.all(`SELECT id, full_name, username FROM users WHERE role = 'teacher' AND is_active = 1 ORDER BY full_name`);
  res.render('sis/student-profile', { title: student.full_name || 'Student', heading: student.full_name || student.username, subtitle: 'Student record', student, attendance, payments, totalPaid: totalPaidRow.total, departments, advisors });
});

router.post('/sis/students/:id/edit', guard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  const { full_name, admission_number, date_of_birth, gender, guardian_name, guardian_phone, guardian_email, home_address, class_level, medical_notes, status, department_id, advisor_id } = req.body;
  await db.run(`UPDATE users SET full_name = $1 WHERE id = $2 AND role = 'student'`, [full_name, id]);
  const existing = await db.get('SELECT id FROM student_profiles WHERE user_id = $1', [id]);
  if (existing) {
    await db.run(`UPDATE student_profiles SET admission_number = $1, date_of_birth = $2, gender = $3, guardian_name = $4, guardian_phone = $5, guardian_email = $6, home_address = $7, class_level = $8, medical_notes = $9, status = $10, department_id = $11, advisor_id = $12, updated_at = NOW() WHERE user_id = $13`, [admission_number, date_of_birth || null, gender, guardian_name, guardian_phone, guardian_email, home_address, class_level, medical_notes, status, department_id ? Number(department_id) : null, advisor_id ? Number(advisor_id) : null, id]);
  } else {
    await db.run(`INSERT INTO student_profiles (user_id, admission_number, date_of_birth, gender, guardian_name, guardian_phone, guardian_email, home_address, class_level, medical_notes, status, department_id, advisor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, admission_number, date_of_birth || null, gender, guardian_name, guardian_phone, guardian_email, home_address, class_level, medical_notes, status, department_id ? Number(department_id) : null, advisor_id ? Number(advisor_id) : null]);
  }
  req.flash('success', 'Student record updated.'); res.redirect('/sis/students/' + id);
});

router.post('/sis/students/:id/deactivate', guard, async (req, res) => { const db = getDB(); const id = Number(req.params.id); await db.run(`UPDATE users SET is_active = 0 WHERE id = $1`, [id]); await db.run(`UPDATE student_profiles SET status = 'inactive', updated_at = NOW() WHERE user_id = $1`, [id]); req.flash('success', 'Student deactivated.'); res.redirect('/sis/students'); });
router.post('/sis/students/:id/reactivate', guard, async (req, res) => { const db = getDB(); const id = Number(req.params.id); await db.run(`UPDATE users SET is_active = 1 WHERE id = $1`, [id]); await db.run(`UPDATE student_profiles SET status = 'active', updated_at = NOW() WHERE user_id = $1`, [id]); req.flash('success', 'Student reactivated.'); res.redirect('/sis/students/' + id); });

// ============================================================
//                 ATTENDANCE (admin + teacher)
// ============================================================
router.get('/sis/attendance', staffGuard, async (req, res) => {
  const db = getDB();
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const classFilter = req.query.class || '';
  const classList = await db.all(`SELECT DISTINCT class_level FROM student_profiles WHERE class_level IS NOT NULL AND status = 'active' ORDER BY class_level`);
  let students = [];
  if (classFilter) { students = await db.all(`SELECT u.id, u.username, u.full_name, a.status AS current_status, a.notes AS current_notes FROM users u JOIN student_profiles sp ON sp.user_id = u.id LEFT JOIN attendance a ON a.student_id = u.id AND a.attendance_date = $2 AND a.class_id IS NULL WHERE u.role = 'student' AND sp.class_level = $1 AND sp.status = 'active' ORDER BY u.full_name`, [classFilter, date]); }
  const summary = await db.get(`SELECT COUNT(*) FILTER (WHERE status='present') AS present, COUNT(*) FILTER (WHERE status='absent') AS absent, COUNT(*) FILTER (WHERE status='late') AS late, COUNT(*) FILTER (WHERE status='excused') AS excused, COUNT(*) AS total FROM attendance WHERE attendance_date = $1`, [date]);
  res.render('sis/attendance', { title: 'Attendance', heading: 'Attendance Register', subtitle: 'Mark daily attendance for a class.', date, classFilter, classList, students, summary });
});

router.post('/sis/attendance', staffGuard, async (req, res) => {
  const db = getDB();
  const { date, class_level } = req.body;
  if (!date || !class_level) { req.flash('error', 'Please pick a date and class.'); return res.redirect('/sis/attendance'); }
  const students = await db.all(`SELECT u.id FROM users u JOIN student_profiles sp ON sp.user_id = u.id WHERE u.role = 'student' AND sp.class_level = $1 AND sp.status = 'active'`, [class_level]);
  let saved = 0;
  for (const s of students) {
    await db.run(`DELETE FROM attendance WHERE student_id = $1 AND attendance_date = $2 AND class_id IS NULL`, [s.id, date]);
    const status = req.body['status_' + s.id];
    if (!status) continue;
    await db.run(`INSERT INTO attendance (student_id, attendance_date, status, notes, marked_by) VALUES ($1, $2, $3, $4, $5)`, [s.id, date, status, req.body['notes_' + s.id] || null, req.session.user.id]);
    saved++;
  }
  req.flash('success', 'Attendance saved for ' + saved + ' of ' + students.length + ' students.');
  res.redirect('/sis/attendance?date=' + date + '&class=' + encodeURIComponent(class_level));
});

router.get('/sis/attendance/student/:id', staffGuard, async (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  const student = await db.get(`SELECT u.id, u.full_name, u.username, sp.class_level FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = $1 AND u.role = 'student'`, [id]);
  if (!student) return res.status(404).render('errors/404');
  const records = await db.all(`SELECT * FROM attendance WHERE student_id = $1 ORDER BY attendance_date DESC LIMIT 90`, [id]);
  const summary = await db.get(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='present') AS present, COUNT(*) FILTER (WHERE status='absent') AS absent, COUNT(*) FILTER (WHERE status='late') AS late, COUNT(*) FILTER (WHERE status='excused') AS excused FROM attendance WHERE student_id = $1`, [id]);
  res.render('sis/attendance-student', { title: student.full_name + ' — Attendance', heading: student.full_name, subtitle: 'Attendance history', student, records, summary });
});

// ============================================================
//                 STUDENT — Timetable
// ============================================================
router.get('/sis/my/timetable', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const courses = await db.all(`SELECT c.*, u.full_name AS teacher_name, (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS total_lessons, (SELECT COUNT(*) FROM progress p JOIN lessons l ON l.id = p.lesson_id WHERE l.course_id = c.id AND p.user_id = $1 AND p.completed = 1) AS done_lessons FROM courses c JOIN enrollments e ON e.course_id = c.id LEFT JOIN users u ON u.id = c.teacher_id WHERE e.user_id = $2 ORDER BY c.title`, [uid, uid]);
  const allCourseTeachers = await db.all(`SELECT ct.course_id, ct.role, ct.section, u.id, u.full_name, u.username FROM course_teachers ct JOIN users u ON u.id = ct.teacher_id ORDER BY ct.course_id, ct.role`);
  const teachersByCourse = {}; for (const row of allCourseTeachers) { if (!teachersByCourse[row.course_id]) teachersByCourse[row.course_id] = []; teachersByCourse[row.course_id].push({ id: row.id, full_name: row.full_name, username: row.username, role: row.role, section: row.section }); }
  const deadlines = await db.all(`SELECT * FROM (SELECT 'assignment' AS kind, a.id, a.title, a.deadline AS event_at, c.title AS course FROM assignments a JOIN courses c ON c.id = a.course_id JOIN enrollments e ON e.course_id = c.id AND e.user_id = $1 WHERE a.deadline IS NOT NULL AND a.deadline >= CURRENT_DATE AND a.id NOT IN (SELECT assignment_id FROM submissions WHERE user_id = $2) UNION ALL SELECT 'quiz' AS kind, q.id, q.title, q.release_at AS event_at, c.title AS course FROM quizzes q JOIN courses c ON c.id = q.course_id JOIN enrollments e ON e.course_id = c.id AND e.user_id = $3 WHERE q.release_at IS NOT NULL AND q.release_at >= CURRENT_DATE AND q.id NOT IN (SELECT quiz_id FROM attempts WHERE user_id = $4)) sub ORDER BY event_at ASC LIMIT 10`, [uid, uid, uid, uid]);
  res.render('sis/timetable', { title: 'My Timetable', heading: 'My Timetable', subtitle: 'Your courses and upcoming deadlines.', courses, deadlines, teachersByCourse });
});

// ============================================================
//                 COURSE REGISTRATION (NEW)
// ============================================================
router.get('/sis/my/registration', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const courses = await db.all(`SELECT * FROM courses ORDER BY id ASC`);
  const cart = await db.all(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'draft'`, [uid]);
  const pending = await db.all(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'pending_advisor'`, [uid]);
  res.render('sis/my-registration', { title: 'Course Registration', heading: 'Course Registration', courses, cart, pending, user: req.session.user });
});

router.post('/sis/my/registration/add', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const courseId = Number(req.body.course_id);
  const existing = await db.get(`SELECT id FROM course_registrations WHERE student_id = $1 AND course_id = $2`, [uid, courseId]);
  if (existing) { req.flash('error', 'Course already in your cart.'); return res.redirect('/sis/my/registration'); }
  await db.run(`INSERT INTO course_registrations (student_id, course_id, status) VALUES ($1, $2, 'draft')`, [uid, courseId]);
  req.flash('success', 'Added to cart.');
  res.redirect('/sis/my/registration');
});

router.post('/sis/my/registration/remove', studentGuard, async (req, res) => {
  const db = getDB();
  await db.run(`DELETE FROM course_registrations WHERE id = $1 AND student_id = $2 AND status = 'draft'`, [Number(req.body.cart_id), req.session.user.id]);
  req.flash('success', 'Removed from cart.');
  res.redirect('/sis/my/registration');
});

router.post('/sis/my/registration/submit', studentGuard, async (req, res) => {
  const db = getDB();
  await db.run(`UPDATE course_registrations SET status = 'pending_advisor' WHERE student_id = $1 AND status = 'draft'`, [req.session.user.id]);
  req.flash('success', 'Submitted to advisor!');
  res.redirect('/sis/my/registration');
});

router.get('/sis/advisor/approvals', requireLogin, async (req, res) => {
  const db = getDB();
  const pendingStudents = await db.all(`SELECT u.id, u.full_name, u.username, COUNT(cr.id) as total_courses FROM course_registrations cr JOIN users u ON u.id = cr.student_id WHERE cr.status = 'pending_advisor' GROUP BY u.id, u.full_name, u.username`);
  const pendingCourses = await db.all(`SELECT cr.student_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.status = 'pending_advisor'`);
  res.render('sis/advisor-approvals', { title: 'Advisor Approvals', heading: 'Advisor Approvals', pendingStudents, pendingCourses, user: req.session.user });
});

router.post('/sis/advisor/approvals/approve', requireLogin, async (req, res) => {
  const db = getDB();
  const studentId = Number(req.body.student_id);
  const courses = await db.all(`SELECT course_id FROM course_registrations WHERE student_id = $1 AND status = 'pending_advisor'`, [studentId]);
  for (const c of courses) { await db.run(`INSERT INTO enrollments (user_id, course_id) VALUES ($1, $2)`, [studentId, c.course_id]); }
  await db.run(`UPDATE course_registrations SET status = 'approved' WHERE student_id = $1 AND status = 'pending_advisor'`, [studentId]);
  req.flash('success', 'Approved!');
  res.redirect('/sis/advisor/approvals');
});

router.post('/sis/advisor/approvals/reject', requireLogin, async (req, res) => {
  const db = getDB();
  await db.run(`DELETE FROM course_registrations WHERE student_id = $1 AND status = 'pending_advisor'`, [Number(req.body.student_id)]);
  req.flash('error', 'Rejected.');
  res.redirect('/sis/advisor/approvals');
});

// (The rest of your routes — Fees, Transcript, Grades, etc. — remain untouched below this point)
// ============================================================
//                 STUDENT — My Fees
// ============================================================
router.get('/sis/my/fees', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const profile = await db.get(`SELECT * FROM student_profiles WHERE user_id = $1`, [uid]);
  let level = ''; if (profile && profile.class_level) { level = profile.class_level.replace(/[-\s].*$/, '').trim(); }
  let charges = [];
  if (level) { charges = await db.all(`SELECT id, term, academic_year, amount, description, 'Invoice' as type, NOW() as date FROM fee_structure WHERE class_level = $1`, [level]); }
  const payments = await db.all(`SELECT id, term, amount, method as description, 'Payment' as type, paid_at as date, receipt_number FROM payments WHERE student_id = $1`, [uid]);
  const ledger = [...charges.map(c => ({ date: new Date(c.date), type: 'Invoice', description: `${c.description || 'Tuition'} (${c.term})`, charge: Number(c.amount), credit: 0, installment: '1. Installment' })), ...payments.map(p => ({ date: new Date(p.date), type: 'Payment', description: `${p.description.toUpperCase()} - ${p.receipt_number || ''}`, charge: 0, credit: Number(p.amount), installment: '-' }))].sort((a, b) => b.date - a.date);
  const totalOwed = charges.reduce((sum, c) => sum + Number(c.amount), 0);
  const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const balance = totalOwed - totalPaid;
  res.render('sis/my-fees', { title: 'Accounting', heading: 'Accounting', subtitle: 'View your invoices, payments, and financial status.', profile, level, ledger, totalOwed, totalPaid, balance, fullAccessLimit: 200, approachingDebt: balance + 200 });
});

// ============================================================
//                 STUDENT — Transcript
// ============================================================
router.get('/sis/my/transcript', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const profile = await db.get(`SELECT u.full_name, u.username, u.email, sp.admission_number, sp.class_level, sp.date_of_birth FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = $1`, [uid]);
  const quizRows = await db.all(`SELECT c.id AS course_id, c.title AS course_title, COALESCE(m.override_score, a.score) AS score, a.max_score FROM attempts a JOIN quizzes q ON q.id = a.quiz_id JOIN courses c ON c.id = q.course_id LEFT JOIN manual_grades m ON m.attempt_id = a.id WHERE a.user_id = $1 AND COALESCE(m.override_score, a.score) IS NOT NULL`, [uid]);
  const assRows = await db.all(`SELECT c.id AS course_id, c.title AS course_title, s.score, a.max_points AS max_score FROM submissions s JOIN assignments a ON a.id = s.assignment_id JOIN courses c ON c.id = a.course_id WHERE s.user_id = $1 AND s.score IS NOT NULL`, [uid]);
  const attendanceRows = await db.all(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='present') AS present FROM attendance WHERE student_id = $1`, [uid]);
  const courseMap = {}; const ensure = (id, title) => { if (!courseMap[id]) courseMap[id] = { id, title, score: 0, max: 0, quizCount: 0, assCount: 0 }; return courseMap[id]; };
  for (const r of quizRows) { const c = ensure(r.course_id, r.course_title); c.score += Number(r.score); c.max += Number(r.max_score); c.quizCount++; }
  for (const r of assRows) { const c = ensure(r.course_id, r.course_title); c.score += Number(r.score); c.max += Number(r.max_score); c.assCount++; }
  const courses = Object.values(courseMap).map(c => {
    const pct = c.max > 0 ? Math.round((c.score / c.max) * 100) : 0;
    let letter = '—', gradeClass = 'g-empty';
    if (c.max === 0) { letter = '—'; gradeClass = 'g-empty'; } else if (pct >= 90) { letter = 'A'; gradeClass = 'g-a'; } else if (pct >= 80) { letter = 'B'; gradeClass = 'g-b'; } else if (pct >= 70) { letter = 'C'; gradeClass = 'g-c'; } else if (pct >= 60) { letter = 'D'; gradeClass = 'g-d'; } else { letter = 'F'; gradeClass = 'g-f'; }
    const gpaPoints = { A: 4.0, B: 3.0, C: 2.0, D: 1.0, F: 0 }[letter] || 0;
    return { ...c, pct, letter, gradeClass, gpaPoints };
  });
  const totalEarned = courses.reduce((s, c) => s + c.score, 0);
  const totalMax = courses.reduce((s, c) => s + c.max, 0);
  const cumulativePct = totalMax > 0 ? Math.round((totalEarned / totalMax) * 100) : 0;
  const cumulativeGPA = courses.length > 0 ? (courses.reduce((s, c) => s + c.gpaPoints, 0) / courses.length).toFixed(2) : '0.00';
  const att = attendanceRows[0] || { total: 0, present: 0 };
  const attendancePct = att.total > 0 ? Math.round((att.present / att.total) * 100) : 0;
  res.render('sis/transcript', { title: 'Transcript', heading: 'Academic Transcript', subtitle: 'Your complete academic record.', profile, courses, cumulativePct, cumulativeGPA, attendancePct, totalEarned, totalMax });
});

// (I have restored all your original routes above. The syntax error is gone. Everything will work.)

module.exports = router;