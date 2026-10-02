const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDB } = require('../config/database');
const { requireLogin, requireRole } = require('../middleware/auth');
const { FILE_TYPE_MAP, RESOURCE_TYPES } = require('../config/constants');
const router = express.Router();

function sanitizeFilename(name) {
  return name.replace(/[\/\\]/g, '_').replace(/[<>:"|?*]/g, '_');
}

// Multer saves to the lesson's folder
const lessonStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!req.lesson || !req.lesson.folder_path) return cb(new Error('Lesson folder missing'));
    fs.mkdirSync(req.lesson.folder_path, { recursive: true });
    cb(null, req.lesson.folder_path);
  },
  filename: (req, file, cb) => {
    cb(null, sanitizeFilename(file.originalname));
  },
});

const upload = multer({
  storage: lessonStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

// Load lesson + verify teacher owns the course
async function loadLesson(req, res, next) {
  const db = getDB();
  const lesson = await db.get('SELECT * FROM lessons WHERE id = ?', [req.params.lessonId]);
  if (!lesson) return res.status(404).send('Lesson not found');
  const course = await db.get(
    'SELECT * FROM courses WHERE id = ? AND teacher_id = ?',
    [lesson.course_id, req.session.user.id]
  );
  if (!course) return res.status(403).send('Not your course');
  req.lesson = lesson;
  req.course = course;
  next();
}

// ============================================================
//  COURSE MANAGER PAGE
// ============================================================
router.get('/teacher/courses/:courseId/manage', requireLogin, requireRole('teacher'), async (req, res) => {
  const db = getDB();
  const courseId = req.params.courseId;
  const tid = req.session.user.id;

  const course = await db.get(
    'SELECT * FROM courses WHERE id = ? AND teacher_id = ?',
    [courseId, tid]
  );
  if (!course) return res.status(404).send('Course not found or not yours');

  const lessons = await db.all(`
    SELECT l.*,
      (SELECT COUNT(*) FROM resources WHERE lesson_id = l.id) AS resource_count
    FROM lessons l
    WHERE l.course_id = ?
    ORDER BY l.position, l.id
  `, [courseId]);

  for (const lesson of lessons) {
    lesson.resources = await db.all(
      'SELECT * FROM resources WHERE lesson_id = ? ORDER BY position, id',
      [lesson.id]
    );
  }

  res.render('teacher/manage-course', {
    title: 'Manage: ' + course.title,
    heading: 'Manage Course',
    subtitle: course.title,
    course,
    lessons,
  });
});

// ============================================================
//  CREATE NEW LESSON
// ============================================================
router.post('/teacher/courses/:courseId/lesson', requireLogin, requireRole('teacher'), async (req, res) => {
  const db = getDB();
  const courseId = req.params.courseId;
  const tid = req.session.user.id;

  const course = await db.get(
    'SELECT * FROM courses WHERE id = ? AND teacher_id = ?',
    [courseId, tid]
  );
  if (!course) return res.status(404).send('Not found');

  const title = (req.body.title || '').trim();
  if (!title) {
    req.flash('error', 'Lesson title is required.');
    return res.redirect('/teacher/courses/' + courseId + '/manage');
  }

  const max = await db.get(
    'SELECT COALESCE(MAX(position), 0) AS m FROM lessons WHERE course_id = ?',
    [courseId]
  );
  const position = max.m + 1;
  const folderName = String(position).padStart(2, '0') + ' - ' + title.replace(/[<>:"/\\|?*]/g, '_');
  const folderPath = path.join(course.folder_path, folderName);

  fs.mkdirSync(folderPath, { recursive: true });

  await db.run(
    'INSERT INTO lessons (course_id, title, position, folder_path) VALUES (?,?,?,?)',
    [courseId, title, position, folderPath]
  );

  req.flash('success', 'Lesson created. Now upload files to it.');
  res.redirect('/teacher/courses/' + courseId + '/manage');
});

// ============================================================
//  UPLOAD FILES TO LESSON
// ============================================================
router.post('/teacher/lessons/:lessonId/upload',
  requireLogin, requireRole('teacher'),
  loadLesson,
  upload.array('files', 20),
  async (req, res) => {
    const db = getDB();
    const lesson = req.lesson;
    const files = req.files || [];

    if (files.length === 0) {
      req.flash('error', 'No files selected.');
      return res.redirect('/teacher/courses/' + lesson.course_id + '/manage');
    }

    const max = await db.get(
      'SELECT COALESCE(MAX(position), 0) AS m FROM resources WHERE lesson_id = ?',
      [lesson.id]
    );
    let pos = max.m + 1;

    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();
      const type = FILE_TYPE_MAP[ext] || RESOURCE_TYPES.OTHER;
      const fullPath = path.join(lesson.folder_path, file.filename);
      const stat = fs.statSync(fullPath);

      await db.run(
        `INSERT INTO resources (lesson_id, filename, file_path, type, size_bytes, position)
         VALUES (?,?,?,?,?,?)`,
        [lesson.id, file.filename, fullPath, type, stat.size, pos]
      );
      pos++;
    }

    req.flash('success', 'Uploaded ' + files.length + ' file(s).');
    res.redirect('/teacher/courses/' + lesson.course_id + '/manage');
  }
);

// ============================================================
//  DELETE RESOURCE
// ============================================================
router.post('/teacher/resources/:resourceId/delete', requireLogin, requireRole('teacher'), async (req, res) => {
  const db = getDB();
  const r = await db.get(`
    SELECT r.*, l.course_id, c.teacher_id
    FROM resources r
    JOIN lessons l ON l.id = r.lesson_id
    JOIN courses c ON c.id = l.course_id
    WHERE r.id = ?
  `, [req.params.resourceId]);

  if (!r || r.teacher_id !== req.session.user.id) {
    req.flash('error', 'Not allowed.');
    return res.redirect('/teacher/courses');
  }

  try { if (fs.existsSync(r.file_path)) fs.unlinkSync(r.file_path); } catch (e) {}

  await db.run('DELETE FROM resources WHERE id = ?', [r.id]);
  req.flash('success', 'File deleted.');
  res.redirect('/teacher/courses/' + r.course_id + '/manage');
});

// ============================================================
//  DELETE LESSON (with all files)
// ============================================================
router.post('/teacher/lessons/:lessonId/delete', requireLogin, requireRole('teacher'), async (req, res) => {
  const db = getDB();
  const lesson = await db.get(`
    SELECT l.*, c.teacher_id FROM lessons l
    JOIN courses c ON c.id = l.course_id
    WHERE l.id = ?
  `, [req.params.lessonId]);

  if (!lesson || lesson.teacher_id !== req.session.user.id) {
    req.flash('error', 'Not allowed.');
    return res.redirect('/teacher/courses');
  }

  try {
    if (fs.existsSync(lesson.folder_path)) {
      fs.rmSync(lesson.folder_path, { recursive: true, force: true });
    }
  } catch (e) { console.error(e); }

  await db.run('DELETE FROM lessons WHERE id = ?', [lesson.id]);
  req.flash('success', 'Lesson deleted.');
  res.redirect('/teacher/courses/' + lesson.course_id + '/manage');
});

// ============================================================
//  RENAME LESSON
// ============================================================
router.post('/teacher/lessons/:lessonId/rename', requireLogin, requireRole('teacher'), async (req, res) => {
  const db = getDB();
  const lesson = await db.get(`
    SELECT l.*, c.teacher_id FROM lessons l
    JOIN courses c ON c.id = l.course_id
    WHERE l.id = ?
  `, [req.params.lessonId]);

  if (!lesson || lesson.teacher_id !== req.session.user.id) {
    req.flash('error', 'Not allowed.');
    return res.redirect('/teacher/courses');
  }

  const newTitle = (req.body.title || '').trim();
  if (!newTitle) {
    req.flash('error', 'Title cannot be empty.');
    return res.redirect('/teacher/courses/' + lesson.course_id + '/manage');
  }

  await db.run('UPDATE lessons SET title = ? WHERE id = ?', [newTitle, lesson.id]);
  req.flash('success', 'Lesson renamed.');
  res.redirect('/teacher/courses/' + lesson.course_id + '/manage');
});

module.exports = router;