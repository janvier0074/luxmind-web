const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDB } = require('../config/database');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

// upload dir
const uploadRoot = path.join(__dirname, '..', 'uploads', 'assignments');
if (!fs.existsSync(uploadRoot)) fs.mkdirSync(uploadRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(uploadRoot, 'assignment-' + req.params.id, 'user-' + req.session.user.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

// ============================================================
//                     TEACHER
// ============================================================

router.get('/teacher/assignments', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/dashboard');
  const db = getDB();
  const tid = req.session.user.id;

  const courses = await db.all('SELECT * FROM courses WHERE teacher_id = ?', [tid]);

  const assignments = await db.all(`
    SELECT a.*, c.title AS course_title,
      (SELECT COUNT(*) FROM submissions WHERE assignment_id = a.id) AS subs,
      (SELECT COUNT(*) FROM submissions WHERE assignment_id = a.id AND score IS NULL) AS pending
    FROM assignments a
    JOIN courses c ON c.id = a.course_id
    WHERE c.teacher_id = ?
    ORDER BY a.created_at DESC
  `, [tid]);

  res.render('teacher/assignments', {
    title: 'Assignments',
    heading: 'Assignments',
    subtitle: 'Create assignments and grade submissions.',
    courses, assignments,
  });
});

router.post('/teacher/assignments', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/dashboard');
  const db = getDB();
  const { course_id, title, description, deadline, max_points } = req.body;

  const course = await db.get(
    'SELECT * FROM courses WHERE id = ? AND teacher_id = ?',
    [course_id, req.session.user.id]
  );
  if (!course) {
    req.flash('error', 'Invalid course.');
    return res.redirect('/teacher/assignments');
  }

  const iso = deadline ? new Date(deadline).toISOString() : null;

  await db.run(
    'INSERT INTO assignments (course_id, title, description, deadline, max_points) VALUES (?,?,?,?,?)',
    [course_id, title, description || null, iso, Number(max_points) || 100]
  );

  req.flash('success', 'Assignment created.');
  res.redirect('/teacher/assignments');
});

router.post('/teacher/assignments/:id/delete', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/dashboard');
  const db = getDB();
  const a = await db.get(`
    SELECT a.id FROM assignments a
    JOIN courses c ON c.id = a.course_id
    WHERE a.id = ? AND c.teacher_id = ?
  `, [req.params.id, req.session.user.id]);
  if (!a) { req.flash('error', 'Not found.'); return res.redirect('/teacher/assignments'); }
  await db.run('DELETE FROM assignments WHERE id = ?', [a.id]);
  req.flash('success', 'Assignment deleted.');
  res.redirect('/teacher/assignments');
});

router.get('/teacher/assignments/:id', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/dashboard');
  const db = getDB();
  const tid = req.session.user.id;

  const assignment = await db.get(`
    SELECT a.*, c.title AS course_title
    FROM assignments a
    JOIN courses c ON c.id = a.course_id
    WHERE a.id = ? AND c.teacher_id = ?
  `, [req.params.id, tid]);

  if (!assignment) return res.status(404).send('Not found');

  const submissions = await db.all(`
    SELECT s.*, u.full_name AS student_name, u.username AS student_username
    FROM submissions s
    JOIN users u ON u.id = s.user_id
    WHERE s.assignment_id = ?
    ORDER BY s.submitted_at DESC
  `, [assignment.id]);

  // enrolled students who haven't submitted yet
  const notSubmitted = await db.all(`
    SELECT u.id, u.full_name, u.username
    FROM enrollments e
    JOIN users u ON u.id = e.user_id
    WHERE e.course_id = ?
      AND u.id NOT IN (SELECT user_id FROM submissions WHERE assignment_id = ?)
  `, [assignment.course_id, assignment.id]);

  res.render('teacher/assignment-detail', {
    title: assignment.title,
    heading: assignment.title,
    subtitle: assignment.course_title,
    assignment, submissions, notSubmitted,
  });
});

router.post('/teacher/submissions/:id/grade', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/dashboard');
  const db = getDB();
  const { score, feedback } = req.body;
  const subId = req.params.id;

  const sub = await db.get(`
    SELECT s.id, s.assignment_id FROM submissions s
    JOIN assignments a ON a.id = s.assignment_id
    JOIN courses c ON c.id = a.course_id
    WHERE s.id = ? AND c.teacher_id = ?
  `, [subId, req.session.user.id]);

  if (!sub) { req.flash('error', 'Not found.'); return res.redirect('/teacher/assignments'); }

  await db.run(
    'UPDATE submissions SET score = ?, feedback = ?, graded_by = ?, graded_at = CURRENT_TIMESTAMP WHERE id = ?',
    [Number(score), feedback || null, req.session.user.id, subId]
  );

  req.flash('success', 'Grade saved.');
  res.redirect('/teacher/assignments/' + sub.assignment_id);
});

// ============================================================
//                     STUDENT
// ============================================================

router.get('/student/assignments', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/dashboard');
  const db = getDB();
  const uid = req.session.user.id;

  const assignments = await db.all(`
    SELECT a.*, c.title AS course_title, s.id AS submission_id,
      s.submitted_at, s.score, s.feedback, s.file_name
    FROM assignments a
    JOIN courses c ON c.id = a.course_id
    JOIN enrollments e ON e.course_id = c.id AND e.user_id = ?
    LEFT JOIN submissions s ON s.assignment_id = a.id AND s.user_id = ?
    ORDER BY a.deadline IS NULL, a.deadline ASC, a.created_at DESC
  `, [uid, uid]);

  const now = new Date();
  assignments.forEach(a => {
    a.isOverdue = a.deadline && new Date(a.deadline) < now;
    a.isDueSoon = a.deadline && !a.isOverdue && (new Date(a.deadline) - now) < 1000 * 60 * 60 * 48;
  });

  res.render('student/assignments', {
    title: 'Assignments',
    heading: 'Assignments',
    subtitle: 'Your tasks and submissions.',
    assignments,
  });
});

router.get('/student/assignments/:id', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/dashboard');
  const db = getDB();
  const uid = req.session.user.id;

  const assignment = await db.get(`
    SELECT a.*, c.title AS course_title
    FROM assignments a
    JOIN courses c ON c.id = a.course_id
    JOIN enrollments e ON e.course_id = c.id AND e.user_id = ?
    WHERE a.id = ?
  `, [uid, req.params.id]);

  if (!assignment) return res.status(404).send('Not found');

  const submission = await db.get(
    'SELECT * FROM submissions WHERE assignment_id = ? AND user_id = ?',
    [assignment.id, uid]
  );

  const now = new Date();
  assignment.isOverdue = assignment.deadline && new Date(assignment.deadline) < now;

  res.render('student/assignment-detail', {
    title: assignment.title,
    heading: assignment.title,
    subtitle: assignment.course_title,
    assignment, submission,
  });
});

router.post('/student/assignments/:id/submit', requireLogin,
  upload.single('file'), async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/dashboard');
  const db = getDB();
  const uid = req.session.user.id;
  const assignmentId = req.params.id;

  const assignment = await db.get(
    'SELECT * FROM assignments WHERE id = ?', [assignmentId]
  );
  if (!assignment) return res.status(404).send('Not found');

  const existing = await db.get(
    'SELECT * FROM submissions WHERE assignment_id = ? AND user_id = ?',
    [assignmentId, uid]
  );

  // accept late submission but flag it
  const now = new Date();
  const isLate = assignment.deadline && new Date(assignment.deadline) < now;

  const relPath = req.file
    ? '/uploads/assignments/assignment-' + assignmentId + '/user-' + uid + '/' + req.file.filename
    : (existing ? existing.file_path : null);
  const fileName = req.file ? req.file.originalname : (existing ? existing.file_name : null);
  const textContent = (req.body.text_content || '').trim() || null;

  if (existing) {
    await db.run(`
      UPDATE submissions SET file_path = ?, file_name = ?, text_content = ?,
        submitted_at = CURRENT_TIMESTAMP, score = NULL, feedback = NULL, graded_at = NULL
      WHERE id = ?
    `, [relPath, fileName, textContent, existing.id]);
    req.flash('success', isLate ? 'Resubmitted (late).' : 'Resubmitted.');
  } else {
    await db.run(`
      INSERT INTO submissions (assignment_id, user_id, file_path, file_name, text_content)
      VALUES (?,?,?,?,?)
    `, [assignmentId, uid, relPath, fileName, textContent]);
    req.flash('success', isLate ? 'Submitted (late).' : 'Submitted.');
  }

  res.redirect('/student/assignments/' + assignmentId);
});

module.exports = router;