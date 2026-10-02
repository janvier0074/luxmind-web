const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

// helper: is grade visible?
function isReleased(quiz) {
  if (!quiz.release_at) return false;
  return new Date(quiz.release_at) <= new Date();
}

// ============================================================
//                     STUDENT
// ============================================================

// ---------- LIST QUIZZES ----------
router.get('/student/quizzes', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/dashboard');
  const db = getDB();
  const uid = req.session.user.id;

  const quizzes = await db.all(`
    SELECT q.*, c.title AS course_title,
      a.id AS attempt_id, a.score, a.max_score, a.submitted_at,
      m.override_score, m.feedback
    FROM quizzes q
    JOIN courses c ON c.id = q.course_id
    JOIN enrollments e ON e.course_id = c.id AND e.user_id = ?
    LEFT JOIN attempts a ON a.quiz_id = q.id AND a.user_id = ?
    LEFT JOIN manual_grades m ON m.attempt_id = a.id
    ORDER BY q.created_at DESC
  `, [uid, uid]);

  const now = new Date();
  quizzes.forEach(q => {
    q.released = q.release_at && new Date(q.release_at) <= now;
    q.finalScore = (q.override_score !== null && q.override_score !== undefined)
      ? q.override_score : q.score;
  });

  res.render('student/quizzes', {
    title: 'Quizzes',
    heading: 'Quizzes',
    subtitle: 'Take quizzes and check your grades.',
    quizzes,
  });
});

// ---------- TAKE QUIZ ----------
router.get('/student/quiz/:id', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/dashboard');
  const db = getDB();
  const uid = req.session.user.id;

  const quiz = await db.get(`
    SELECT q.*, c.title AS course_title
    FROM quizzes q JOIN courses c ON c.id = q.course_id
    WHERE q.id = ?
  `, [req.params.id]);
  if (!quiz) return res.status(404).send('Quiz not found');

  const existing = await db.get(
    'SELECT * FROM attempts WHERE quiz_id = ? AND user_id = ?',
    [quiz.id, uid]
  );
  if (existing) return res.redirect(`/student/quiz/${quiz.id}/result`);

  const questions = await db.all(
    'SELECT * FROM questions WHERE quiz_id = ? ORDER BY position, id',
    [quiz.id]
  );

  if (questions.length === 0) {
    req.flash('error', 'This quiz has no questions yet.');
    return res.redirect('/student/quizzes');
  }

  res.render('student/quiz-take', {
    title: quiz.title,
    heading: quiz.title,
    subtitle: quiz.course_title,
    quiz,
    questions,
  });
});

// ---------- SUBMIT + AUTO-GRADE ----------
router.post('/student/quiz/:id', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/dashboard');
  const db = getDB();
  const uid = req.session.user.id;
  const quizId = req.params.id;

  const existing = await db.get(
    'SELECT id FROM attempts WHERE quiz_id = ? AND user_id = ?',
    [quizId, uid]
  );
  if (existing) return res.redirect(`/student/quiz/${quizId}/result`);

  const questions = await db.all('SELECT * FROM questions WHERE quiz_id = ?', [quizId]);

  let score = 0, max = 0;
  const answers = {};

  for (const q of questions) {
    const picked = req.body['q_' + q.id] || null;
    answers[q.id] = picked;
    max += q.points;
    if (picked === q.correct) score += q.points;
  }

  await db.run(
    'INSERT INTO attempts (quiz_id, user_id, score, max_score, answers) VALUES (?,?,?,?,?)',
    [quizId, uid, score, max, JSON.stringify(answers)]
  );

  req.flash('success', 'Quiz submitted! Your grade will appear after the teacher releases it.');
  res.redirect(`/student/quiz/${quizId}/result`);
});

// ---------- RESULT (LOCKED / UNLOCKED) ----------
router.get('/student/quiz/:id/result', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/dashboard');
  const db = getDB();
  const quizId = req.params.id;
  const uid = req.session.user.id;

  const quiz = await db.get(
    'SELECT q.*, c.title AS course_title FROM quizzes q JOIN courses c ON c.id = q.course_id WHERE q.id = ?',
    [quizId]
  );
  const attempt = await db.get(
    'SELECT * FROM attempts WHERE quiz_id = ? AND user_id = ?',
    [quizId, uid]
  );
  if (!attempt) return res.redirect(`/student/quiz/${quizId}`);

  const manual = await db.get('SELECT * FROM manual_grades WHERE attempt_id = ?', [attempt.id]);
  const released = isReleased(quiz);
  const finalScore = (manual && manual.override_score !== null && manual.override_score !== undefined)
    ? manual.override_score : attempt.score;
  const feedback = manual ? manual.feedback : null;

  const questions = await db.all(
    'SELECT * FROM questions WHERE quiz_id = ? ORDER BY position, id', [quizId]
  );
  const answers = JSON.parse(attempt.answers || '{}');

  res.render('student/quiz-result', {
    title: quiz.title + ' — Result',
    heading: quiz.title,
    subtitle: quiz.course_title,
    quiz, attempt, released, finalScore, feedback, questions, answers,
  });
});

// ============================================================
//                     TEACHER
// ============================================================

// ---------- LIST + CREATE ENTRY ----------
router.get('/teacher/quizzes', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/dashboard');
  const db = getDB();
  const tid = req.session.user.id;

  const courses = await db.all('SELECT * FROM courses WHERE teacher_id = ?', [tid]);

  const quizzes = await db.all(`
    SELECT q.*, c.title AS course_title,
      (SELECT COUNT(*) FROM questions WHERE quiz_id = q.id) AS q_count,
      (SELECT COUNT(*) FROM attempts WHERE quiz_id = q.id) AS attempts
    FROM quizzes q
    JOIN courses c ON c.id = q.course_id
    WHERE c.teacher_id = ?
    ORDER BY q.created_at DESC
  `, [tid]);

  res.render('teacher/quizzes', {
    title: 'Quizzes',
    heading: 'Quizzes',
    subtitle: 'Create and manage quizzes.',
    courses,
    quizzes,
  });
});

// ---------- QUIZ BUILDER ----------
router.get('/teacher/quiz/new/:courseId', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/dashboard');
  const course = await getDB().get('SELECT * FROM courses WHERE id = ?', [req.params.courseId]);
  if (!course) return res.status(404).send('Course not found');

  res.render('teacher/quiz-builder', {
    title: 'New Quiz',
    heading: 'Create Quiz',
    subtitle: course.title,
    course,
  });
});

router.post('/teacher/quiz/new/:courseId', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/dashboard');
  const db = getDB();
  const { title, release_at, duration_min, questions } = req.body;
  const courseId = req.params.courseId;

  const releaseISO = release_at ? new Date(release_at).toISOString() : null;

  const r = await db.run(
    'INSERT INTO quizzes (course_id, title, release_at, duration_min) VALUES (?,?,?,?)',
    [courseId, title, releaseISO, Number(duration_min) || 15]
  );
  const quizId = r.lastID;

  let parsed = [];
  try { parsed = JSON.parse(questions || '[]'); } catch (e) { parsed = []; }

  let pos = 1;
  for (const q of parsed) {
    await db.run(
      `INSERT INTO questions (quiz_id, text, option_a, option_b, option_c, option_d, correct, points, position)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [quizId, q.text, q.a, q.b, q.c, q.d, q.correct, Number(q.points) || 1, pos]
    );
    pos++;
  }

  req.flash('success', 'Quiz created with ' + parsed.length + ' questions.');
  res.redirect('/teacher/quizzes');
});

// ---------- UPDATE RELEASE TIME ----------
router.post('/teacher/quiz/:id/release', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/dashboard');
  const { release_at } = req.body;
  const iso = release_at ? new Date(release_at).toISOString() : null;
  await getDB().run('UPDATE quizzes SET release_at = ? WHERE id = ?', [iso, req.params.id]);
  req.flash('success', 'Release time updated.');
  res.redirect('/teacher/quizzes');
});

// ---------- GRADING QUEUE ----------
router.get('/teacher/grading', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/dashboard');
  const db = getDB();
  const tid = req.session.user.id;

  const submissions = await db.all(`
    SELECT a.*, u.full_name AS student_name, q.title AS quiz_title, q.id AS quiz_id,
      q.release_at, m.override_score, m.feedback
    FROM attempts a
    JOIN users u ON u.id = a.user_id
    JOIN quizzes q ON q.id = a.quiz_id
    JOIN courses c ON c.id = q.course_id
    LEFT JOIN manual_grades m ON m.attempt_id = a.id
    WHERE c.teacher_id = ?
    ORDER BY a.submitted_at DESC
  `, [tid]);

  res.render('teacher/grading', {
    title: 'Grading Queue',
    heading: 'Grading Queue',
    subtitle: 'Auto-graded submissions — override, feedback, and release.',
    submissions,
  });
});

// ---------- OVERRIDE GRADE ----------
router.post('/teacher/attempt/:id/grade', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/dashboard');
  const db = getDB();
  const { override_score, feedback } = req.body;
  const attemptId = req.params.id;

  const existing = await db.get('SELECT * FROM manual_grades WHERE attempt_id = ?', [attemptId]);
  if (existing) {
    await db.run(
      'UPDATE manual_grades SET override_score = ?, feedback = ?, graded_by = ?, graded_at = CURRENT_TIMESTAMP WHERE attempt_id = ?',
      [Number(override_score), feedback || null, req.session.user.id, attemptId]
    );
  } else {
    await db.run(
      'INSERT INTO manual_grades (attempt_id, override_score, feedback, graded_by) VALUES (?,?,?,?)',
      [attemptId, Number(override_score), feedback || null, req.session.user.id]
    );
  }
  req.flash('success', 'Grade saved.');
  res.redirect('/teacher/grading');
});

module.exports = router;