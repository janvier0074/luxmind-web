const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

// ============================================================
//   COURSE FORUM (list of threads)
// ============================================================
router.get('/forums/:courseId', requireLogin, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const courseId = req.params.courseId;

  const course = await db.get('SELECT * FROM courses WHERE id = ?', [courseId]);
  if (!course) return res.status(404).send('Course not found');

  // access check: student must be enrolled, teacher must own it, admin sees all
  const role = req.session.user.role;
  if (role === 'student') {
    const enrolled = await db.get(
      'SELECT id FROM enrollments WHERE user_id = ? AND course_id = ?',
      [uid, courseId]
    );
    if (!enrolled) return res.status(403).send('Not enrolled in this course.');
  } else if (role === 'teacher') {
    const owns = await db.get(
      'SELECT id FROM courses WHERE id = ? AND teacher_id = ?',
      [courseId, uid]
    );
    if (!owns) return res.status(403).send('Not your course.');
  }

  const threads = await db.all(`
    SELECT t.*, u.full_name AS author_name, u.username AS author_username, u.role AS author_role,
      (SELECT COUNT(*) FROM forum_posts WHERE thread_id = t.id) AS reply_count,
      (SELECT MAX(created_at) FROM forum_posts WHERE thread_id = t.id) AS last_reply_at
    FROM forum_threads t
    JOIN users u ON u.id = t.author_id
    WHERE t.course_id = ?
    ORDER BY (SELECT MAX(created_at) FROM forum_posts WHERE thread_id = t.id) DESC NULLS LAST, t.created_at DESC
  `, [courseId]);

  res.render('forums/course', {
    title: course.title + ' — Forum',
    heading: course.title + ' — Forum',
    subtitle: 'Ask questions, share ideas, help each other.',
    course, threads,
  });
});

// ============================================================
//   NEW THREAD
// ============================================================
router.get('/forums/:courseId/new', requireLogin, async (req, res) => {
  const db = getDB();
  const course = await db.get('SELECT * FROM courses WHERE id = ?', [req.params.courseId]);
  if (!course) return res.status(404).send('Course not found');
  res.render('forums/new-thread', {
    title: 'New Thread',
    heading: 'New Thread',
    subtitle: course.title,
    course,
  });
});

router.post('/forums/:courseId/new', requireLogin, async (req, res) => {
  const db = getDB();
  const { title, body } = req.body;
  const courseId = req.params.courseId;
  const uid = req.session.user.id;

  if (!title || !title.trim() || !body || !body.trim()) {
    req.flash('error', 'Title and body are required.');
    return res.redirect('/forums/' + courseId + '/new');
  }

  const r = await db.run(
    'INSERT INTO forum_threads (course_id, author_id, title, body) VALUES (?,?,?,?)',
    [courseId, uid, title.trim(), body.trim()]
  );

  req.flash('success', 'Thread posted.');
  res.redirect('/forums/thread/' + r.lastID);
});

// ============================================================
//   VIEW THREAD + REPLIES
// ============================================================
router.get('/forums/thread/:id', requireLogin, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const role = req.session.user.role;

  const thread = await db.get(`
    SELECT t.*, c.title AS course_title, c.id AS course_id,
      u.full_name AS author_name, u.username AS author_username, u.role AS author_role
    FROM forum_threads t
    JOIN courses c ON c.id = t.course_id
    JOIN users u ON u.id = t.author_id
    WHERE t.id = ?
  `, [req.params.id]);

  if (!thread) return res.status(404).send('Thread not found');

  const posts = await db.all(`
    SELECT p.*, u.full_name AS author_name, u.username AS author_username, u.role AS author_role
    FROM forum_posts p
    JOIN users u ON u.id = p.author_id
    WHERE p.thread_id = ?
    ORDER BY p.created_at ASC
  `, [thread.id]);

  res.render('forums/thread', {
    title: thread.title,
    heading: thread.title,
    subtitle: thread.course_title,
    thread, posts,
    canDelete: (role === 'admin' || thread.author_id === uid),
  });
});

// ---------- REPLY ----------
router.post('/forums/thread/:id/reply', requireLogin, async (req, res) => {
  const db = getDB();
  const { body } = req.body;
  if (!body || !body.trim()) {
    req.flash('error', 'Reply cannot be empty.');
    return res.redirect('/forums/thread/' + req.params.id);
  }

  await db.run(
    'INSERT INTO forum_posts (thread_id, author_id, body) VALUES (?,?,?)',
    [req.params.id, req.session.user.id, body.trim()]
  );

  // notify thread author
  const thread = await db.get('SELECT author_id, title, id FROM forum_threads WHERE id = ?', [req.params.id]);
  if (thread && thread.author_id !== req.session.user.id) {
    const sender = await db.get('SELECT full_name, username FROM users WHERE id = ?', [req.session.user.id]);
    await db.run(
      'INSERT INTO notifications (user_id, title, body, link) VALUES (?,?,?,?)',
      [
        thread.author_id,
        'New reply in "' + thread.title + '"',
        (sender.full_name || sender.username) + ' replied to your thread',
        '/forums/thread/' + thread.id,
      ]
    );
  }

  req.flash('success', 'Reply posted.');
  res.redirect('/forums/thread/' + req.params.id);
});

// ---------- DELETE ----------
router.post('/forums/thread/:id/delete', requireLogin, async (req, res) => {
  const db = getDB();
  const thread = await db.get('SELECT * FROM forum_threads WHERE id = ?', [req.params.id]);
  if (!thread) { req.flash('error', 'Not found.'); return res.redirect('/dashboard'); }

  const canDelete = req.session.user.role === 'admin' || thread.author_id === req.session.user.id;
  if (!canDelete) { req.flash('error', 'Not allowed.'); return res.redirect('/forums/thread/' + thread.id); }

  const courseId = thread.course_id;
  await db.run('DELETE FROM forum_threads WHERE id = ?', [thread.id]);
  req.flash('success', 'Thread deleted.');
  res.redirect('/forums/' + courseId);
});

router.post('/forums/post/:id/delete', requireLogin, async (req, res) => {
  const db = getDB();
  const post = await db.get('SELECT * FROM forum_posts WHERE id = ?', [req.params.id]);
  if (!post) { req.flash('error', 'Not found.'); return res.redirect('/dashboard'); }

  const canDelete = req.session.user.role === 'admin' || post.author_id === req.session.user.id;
  if (!canDelete) { req.flash('error', 'Not allowed.'); return res.redirect('/forums/thread/' + post.thread_id); }

  await db.run('DELETE FROM forum_posts WHERE id = ?', [post.id]);
  req.flash('success', 'Reply deleted.');
  res.redirect('/forums/thread/' + post.thread_id);
});

module.exports = router;