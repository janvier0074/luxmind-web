const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

router.get('/student/grades', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/dashboard');
  const db = getDB();
  const uid = req.session.user.id;

  const quizzes = await db.all(`
    SELECT a.*, q.title, q.release_at, q.id AS quiz_id, c.title AS course_title,
      m.override_score, m.feedback
    FROM attempts a
    JOIN quizzes q ON q.id = a.quiz_id
    JOIN courses c ON c.id = q.course_id
    LEFT JOIN manual_grades m ON m.attempt_id = a.id
    WHERE a.user_id = ?
    ORDER BY a.submitted_at DESC
  `, [uid]);

  const now = new Date();
  quizzes.forEach(q => {
    q.released = q.release_at && new Date(q.release_at) <= now;
    q.finalScore = (q.override_score !== null && q.override_score !== undefined)
      ? q.override_score : q.score;
  });

  const assignments = await db.all(`
    SELECT s.*, a.title, a.max_points, a.deadline, c.title AS course_title
    FROM submissions s
    JOIN assignments a ON a.id = s.assignment_id
    JOIN courses c ON c.id = a.course_id
    WHERE s.user_id = ?
    ORDER BY s.submitted_at DESC
  `, [uid]);

  const progressRows = await db.all(`
    SELECT c.id AS course_id, c.title AS course_title,
      (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS total_lessons,
      (SELECT COUNT(*) FROM progress p JOIN lessons l ON l.id = p.lesson_id
        WHERE l.course_id = c.id AND p.user_id = ? AND p.completed = 1) AS done_lessons
    FROM courses c
    JOIN enrollments e ON e.course_id = c.id AND e.user_id = ?
  `, [uid, uid]);

  let quizScore = 0, quizMax = 0, released = 0;
  quizzes.forEach(q => {
    if (q.released) { quizScore += q.finalScore; quizMax += q.max_score; released++; }
  });

  let assScore = 0, assMax = 0, graded = 0;
  assignments.forEach(a => {
    if (a.score !== null && a.score !== undefined) {
      assScore += a.score; assMax += a.max_points; graded++;
    }
  });

  res.render('student/grades', {
    title: 'My Grades',
    heading: 'My Grades',
    subtitle: 'All your quiz and assignment grades.',
    quizzes, assignments, progressRows,
    stats: {
      quizScore, quizMax, released,
      assScore, assMax, graded,
      pendingQuizzes: quizzes.length - released,
      pendingAssignments: assignments.filter(a => a.score === null || a.score === undefined).length,
    },
  });
});

module.exports = router;