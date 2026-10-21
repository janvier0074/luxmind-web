require('dotenv').config();
const { connectDB, getDB } = require('../config/database');

(async () => {
  await connectDB();
  const db = getDB();
  const users = await db.all('SELECT id, username, email, role FROM users ORDER BY id');
  console.log('\nID | USERNAME | EMAIL | ROLE');
  console.log('---------------------------------------');
  for (const u of users) {
    console.log(`${u.id} | ${u.username} | ${u.email || '(empty)'} | ${u.role}`);
  }
  console.log('');
  process.exit(0);
})();