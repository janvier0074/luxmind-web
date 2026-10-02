require('dotenv').config();
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const { connectDB } = require('../config/database');
const { DEFAULT_SETTINGS } = require('../config/constants');

async function seed() {
  const db = await connectDB();
  await db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  console.log('Schema applied.');

  const c = await db.get('SELECT COUNT(*) as c FROM users');
  if (c.c > 0) { console.log('Users exist. Skip.'); return; }

  const a = await bcrypt.hash('admin123', 10);
  const t = await bcrypt.hash('teacher123', 10);
  const s = await bcrypt.hash('student123', 10);

  const r1 = await db.run('INSERT INTO users (username,email,password,role,full_name) VALUES (?,?,?,?,?)', ['admin','admin@luxmind.local',a,'admin','Admin']);
  const r2 = await db.run('INSERT INTO users (username,email,password,role,full_name) VALUES (?,?,?,?,?)', ['teacher','teacher@luxmind.local',t,'teacher','Teacher']);
  const r3 = await db.run('INSERT INTO users (username,email,password,role,full_name) VALUES (?,?,?,?,?)', ['student','student@luxmind.local',s,'student','Student']);

  for (const uid of [r1.lastID, r2.lastID, r3.lastID]) {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      await db.run('INSERT INTO settings (user_id,key,value) VALUES (?,?,?)', [uid, k, v]);
    }
  }
  console.log('Seeded: admin/admin123, teacher/teacher123, student/student123');
}

seed().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });