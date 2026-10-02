const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin, requireRole } = require('../middleware/auth');
const router = express.Router();

// ---------- MY COURSES ----------
router.get('/teacher/courses', requireLogin, requireRole('teacher'), async (req, res) => {
  const db = getDB();
  const tid = req.session.user.id;

  const courses = await db.all(`
    SELECT c.*,
      (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS lesson_count,
      (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS student_count,
      (SELECT COUNT(*) FROM quizzes WHERE course_id = c.id) AS quiz_count,
      (SELECT COUNT(*) FROM assignments WHERE course_id = c.id) AS assignment_count
    FROM courses c
    WHERE c.teacher_id = ?
    ORDER BY c.title
  `, [tid]);

  res.render('teacher/courses', {
    title: 'My Courses',
    heading: 'My Courses',
    subtitle: 'Everything you teach on LuxMind.',
    courses,
  });
});

// ---------- STUDENTS ----------
router.get('/teacher/students', requireLogin, requireRole('teacher'), async (req, res) => {
  const db = getDB();
  const tid = req.session.user.id;

  const students = await db.all(`
    SELECT DISTINCT u.id, u.username, u.full_name, u.email, u.created_at, u.last_seen,
      (SELECT COUNT(*) FROM enrollments e2
        JOIN courses c2 ON c2.id = e2.course_id
        WHERE e2.user_id = u.id AND c2.teacher_id = ?) AS course_count,
      (SELECT COUNT(*) FROM progress p
        JOIN lessons l ON l.id = p.lesson_id
        JOIN courses c3 ON c3.id = l.course_id
        WHERE p.user_id = u.id AND c3.teacher_id = ? AND p.completed = 1) AS lessons_done
    FROM users u
    JOIN enrollments e ON e.user_id = u.id
    JOIN courses c ON c.id = e.course_id
    WHERE c.teacher_id = ? AND u.role = 'student'
    ORDER BY u.full_name
  `, [tid, tid, tid]);

  res.render('teacher/students', {
    title: 'Students',
    heading: 'My Students',
    subtitle: 'Everyone enrolled in your courses.',
    students,
  });
});

module.exports = router;