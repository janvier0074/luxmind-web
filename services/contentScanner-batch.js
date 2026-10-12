const fs = require('fs');
const path = require('path');
const { getDB } = require('../config/database');
const { FILE_TYPE_MAP, RESOURCE_TYPES } = require('../config/constants');

const CONTENT_ROOT = process.env.CONTENT_ROOT
  ? path.resolve(process.env.CONTENT_ROOT)
  : path.resolve('./content');

function cleanName(n) {
  return n.replace(/^\d+\s*[-._)]\s*/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || n;
}
function toSlug(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'c-' + Date.now();
}

async function scanContent() {
  const db = getDB();
  const { query } = db;

  if (!fs.existsSync(CONTENT_ROOT)) {
    fs.mkdirSync(CONTENT_ROOT, { recursive: true });
    return { courses: 0, lessons: 0, resources: 0 };
  }

  const counts = { courses: 0, lessons: 0, resources: 0 };
  const t0 = Date.now();

  // fetch teacher id once
  const teacherRow = await db.get("SELECT id FROM users WHERE role='teacher' ORDER BY id LIMIT 1");
  const teacherId = teacherRow ? teacherRow.id : null;

  const courseFolders = fs.readdirSync(CONTENT_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'));

  for (const cd of courseFolders) {
    const cPath = path.join(CONTENT_ROOT, cd.name);
    const cTitle = cleanName(cd.name);
    const slug = toSlug(cTitle);

    // upsert course
    let course = await db.get('SELECT id FROM courses WHERE slug = $1', [slug]);
    if (!course) {
      const r = await db.run(
        'INSERT INTO courses (title, slug, folder_path, teacher_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [cTitle, slug, cPath, teacherId]
      );
      course = { id: r.lastID };
      counts.courses++;
    } else {
      await db.run('UPDATE courses SET folder_path = $1, title = $2 WHERE id = $3', [cPath, cTitle, course.id]);
    }

    const lessonFolders = fs.readdirSync(cPath, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    let pos = 1;
    for (const ld of lessonFolders) {
      const lPath = path.join(cPath, ld.name);
      const lTitle = cleanName(ld.name);

      let lesson = await db.get(
        'SELECT id FROM lessons WHERE course_id = $1 AND folder_path = $2',
        [course.id, lPath]
      );
      if (!lesson) {
        const r = await db.run(
          'INSERT INTO lessons (course_id, title, position, folder_path) VALUES ($1,$2,$3,$4) RETURNING id',
          [course.id, lTitle, pos, lPath]
        );
        lesson = { id: r.lastID };
        counts.lessons++;
      } else {
        await db.run('UPDATE lessons SET title = $1, position = $2 WHERE id = $3', [lTitle, pos, lesson.id]);
      }

      // wipe old resources for this lesson
      await db.run('DELETE FROM resources WHERE lesson_id = $1', [lesson.id]);

      const files = fs.readdirSync(lPath, { withFileTypes: true })
        .filter(f => f.isFile() && !f.name.startsWith('.'));

      // BATCH INSERT — 100 rows per query
      const BATCH = 100;
      for (let i = 0; i < files.length; i += BATCH) {
        const slice = files.slice(i, i + BATCH);
        const values = [];
        const placeholders = slice.map((f, idx) => {
          const base = idx * 6;
          const full = path.join(lPath, f.name);
          const stat = fs.statSync(full);
          const ext = path.extname(f.name).toLowerCase();
          const type = FILE_TYPE_MAP[ext] || RESOURCE_TYPES.OTHER;
          values.push(lesson.id, f.name, full, type, stat.size, i + idx + 1);
          return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6})`;
        }).join(',');

        await query(
          `INSERT INTO resources (lesson_id, filename, file_path, type, size_bytes, position) VALUES ${placeholders}`,
          values
        );
        counts.resources += slice.length;
      }
      pos++;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Scan done: ${counts.courses} courses, ${counts.lessons} lessons, ${counts.resources} resources — ${elapsed}s`);
  return counts;
}

module.exports = { scanContent };