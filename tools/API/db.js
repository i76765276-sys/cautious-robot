'use strict';

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function openDb(dbPath) {
  ensureDirFor(dbPath);
  const db = new sqlite3.Database(dbPath);

  // Promisified wrappers
  const run = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ changes: this.changes, lastID: this.lastID });
      });
    });

  const get = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

  const all = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });

  const exec = (sql) =>
    new Promise((resolve, reject) => {
      db.exec(sql, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

  return { raw: db, run, get, all, exec };
}

async function migrate(db) {
  // Basic pragmas for sane behavior
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
  `);

  // Simple schema (example users table)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
  `);
}

function initDb(dbPath) {
  const db = openDb(dbPath);

  // Kick off migration; keep reference and await within routes as needed
  // but we want to fail fast on boot:
  migrate(db).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[db] migration failed:', e);
    process.exit(1);
  });

  return db;
}

module.exports = { initDb };
