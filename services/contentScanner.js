const fs = require('fs');
const path = require('path');
const { getDB } = require('../config/database');
const { FILE_TYPE_MAP, RESOURCE_TYPES } = require('../config/constants');

const CONTENT_ROOT = process.env.CONTENT_ROOT
  ? path.resolve(process.env.CONTENT_ROOT)
  : (process.env.NODE_ENV === 'production'
      ? '/data/content'
      : path.resolve('./content'));
function cleanName(n) {
  return n.replace(/^\d+\s*[-._)]\s*/, '').replace(/[-_]+/g,' ').replace(/\s+/g,' ').trim() || n;
}
function toSlug(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'c-' + Date.now();
}

async function scanContent() {
  const db = getDB();
  if (!fs.existsSync(CONTENT_ROOT)) {
    fs.mkdirSync(CONTENT_ROOT, { recursive: true });
    return { courses:0, lessons:0, resources:0 };
  }

  const courses = fs.readdirSync(CONTENT_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'));

  const counts = { courses:0, lessons:0, resources:0 };

  for (const cd of courses) {
    const cPath = path.join(CONTENT_ROOT, cd.name);
    const cTitle = cleanName(cd.name);
    const slug = toSlug(cTitle);

    let course = await db.get('SELECT * FROM courses WHERE slug=?', [slug]);
    if (!course) {
  const teacherRow = await db.get("SELECT id FROM users WHERE role='teacher' ORDER BY id LIMIT 1");
const teacherId = teacherRow ? teacherRow.id : null;
const r = await db.run(
  `INSERT INTO courses (title, slug, folder_path, teacher_id) VALUES (?, ?, ?, ?)`,
  [courseTitle, slug, coursePath, teacherId]
);
      course = { id: r.lastID };
      counts.courses++;
    } else {
      await db.run('UPDATE courses SET folder_path=?, title=? WHERE id=?', [cPath, cTitle, course.id]);
    }

    const lessons = fs.readdirSync(cPath, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a,b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    let pos = 1;
    for (const ld of lessons) {
      const lPath = path.join(cPath, ld.name);
      const lTitle = cleanName(ld.name);

      let lesson = await db.get('SELECT * FROM lessons WHERE course_id=? AND folder_path=?', [course.id, lPath]);
      if (!lesson) {
        const r = await db.run('INSERT INTO lessons (course_id,title,position,folder_path) VALUES (?,?,?,?)', [course.id, lTitle, pos, lPath]);
        lesson = { id: r.lastID };
        counts.lessons++;
      }

      await db.run('DELETE FROM resources WHERE lesson_id=?', [lesson.id]);

      const files = fs.readdirSync(lPath, { withFileTypes: true })
        .filter(f => f.isFile() && !f.name.startsWith('.'));

      let rp = 1;
      for (const f of files) {
        const full = path.join(lPath, f.name);
        const stat = fs.statSync(full);
        const ext = path.extname(f.name).toLowerCase();
        const type = FILE_TYPE_MAP[ext] || RESOURCE_TYPES.OTHER;
        await db.run('INSERT INTO resources (lesson_id,filename,file_path,type,size_bytes,position) VALUES (?,?,?,?,?,?)',
          [lesson.id, f.name, full, type, stat.size, rp]);
        counts.resources++;
        rp++;
      }
      pos++;
    }
  }
  console.log('Scan done: ' + counts.courses + ' courses, ' + counts.lessons + ' lessons, ' + counts.resources + ' resources');
  return counts;
}

module.exports = { scanContent };