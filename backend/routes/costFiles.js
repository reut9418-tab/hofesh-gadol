const express = require('express');
const router = express.Router();
const multer = require('multer');
const { z } = require('zod');
const { getDB } = require('../db');
const { parseCostFile, norm } = require('../lib/ingest');
const { reportLabel } = require('../lib/domain');
const { staffFromRoleText } = require('../lib/salaryCheck');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* מיפוי dept→project נלמד לכל לקוח (client_mappings, mapping_type='dept_to_project') */
async function learnedRouting(db, clientId) {
  const rows = await db.prepare(
    "SELECT map_key, map_value FROM client_mappings WHERE client_id = ? AND mapping_type = 'dept_to_project'"
  ).all(clientId);
  const m = {};
  rows.forEach((r) => { m[r.map_key] = r.map_value; }); // map_value = reportId או 'none'
  return m;
}

async function saveRouting(db, clientId, deptKey, reportId) {
  const val = reportId == null ? 'none' : String(reportId);
  await db.prepare(
    `INSERT INTO client_mappings (client_id, mapping_type, map_key, map_value)
     VALUES (?, 'dept_to_project', ?, ?)
     ON CONFLICT(client_id, mapping_type, map_key) DO UPDATE SET map_value = excluded.map_value`
  ).run(clientId, deptKey, val);
}

/* דוחות הלקוח עם תווית קריאה — יעדי הניתוב */
async function clientReports(db, clientId) {
  const reports = await db.prepare('SELECT * FROM reports WHERE client_id = ? ORDER BY id').all(clientId);
  const auths = {};
  (await db.prepare('SELECT id, name FROM authorities WHERE client_id = ?').all(clientId)).forEach((a) => { auths[a.id] = a.name; });
  return reports.map((r) => ({
    id: r.id,
    label: reportLabel(r.framework, r.program),
    authorityName: r.authority_id ? (auths[r.authority_id] || null) : null,
  }));
}

/* צבירת שורות קובץ לרמת מחלקה — ציר הניתוב */
async function departmentsForFile(db, fileId) {
  const rows = await db.prepare('SELECT dept, emp_id, cost, hours, report_id FROM cost_rows WHERE cost_file_id = ?').all(fileId);
  const m = new Map();
  rows.forEach((r) => {
    const cur = m.get(r.dept) || { dept: r.dept, workers: new Set(), cost: 0, hours: 0, report_id: r.report_id };
    cur.workers.add(r.emp_id);
    cur.cost += r.cost || 0;
    cur.hours += r.hours || 0;
    m.set(r.dept, cur);
  });
  return [...m.values()]
    .map((d) => ({ dept: d.dept, workers: d.workers.size, cost: d.cost, hours: d.hours, report_id: d.report_id }))
    .sort((a, b) => b.cost - a.cost);
}

/* מרענן את דגל has_cost_report של דוח לפי קיום שורות מנותבות */
async function refreshReportFlag(db, reportId) {
  if (reportId == null) return;
  const c = Number((await db.prepare('SELECT COUNT(*) c FROM cost_rows WHERE report_id = ?').get(reportId)).c);
  await db.prepare('UPDATE reports SET has_cost_report = ? WHERE id = ?').run(c > 0 ? 1 : 0, reportId);
}

/* ---------- העלאת דוח עלות (קובץ יחיד) ברמת הלקוח ---------- */
router.post('/clients/:clientId/cost-files', upload.single('file'), ah(async (req, res) => {
  const db = getDB();
  const clientId = parseInt(req.params.clientId);
  if (!(await db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId))) return res.status(404).json({ error: 'לקוח לא נמצא' });
  if (!req.file) return res.status(400).json({ error: 'לא צורף קובץ' });
  // multer מפענח את שם הקובץ שבכותרת ה-multipart כ-latin1 — תיקון לעברית
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

  // מילון עמודות נלמד לכל לקוח (column_header) — משפר זיהוי בקבצים הבאים
  const learnedCols = {};
  (await db.prepare("SELECT map_key, map_value FROM client_mappings WHERE client_id = ? AND mapping_type = 'column_header'")
    .all(clientId)).forEach((r) => { learnedCols[r.map_key] = r.map_value; });

  let parsed;
  try {
    parsed = parseCostFile(req.file.buffer, learnedCols);
  } catch {
    return res.status(422).json({ error: 'לא הצלחתי לקרוא את הקובץ. ודאי שזה קובץ Excel או CSV תקין.' });
  }
  if (!parsed.records.length) {
    return res.status(422).json({ error: 'לא זוהו שורות שכר בקובץ (ת.ז / עלות / ברוטו). ניתן לשייך עמודות ידנית בהמשך.' });
  }

  const fileRow = await db.prepare(
    'INSERT INTO cost_files (client_id, filename, software, sheets_used, row_count) VALUES (?, ?, ?, ?, ?)'
  ).run(clientId, originalName, parsed.software, JSON.stringify(parsed.sheetsUsed), parsed.records.length);
  const fileId = fileRow.lastInsertRowid;

  for (const r of parsed.records) {
    // אם דוח השכר כולל עמודת "תפקיד" — איש הצוות והתפקיד נגזרים ממנה אוטומטית
    const staff = staffFromRoleText(r.roleText);
    await db.prepare(
      `INSERT INTO cost_rows (cost_file_id, client_id, report_id, emp_id, emp_name, first_name, last_name, dept, inst_symbol, inst_name, component_names, gross, cost, hours, staff_type, role)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(fileId, clientId, r.id, r.name || null, r.firstName, r.lastName, r.dept,
      r.instSymbol, r.instName || null, JSON.stringify(r.componentNames || []), r.gross, r.cost, r.hours,
      staff ? staff.staffType : null, staff ? staff.role : null);
  }

  // הצעת ניתוב לפי מה שנלמד; ברירת מחדל — הדוח היחיד אם ללקוח דוח אחד בלבד
  const learned = await learnedRouting(db, clientId);
  const reports = await clientReports(db, clientId);
  const validIds = new Set(reports.map((r) => r.id));
  const soleReport = reports.length === 1 ? reports[0].id : null;
  const departments = (await departmentsForFile(db, fileId)).map((d) => {
    let proposed = null;
    const lv = learned[norm(d.dept)];
    if (lv === 'none') proposed = null;
    else if (lv !== undefined && validIds.has(parseInt(lv))) proposed = parseInt(lv);
    else if (lv === undefined && soleReport) proposed = soleReport;
    return { ...d, proposedReportId: proposed, learned: lv !== undefined };
  });

  res.status(201).json({
    file: { id: fileId, filename: originalName, software: parsed.software, sheetsUsed: parsed.sheetsUsed, rowCount: parsed.records.length, routed: false },
    departments, reports,
  });
}));

/* ---------- אישור ניתוב: מחלקה → דוח ---------- */
const routeSchema = z.object({
  routing: z.record(z.string(), z.union([z.number().int(), z.null()])),
});

router.post('/cost-files/:fileId/route', ah(async (req, res) => {
  const parsed = routeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'מבנה ניתוב לא תקין' });
  const db = getDB();
  const fileId = parseInt(req.params.fileId);
  const file = await db.prepare('SELECT * FROM cost_files WHERE id = ?').get(fileId);
  if (!file) return res.status(404).json({ error: 'קובץ לא נמצא' });

  const validIds = new Set((await db.prepare('SELECT id FROM reports WHERE client_id = ?').all(file.client_id)).map((r) => r.id));
  const affected = new Set();
  (await db.prepare('SELECT DISTINCT report_id FROM cost_rows WHERE cost_file_id = ? AND report_id IS NOT NULL').all(fileId))
    .forEach((r) => affected.add(r.report_id));

  for (const [dept, reportIdRaw] of Object.entries(parsed.data.routing)) {
    const reportId = reportIdRaw != null && validIds.has(reportIdRaw) ? reportIdRaw : null;
    await db.prepare('UPDATE cost_rows SET report_id = ? WHERE cost_file_id = ? AND dept = ?').run(reportId, fileId, dept);
    await saveRouting(db, file.client_id, norm(dept), reportId); // נלמד להעלאות הבאות
    if (reportId != null) affected.add(reportId);
  }

  await db.prepare('UPDATE cost_files SET routed = 1 WHERE id = ?').run(fileId);
  for (const rid of affected) await refreshReportFlag(db, rid);
  res.json({ ok: true, affectedReports: [...affected] });
}));

/* ---------- רשימת קבצי העלות של לקוח ---------- */
router.get('/clients/:clientId/cost-files', ah(async (req, res) => {
  const db = getDB();
  const clientId = parseInt(req.params.clientId);
  const files = await db.prepare('SELECT * FROM cost_files WHERE client_id = ? ORDER BY id DESC').all(clientId);
  const out = [];
  for (const f of files) {
    const routedCount = Number((await db.prepare('SELECT COUNT(*) c FROM cost_rows WHERE cost_file_id = ? AND report_id IS NOT NULL').get(f.id)).c);
    out.push({
      id: f.id, filename: f.filename, software: f.software,
      sheetsUsed: JSON.parse(f.sheets_used || '[]'),
      rowCount: f.row_count, routed: !!f.routed, routedRows: routedCount,
      payer: f.payer || null,
      created_at: f.created_at,
    });
  }
  res.json(out);
}));

/* ---------- עדכון משלם (מתנ"ס/רשות) של קובץ עלות ---------- */
router.put('/cost-files/:fileId/payer', ah(async (req, res) => {
  const db = getDB();
  const fileId = parseInt(req.params.fileId);
  if (!(await db.prepare('SELECT id FROM cost_files WHERE id = ?').get(fileId))) return res.status(404).json({ error: 'קובץ לא נמצא' });
  const payer = String(req.body.payer || '').trim() || null;
  await db.prepare('UPDATE cost_files SET payer = ? WHERE id = ?').run(payer, fileId);
  res.json({ ok: true, payer });
}));

/* ---------- מחלקות של קובץ + הצעת ניתוב (לפתיחה מחדש של מסך הניתוב) ---------- */
router.get('/cost-files/:fileId', ah(async (req, res) => {
  const db = getDB();
  const fileId = parseInt(req.params.fileId);
  const file = await db.prepare('SELECT * FROM cost_files WHERE id = ?').get(fileId);
  if (!file) return res.status(404).json({ error: 'קובץ לא נמצא' });
  const learned = await learnedRouting(db, file.client_id);
  const reports = await clientReports(db, file.client_id);
  const validIds = new Set(reports.map((r) => r.id));
  const soleReport = reports.length === 1 ? reports[0].id : null;
  const departments = (await departmentsForFile(db, fileId)).map((d) => {
    let proposed = d.report_id;
    if (proposed == null && !file.routed) {
      const lv = learned[norm(d.dept)];
      if (lv === 'none') proposed = null;
      else if (lv !== undefined && validIds.has(parseInt(lv))) proposed = parseInt(lv);
      else if (soleReport) proposed = soleReport;
    }
    return { dept: d.dept, workers: d.workers, cost: d.cost, hours: d.hours, proposedReportId: proposed };
  });
  res.json({
    file: { id: file.id, filename: file.filename, software: file.software, sheetsUsed: JSON.parse(file.sheets_used || '[]'), rowCount: file.row_count, routed: !!file.routed },
    departments, reports,
  });
}));

/* ---------- מחיקת קובץ עלות ---------- */
router.delete('/cost-files/:fileId', ah(async (req, res) => {
  const db = getDB();
  const fileId = parseInt(req.params.fileId);
  const affected = (await db.prepare('SELECT DISTINCT report_id FROM cost_rows WHERE cost_file_id = ? AND report_id IS NOT NULL').all(fileId)).map((r) => r.report_id);
  await db.prepare('DELETE FROM cost_rows WHERE cost_file_id = ?').run(fileId);
  await db.prepare('DELETE FROM cost_files WHERE id = ?').run(fileId);
  for (const rid of affected) await refreshReportFlag(db, rid);
  res.json({ ok: true });
}));

module.exports = router;
