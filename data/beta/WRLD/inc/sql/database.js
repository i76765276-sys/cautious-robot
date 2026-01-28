// sqlite-migrate.js (CommonJS)
// Creates "schemas" (simulated via name prefixes) and tables for SQLite3.
// NOTE: SQLite does NOT support real schemas like Postgres.
// Convention used here: `${schema}__${table}` (double underscore).
//
// Requires: npm i sqlite3
// Env: SQLITE_PATH (default: ./data/app.db)

'use strict';

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

function assertName(name, label) {
  if (typeof name !== 'string' || !name.trim()) throw new Error(`${label} must be a non-empty string`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label} "${name}" invalid (use letters/numbers/underscore, must not start with a number)`);
  }
  return name;
}

function qIdent(name) {
  // SQLite identifier quoting
  return `"${String(name).replace(/"/g, '""')}"`;
}

function tableName(schema, table) {
  assertName(schema, 'schema');
  assertName(table, 'table');
  return `${schema}__${table}`;
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * @typedef {Object} TableSpec
 * @property {string} name
 * @property {Record<string,string>} columns  // { colName: "TYPE constraints..." }
 * @property {string[]=} constraints          // extra lines inside CREATE TABLE (...), e.g. ['UNIQUE("email")']
 * @property {Array<{name?:string, columns:string[], unique?:boolean, where?:string }>=} indexes
 */

/**
 * @typedef {Object} SchemaSpec
 * @property {string} schema
 * @property {TableSpec[]} tables
 */

/**
 * Create "schema" and tables (idempotent) for SQLite.
 * "schema" is only a prefix in table names: schema__table.
 *
 * @param {SchemaSpec} spec
 * @param {{ filename?: string }} [options]
 */
async function ensureSqlite(spec, options = {}) {
  if (!spec || typeof spec !== 'object') throw new Error('spec is required');
  const schema = assertName(spec.schema, 'spec.schema');
  const tables = Array.isArray(spec.tables) ? spec.tables : [];
  const filename = options.filename || process.env.SQLITE_PATH || path.join(process.cwd(), 'data', 'app.db');

  // Ensure parent dir exists
  fs.mkdirSync(path.dirname(filename), { recursive: true });

  const db = new sqlite3.Database(filename);

  try {
    // Foreign keys are OFF by default in SQLite
    await exec(db, 'PRAGMA foreign_keys = ON;');

    await exec(db, 'BEGIN;');

    // Ensure a "schemas" registry table (optional, for tracking)
    await exec(
      db,
      `
      CREATE TABLE IF NOT EXISTS "__schemas" (
        "name" TEXT PRIMARY KEY,
        "created_at" TEXT NOT NULL DEFAULT (datetime('now'))
      );
      `
    );
    await run(db, `INSERT OR IGNORE INTO "__schemas" ("name") VALUES (?);`, [schema]);

    // Create each table
    for (const t of tables) {
      if (!t || typeof t !== 'object') throw new Error('Invalid table spec');
      const tName = assertName(t.name, 'table.name');
      if (!t.columns || typeof t.columns !== 'object') throw new Error(`Table "${tName}" columns must be an object`);

      const full = tableName(schema, tName);

      const colLines = [];
      for (const [col, def] of Object.entries(t.columns)) {
        assertName(col, `column name in ${tName}`);
        if (typeof def !== 'string' || !def.trim()) throw new Error(`Invalid definition for column "${col}" in "${tName}"`);
        colLines.push(`${qIdent(col)} ${def}`);
      }

      const constraintLines = Array.isArray(t.constraints) ? t.constraints.filter(Boolean) : [];

      const ddl = `
        CREATE TABLE IF NOT EXISTS ${qIdent(full)} (
          ${[...colLines, ...constraintLines].join(',\n          ')}
        );
      `;
      await exec(db, ddl);

      // Indexes
      const indexes = Array.isArray(t.indexes) ? t.indexes : [];
      for (const idx of indexes) {
        if (!idx || typeof idx !== 'object') throw new Error(`Invalid index spec on "${tName}"`);
        const cols = Array.isArray(idx.columns) ? idx.columns : [];
        if (cols.length === 0) throw new Error(`Index on "${tName}" must include columns`);
        cols.forEach((c) => assertName(c, `index column on ${tName}`));

        const unique = !!idx.unique;
        const idxName =
          idx.name && String(idx.name).trim()
            ? assertName(String(idx.name).trim(), 'index.name')
            : assertName(`${full}__${cols.join('_')}__${unique ? 'uidx' : 'idx'}`, 'index.name');

        const where = idx.where ? String(idx.where).trim() : '';
        const whereSql = where ? ` WHERE ${where}` : '';

        const sql = `
          CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${qIdent(idxName)}
          ON ${qIdent(full)} (${cols.map(qIdent).join(', ')})${whereSql};
        `;
        await exec(db, sql);
      }
    }

    await exec(db, 'COMMIT;');
  } catch (err) {
    try {
      await exec(db, 'ROLLBACK;');
    } catch (_) {}
    throw err;
  } finally {
    await new Promise((resolve) => db.close(resolve));
  }
}

module.exports = { ensureSqlite, tableName };

/* ---------------------------
   Example usage:

const { ensureSqlite, tableName } = require('WRLD-SDK');

(async () => {
  await ensureSchemaAndTablesSqlite({
    schema: 'eviroment',
    tables: []
    }, { filename: './data/wrld-main.db' });

  console.log('SQLite schema + tables ensured');
})().catch(console.error);

---------------------------- */
