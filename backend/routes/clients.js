const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { getDB } = require('../db');
const { shapeReport } = require('../lib/reportShape');
const { reportHealth, reportAlerts, dashboardStatus, deriveClientStage, CLIENT_STAGES } = require('../lib/status');

const clientSchema = z.object({
  name: z.string().min(1, 'שם לקוח נדרש'),
  has_vat: z.boolean().optional(),
  cluster_number: z.number().int().min(1).max(10).nullable().optional(),
  notes: z.string().optional(),
  manage_status: z.enum(['no_material', 'material', 'in_treatment', 'done']).nullable().optional(),
  manage_notes: z.string().nullable().optional(),
  manage_data: z.record(z.string(), z.any()).nullable().optional(), // צ'ק-ליסט הניהול (JSON)
});

function validate(schema, body) {
  const r = schema.safeParse(body);
  if (!r.success) return { error: r.error.issues.map((i) => i.message).join(', ') };
  return { data: r.data };
}

/* עוטף ראוט אסינכרוני עם טיפול בשגיאות */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* מוסיף בריאות/סטטוס נגזר לשורת דוח (§13) */
async function withHealth(db, r) {
  return { ...shapeReport(r), health: await reportHealth(db, r) };
}

/* עץ מלא: לקוחות → רשויות → דוחות + דוחות ישירים — ללוח השליטה */
async function buildTree(db) {
  const clients = await db.prepare('SELECT * FROM clients ORDER BY name').all();
  const authorities = await db.prepare('SELECT * FROM authorities ORDER BY name').all();
  const rawReports = await db.prepare('SELECT * FROM reports ORDER BY id').all();
  const reports = [];
  for (const r of rawReports) reports.push(await withHealth(db, r));
  return clients.map((c) => {
    const clientReports = reports.filter((r) => r.client_id === c.id);
    const stage = deriveClientStage(c, clientReports.map((r) => r.health));
    return {
      ...c,
      has_vat: !!c.has_vat,
      stage,
      stageLabel: CLIENT_STAGES[stage],
      directReports: clientReports.filter((r) => !r.authority_id),
      authorities: authorities
        .filter((a) => a.client_id === c.id)
        .map((a) => ({ ...a, reports: clientReports.filter((r) => r.authority_id === a.id) })),
    };
  });
}

router.get('/tree', ah(async (req, res) => res.json(await buildTree(getDB()))));

router.get('/dashboard', ah(async (req, res) => {
  const db = getDB();
  res.json({
    clients: Number((await db.prepare('SELECT COUNT(*) c FROM clients').get()).c),
    authorities: Number((await db.prepare('SELECT COUNT(*) c FROM authorities').get()).c),
    reports: Number((await db.prepare('SELECT COUNT(*) c FROM reports').get()).c),
    status: await dashboardStatus(db), // דליים נגזרים, התראות, וכסף על השולחן (§13)
  });
}));

router.get('/', ah(async (req, res) => {
  const db = getDB();
  const clients = await db.prepare('SELECT * FROM clients ORDER BY name').all();
  const out = [];
  for (const c of clients) {
    out.push({
      ...c,
      has_vat: !!c.has_vat,
      authorityCount: Number((await db.prepare('SELECT COUNT(*) c FROM authorities WHERE client_id = ?').get(c.id)).c),
      reportCount: Number((await db.prepare('SELECT COUNT(*) c FROM reports WHERE client_id = ?').get(c.id)).c),
    });
  }
  res.json(out);
}));

router.get('/:id', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!client) return res.status(404).json({ error: 'לקוח לא נמצא' });
  const auths = {};
  (await db.prepare('SELECT id, name FROM authorities WHERE client_id = ?').all(id)).forEach((a) => { auths[a.id] = a.name; });
  const rawReports = await db.prepare('SELECT * FROM reports WHERE client_id = ? ORDER BY id').all(id);
  const reports = [];
  let alerts = [];
  for (const r of rawReports) {
    const shaped = await withHealth(db, r);
    reports.push(shaped);
    // ההתראות של הלקוח (עברו לכאן מהמסך הראשי)
    r._authorityName = r.authority_id ? auths[r.authority_id] : null;
    alerts = alerts.concat(reportAlerts(r, shaped.health));
  }
  alerts.sort((a, b) => b.urgency - a.urgency);
  const authorities = (await db.prepare('SELECT * FROM authorities WHERE client_id = ? ORDER BY name').all(id))
    .map((a) => ({ ...a, reports: reports.filter((r) => r.authority_id === a.id) }));
  const stage = deriveClientStage(client, reports.map((r) => r.health));
  let manageData = {};
  try { manageData = client.manage_data ? JSON.parse(client.manage_data) : {}; } catch { /* ריק */ }
  res.json({
    ...client,
    has_vat: !!client.has_vat,
    stage,
    stageLabel: CLIENT_STAGES[stage],
    stageLabels: CLIENT_STAGES,
    manageData,
    alerts,
    directReports: reports.filter((r) => !r.authority_id),
    authorities,
  });
}));

router.post('/', ah(async (req, res) => {
  const { error, data } = validate(clientSchema, req.body);
  if (error) return res.status(400).json({ error });
  const db = getDB();
  const r = await db.prepare('INSERT INTO clients (name, has_vat, cluster_number, notes) VALUES (?, ?, ?, ?)')
    .run(data.name, data.has_vat ? 1 : 0, data.cluster_number ?? null, data.notes ?? null);
  res.status(201).json(await db.prepare('SELECT * FROM clients WHERE id = ?').get(r.lastInsertRowid));
}));

router.put('/:id', ah(async (req, res) => {
  const { error, data } = validate(clientSchema, req.body);
  if (error) return res.status(400).json({ error });
  const db = getDB();
  const id = parseInt(req.params.id);
  const cur = await db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'לקוח לא נמצא' });
  await db.prepare('UPDATE clients SET name = ?, has_vat = ?, cluster_number = ?, notes = ?, manage_status = ?, manage_notes = ?, manage_data = ? WHERE id = ?')
    .run(
      data.name,
      data.has_vat != null ? (data.has_vat ? 1 : 0) : cur.has_vat,
      data.cluster_number !== undefined ? data.cluster_number : cur.cluster_number,
      data.notes !== undefined ? data.notes : cur.notes,
      data.manage_status !== undefined ? data.manage_status : cur.manage_status,
      data.manage_notes !== undefined ? data.manage_notes : cur.manage_notes,
      data.manage_data !== undefined ? (data.manage_data ? JSON.stringify(data.manage_data) : null) : cur.manage_data,
      id
    );
  res.json(await db.prepare('SELECT * FROM clients WHERE id = ?').get(id));
}));

/* מחיקת לקוח — מפל ידני על כל העץ שמתחתיו (ללא אכיפת FK) */
router.delete('/:id', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const reportIds = (await db.prepare('SELECT id FROM reports WHERE client_id = ?').all(id)).map((r) => r.id);
  for (const rid of reportIds) await cascadeReport(db, rid);
  await db.prepare('DELETE FROM cost_rows WHERE client_id = ?').run(id);
  await db.prepare('DELETE FROM cost_files WHERE client_id = ?').run(id);
  await db.prepare('DELETE FROM authorities WHERE client_id = ?').run(id);
  await db.prepare('DELETE FROM client_mappings WHERE client_id = ?').run(id);
  await db.prepare('DELETE FROM clients WHERE id = ?').run(id);
  res.json({ ok: true });
}));

/* עזר משותף: מחיקת דוח על מוסדותיו, סליו ותנועותיו */
async function cascadeReport(db, reportId) {
  const instIds = (await db.prepare('SELECT id FROM institutions WHERE report_id = ?').all(reportId)).map((i) => i.id);
  for (const iid of instIds) {
    const basketIds = (await db.prepare('SELECT id FROM baskets WHERE institution_id = ?').all(iid)).map((b) => b.id);
    for (const bid of basketIds) await db.prepare('DELETE FROM transactions WHERE basket_id = ?').run(bid);
    await db.prepare('DELETE FROM baskets WHERE institution_id = ?').run(iid);
  }
  await db.prepare('DELETE FROM institutions WHERE report_id = ?').run(reportId);
  // שורות עלות שנותבו לדוח זה חוזרות למצב "לא משויך" (הן שייכות לקובץ של הלקוח)
  await db.prepare('UPDATE cost_rows SET report_id = NULL WHERE report_id = ?').run(reportId);
  await db.prepare('DELETE FROM ledger_cards WHERE report_id = ?').run(reportId);
  await db.prepare('DELETE FROM ledger_files WHERE report_id = ?').run(reportId);
  await db.prepare('DELETE FROM reports WHERE id = ?').run(reportId);
}

module.exports = router;
module.exports.cascadeReport = cascadeReport;
