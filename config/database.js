const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

let db = null;

async function connectDB() {
  if (db) return db;
  const dbFile = process.env.DB_FILE || './database/luxmind.db';
  const dbDir = path.dirname(dbFile);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  db = await open({ filename: dbFile, driver: sqlite3.Database });
  await db.run('PRAGMA foreign_keys = ON;');
  console.log('DB connected -> ' + dbFile);
  return db;
}

function getDB() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

module.exports = { connectDB, getDB };