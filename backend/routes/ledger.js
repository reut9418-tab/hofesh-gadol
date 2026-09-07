/* קליטת כרטסות ושיוכן לסלים (README §14 צעד 6) */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { z } = require('zod');
const { getDB } = require('../db');
const { parseLedgerFile, basketForCardName, BASKET_HE } = require('../lib/ledger');
const { ledgerReconcile } = require('../lib/reconcile');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* מיפוי נלמד: מפתח חשבון → סל, לכל לקוח ולכל מסגרת (אותו כרטיס יכול להיות
   "שכר" בבתי"ס ו"לא רלוונטי" בגנים). map_value 'none' = "לא רלוונטי" במפורש. */
const aliasKey = (framework, cardKey) => `${framework}:${cardKey}`;
async function learnedAliases(db, clientId) {
  const m = {};
  (await db.prepare("SELECT map_key, map_value FROM client_mappings WHERE client_id = ? AND mapping_type = 'ledger_alias'")
    .all(clientId)).forEach((r) => { m[r.map_key] = r.map_value; });
  return m;
}
async function saveAlias(db, clientId, framework, cardKey, basket) {
  await db.prepare(
    `INSERT INTO client_mappings (client_id, mapping_type, map_key, map_value)
     VALUES (?, 'ledger_alias', ?, ?)
     ON CONFLICT(client_id, mapping_type, map_key) DO UPDATE SET map_value = excluded.map_value`
  ).run(clientId, aliasKey(framework, cardKey), basket == null ? 'none' : basket);
}

async function refreshLedgerFlag(db, reportId) {
  const c = Number((await db.prepare('SELECT COUNT(*) c FROM ledger_cards WHERE report_id = ? AND basket_type IS NOT NULL').get(reportId)).c);
  await db.prepare('UPDATE reports SET has_ledger = ? WHERE id = ?').run(c > 0 ? 1 : 0, reportId);
}

/* ---------- העלאת כרטסת לדוח ---------- */
router.post('/reports/:id/ledger-file', upload.single('file'), ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  if (!req.file) return res.status(400).json({ error: 'לא צורף קובץ' });
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

  let parsed;
  try { parsed = parseLedgerFile(req.file.buffer); }
  catch { return res.status(422).json({ error: 'לא הצלחתי לקרוא את קובץ הכרטסת.' }); }
  if (!parsed.cards.length) {
    return res.status(422).json({ error: 'לא זוהו כרטיסי הנהלת חשבונות בקובץ (מבנה "מפתח חשבון" של חשבשבת).' });
  }

  const aliases = await learnedAliases(db, report.client_id);
  const fileId = (await db.prepare('INSERT INTO ledger_files (report_id, filename, card_count) VALUES (?, ?, ?)')
    .run(id, originalName, parsed.cards.length)).lastInsertRowid;
  for (const c of parsed.cards) {
    // עדיפות: מיפוי נלמד (גם "לא רלוונטי") ← מילות מפתח משם הכרטסת
    const learned = aliases[aliasKey(report.framework, c.key)];
    const basket = learned !== undefined ? (learned === 'none' ? null : learned) : basketForCardName(c.name);
    await db.prepare(
      'INSERT INTO ledger_cards (ledger_file_id, report_id, card_key, card_name, debit, credit, net, basket_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(fileId, id, c.key, c.name, c.debit, c.credit, c.net, basket);
  }
  await refreshLedgerFlag(db, id);
  res.status(201).json({ ok: true, fileId, cards: parsed.cards.length });
}));

/* ---------- כרטסות הדוח + התאמה ---------- */
router.get('/reports/:id/ledger', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(report.client_id);
  const files = await db.prepare('SELECT * FROM ledger_files WHERE report_id = ? ORDER BY id DESC').all(id);
  const cards = await db.prepare('SELECT * FROM ledger_cards WHERE report_id = ? ORDER BY net DESC').all(id);
  res.json({
    files,
    cards,
    basketOptions: Object.entries(BASKET_HE).map(([value, label]) => ({ value, label })),
    reconcile: await ledgerReconcile(db, report, client),
    hasVat: !!(client && client.has_vat),
  });
}));

/* ---------- שיוך כרטיס לסל (נלמד להעלאות הבאות) ---------- */
const cardSchema = z.object({ basket_type: z.string().nullable() });
router.put('/ledger-cards/:cardId', ah(async (req, res) => {
  const parsed = cardSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'שיוך לא תקין' });
  const db = getDB();
  const cardId = parseInt(req.params.cardId);
  const card = await db.prepare('SELECT * FROM ledger_cards WHERE id = ?').get(cardId);
  if (!card) return res.status(404).json({ error: 'כרטיס לא נמצא' });
  const basket = parsed.data.basket_type && BASKET_HE[parsed.data.basket_type] ? parsed.data.basket_type : null;
  await db.prepare('UPDATE ledger_cards SET basket_type = ? WHERE id = ?').run(basket, cardId);
  const report = await db.prepare('SELECT client_id, framework FROM reports WHERE id = ?').get(card.report_id);
  if (report) await saveAlias(db, report.client_id, report.framework, card.card_key, basket);
  await refreshLedgerFlag(db, card.report_id);
  res.json({ ok: true });
}));

/* ---------- עדכון משלם (מתנ"ס/רשות) של כרטסת ---------- */
router.put('/ledger-files/:fileId/payer', ah(async (req, res) => {
  const db = getDB();
  const fileId = parseInt(req.params.fileId);
  if (!(await db.prepare('SELECT id FROM ledger_files WHERE id = ?').get(fileId))) return res.status(404).json({ error: 'קובץ לא נמצא' });
  const payer = String(req.body.payer || '').trim() || null;
  await db.prepare('UPDATE ledger_files SET payer = ? WHERE id = ?').run(payer, fileId);
  res.json({ ok: true, payer });
}));

/* ---------- מחיקת קובץ כרטסת ---------- */
router.delete('/ledger-files/:fileId', ah(async (req, res) => {
  const db = getDB();
  const fileId = parseInt(req.params.fileId);
  const file = await db.prepare('SELECT * FROM ledger_files WHERE id = ?').get(fileId);
  if (!file) return res.status(404).json({ error: 'קובץ לא נמצא' });
  await db.prepare('DELETE FROM ledger_cards WHERE ledger_file_id = ?').run(fileId);
  await db.prepare('DELETE FROM ledger_files WHERE id = ?').run(fileId);
  await refreshLedgerFlag(db, file.report_id);
  res.json({ ok: true });
}));

module.exports = router;
