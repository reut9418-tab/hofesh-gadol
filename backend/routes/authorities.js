const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { getDB } = require('../db');
const { cascadeReport } = require('./clients');

const schema = z.object({ name: z.string().min(1, 'שם רשות נדרש') });
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post('/clients/:clientId/authorities', ah(async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const db = getDB();
  const clientId = parseInt(req.params.clientId);
  if (!(await db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId))) return res.status(404).json({ error: 'לקוח לא נמצא' });
  const r = await db.prepare('INSERT INTO authorities (client_id, name) VALUES (?, ?)').run(clientId, parsed.data.name);
  res.status(201).json(await db.prepare('SELECT * FROM authorities WHERE id = ?').get(r.lastInsertRowid));
}));

router.put('/authorities/:id', ah(async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const db = getDB();
  const id = parseInt(req.params.id);
  await db.prepare('UPDATE authorities SET name = ? WHERE id = ?').run(parsed.data.name, id);
  res.json(await db.prepare('SELECT * FROM authorities WHERE id = ?').get(id));
}));

router.delete('/authorities/:id', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const reports = await db.prepare('SELECT id FROM reports WHERE authority_id = ?').all(id);
  for (const r of reports) await cascadeReport(db, r.id);
  await db.prepare('DELETE FROM authorities WHERE id = ?').run(id);
  res.json({ ok: true });
}));

module.exports = router;
