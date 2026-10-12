const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { getDB } = require('../config/database');
const { requireLogin, requireRole } = require('../middleware/auth');
const { DEFAULT_SETTINGS } = require('../config/constants');
const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (/\.csv$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Only CSV files allowed'));
  },
});

// ---------- PAGE ----------
router.get('/teacher/import-students', requireLogin, requireRole('teacher'), async (req, res) => {
  const db = getDB();
  const courses = await db.all(
    'SELECT id, title FROM courses WHERE teacher_id = $1 ORDER BY title',
    [req.session.user.id]
  );

  res.render('teacher/import-students', {
    title: 'Import Students',
    heading: 'Import Students',
    subtitle: 'Upload a CSV to create accounts in bulk.',
    courses,
  });
});

// ---------- UPLOAD ----------
router.post('/teacher/import-students',
  requireLogin, requireRole('teacher'),
  upload.single('csvfile'),
  async (req, res) => {
    const db = getDB();
    const teacherId = req.session.user.id;

    if (!req.file) {
      req.flash('error', 'Please choose a CSV file.');
      return res.redirect('/teacher/import-students');
    }

    const courseId = req.body.course_id ? Number(req.body.course_id) : null;

    // verify course ownership (if provided)
    if (courseId) {
      const owns = await db.get(
        'SELECT id FROM courses WHERE id = $1 AND teacher_id = $2',
        [courseId, teacherId]
      );
      if (!owns) {
        req.flash('error', 'Invalid course.');
        return res.redirect('/teacher/import-students');
      }
    }

    // parse CSV
    let rows;
    try {
      rows = parse(req.file.buffer.toString('utf8'), {
        columns: (header) => header.map(h => h.trim().toLowerCase()),
        skip_empty_lines: true,
        trim: true,
      });
    } catch (e) {
      req.flash('error', 'Could not parse CSV: ' + e.message);
      return res.redirect('/teacher/import-students');
    }

    if (rows.length === 0) {
      req.flash('error', 'CSV is empty.');
      return res.redirect('/teacher/import-students');
    }

    const results = {
      created: [],
      skipped: [],
      errors: [],
    };

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const line = i + 2; // header is line 1

      const email = (r.email || '').trim().toLowerCase();
      const fullName = (r.full_name || r.name || '').trim();
      let username = (r.username || '').trim().toLowerCase();

      if (!email) {
        results.errors.push('Line ' + line + ': missing email');
        continue;
      }

      // basic email validation
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        results.errors.push('Line ' + line + ': invalid email (' + email + ')');
        continue;
      }

      // check existing by email
      const existingEmail = await db.get('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
      if (existingEmail) {
        // skip and optionally enroll in course
        if (courseId) {
          try {
            await db.run(
              'INSERT INTO enrollments (user_id, course_id) VALUES ($1,$2)',
              [existingEmail.id, courseId]
            );
          } catch (e) { /* already enrolled */ }
        }
        results.skipped.push(email + ' (already exists)');
        continue;
      }

      // generate username if not provided
      if (!username) {
        let base = email.split('@')[0].replace(/[^a-z0-9_]/g, '');
        if (!base) base = 'user';
        username = base;
        let counter = 1;
        while (await db.get('SELECT id FROM users WHERE LOWER(username) = $1', [username])) {
          username = base + counter++;
        }
      } else {
        // check username conflict
        const existingUser = await db.get('SELECT id FROM users WHERE LOWER(username) = $1', [username]);
        if (existingUser) {
          let base = username;
          let counter = 1;
          while (await db.get('SELECT id FROM users WHERE LOWER(username) = $1', [username])) {
            username = base + counter++;
          }
        }
      }

      // insert user
      try {
        const r1 = await db.run(
          'INSERT INTO users (username, email, password, role, full_name) VALUES ($1,$2,$3,$4,$5)',
          [username, email, 'FIREBASE_AUTH', 'student', fullName || username]
        );

        // create settings
        try {
          for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
            await db.run(
              'INSERT INTO settings (user_id, key, value) VALUES ($1,$2,$3)',
              [r1.lastID, k, v]
            );
          }
        } catch (e) { /* ignore */ }

        // enroll in course
        if (courseId) {
          try {
            await db.run(
              'INSERT INTO enrollments (user_id, course_id) VALUES ($1,$2)',
              [r1.lastID, courseId]
            );
          } catch (e) { /* ignore */ }
        }

        results.created.push(email);
      } catch (e) {
        results.errors.push('Line ' + line + ': ' + e.message);
      }
    }

    res.render('teacher/import-result', {
      title: 'Import Result',
      heading: 'Import Complete',
      subtitle: 'Summary of the CSV upload.',
      results,
      course: courseId ? await db.get('SELECT title FROM courses WHERE id = $1', [courseId]) : null,
    });
  }
);

// ---------- TEMPLATE CSV DOWNLOAD ----------
router.get('/teacher/import-students/template', requireLogin, requireRole('teacher'), (req, res) => {
  const csv = 'full_name,email,username\nJohn Smith,john@example.com,john\nJane Doe,jane@example.com,\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="students-template.csv"');
  res.send('\uFEFF' + csv);
});

module.exports = router;