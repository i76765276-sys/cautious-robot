// db.js (CommonJS)
// Production-ready insert helper for Supabase (supabase-js v2)
//
// Env needed:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (server-side only)

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables.');
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

class DbInsertError extends Error {
  constructor(message, { table, valuesCount, postgrest } = {}) {
    super(message);
    this.name = 'DbInsertError';
    this.table = table;
    this.valuesCount = valuesCount;
    this.postgrest = postgrest;
  }
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function assertValidTableName(table) {
  // Allow: table or schema.table
  const ok = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(table);
  if (!ok) {
    throw new Error(
      `Invalid table name "${table}". Use only letters/numbers/underscore, optionally "schema.table".`
    );
  }
}

/**
 * Insert into a Postgres table via Supabase.
 *
 * @param {string} table - Table name (or schema.table).
 * @param {object|object[]} values - Single row object or array of row objects.
 * @param {object} [opts]
 * @param {string} [opts.select="*"] - Columns to return (only for returning="representation").
 * @param {"minimal"|"representation"} [opts.returning="representation"] - Return mode.
 * @param {boolean} [opts.single=false] - If true, returns a single row (only for single-object insert).
 * @returns {Promise<any|any[]>}
 */
const insertInto = async (table, values, opts = {}) => {
  if (typeof table !== 'string' || table.trim() === '') {
    throw new Error("insertInto: 'table' must be a non-empty string.");
  }
  assertValidTableName(table);

  const isArray = Array.isArray(values);
  const valuesCount = isArray ? values.length : 1;

  if (isArray) {
    if (values.length === 0) throw new Error("insertInto: 'values' array cannot be empty.");
    for (let i = 0; i < values.length; i++) {
      if (!isPlainObject(values[i])) {
        throw new Error(`insertInto: values[${i}] must be a plain object.`);
      }
    }
  } else {
    if (!isPlainObject(values)) {
      throw new Error("insertInto: 'values' must be a plain object or an array of plain objects.");
    }
  }

  const returning = opts.returning || 'representation';
  const select = opts.select || '*';
  const wantSingle = !!opts.single;

  if (wantSingle && isArray) {
    throw new Error('insertInto: opts.single=true is only valid when inserting a single row object.');
  }

  try {
    if (returning === 'minimal') {
      const { error } = await supabaseAdmin.from(table).insert(values, { returning: 'minimal' });
      if (error) {
        throw new DbInsertError(`insertInto(${table}) failed: ${error.message}`, {
          table,
          valuesCount,
          postgrest: error,
        });
      }
      // minimal returns nothing; return a safe empty shape
      return wantSingle ? null : [];
    }

    if (wantSingle) {
      const { data, error } = await supabaseAdmin
        .from(table)
        .insert(values, { returning: 'representation' })
        .select(select)
        .single();

      if (error) {
        throw new DbInsertError(`insertInto(${table}) failed: ${error.message}`, {
          table,
          valuesCount,
          postgrest: error,
        });
      }
      return data;
    }

    const { data, error } = await supabaseAdmin
      .from(table)
      .insert(values, { returning: 'representation' })
      .select(select);

    if (error) {
      throw new DbInsertError(`insertInto(${table}) failed: ${error.message}`, {
        table,
        valuesCount,
        postgrest: error,
      });
    }

    return data;
  } catch (e) {
    if (e instanceof DbInsertError) throw e;
    const msg = e && typeof e === 'object' && e.message ? e.message : String(e);
    throw new DbInsertError(`insertInto(${table}) failed: ${msg}`, { table, valuesCount });
  }
};

module.exports = {
  supabaseAdmin,
  insertInto,
  DbInsertError,
};
