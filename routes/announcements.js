const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

// ---------- TEACHER: list + create ----------
router.get('/teacher/announcements', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/dashboard');
  const db = getDB();
  const tid = req.session.user.id;

  const courses = await db.all('SELECT * FROM courses WHERE teacher_id = $1', [tid]);

  const announcements = await db.all(`
    SELECT a.*, c.title AS course_title,
      (SELECT COUNT(*) FROM enrollments WHERE course_id = a.course_id) AS recipients
    FROM announcements a
    JOIN courses c ON c.id = a.course_id
    WHERE c.teacher_id = $1
    ORDER BY a.created_at DESC
  `, [tid]);

  res.render('teacher/announcements', {
    title: 'Announcements',
    heading: 'Announcements',
    subtitle: 'Broadcast updates to your students.',
    courses, announcements,
  });
});

router.post('/teacher/announcements', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/dashboard');
  const db = getDB();
  const { course_id, title, body } = req.body;

  if (!course_id || !title || !body) {
    req.flash('error', 'All fields are required.');
    return res.redirect('/teacher/announcements');
  }

  // verify the teacher owns this course
  const course = await db.get(
    'SELECT * FROM courses WHERE id = $1 AND teacher_id = $2',
    [course_id, req.session.user.id]
  );
  if (!course) {
    req.flash('error', 'You can only post to your own courses.');
    return res.redirect('/teacher/announcements');
  }

  await db.run(
    'INSERT INTO announcements (course_id, author_id, title, body) VALUES ($1,$2,$3,$4)',
    [course_id, req.session.user.id, title, body]
  );

  // also create notifications for every enrolled student
  const students = await db.all(
    'SELECT user_id FROM enrollments WHERE course_id = $1',
    [course_id]
  );
  for (const s of students) {
    await db.run(
      'INSERT INTO notifications (user_id, title, body, link) VALUES ($1,$2,$3,$4)',
      [s.user_id, 'New announcement: ' + title, course.title, '/student/announcements']
    );
  }

  req.flash('success', 'Announcement posted to ' + students.length + ' students.');
  res.redirect('/teacher/announcements');
});

router.post('/teacher/announcements/:id/delete', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/dashboard');
  await getDB().run('DELETE FROM announcements WHERE id = $1 AND author_id = $2',
    [req.params.id, req.session.user.id]);
  req.flash('success', 'Announcement deleted.');
  res.redirect('/teacher/announcements');
});

// ---------- STUDENT: read announcements ----------
router.get('/student/announcements', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/dashboard');
  const db = getDB();
  const uid = req.session.user.id;




  // mark as seen — clears the red badge
  await db.run(
    'UPDATE users SET announcements_seen_at = CURRENT_TIMESTAMP WHERE id = $1',
    [uid]
  );



  const announcements = await db.all(`
    SELECT a.*, c.title AS course_title, u.full_name AS author_name
    FROM announcements a
    JOIN courses c ON c.id = a.course_id
    JOIN enrollments e ON e.course_id = c.id AND e.user_id = $1
    JOIN users u ON u.id = a.author_id
    ORDER BY a.created_at DESC
  `, [uid]);

  res.render('student/announcements', {
    title: 'Announcements',
    heading: 'Announcements',
    subtitle: 'Updates from your teachers.',
    announcements,
  });
});

module.exports = router;