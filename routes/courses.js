const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

// ---------- ALL COURSES (browse + enroll) ----------
router.get('/student/courses', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/dashboard');
  const db = getDB();
  const uid = req.session.user.id;

  const allCourses = await db.all(`
    SELECT c.*, u.full_name AS teacher_name,
      (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) AS lesson_count,
      (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS student_count,
      (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id AND user_id = ?) AS enrolled
    FROM courses c
    LEFT JOIN users u ON u.id = c.teacher_id
    ORDER BY c.created_at DESC
  `, [uid]);

  res.render('student/courses', {
    title: 'My Courses',
    heading: 'Courses',
    subtitle: 'Enroll and start learning.',
    courses: allCourses,
  });
});

// ---------- COURSE DETAIL ----------
router.get('/courses/:id', requireLogin, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const courseId = req.params.id;

  const course = await db.get(`
    SELECT c.*, u.full_name AS teacher_name
    FROM courses c LEFT JOIN users u ON u.id = c.teacher_id
    WHERE c.id = ?
  `, [courseId]);

  if (!course) return res.status(404).send('Course not found');

  const enrolled = await db.get(
    'SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?',
    [uid, courseId]
  );

  const lessons = await db.all(
    'SELECT * FROM lessons WHERE course_id = ? ORDER BY position, id',
    [courseId]
  );

  // attach progress + resource count for each lesson
  for (const l of lessons) {
    const p = await db.get(
      'SELECT completed FROM progress WHERE user_id = ? AND lesson_id = ?',
      [uid, l.id]
    );
    l.completed = p ? p.completed : 0;

    const rc = await db.get(
      'SELECT COUNT(*) as c FROM resources WHERE lesson_id = ?',
      [l.id]
    );
    l.resource_count = rc.c;
  }

  const done = lessons.filter(l => l.completed).length;
  const total = lessons.length;
  const percent = total ? Math.round((done / total) * 100) : 0;

  res.render('student/course-detail', {
    title: course.title,
    heading: course.title,
    subtitle: course.description || 'Course materials',
    course,
    lessons,
    enrolled: !!enrolled,
    percent,
    done,
    total,
  });
});

// ---------- ENROLL ----------
router.post('/courses/:id/enroll', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/dashboard');
  const db = getDB();
  try {
    await db.run(
      'INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)',
      [req.session.user.id, req.params.id]
    );
    req.flash('success', 'You are now enrolled.');
  } catch (e) {
    req.flash('error', 'Already enrolled.');
  }
  res.redirect('/courses/' + req.params.id);
});

// ---------- UNENROLL ----------
router.post('/courses/:id/unenroll', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/dashboard');
  await getDB().run(
    'DELETE FROM enrollments WHERE user_id = ? AND course_id = ?',
    [req.session.user.id, req.params.id]
  );
  req.flash('success', 'You have left the course.');
  res.redirect('/student/courses');
});

module.exports = router;
