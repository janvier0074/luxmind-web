const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin } = require('../middleware/auth');
const { generateCode, generateCertificatePDF } = require('../services/certificateService');
const router = express.Router();

// ---------- ISSUE / DOWNLOAD CERTIFICATE ----------
router.get('/certificates/:courseId', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.status(403).send('Only students get certificates.');
  const db = getDB();
  const uid = req.session.user.id;
  const courseId = req.params.courseId;

  const course = await db.get(`
    SELECT c.*, u.full_name AS teacher_name
    FROM courses c
    LEFT JOIN users u ON u.id = c.teacher_id
    WHERE c.id = ?
  `, [courseId]);

  if (!course) return res.status(404).send('Course not found');

  const enrolled = await db.get(
    'SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?',
    [uid, courseId]
  );
  if (!enrolled) return res.status(403).send('You are not enrolled in this course.');

  // compute progress
  const total = (await db.get(
    'SELECT COUNT(*) c FROM lessons WHERE course_id = ?', [courseId]
  )).c;

  const done = (await db.get(`
    SELECT COUNT(*) c FROM progress p
    JOIN lessons l ON l.id = p.lesson_id
    WHERE l.course_id = ? AND p.user_id = ? AND p.completed = 1
  `, [courseId, uid])).c;

  if (total === 0 || done < total) {
    req.flash('error', 'Complete all lessons before claiming your certificate.');
    return res.redirect('/courses/' + courseId);
  }

  // check if already issued
  let cert = await db.get(
    'SELECT * FROM certificates WHERE user_id = ? AND course_id = ?',
    [uid, courseId]
  );

  if (!cert) {
    const code = generateCode();
    const r = await db.run(
      'INSERT INTO certificates (user_id, course_id, code) VALUES (?,?,?)',
      [uid, courseId, code]
    );
    cert = await db.get('SELECT * FROM certificates WHERE id = ?', [r.lastID]);
    req.flash('success', '🎉 Certificate issued!');
  }

  const user = await db.get('SELECT full_name, username FROM users WHERE id = ?', [uid]);
  const studentName = user.full_name || user.username;

  const issuedAt = new Date(cert.issued_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  generateCertificatePDF(res, {
    studentName,
    courseTitle: course.title,
    teacherName: course.teacher_name || 'LuxMind',
    issuedAt,
    code: cert.code,
  });
});

// ---------- MY CERTIFICATES ----------
router.get('/my-certificates', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/dashboard');
  const db = getDB();
  const uid = req.session.user.id;

  const certificates = await db.all(`
    SELECT cert.*, c.title AS course_title
    FROM certificates cert
    JOIN courses c ON c.id = cert.course_id
    WHERE cert.user_id = ?
    ORDER BY cert.issued_at DESC
  `, [uid]);

  res.render('student/certificates', {
    title: 'My Certificates',
    heading: 'My Certificates',
    subtitle: 'Your achievements on LuxMind.',
    certificates,
  });
});

// ---------- VERIFY (public) ----------
router.get('/verify/:code', async (req, res) => {
  const db = getDB();
  const cert = await db.get(`
    SELECT cert.*, c.title AS course_title, u.full_name AS student_name, u.username AS student_username
    FROM certificates cert
    JOIN courses c ON c.id = cert.course_id
    JOIN users u ON u.id = cert.user_id
    WHERE cert.code = ?
  `, [req.params.code]);

  res.render('certificate-verify', {
    title: 'Verify Certificate',
    heading: 'Certificate Verification',
    subtitle: 'Public verification page.',
    cert: cert || null,
    code: req.params.code,
  });
});

module.exports = router;