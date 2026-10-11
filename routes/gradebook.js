const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin, requireRole } = require('../middleware/auth');
const router = express.Router();

// ---------- LOAD GRADEBOOK DATA ----------
async function loadGradebook(db, courseId, teacherId) {
  const course = await db.get(
    'SELECT * FROM courses WHERE id = $1 AND teacher_id = $2',
    [courseId, teacherId]
  );
  if (!course) return null;

  const students = await db.all(`
    SELECT u.id, u.username, u.full_name, u.email
    FROM users u
    JOIN enrollments e ON e.user_id = u.id
    WHERE e.course_id = $1 AND u.role = 'student'
    ORDER BY u.full_name, u.username
  `, [courseId]);

  const quizzes = await db.all(`
    SELECT id, title FROM quizzes WHERE course_id = $1 ORDER BY created_at
  `, [courseId]);

  const assignments = await db.all(`
    SELECT id, title, max_points FROM assignments WHERE course_id = $1 ORDER BY created_at
  `, [courseId]);

  const quizAttempts = await db.all(`
    SELECT a.user_id, a.quiz_id,
      COALESCE(m.override_score, a.score) AS score,
      a.max_score
    FROM attempts a
    LEFT JOIN manual_grades m ON m.attempt_id = a.id
    WHERE a.quiz_id IN (SELECT id FROM quizzes WHERE course_id = $1)
  `, [courseId]);

  const submissions = await db.all(`
    SELECT s.user_id, s.assignment_id, s.score
    FROM submissions s
    WHERE s.assignment_id IN (SELECT id FROM assignments WHERE course_id = $1)
  `, [courseId]);

  const quizMap = {};
  quizAttempts.forEach(a => {
    quizMap[a.user_id + '-' + a.quiz_id] = { score: a.score, max: a.max_score };
  });

  const assMap = {};
  submissions.forEach(s => {
    assMap[s.user_id + '-' + s.assignment_id] = s.score;
  });

  const rows = students.map(st => {
    const quizScores = quizzes.map(q => {
      const cell = quizMap[st.id + '-' + q.id];
      return {
        id: q.id,
        score: cell ? cell.score : null,
        max: cell ? cell.max : null,
      };
    });
    const assScores = assignments.map(a => {
      const score = assMap[st.id + '-' + a.id];
      return {
        id: a.id,
        score: (score !== undefined && score !== null) ? score : null,
        max: a.max_points,
      };
    });
    const all = [...quizScores, ...assScores];
    const totalEarned = all.reduce((s, x) => s + (x.score || 0), 0);
    const totalMax = all.reduce((s, x) => s + (x.max || 0), 0);
    return {
      student: st,
      quizScores,
      assScores,
      totalEarned,
      totalMax,
      percent: totalMax ? Math.round((totalEarned / totalMax) * 100) : 0,
    };
  });

  return { course, students, quizzes, assignments, rows };
}

// ---------- VIEW ----------
router.get('/teacher/courses/:courseId/gradebook',
  requireLogin, requireRole('teacher'),
  async (req, res) => {
    const db = getDB();
    const data = await loadGradebook(db, req.params.courseId, req.session.user.id);
    if (!data) return res.status(404).send('Course not found');

    res.render('teacher/gradebook', {
      title: 'Gradebook — ' + data.course.title,
      heading: 'Gradebook',
      subtitle: data.course.title,
      course: data.course,
      students: data.students,
      quizzes: data.quizzes,
      assignments: data.assignments,
      rows: data.rows,
    });
  }
);

// ---------- CSV EXPORT ----------
router.get('/teacher/courses/:courseId/gradebook.csv',
  requireLogin, requireRole('teacher'),
  async (req, res) => {
    const db = getDB();
    const data = await loadGradebook(db, req.params.courseId, req.session.user.id);
    if (!data) return res.status(404).send('Course not found');

    const { course, students, quizzes, assignments, rows } = data;

    // build CSV
    const headers = [
      'Student',
      'Username',
      'Email',
      ...quizzes.map(q => 'Q: ' + q.title),
      ...assignments.map(a => 'A: ' + a.title + ' (/' + a.max_points + ')'),
      'Total',
      'Max',
      'Percent',
    ];

    const escapeCsv = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };

    const lines = [headers.map(escapeCsv).join(',')];

    for (const r of rows) {
      const row = [
        r.student.full_name || r.student.username,
        r.student.username,
        r.student.email || '',
        ...r.quizScores.map(c => c.score !== null ? c.score : ''),
        ...r.assScores.map(c => c.score !== null ? c.score : ''),
        r.totalEarned,
        r.totalMax,
        r.percent + '%',
      ];
      lines.push(row.map(escapeCsv).join(','));
    }

    const csv = lines.join('\n');
    const filename = course.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-gradebook.csv';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send('\uFEFF' + csv); // BOM for Excel
  }
);

module.exports = router;