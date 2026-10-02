const express = require('express');
const { getDB } = require('../config/database');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

async function getEventsForUser(db, user) {
  const uid = user.id;
  const events = [];

  if (user.role === 'student') {
    // assignments
    const assignments = await db.all(`
      SELECT a.id, a.title, a.deadline AS event_at, c.title AS course,
        (SELECT COUNT(*) FROM submissions WHERE assignment_id = a.id AND user_id = ?) AS submitted
      FROM assignments a
      JOIN courses c ON c.id = a.course_id
      JOIN enrollments e ON e.course_id = c.id
      WHERE e.user_id = ? AND a.deadline IS NOT NULL
    `, [uid, uid]);

    assignments.forEach(a => events.push({
      type: 'assignment',
      title: a.title,
      course: a.course,
      when: a.event_at,
      link: '/student/assignments/' + a.id,
      meta: a.submitted ? 'Submitted' : 'Due',
    }));

    // quiz releases
    const quizzes = await db.all(`
      SELECT q.id, q.title, q.release_at AS event_at, c.title AS course
      FROM quizzes q
      JOIN courses c ON c.id = q.course_id
      JOIN enrollments e ON e.course_id = c.id
      WHERE e.user_id = ? AND q.release_at IS NOT NULL
    `, [uid]);

    quizzes.forEach(q => events.push({
      type: 'quiz',
      title: q.title + ' — grades released',
      course: q.course,
      when: q.event_at,
      link: '/student/quiz/' + q.id + '/result',
      meta: 'Release',
    }));

    // announcements
    const ann = await db.all(`
      SELECT a.id, a.title, a.created_at AS event_at, c.title AS course
      FROM announcements a
      JOIN courses c ON c.id = a.course_id
      JOIN enrollments e ON e.course_id = c.id
      WHERE e.user_id = ?
    `, [uid]);

    ann.forEach(a => events.push({
      type: 'announcement',
      title: a.title,
      course: a.course,
      when: a.event_at,
      link: '/student/announcements',
      meta: 'Announcement',
    }));

  } else if (user.role === 'teacher') {
    const assignments = await db.all(`
      SELECT a.id, a.title, a.deadline AS event_at, c.title AS course
      FROM assignments a
      JOIN courses c ON c.id = a.course_id
      WHERE c.teacher_id = ? AND a.deadline IS NOT NULL
    `, [uid]);

    assignments.forEach(a => events.push({
      type: 'assignment',
      title: a.title + ' (deadline)',
      course: a.course,
      when: a.event_at,
      link: '/teacher/assignments/' + a.id,
      meta: 'Deadline',
    }));

    const quizzes = await db.all(`
      SELECT q.id, q.title, q.release_at AS event_at, c.title AS course
      FROM quizzes q
      JOIN courses c ON c.id = q.course_id
      WHERE c.teacher_id = ? AND q.release_at IS NOT NULL
    `, [uid]);

    quizzes.forEach(q => events.push({
      type: 'quiz',
      title: q.title + ' — release',
      course: q.course,
      when: q.event_at,
      link: '/teacher/quizzes',
      meta: 'Release',
    }));

  } else {
    const assignments = await db.all(`
      SELECT a.id, a.title, a.deadline AS event_at, c.title AS course
      FROM assignments a
      JOIN courses c ON c.id = a.course_id
      WHERE a.deadline IS NOT NULL
    `);

    assignments.forEach(a => events.push({
      type: 'assignment',
      title: a.title,
      course: a.course,
      when: a.event_at,
      link: '/admin/courses',
      meta: 'Deadline',
    }));
  }

  return events
    .filter(e => e.when)
    .sort((a, b) => new Date(a.when) - new Date(b.when));
}

router.get('/calendar', requireLogin, async (req, res) => {
  const db = getDB();
  const user = req.session.user;
  const events = await getEventsForUser(db, user);

  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) ?? now.getMonth();

  const first = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0).getDate();
  const startWeekday = first.getDay();

  const byDay = {};
  events.forEach(e => {
    const d = new Date(e.when);
    const key = d.getFullYear() + '-' +
      String(d.getMonth()+1).padStart(2,'0') + '-' +
      String(d.getDate()).padStart(2,'0');
    (byDay[key] = byDay[key] || []).push(e);
  });

  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const prevM = month === 0 ? 11 : month - 1;
  const prevY = month === 0 ? year - 1 : year;
  const nextM = month === 11 ? 0 : month + 1;
  const nextY = month === 11 ? year + 1 : year;

  res.render('calendar', {
    title: 'Calendar',
    heading: 'Calendar',
    subtitle: 'Every deadline, release, and update.',
    events, byDay, year, month, first, lastDay, startWeekday,
    monthNames, prevM, prevY, nextM, nextY, today: now,
  });
});

module.exports = router;