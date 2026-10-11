const { Pool } = require('pg');
require('dotenv').config();

let pool = null;

async function connectDB() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ DATABASE_URL not set');
    process.exit(1);
  }

  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 10,
  });

  try {
    await pool.query('SELECT 1');
    console.log('✅ Postgres connected');
  } catch (e) {
    console.error('❌ Postgres failed:', e.message);
    process.exit(1);
  }

  return pool;
}

function getDB() {
  if (!pool) throw new Error('DB not initialized');
  return {
    get: async (sql, params = []) => {
      const r = await pool.query(sql, params);
      return r.rows[0];
    },
    all: async (sql, params = []) => {
      const r = await pool.query(sql, params);
      return r.rows;
    },
       run: async (sql, params = []) => {
      const r = await pool.query(sql, params);
      return {
        lastID: r.rows && r.rows[0] && r.rows[0].id !== undefined ? r.rows[0].id : null,
        changes: r.rowCount,
        rows: r.rows,
      };
    },
    query: (sql, params = []) => pool.query(sql, params),
  };
}

module.exports = { connectDB, getDB };