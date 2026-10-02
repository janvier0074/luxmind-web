const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDB } = require('../config/database');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

// These types show as file tabs. Everything else (images, css, js) is hidden
// but still served so the HTML can reference them.
const PRIMARY_TYPES = ['html', 'pdf', 'video', 'audio', 'doc', 'slide', 'markdown', 'archive'];

// ---------- LESSON VIEW ----------
router.get('/lessons/:id', requireLogin, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const lessonId = req.params.id;

  const lesson = await db.get(`
    SELECT l.*, c.title AS course_title, c.id AS course_id
    FROM lessons l
    JOIN courses c ON c.id = l.course_id
    WHERE l.id = ?
  `, [lessonId]);

  if (!lesson) return res.status(404).send('Lesson not found');

  // all resources on disk
  const allResources = await db.all(
    'SELECT * FROM resources WHERE lesson_id = ? ORDER BY position, id',
    [lessonId]
  );

  // only show "primary" files as tabs; assets hidden but still served
  let primary = allResources.filter(r => PRIMARY_TYPES.includes(r.type));

  // if nothing primary, fall back to first 3 files so lesson isn't empty
  if (primary.length === 0) primary = allResources.slice(0, 3);

  const progress = await db.get(
    'SELECT completed FROM progress WHERE user_id = ? AND lesson_id = ?',
    [uid, lessonId]
  );
  const completed = progress ? progress.completed : 0;

  const siblings = await db.all(
    'SELECT id, title, position FROM lessons WHERE course_id = ? ORDER BY position, id',
    [lesson.course_id]
  );
  const idx = siblings.findIndex(s => s.id === lesson.id);
  const prev = idx > 0 ? siblings[idx - 1] : null;
  const next = idx < siblings.length - 1 ? siblings[idx + 1] : null;

  res.render('student/lesson', {
    title: lesson.title,
    heading: lesson.title,
    subtitle: lesson.course_title,
    lesson,
    resources: primary,
    hiddenCount: allResources.length - primary.length,
    completed,
    prev,
    next,
  });
});

// ---------- TOGGLE COMPLETE ----------
router.post('/lessons/:id/complete', requireLogin, async (req, res) => {
  const db = getDB();
  const uid = req.session.user.id;
  const lessonId = req.params.id;

  const existing = await db.get(
    'SELECT * FROM progress WHERE user_id = ? AND lesson_id = ?',
    [uid, lessonId]
  );

  if (existing) {
    await db.run(
      'UPDATE progress SET completed = ?, completed_at = ? WHERE id = ?',
      [existing.completed ? 0 : 1, existing.completed ? null : new Date().toISOString(), existing.id]
    );
  } else {
    await db.run(
      'INSERT INTO progress (user_id, lesson_id, completed, completed_at) VALUES (?, ?, 1, ?)',
      [uid, lessonId, new Date().toISOString()]
    );
  }

  res.redirect('/lessons/' + lessonId);
});

// ---------- DOWNLOAD ----------
router.get('/files/resource/:id', requireLogin, async (req, res) => {
  const db = getDB();
  const resource = await db.get('SELECT * FROM resources WHERE id = ?', [req.params.id]);
  if (!resource) return res.status(404).send('File not found');
  const absolute = path.resolve(resource.file_path);
  if (!fs.existsSync(absolute)) return res.status(404).send('File missing on disk');
  res.sendFile(absolute);
});

// ---------- SERVE ANY FILE INSIDE LESSON FOLDER (assets too) ----------
router.get('/lesson-files/:lessonId/:file(*)', requireLogin, async (req, res) => {
  const db = getDB();
  const lesson = await db.get('SELECT * FROM lessons WHERE id = ?', [req.params.lessonId]);
  if (!lesson) return res.status(404).send('Lesson not found');

  const wanted = req.params.file || '';
  const lessonDir = path.resolve(lesson.folder_path);
  const filePath = path.resolve(path.join(lessonDir, wanted));

  if (!filePath.startsWith(lessonDir)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return res.status(404).send('File not found');
  }
  res.sendFile(filePath);
});

module.exports = router;