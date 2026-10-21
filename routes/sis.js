const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin, requireRole } = require('../middleware/auth');
const router = express.Router();

const studentGuard = [requireLogin, (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'student') return res.status(403).render('errors/403');
  next();
}];

router.get('/sis/my/registration', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const courses = await db.all(`SELECT * FROM courses ORDER BY id ASC`);
  const cart = await db.all(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'draft'`, [uid]);
  const pending = await db.all(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'pending_advisor'`, [uid]);

  res.render('sis/my-registration', {
    title: 'Course Registration', heading: 'Course Registration',
    courses, cart, pending, user: req.session.user
  });
});

router.post('/sis/my/registration/add', studentGuard, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const courseId = Number(req.body.course_id);
  const existing = await db.get(`SELECT id FROM course_registrations WHERE student_id = $1 AND course_id = $2`, [uid, courseId]);
  if (existing) { req.flash('error', 'Already in cart.'); return res.redirect('/sis/my/registration'); }
  await db.run(`INSERT INTO course_registrations (student_id, course_id, status) VALUES ($1, $2, 'draft')`, [uid, courseId]);
  req.flash('success', 'Added.');
  res.redirect('/sis/my/registration');
});

router.post('/sis/my/registration/remove', studentGuard, async (req, res) => {
  const db = getDB();
  await db.run(`DELETE FROM course_registrations WHERE id = $1 AND student_id = $2 AND status = 'draft'`, [Number(req.body.cart_id), req.session.user.id]);
  res.redirect('/sis/my/registration');
});

router.post('/sis/my/registration/submit', studentGuard, async (req, res) => {
  const db = getDB();
  await db.run(`UPDATE course_registrations SET status = 'pending_advisor' WHERE student_id = $1 AND status = 'draft'`, [req.session.user.id]);
  req.flash('success', 'Submitted!');
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
  for (const c of courses) {
    await db.run(`INSERT INTO enrollments (user_id, course_id) VALUES ($1, $2)`, [studentId, c.course_id]);
  }
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

module.exports = router;