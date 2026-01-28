'use strict';

function mustEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`Missing required env: ${name}`);
  }
  return String(v);
}

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = parseInt(String(v), 10);
  if (Number.isNaN(n)) return fallback;
  return n;
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

module.exports = { mustEnv, envInt, envBool };
