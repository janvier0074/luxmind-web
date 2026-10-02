const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

router.get('/search', requireLogin, async (req, res) => {
  const db = getDB();
  const q = (req.query.q || '').trim();
  const user = req.session.user;

  let courses = [], lessons = [], quizzes = [];

  if (q.length >= 2) {
    // courses — only ones the user can see
    if (user.role === 'student') {
      courses = await db.all(`
        SELECT c.* FROM courses c
        JOIN enrollments e ON e.course_id = c.id AND e.user_id = ?
        WHERE c.title LIKE ? OR c.description LIKE ?
        LIMIT 20
      `, [user.id, '%'+q+'%', '%'+q+'%']);
    } else if (user.role === 'teacher') {
      courses = await db.all(`
        SELECT c.* FROM courses c WHERE c.teacher_id = ?
          AND (c.title LIKE ? OR c.description LIKE ?)
        LIMIT 20
      `, [user.id, '%'+q+'%', '%'+q+'%']);
    } else {
      courses = await db.all(`
        SELECT * FROM courses WHERE title LIKE ? OR description LIKE ? LIMIT 20
      `, ['%'+q+'%', '%'+q+'%']);
    }

    // lessons — scoped by role
    if (user.role === 'student') {
      lessons = await db.all(`
        SELECT l.*, c.title AS course_title, c.id AS course_id
        FROM lessons l
        JOIN courses c ON c.id = l.course_id
        JOIN enrollments e ON e.course_id = c.id AND e.user_id = ?
        WHERE l.title LIKE ?
        LIMIT 30
      `, [user.id, '%'+q+'%']);
    } else if (user.role === 'teacher') {
      lessons = await db.all(`
        SELECT l.*, c.title AS course_title, c.id AS course_id
        FROM lessons l
        JOIN courses c ON c.id = l.course_id
        WHERE c.teacher_id = ? AND l.title LIKE ?
        LIMIT 30
      `, [user.id, '%'+q+'%']);
    } else {
      lessons = await db.all(`
        SELECT l.*, c.title AS course_title, c.id AS course_id
        FROM lessons l JOIN courses c ON c.id = l.course_id
        WHERE l.title LIKE ? LIMIT 30
      `, ['%'+q+'%']);
    }

    // quizzes
    if (user.role === 'student') {
      quizzes = await db.all(`
        SELECT q.*, c.title AS course_title
        FROM quizzes q
        JOIN courses c ON c.id = q.course_id
        JOIN enrollments e ON e.course_id = c.id AND e.user_id = ?
        WHERE q.title LIKE ?
        LIMIT 20
      `, [user.id, '%'+q+'%']);
    } else if (user.role === 'teacher') {
      quizzes = await db.all(`
        SELECT q.*, c.title AS course_title
        FROM quizzes q
        JOIN courses c ON c.id = q.course_id
        WHERE c.teacher_id = ? AND q.title LIKE ?
        LIMIT 20
      `, [user.id, '%'+q+'%']);
    }
  }

  res.render('search', {
    title: 'Search',
    heading: 'Search',
    subtitle: q ? 'Results for "' + q + '"' : 'Type to search across LuxMind.',
    q, courses, lessons, quizzes,
  });
});

module.exports = router;