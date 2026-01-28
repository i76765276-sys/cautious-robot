'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../lib/asyncHandler');
const { badRequest, notFound, conflict } = require('../lib/httpError');

const createSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(254)
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().max(254).optional()
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field required' });

function parseId(req) {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Invalid id', 'INVALID_ID');
  return n;
}

function usersRoutes({ db }) {
  if (!db) throw new Error('usersRoutes: db required');
  const r = express.Router();

  // List
  r.get('/', asyncHandler(async (req, res) => {
    const rows = await db.all('SELECT id, name, email, created_at FROM users ORDER BY id DESC LIMIT 200');
    res.json({ ok: true, data: rows, requestId: req.id });
  }));

  // Create
  r.post('/', asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Validation failed', 'VALIDATION', parsed.error.flatten());

    const { name, email } = parsed.data;

    try {
      const result = await db.run(
        'INSERT INTO users (name, email) VALUES (?, ?)',
        [name, email]
      );
      const row = await db.get('SELECT id, name, email, created_at FROM users WHERE id = ?', [result.lastID]);
      res.status(201).json({ ok: true, data: row, requestId: req.id });
    } catch (e) {
      // SQLite unique constraint
      const msg = String(e && e.message || '');
      if (msg.includes('UNIQUE') && msg.includes('users.email')) {
        throw conflict('Email already exists', 'EMAIL_TAKEN');
      }
      throw e;
    }
  }));

  // Get by id
  r.get('/:id', asyncHandler(async (req, res) => {
    const id = parseId(req);
    const row = await db.get('SELECT id, name, email, created_at FROM users WHERE id = ?', [id]);
    if (!row) throw notFound('User not found', 'USER_NOT_FOUND');
    res.json({ ok: true, data: row, requestId: req.id });
  }));

  // Patch
  r.patch('/:id', asyncHandler(async (req, res) => {
    const id = parseId(req);

    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Validation failed', 'VALIDATION', parsed.error.flatten());

    const existing = await db.get('SELECT id FROM users WHERE id = ?', [id]);
    if (!existing) throw notFound('User not found', 'USER_NOT_FOUND');

    const fields = [];
    const params = [];
    if (parsed.data.name !== undefined) { fields.push('name = ?'); params.push(parsed.data.name); }
    if (parsed.data.email !== undefined) { fields.push('email = ?'); params.push(parsed.data.email); }
    params.push(id);

    try {
      await db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
      const row = await db.get('SELECT id, name, email, created_at FROM users WHERE id = ?', [id]);
      res.json({ ok: true, data: row, requestId: req.id });
    } catch (e) {
      const msg = String(e && e.message || '');
      if (msg.includes('UNIQUE') && msg.includes('users.email')) {
        throw conflict('Email already exists', 'EMAIL_TAKEN');
      }
      throw e;
    }
  }));

  // Delete
  r.delete('/:id', asyncHandler(async (req, res) => {
    const id = parseId(req);
    const result = await db.run('DELETE FROM users WHERE id = ?', [id]);
    if (result.changes === 0) throw notFound('User not found', 'USER_NOT_FOUND');
    res.json({ ok: true, data: { deleted: true, id }, requestId: req.id });
  }));

  return r;
}

module.exports = { usersRoutes };
