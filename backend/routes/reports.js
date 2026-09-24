const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { getDB } = require('../db');
const { FRAMEWORKS } = require('../lib/domain');
const { shapeReport } = require('../lib/reportShape');
const { cascadeReport } = require('./clients');
const { costDataForReport } = require('../lib/reportCosts');
const { reportHealth } = require('../lib/status');
const { parseBudgetFile, extractTariff, parseGardenExecKids, norm } = require('../lib/budgetFile');
const { fillMinistryReport, extractInstitutions, extractCoordinatorGardens, extractExecGardens, extractWorkerAssignments, STAFF_TYPES, SCHOOL_STAFF_TYPES, extractSchoolStaffTypes,
  SCHOOL_TYPE_MAP, mapGardensStaff, mapSchoolsStaff, clampStaffForFramework } = require('../lib/fillMinistry');
const { salaryCheck, suggestRole, schoolsRoleByHours, demoteExtraSchoolRoles, defaultSchoolsStaff, coordHoursCapFor } = require('../lib/salaryCheck');
const { applyFileAssignments, saveManualAssignments, applyManualAssignments } = require('../lib/applyAssignments');
const { COST_MARKUP_LIMIT, effectiveGross } = require('../lib/ingest');
const { renderCostMatchHtml, buildCostMatchXlsx } = require('../lib/costMatch');
const { recommendations } = require('../lib/recommend');
const { matchDeptsToInstitutions } = require('../lib/nameMatch');
const { stage1Data, renderStage1Html, invalidateFileMeta } = require('../lib/stage1');
const { parseXlsxOffloaded } = require('../lib/xlsxOffload');

/* שם הלקוח (והרשות, כשהיא שונה ממנו) לשמות קבצים שיורדים — ברשות עם כמה
   מפעילים (קריית אונו) שם הרשות לבדו לא מבדיל בין הקבצים */
function downloadWho(client, authority) {
  const c = (client && client.name) || '';
  const a = (authority && authority.name) || '';
  if (c && a && a !== c) return `${c} - ${a}`;
  return c || a || '';
}

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* מטמון פר-דוח לנגזרות היקרות של קובץ המשרד (פענוח 2-3MB בכל בקשה האט
   את כל המסכים) — מתרוקן אוטומטית כשמעלים קובץ חדש לדוח */
const ministryCache = new Map(); // reportId -> { fileName, buf, institutions, schoolTypes, redirect, coordGardens, execGardens }
async function ministryData(db, report) {
  const key = report.id;
  const cached = ministryCache.get(key);
  if (cached && cached.fileName === (report.budget_file_name || '')) return cached;
  const buf = await budgetFileBuf(db, report);
  const entry = { fileName: report.budget_file_name || '', buf, institutions: [], schoolTypes: null, redirect: new Map(), coordGardens: [], execGardens: [], workerSyms: {} };
  if (buf) {
    // פענוח אחד של הקובץ (2-3MB, שניות של CPU) משרת את כל פונקציות החילוץ,
    // ורץ ב-worker thread כדי לא לחסום את שאר המשתמשים; נפילה חזרה לנתיב
    // סינכרוני אם ה-worker לא זמין
    let parsed = null;
    try { parsed = await parseXlsxOffloaded({ mode: 'ministry', framework: report.framework, buf }); } catch { /* סינכרוני */ }
    if (!parsed) {
      let wb = null;
      try { wb = require('xlsx').read(buf, { type: 'buffer' }); } catch { /* קובץ פגום — ננסה פר פונקציה */ }
      const src = wb || buf;
      parsed = { institutions: [], schoolTypes: null, coordGardens: [], execGardens: [], workerSyms: {} };
      try { parsed.workerSyms = extractWorkerAssignments(src); } catch { /* בלי שיוכים */ }
      try { parsed.institutions = extractInstitutions(src); } catch { /* בלי רשימה */ }
      if (report.framework !== 'gardens') {
        try { parsed.schoolTypes = extractSchoolStaffTypes(src); } catch { /* ברירת מחדל */ }
      } else {
        try { parsed.coordGardens = extractCoordinatorGardens(src); } catch { /* ריק */ }
        try { parsed.execGardens = extractExecGardens(src); } catch { /* ריק */ }
      }
    }
    entry.institutions = parsed.institutions || [];
    entry.schoolTypes = parsed.schoolTypes || null;
    entry.coordGardens = parsed.coordGardens || [];
    entry.execGardens = parsed.execGardens || [];
    entry.workerSyms = parsed.workerSyms || {};
    // בתי ספר מאוחדים: הסמל הרשמי מפנה לסמל שבו מתקיימת הפעילות
    entry.redirect = new Map(entry.institutions.filter((i) => i.activitySymbol).map((i) => [String(i.symbol), String(i.activitySymbol)]));
  }
  ministryCache.set(key, entry);
  return entry;
}

/* קובץ המשרד השמור של הדוח: מהדיסק אם קיים, אחרת מהמסד (הדיסק בענן מתאפס
   בכל פריסה — העותק במסד הוא הקבוע). כשמשחזרים מהמסד כותבים גם לדיסק. */
async function budgetFileBuf(db, report) {
  if (report.budget_file_path && fs.existsSync(report.budget_file_path)) {
    return fs.readFileSync(report.budget_file_path);
  }
  const row = await db.prepare('SELECT data FROM report_files WHERE report_id = ?').get(report.id);
  if (!row || !row.data) return null;
  const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const p = path.join(UPLOADS_DIR, `report_${report.id}_budget.xlsx`);
    fs.writeFileSync(p, buf);
    await db.prepare('UPDATE reports SET budget_file_path = ? WHERE id = ?').run(p, report.id);
  } catch { /* נמשיך מהזיכרון */ }
  return buf;
}

const VALID_PROGRAMS = ['base15', 'extension', 'base'];
const VALID_STATUS = ['draft', 'in_progress', 'blocked', 'ready', 'submitted'];

const createSchema = z.object({
  client_id: z.number().int(),
  authority_id: z.number().int().nullable().optional(),
  framework: z.enum(FRAMEWORKS),
  program: z.enum(VALID_PROGRAMS).optional(),
  extension_days: z.number().int().min(0).max(60).optional(),
});

const updateSchema = z.object({
  status: z.enum(VALID_STATUS).optional(),
  extension_days: z.number().int().min(0).max(60).optional(),
  has_cost_report: z.boolean().optional(),
  has_ledger: z.boolean().optional(),
  has_participants: z.boolean().optional(),
});

router.post('/', ah(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(', ') });
  const d = parsed.data;
  const db = getDB();
  if (!(await db.prepare('SELECT id FROM clients WHERE id = ?').get(d.client_id))) return res.status(404).json({ error: 'לקוח לא נמצא' });
  // מכינות = תוכנית base; אחרת ברירת מחדל base15
  const program = d.framework === 'prep' ? 'base' : (d.program || 'base15');
  // ימי הפעלה נתונים לעריכה בכל תוכנית (רעות 16.9); ברירות מחדל: 15 יום / 6 להרחבה
  const days = d.extension_days ?? (program === 'extension' ? 6 : 15);
  const r = await db.prepare(
    'INSERT INTO reports (client_id, authority_id, framework, program, extension_days) VALUES (?, ?, ?, ?, ?)'
  ).run(d.client_id, d.authority_id ?? null, d.framework, program, days);
  res.status(201).json(shapeReport(await db.prepare('SELECT * FROM reports WHERE id = ?').get(r.lastInsertRowid)));
}));

router.get('/:id', ah(async (req, res) => {
  const db = getDB();
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(parseInt(req.params.id));
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(report.client_id);
  const authority = report.authority_id ? await db.prepare('SELECT * FROM authorities WHERE id = ?').get(report.authority_id) : null;
  const institutions = await db.prepare('SELECT * FROM institutions WHERE report_id = ? ORDER BY symbol').all(report.id);
  res.json({ ...shapeReport(report), client: client ? { ...client, has_vat: !!client.has_vat } : null, authority, institutions, health: await reportHealth(db, report) });
}));

router.put('/:id', ah(async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(', ') });
  const db = getDB();
  const id = parseInt(req.params.id);
  const cur = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'דוח לא נמצא' });
  const d = parsed.data;
  const next = {
    status: d.status ?? cur.status,
    extension_days: d.extension_days ?? cur.extension_days,
    has_cost_report: d.has_cost_report != null ? (d.has_cost_report ? 1 : 0) : cur.has_cost_report,
    has_ledger: d.has_ledger != null ? (d.has_ledger ? 1 : 0) : cur.has_ledger,
    has_participants: d.has_participants != null ? (d.has_participants ? 1 : 0) : cur.has_participants,
  };
  await db.prepare('UPDATE reports SET status = ?, extension_days = ?, has_cost_report = ?, has_ledger = ?, has_participants = ? WHERE id = ?')
    .run(next.status, next.extension_days, next.has_cost_report, next.has_ledger, next.has_participants, id);
  res.json(shapeReport(await db.prepare('SELECT * FROM reports WHERE id = ?').get(id)));
}));

/* ---------- דוח העלות המאוחד של הדוח: כל השורות שנותבו אליו (מכל הקבצים) + בקרות ---------- */
router.get('/:id/costs', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  res.json(await costDataForReport(db, report));
}));

/* ---------- העלאת דוח הביצוע של המשרד → בניית התקציב אוטומטית (§9) ---------- */
router.post('/:id/budget-file', upload.single('file'), ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  if (!req.file) return res.status(400).json({ error: 'לא צורף קובץ' });

  let parsed;
  try { parsed = parseBudgetFile(req.file.buffer, { program: report.program, extensionDays: report.extension_days }); }
  catch { return res.status(422).json({ error: 'לא הצלחתי לקרוא את קובץ דוח הביצוע.' }); }
  if (parsed.error) return res.status(422).json({ error: parsed.error });
  if (!parsed.institutions.length) {
    if (parsed.schoolsNotComputed) {
      return res.status(422).json({ error: 'לשונית "תקצוב לפי מוסד" בקובץ לא חושבה (אין סמלי מוסדות — הנוסחאות קפואות). יש לפתוח את הקובץ ב-Excel, לוודא שנבחרה הרשות בגיליון "נתונים כלליים", להקיש Ctrl+Alt+F9 לשמור — ולהעלות שוב.' });
    }
    return res.status(422).json({ error: 'לא נמצאו מוסדות עם תקציב מחושב בקובץ. ודאי שכמות הילדים מולאה ב"מצבת והרשמה" ושהקובץ נשמר ב-Excel.' });
  }

  // גנים: כשבקרת הזכאות בקובץ איפסה את תקציב הרכזות אך יש גנים מסומנים
  // בלשונית "רכזות גנים - דוח ביצוע" — תקציב הריכוז = מס' הגנים × התעריף לגן
  if (report.framework === 'gardens') {
    const inst0 = parsed.institutions[0];
    if (inst0 && !(inst0.baskets.coordinator > 0) && inst0.coordRatePerGarden > 0) {
      try {
        const cg = extractCoordinatorGardens(req.file.buffer);
        if (cg.length) {
          // בהרחבה גן שעבד 6 מתוך 7 ימים נספר יחסית (6/7) — כמו בקובץ המשרד
          let eligible = cg.length;
          try {
            const XLSX2 = require('xlsx');
            const exec = parseGardenExecKids(XLSX2.read(req.file.buffer, { type: 'buffer' }));
            if (exec && exec.daysBySymbol) eligible = cg.reduce((s, sym) => s + (exec.daysBySymbol[String(sym)] ?? 1), 0);
          } catch { /* בלי יחס ימים — ספירה מלאה */ }
          const add = Math.round(eligible * inst0.coordRatePerGarden * 100) / 100;
          inst0.baskets.coordinator = add;
          inst0.total = (inst0.total || 0) + add;
        }
      } catch { /* בלי הלשונית — נשאר כפי שחישב המשרד */ }
    }
  }

  // כל המוסדות עם תקציב 0 — הקובץ נקרא, אבל האקסל של המשרד חישב זכאות אפס.
  const allZero = parsed.institutions.every((i) => !(i.total > 0));
  if (allZero) {
    const reasons = [];
    if (parsed.institutions.some((i) => i.staffingInvalid))
      reasons.push('גיליון "איוש משרות" לא מולא — המשרד מסמן "לא תקין" ומאפס את הזכאות');
    // רק כשבקובץ רשום במפורש 0 ימים (null = בתבנית הזו אין שדה כזה — לא מציפים סתם)
    if (parsed.institutions.some((i) => i.days === 0))
      reasons.push('ימי הפעילות לא מולאו (0 ימים)');
    if (parsed.institutions.some((i) => i.afterControlZero))
      reasons.push(`כמות הילדים דווחה (${parsed.institutions.find((i) => i.afterControlZero)?.reported ?? '?'}) אך "תלמידים לתקצוב לאחר בקרת איוש" = 0 — כנראה גיליון "איוש משרות" לא הושלם בקובץ`);
    else if (parsed.institutions.some((i) => i.reported > 0 && !(i.eligibleReg > 0 || i.eligibleSpec > 0)))
      reasons.push('כמות הילדים דווחה אך הזכאים לאחר בקרה = 0');
    if (!reasons.length) reasons.push('ייתכן שהקובץ לא חושב מחדש — לפתוח ב-Excel, ללחוץ Ctrl+Alt+F9 ולשמור');
    return res.status(422).json({
      error: `הקובץ נקרא (${parsed.institutions.length} מוסדות, ${parsed.authority || 'רשות לא זוהתה'}), אבל המשרד חישב בו תקציב 0 לכל המוסדות. סיבות בקובץ: ${reasons.join(' · ')}. יש להשלים את הנתונים בקובץ המשרד ולהעלות שוב.`,
    });
  }

  // החלפת המוסדות של הדוח (מוחקים סלים/תנועות ישנים תחילה)
  const oldInst = (await db.prepare('SELECT id FROM institutions WHERE report_id = ?').all(id)).map((r) => r.id);
  for (const iid of oldInst) {
    const bids = (await db.prepare('SELECT id FROM baskets WHERE institution_id = ?').all(iid)).map((b) => b.id);
    for (const bid of bids) await db.prepare('DELETE FROM transactions WHERE basket_id = ?').run(bid);
    await db.prepare('DELETE FROM baskets WHERE institution_id = ?').run(iid);
  }
  await db.prepare('DELETE FROM institutions WHERE report_id = ?').run(id);

  for (const inst of parsed.institutions) {
    // קבצי המשרד מחשבים לעיתים זכאים כמספר עשרוני (אחוז בקרה × ילדים) —
    // עמודות הילדים במסד הן מספרים שלמים, מעגלים
    const reg = Math.round(inst.eligibleReg || 0), spec = Math.round(inst.eligibleSpec || 0);
    const st = inst.staffing || {};
    const iid = (await db.prepare(
      `INSERT INTO institutions (report_id, symbol, name, size_type, children_count, children_regular, children_special, budget_total, actual_total,
        staff_coord_reported, staff_dep_reported, staff_coord_budget, staff_dep_budget, payment_total, payment_aides, payment_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      // תקציב וניצול לתצוגה — משורת "סה"כ נטו" של הקובץ כשקיימת (כלל רעות 16.9)
    ).run(id, inst.symbol, inst.name || '', inst.size || 'small', reg + spec, reg, spec,
      (inst.totalNet != null && inst.totalNet > 0 ? inst.totalNet : inst.total) || 0,
      (inst.netActual != null ? inst.netActual : inst.totalActual) || 0,
      st.coordReported || 0, st.depReported || 0, st.coordBudget || 0, st.depBudget || 0,
      inst.paymentTotal ?? null, inst.paymentAides ?? null, inst.paymentNote ?? null)).lastInsertRowid;
    for (const [type, amount] of Object.entries(inst.baskets || {})) {
      if (amount > 0) await db.prepare('INSERT INTO baskets (institution_id, basket_type, budget_amount) VALUES (?, ?, ?)').run(iid, type, amount);
    }
  }

  // שומרים את קובץ המשרד בדיסק — ממלאים אותו בחזרה בייצוא (§9);
  // ב-Cloudflare Workers אין דיסק — העותק במסד (report_files) הוא המקור
  let savedPath = null;
  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    savedPath = path.join(UPLOADS_DIR, `report_${id}_budget.xlsx`);
    fs.writeFileSync(savedPath, req.file.buffer);
  } catch { savedPath = null; }
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

  // דוח הביצוע מספק את כמות המשתתפים; התעריף לילד מחולץ ללשונית ההכנסות
  const tariff = extractTariff(req.file.buffer) || 0;
  await db.prepare('UPDATE reports SET has_participants = 1, budget_file_name = ?, budget_file_path = ?, parent_tariff = ? WHERE id = ?')
    .run(originalName, savedPath, tariff, id);
  // עותק קבוע במסד — שורד את איפוס הדיסק של הענן בכל פריסה
  await db.prepare('DELETE FROM report_files WHERE report_id = ?').run(id);
  await db.prepare('INSERT INTO report_files (report_id, data) VALUES (?, ?)').run(id, req.file.buffer);
  ministryCache.delete(id); // הקובץ התחלף — הנגזרות ייבנו מחדש
  invalidateFileMeta(id); // גם המטמון של מחולל המכתב

  // החוק של רעות (16.9): שיוכי סמל/תפקיד שהלקוח מילא בלשונית כח האדם
  // של הקובץ מוחלים מיד על שורות הדוח — בלי עבודה חוזרת ובלי לבקש
  let assignApplied = 0;
  try { assignApplied = await applyFileAssignments(db, id, req.file.buffer); } catch { /* אין לשונית/שיוכים */ }

  const totalBudget = parsed.institutions.reduce((s, i) => s + (i.total || 0), 0);
  const fallbackInst = parsed.institutions.find((i) => i.ratesFallback);
  res.status(201).json({
    assignmentsApplied: assignApplied,
    authority: parsed.authority,
    institutions: parsed.institutions.length,
    totalBudget,
    warning: fallbackInst
      ? `שימי לב: בקובץ המשרד "בקרת האיוש" איפסה את חישוב התקציב, ולכן המערכת חישבה אותו לבד — ${fallbackInst.eligibleReg?.toLocaleString('he-IL')} ילדים בהרשמה × התעריף לילד שבקובץ. כדאי להשלים את גיליון "איוש משרות" בקובץ ולרענן, אך אפשר להמשיך לעבוד כרגיל.`
      : undefined,
    health: await reportHealth(db, await db.prepare('SELECT * FROM reports WHERE id = ?').get(id)),
  });

  // חימום המטמון ברקע, אחרי שהתשובה כבר נשלחה: הפותחת הראשונה של מסך
  // ההכנה לא תספוג את פענוח הקובץ הקר (שניות) — הוא ייבנה עכשיו
  setImmediate(async () => {
    try {
      const fresh = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
      if (fresh) await ministryData(db, fresh);
    } catch { /* חימום בלבד — כישלון לא מפריע לעבודה */ }
  });
}));

/* הורדת קובץ דוח הביצוע השמור (המקור שהועלה) */
router.get('/:id/budget-file', ah(async (req, res) => {
  const db = getDB();
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(parseInt(req.params.id));
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  const buf = await budgetFileBuf(db, report);
  if (!buf) return res.status(404).json({ error: 'לדוח זה עדיין לא הועלה קובץ דוח ביצוע.' });
  const bfClient = await db.prepare('SELECT name FROM clients WHERE id = ?').get(report.client_id);
  const bfAuthority = report.authority_id ? await db.prepare('SELECT name FROM authorities WHERE id = ?').get(report.authority_id) : null;
  const name = `${downloadWho(bfClient, bfAuthority)} - ${report.budget_file_name || `budget_${report.id}.xlsx`}`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="budget_${report.id}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(buf);
}));

/* ---------- תקציב הדוח: מוסדות + תקציב מול ניצול ---------- */
router.get('/:id/budget', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  const institutions = await db.prepare('SELECT * FROM institutions WHERE report_id = ? ORDER BY symbol').all(id);
  const cost = await costDataForReport(db, report);
  const totalBudget = institutions.reduce((s, i) => s + (Number(i.budget_total) || 0), 0);
  const totalActual = cost.summary.totalCost;
  const out = [];
  for (const i of institutions) {
    out.push({
      symbol: i.symbol, name: i.name, size: i.size_type,
      children: i.children_count, childrenRegular: i.children_regular, childrenSpecial: i.children_special,
      budget: i.budget_total,
      baskets: await db.prepare('SELECT basket_type, budget_amount FROM baskets WHERE institution_id = ?').all(i.id),
    });
  }
  res.json({ institutions: out, totalBudget, totalActual, underUtilization: Math.max(0, totalBudget - totalActual) });
}));

/* ---------- הכנת דוח הביצוע (§9): שיוך עובד → גן/מוסד + איש צוות + תפקיד ---------- */
router.get('/:id/prep', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const t0 = Date.now();
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });

  // רשימת המוסדות מקובץ המשרד השמור (מצבת והרשמה) — לבחירת סמל מקום פעילות
  const md = await ministryData(db, report);
  const tMinistry = Date.now();
  const institutions = md.institutions;
  const prepBuf = md.buf;
  const validSymbols = new Set(institutions.map((i) => i.symbol));
  const toActivity = (s) => (s ? (md.redirect.get(String(s)) || s) : s);

  const rawRows = await db.prepare(
    `SELECT cr.id, cr.emp_id, cr.emp_name, cr.first_name, cr.last_name, cr.dept,
            cr.inst_symbol, cr.inst_name, cr.symbol_override, cr.staff_type, cr.role,
            cr.gross, cr.cost, cr.hours, cr.gross_bump, cr.manual_rates
     FROM cost_rows cr WHERE cr.report_id = ? ORDER BY cr.dept, cr.emp_name`
  ).all(id);

  // הצעת סמל: שם הגן/בי"ס שבשורת העובד מול לשונית ההרשמה, ובבתי"ס גם לפי שם המחלקה
  let deptSymbol = {};
  let nameSymbol = {};
  if (institutions.length) {
    nameSymbol = matchDeptsToInstitutions(institutions, [...new Set(rawRows.map((r) => r.inst_name).filter(Boolean))]);
    if (report.framework !== 'gardens') {
      deptSymbol = matchDeptsToInstitutions(institutions, [...new Set(rawRows.map((r) => r.dept))]);
    }
  }

  const isSchools = report.framework !== 'gardens';
  const schoolTypes = isSchools ? md.schoolTypes : null;
  // הסמל הפעיל של שורה — משמש גם לתצוגה וגם לקיבוץ פר בי"ס
  const prepSymOf = (r) => {
    const wsA = md.workerSyms && md.workerSyms[String(r.emp_id || '').replace(/\D/g, '')];
    // בלי קובץ משרד (validSymbols ריק) אין מול מה לאמת — מציגים את הסמל
    // שנקלט מדוח העלות כמו שהוא במקום לספור את כולם כ"חסרים" (אלעד-מכינות)
    const fileSymbol = r.inst_symbol && (validSymbols.size === 0 || validSymbols.has(String(r.inst_symbol))) ? String(r.inst_symbol) : null;
    const uploadedSymbol = wsA && validSymbols.has(wsA.symbol) ? wsA.symbol : null;
    return toActivity(r.symbol_override || fileSymbol || uploadedSymbol || (r.inst_name && nameSymbol[r.inst_name]) || deptSymbol[r.dept] || null);
  };
  // כלל רעות 16.9 (בתי"ס): רכז אחד לכל היותר בבי"ס, סגן 0 או 1 —
  // מסווגי-שעות עודפים יורדים למורה
  const demotedPrep = new Set();
  if (isSchools) {
    const bySchool = new Map();
    for (const r of rawRows) {
      const s = String(prepSymOf(r) || '');
      if (!bySchool.has(s)) bySchool.set(s, []);
      bySchool.get(s).push(r);
    }
    const capPrep = coordHoursCapFor(report);
    for (const g of bySchool.values()) for (const id of demoteExtraSchoolRoles(g, capPrep)) demotedPrep.add(id);
  }
  const rows = rawRows.map((r) => {
    const sug = suggestRole(r.dept);
    // בתי ספר: רכז/סגן מזוהים לפי שעות (מעל 93 = רכז, 90-93 = סגן) —
    // המשרד מציג את תקציב בית הספר רק כשמוגדר רכז בכל סמל
    const byHours = isSchools && !demotedPrep.has(r.id) ? schoolsRoleByHours(r.hours) : null;
    // שיוך שמולא בקובץ שהועלה (ת"ז): בגנים קודם לניחוש; בבתי"ס כלל השעות גובר
    const wsA = md.workerSyms && md.workerSyms[String(r.emp_id || '').replace(/\D/g, '')];
    let stVal = demotedPrep.has(r.id) ? 'מורה'
      : isSchools
        ? (r.staff_type || (byHours && byHours.staffType) || (wsA && wsA.staffType) || sug.staffType)
        : (r.staff_type || (wsA && wsA.staffType) || sug.staffType);
    let roleVal = demotedPrep.has(r.id) ? 'מורה'
      : isSchools
        ? (r.role || (byHours && byHours.role) || (wsA && wsA.role) || sug.role)
        : (r.role || (wsA && wsA.role) || sug.role);
    // בתי"ס בלי שום סיווג (עמודת התפקיד בדוח העלות ריקה) — ברירת מחדל
    // "מורה" עם תפקיד לפי מדרגת הברוטו השעתי (כלל רעות 22.9, גוש עציון)
    if (isSchools && !stVal) ({ staffType: stVal, role: roleVal } = defaultSchoolsStaff(r.gross != null && r.hours ? r.gross / r.hours : 0));
    if (isSchools) ({ staffType: stVal, role: roleVal } = mapSchoolsStaff(stVal, roleVal, schoolTypes));
    else if (stVal) ({ staffType: stVal, role: roleVal } = mapGardensStaff(stVal, roleVal));
    return {
      rowId: r.id, empId: r.emp_id, name: r.emp_name,
      firstName: r.first_name, lastName: r.last_name, dept: r.dept, instName: r.inst_name,
      symbol: prepSymOf(r),
      staffType: stVal,
      role: roleVal,
      saved: !!(r.symbol_override || r.staff_type || r.role),
      gross: r.gross, cost: r.cost, hours: r.hours,
      hourlyGross: r.gross != null && r.hours ? r.gross / r.hours : null,
      hourlyCost: r.cost != null && r.hours ? r.cost / r.hours : null,
      // תעריפים ידניים: מסומן במסך + מאפשר שחזור לערכי דוח העלות
      manualRates: r.manual_rates ? (() => { try { return JSON.parse(r.manual_rates); } catch { return null; } })() : null,
    };
  });

  // הבדיקות רצות במקביל — כל אחת עושה כמה סבבי-רשת ל-DB בענן
  const tRows = Date.now();
  const [client, authority, salaryRes, recsRes] = await Promise.all([
    db.prepare('SELECT name, has_vat FROM clients WHERE id = ?').get(report.client_id),
    report.authority_id ? db.prepare('SELECT name FROM authorities WHERE id = ?').get(report.authority_id) : null,
    salaryCheck(db, report),
    recommendations(db, report),
  ]);
  // תזמון שלבים — לאיתור צוואר הבקבוק בטעינה קרה (משימות הביצועים)
  if (Date.now() - t0 > 3000) {
    console.log(`[prep ${id}] ${Date.now() - t0}ms סה"כ | קובץ משרד ${tMinistry - t0}ms | שורות ${tRows - tMinistry}ms | בדיקות ${Date.now() - tRows}ms`);
  }

  // מועמדים להתאמת ברוטו (עד 5 ₪ לשעה): העלות המוכרת חורגת מ-140% מהברוטו,
  // והגדלה קטנה של הברוטו מיישרת את בקרת המשרד בלי לוותר על הכרה בעלות
  const vatF = client && client.has_vat ? 1.18 : 1;
  const bumps = rawRows
    .map((r) => {
      if (!(r.gross > 0 && r.hours > 0 && r.cost != null)) return null;
      const hourlyGross = r.gross / r.hours;
      const hourlyCostVat = (r.cost / r.hours) * vatF;
      const needed = hourlyCostVat / COST_MARKUP_LIMIT - hourlyGross;
      if (!(needed > 0.01 && needed <= 5)) return null;
      return {
        rowId: r.id, name: r.emp_name || '', dept: r.dept,
        hourlyGross: Math.round(hourlyGross * 100) / 100,
        hourlyCostVat: Math.round(hourlyCostVat * 100) / 100,
        bump: Math.ceil(needed * 100) / 100,
        applied: (Number(r.gross_bump) || 0) > 0,
      };
    })
    .filter(Boolean);

  res.json({
    rows, institutions,
    staffTypes: isSchools ? (schoolTypes || SCHOOL_STAFF_TYPES) : STAFF_TYPES,
    employer: (authority && authority.name) || (client && client.name) || '',
    hasBudgetFile: !!prepBuf,
    budgetFileName: report.budget_file_name || null,
    salary: salaryRes,
    framework: report.framework,
    recommendations: recsRes,
    bumps,
  });
}));

/* שיוך אוטומטי מלא (גנים): מחלק את העובדים שטרם שויכו בין סמלי הגנים
   מלשונית "גנים - דוח ביצוע", כך שבכל גן תהיה גננת וסייעת — ובקרת
   "איוש משרות" של המשרד תעבור. מופעל רק בלחיצה מפורשת של המשתמשת. */
router.post('/:id/auto-assign', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  const aaMd = await ministryData(db, report);
  if (!aaMd.buf) return res.status(422).json({ error: 'אין קובץ דוח ביצוע שמור — יש להעלות קודם את קובץ המשרד.' });

  /* בתי ספר: (א) עובדים לא-משויכים (למשל מחלקת "מילוי מקום") משובצים בין
     בתי הספר לפי היתרות — שכר + סל גמיש פנויים; (ב) בכל בי"ס בלי רכז,
     העובד/ת עם הכי הרבה שעות מקודם/ת לרכז/ת. */
  if (report.framework !== 'gardens') {
    const insts2 = await db.prepare('SELECT id, symbol FROM institutions WHERE report_id = ?').all(id);
    if (!insts2.length) return res.status(422).json({ error: 'אין מוסדות לדוח — יש להעלות קודם את קובץ המשרד.' });
    const client2 = await db.prepare('SELECT has_vat FROM clients WHERE id = ?').get(report.client_id);
    const vatF = client2 && client2.has_vat ? 1.18 : 1;
    const { recognizedRowCost } = require('../lib/ingest');

    const rows2 = await db.prepare('SELECT * FROM cost_rows WHERE report_id = ?').all(id);
    const nameSym = aaMd.institutions.length
      ? matchDeptsToInstitutions(aaMd.institutions, [...new Set(rows2.map((r) => r.inst_name).filter(Boolean))]) : {};
    // גם לפי שם המחלקה — כמו במסך ההכנה ובייצוא; בלעדיו עובדים עם מחלקה
    // ברורה ("ביהס של החופש הרצוג") נראו "לא משויכים" ופוזרו לפי יתרות
    const deptSym = aaMd.institutions.length
      ? matchDeptsToInstitutions(aaMd.institutions, [...new Set(rows2.map((r) => r.dept))]) : {};
    const validS = new Set(insts2.map((i) => String(i.symbol)));
    const symOf = (r) => {
      const s = r.symbol_override
        || (r.inst_symbol && validS.has(String(r.inst_symbol)) ? String(r.inst_symbol) : null)
        || (r.inst_name && nameSym[r.inst_name])
        || deptSym[r.dept] || null;
      return s ? (aaMd.redirect.get(String(s)) || s) : null;
    };

    // תקציב שכר+גמיש פר בי"ס, פחות הניצול המוכר הנוכחי → יתרה לשיבוץ
    const slack = new Map();
    for (const i of insts2) {
      const b = await db.prepare(
        "SELECT COALESCE(SUM(budget_amount),0) a FROM baskets WHERE institution_id = ? AND basket_type IN ('instruction','coordinator','deputy','flexible')"
      ).get(i.id);
      slack.set(String(i.symbol), Number(b.a) || 0);
    }
    const bySchool = new Map();
    const unplaced = [];
    for (const r of rows2) {
      const s = symOf(r);
      if (s) {
        if (slack.has(s)) slack.set(s, slack.get(s) - recognizedRowCost(r, vatF));
        if (!bySchool.has(s)) bySchool.set(s, []);
        bySchool.get(s).push(r);
      } else unplaced.push(r);
    }
    // שיבוץ לפי יתרות: היקרים קודם, כל אחד לבי"ס עם היתרה הגדולה ביותר
    let placed = 0;
    unplaced.sort((a, b) => recognizedRowCost(b, vatF) - recognizedRowCost(a, vatF));
    const updates2 = [];
    for (const r of unplaced) {
      let best = null;
      for (const [sym, s] of slack) if (!best || s > slack.get(best)) best = sym;
      if (!best) break;
      updates2.push([r.id, best]);
      slack.set(best, slack.get(best) - recognizedRowCost(r, vatF));
      if (!bySchool.has(best)) bySchool.set(best, []);
      bySchool.get(best).push(r);
      placed++;
    }
    for (let i = 0; i < updates2.length; i += 10) {
      await Promise.all(updates2.slice(i, i + 10).map(([rid, sym]) =>
        db.prepare('UPDATE cost_rows SET symbol_override = ? WHERE id = ?').run(sym, rid)));
    }

    const isCoord = (r) => {
      const st = r.staff_type || (schoolsRoleByHours(r.hours) || {}).staffType;
      return st === 'רכזת תכנית בבית הספר';
    };
    let promoted = 0;
    for (const [, list] of bySchool) {
      if (list.some(isCoord)) continue;
      const pick = list.slice().sort((a, b) => (b.hours || 0) - (a.hours || 0) || (b.cost || 0) - (a.cost || 0))[0];
      if (!pick) continue;
      await db.prepare("UPDATE cost_rows SET staff_type = 'רכזת תכנית בבית הספר', role = 'רכז/ת תכנית בבית הספר' WHERE id = ?").run(pick.id);
      promoted++;
    }
    return res.json({ ok: true, assigned: placed + promoted, placed, promoted, gardens: bySchool.size, mode: 'schools' });
  }

  let gardens = aaMd.execGardens.length ? aaMd.execGardens : aaMd.institutions.map((i) => i.symbol);
  if (!gardens.length) return res.status(422).json({ error: 'לא נמצאו סמלי גנים בלשונית "גנים - דוח ביצוע" של הקובץ.' });

  const rows = await db.prepare('SELECT * FROM cost_rows WHERE report_id = ?').all(id);
  const exNameSymbol = aaMd.institutions.length
    ? matchDeptsToInstitutions(aaMd.institutions, [...new Set(rows.map((r) => r.inst_name).filter(Boolean))])
    : {};
  const validSet = new Set(gardens);
  // התפקיד/סמל שמולאו בקובץ הביצוע שהועלה (ת"ז→שיוך) — מקור אמת לפני כל
  // ניחוש: השיוך האוטומטי מאמץ אותם ולא ממציא "גננת" (לקח יבנה, 16.9)
  const fileAssignOf = (r) => (aaMd.workerSyms && aaMd.workerSyms[String(r.emp_id || '').replace(/\D/g, '')]) || null;
  const symbolOf = (r) => r.symbol_override
    || (r.inst_symbol && validSet.has(String(r.inst_symbol)) ? String(r.inst_symbol) : null)
    || (() => { const a = fileAssignOf(r); return a && validSet.has(a.symbol) ? a.symbol : null; })()
    || (r.inst_name && exNameSymbol[r.inst_name]) || null;
  const staffOf = (r) => r.staff_type || (fileAssignOf(r) || {}).staffType || suggestRole(r.dept).staffType || 'גננת';

  // סימון רכזות גן: מספר המשרות נגזר מלשונית "רכזות גנים - דוח ביצוע"
  // (רכזת אחת לכל 5 גנים, 0.2 משרה לגן); המועמדות — כ-90 שעות והברוטו
  // השעתי הגבוה ביותר, מבין עובדות ללא תפקיד שמור. הרכזת מקבלת גם סמל גן
  // כרגיל (לא משנה איזה) — היא נספרת באיוש הגן ואינה גורעת גננת/סייעת
  const coordPositions = aaMd.coordGardens.length ? Math.ceil(aaMd.coordGardens.length / 5) : 0;
  let coordDesignated = 0;
  if (coordPositions > 0) {
    // רכזות שהקובץ שהועלה כבר מסמן נספרות כקיימות — לא ממנים חדשות במקומן
    const existing = rows.filter((r) => /רכזת גן/.test(String(r.staff_type || (fileAssignOf(r) || {}).staffType || ''))).length;
    const need = coordPositions - existing;
    if (need > 0) {
      // מועמדות: בלי תפקיד שמור (במסד או בקובץ), או עם ברירת המחדל "גננת";
      // תפקיד אחר שנקבע במפורש (סייעת, מדצ...) לא נדרס
      const cands = rows
        .filter((r) => { const eff = r.staff_type || (fileAssignOf(r) || {}).staffType; return (!eff || norm(eff) === 'גננת') && r.hours >= 85 && r.hours <= 95 && r.gross > 0
          && !/סייע/.test(String(suggestRole(r.dept).staffType || '')); })
        .sort((a, b) => (a.staff_type ? 1 : 0) - (b.staff_type ? 1 : 0) || (b.gross / b.hours) - (a.gross / a.hours));
      for (const r of cands.slice(0, need)) {
        r.staff_type = 'רכזת גן'; r.role = 'רכז/ת גן'; // גם בזיכרון — להמשך השיבוץ
        await db.prepare("UPDATE cost_rows SET staff_type = 'רכזת גן', role = 'רכז/ת גן' WHERE id = ?").run(r.id);
        coordDesignated++;
      }
    }
  }

  // ספירת האיוש הקיים פר גן
  const staffed = new Map(gardens.map((g) => [g, { gan: 0, say: 0 }]));
  const unassigned = [];
  for (const r of rows) {
    const sym = symbolOf(r);
    const st = staffOf(r);
    // כלל רעות 24.9: רכזת גן אינה צריכה שיוך לסמל — לא מחלקים לה גן
    if (/רכזת גן/.test(String(st || ''))) continue;
    const kind = /סייע/.test(st) ? 'say' : /גננת|מוביל/.test(st) ? 'gan' : null;
    if (sym && staffed.has(sym)) { if (kind) staffed.get(sym)[kind]++; }
    else if (!sym) unassigned.push({ r, kind: kind || 'gan', st });
  }

  // שלב 1: להשלים גננת+סייעת בגנים חסרים; שלב 2: לפזר את היתר מחזורית
  let assigned = 0;
  const takeFor = (need) => {
    const idx = unassigned.findIndex((u) => u.kind === need);
    return idx >= 0 ? unassigned.splice(idx, 1)[0] : null;
  };
  const updates = [];
  for (const g of gardens) {
    const s = staffed.get(g);
    if (s.gan === 0) { const u = takeFor('gan'); if (u) { updates.push([g, u]); s.gan++; } }
    if (s.say === 0) { const u = takeFor('say'); if (u) { updates.push([g, u]); s.say++; } }
  }
  let gi = 0;
  while (unassigned.length) {
    const u = unassigned.shift();
    updates.push([gardens[gi % gardens.length], u]);
    gi++;
  }
  // עדכונים במקביל (בקבוצות) — כל סבב-רשת ל-DB בענן עולה ~50ms
  const CHUNK = 10;
  for (let i = 0; i < updates.length; i += CHUNK) {
    await Promise.all(updates.slice(i, i + CHUNK).map(([g, u]) => {
      const role = u.r.role || (/סייע/.test(u.st) ? 'סייעת' : 'גננת של הגן');
      assigned++;
      return db.prepare('UPDATE cost_rows SET symbol_override = ?, staff_type = COALESCE(staff_type, ?), role = COALESCE(role, ?) WHERE id = ?')
        .run(g, u.st, role, u.r.id);
    }));
  }
  res.json({ ok: true, assigned, gardens: gardens.length, coordinators: coordDesignated, coordPositions });
}));

/* ---------- פיצול שורת עובד/ת בין מוסדות (כלל רעות 17.9: "פיצול שורות
   מותר" — רכז/ת צף/ה מתחלק/ת בין בתי ספר בתוך יתרות סל הריכוז) ----------
   השורה המקורית מקבלת את החלק הראשון; לכל חלק נוסף נוצרת שורה חדשה.
   הפיצול יחסי לעלות: שעות/ברוטו לפי חלק העלות, השארית נספגת בחלק האחרון
   כך שהסכומים סוגרים בדיוק על שורת המקור. hoursTotal מאפשר לקבוע סך
   שעות שונה (תקן רכז 114) — הכספים אינם משתנים. */
const splitSchema = z.object({
  rowId: z.number().int(),
  parts: z.array(z.object({ symbol: z.string().min(1), cost: z.number().positive() })).min(2).max(12),
  hoursTotal: z.number().positive().optional(),
});
router.post('/:id/split-row', ah(async (req, res) => {
  const parsed = splitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'מבנה פיצול לא תקין' });
  const db = getDB();
  const id = parseInt(req.params.id);
  const { rowId, parts, hoursTotal } = parsed.data;
  const src = await db.prepare('SELECT * FROM cost_rows WHERE id = ? AND report_id = ?').get(rowId, id);
  if (!src) return res.status(404).json({ error: 'שורה לא נמצאה בדוח' });
  const totalCost = parts.reduce((s, p) => s + p.cost, 0);
  if (Math.abs(totalCost - (src.cost || 0)) > 1) {
    return res.status(400).json({ error: `סכום החלקים (₪${totalCost.toFixed(2)}) חייב להיות שווה לעלות השורה (₪${(src.cost || 0).toFixed(2)})` });
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  const H = hoursTotal || src.hours || 0;
  // חלוקה יחסית לעלות; החלק האחרון סופג את שאריות העיגול
  const shares = parts.map((p) => p.cost / src.cost);
  const gross = shares.map((f) => r2((src.gross || 0) * f));
  const hours = shares.map((f) => r2(H * f));
  const cost = parts.map((p) => r2(p.cost));
  const last = parts.length - 1;
  gross[last] = r2((src.gross || 0) - gross.slice(0, last).reduce((s, v) => s + v, 0));
  hours[last] = r2(H - hours.slice(0, last).reduce((s, v) => s + v, 0));
  cost[last] = r2((src.cost || 0) - cost.slice(0, last).reduce((s, v) => s + v, 0));

  const createdIds = [];
  for (let i = 1; i < parts.length; i++) {
    const ins = await db.prepare(
      `INSERT INTO cost_rows (cost_file_id, client_id, report_id, emp_id, emp_name, first_name, last_name, dept,
         inst_symbol, inst_name, component_names, gross, cost, hours, staff_type, role, symbol_override)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(src.cost_file_id, src.client_id, id, src.emp_id, src.emp_name, src.first_name, src.last_name, src.dept,
      src.inst_symbol, src.inst_name, src.component_names || '[]', gross[i], cost[i], hours[i],
      src.staff_type, src.role, String(parts[i].symbol));
    createdIds.push(ins.lastInsertRowid);
  }
  await db.prepare('UPDATE cost_rows SET symbol_override = ?, gross = ?, cost = ?, hours = ? WHERE id = ?')
    .run(String(parts[0].symbol), gross[0], cost[0], hours[0], rowId);
  res.json({ ok: true, rowId, createdIds, parts: parts.map((p, i) => ({ symbol: p.symbol, cost: cost[i], gross: gross[i], hours: hours[i] })) });
}));

/* הוספת עובד/ת ידנית לדוח (בקשת רעות 24.9) — למשל עובד/ת בחשבונית שאינו/ה
   בדוח העלות. השורות נשמרות בקובץ וירטואלי "עובדים שנוספו ידנית" של הלקוח,
   ולכן החלפת/מחיקת דוח עלות רגיל אינה נוגעת בהן. */
const MANUAL_FILE_NAME = 'עובדים שנוספו ידנית';
const addWorkerSchema = z.object({
  name: z.string().min(2),
  empId: z.string().optional(),        // ת.ז או ח.פ (חשבונית)
  dept: z.string().optional(),
  symbol: z.string().nullable().optional(),
  staffType: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  hours: z.number().nonnegative().optional(),
  gross: z.number().nonnegative().optional(),
  cost: z.number().nonnegative().optional(), // חשבונית: הסכום = העלות
});
router.post('/:id/workers', ah(async (req, res) => {
  const parsed = addWorkerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'פרטי עובד/ת לא תקינים — נדרש לפחות שם' });
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT id, client_id, framework FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  const w = parsed.data;
  // הקובץ הווירטואלי של הלקוח — נוצר בהוספה הראשונה
  let mf = await db.prepare('SELECT id FROM cost_files WHERE client_id = ? AND filename = ?').get(report.client_id, MANUAL_FILE_NAME);
  if (!mf) {
    mf = { id: (await db.prepare("INSERT INTO cost_files (client_id, filename, software, sheets_used, row_count, routed) VALUES (?, ?, 'ידני', '[]', 0, 1)")
      .run(report.client_id, MANUAL_FILE_NAME)).lastInsertRowid };
  }
  // תפקיד מוצמד לרשימת התבנית של הפרויקט (כלל 23.9)
  const c = clampStaffForFramework(report.framework, w.staffType || null, w.role || null);
  const gross = w.gross ?? w.cost ?? null;
  const cost = w.cost ?? w.gross ?? null;
  const nameParts = w.name.trim().split(/\s+/);
  const ins = await db.prepare(
    `INSERT INTO cost_rows (cost_file_id, client_id, report_id, emp_id, emp_name, first_name, last_name, dept,
       inst_symbol, component_names, gross, cost, hours, staff_type, role, symbol_override)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(mf.id, report.client_id, id, String(w.empId || '').replace(/\D/g, '') || null, w.name.trim(),
    nameParts[0] || null, nameParts.slice(1).join(' ') || null, w.dept || 'הוספה ידנית',
    w.symbol || null, '[]', gross, cost, w.hours ?? null, c.staffType, c.role, w.symbol || null);
  await db.prepare('UPDATE cost_files SET row_count = row_count + 1 WHERE id = ?').run(mf.id);
  await db.prepare('UPDATE reports SET has_cost_report = 1 WHERE id = ?').run(id);
  res.status(201).json({ ok: true, rowId: ins.lastInsertRowid });
}));

/* מחיקת שורת עובד/ת מהדוח (בקשת רעות 24.9) — למשל שורה כפולה או עובד/ת
   שאינו/ה שייך/ת לפרויקט. קליטה מחדש של קובץ העלות תחזיר את השורה. */
router.delete('/:id/cost-rows/:rowId', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const rowId = parseInt(req.params.rowId);
  const row = await db.prepare('SELECT id, emp_name FROM cost_rows WHERE id = ? AND report_id = ?').get(rowId, id);
  if (!row) return res.status(404).json({ error: 'שורה לא נמצאה בדוח' });
  await db.prepare('DELETE FROM cost_rows WHERE id = ?').run(rowId);
  res.json({ ok: true, deleted: row.emp_name || rowId });
}));

/* אישור התאמות ברוטו: מגדיל את הברוטו השעתי בדיוק כדי לעמוד בתקרת ה-140%
   (עד 5 ₪ לשעה — מעבר לזה דורש בדיקה מעמיקה, לא מוצע אוטומטית) */
router.post('/:id/apply-bumps', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT client_id FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  const client = await db.prepare('SELECT has_vat FROM clients WHERE id = ?').get(report.client_id);
  const vatF = client && client.has_vat ? 1.18 : 1;
  const rowIds = (req.body && req.body.rowIds) || [];
  let applied = 0;
  for (const rowId of rowIds) {
    const r = await db.prepare('SELECT id, gross, cost, hours FROM cost_rows WHERE id = ? AND report_id = ?').get(rowId, id);
    if (!r || !(r.gross > 0 && r.hours > 0 && r.cost != null)) continue;
    const needed = ((r.cost / r.hours) * vatF) / COST_MARKUP_LIMIT - r.gross / r.hours;
    if (!(needed > 0 && needed <= 5)) continue;
    await db.prepare('UPDATE cost_rows SET gross_bump = ? WHERE id = ?').run(Math.ceil(needed * 100) / 100, rowId);
    applied++;
  }
  res.json({ ok: true, applied });
}));

const prepSchema = z.object({
  assignments: z.record(z.string(), z.object({
    symbol: z.string().nullable().optional(),
    staffType: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    // תיקון ת.ז לא תקינה (כלל רעות 23.9) — מעדכן את כל שורות העובד ונלמד ללקוח
    empId: z.string().nullable().optional(),
    // תעריפים ידניים (כלל 22.9): מה שבתוכנה קובע — נכתב על השורה עצמה
    hours: z.number().nonnegative().nullable().optional(),
    hourlyGross: z.number().nonnegative().nullable().optional(),
    hourlyCost: z.number().nonnegative().nullable().optional(),
  })),
});

/* עדכון תעריפים ידני לשורה: החדש נכתב על gross/cost/hours (כל המערכת —
   מכתב, בקרות, ייצוא — רואה אותו), והמקור נשמר ב-manual_rates לשחזור.
   שלושת השדות null = ביטול העריכה ושחזור ערכי דוח העלות. */
async function applyManualRates(db, reportId, rowId, a) {
  if (a.hours === undefined && a.hourlyGross === undefined && a.hourlyCost === undefined) return false;
  const r = await db.prepare('SELECT id, gross, cost, hours, manual_rates FROM cost_rows WHERE id = ? AND report_id = ?').get(rowId, reportId);
  if (!r) return false;
  const prev = r.manual_rates ? JSON.parse(r.manual_rates) : null;
  const orig = prev ? prev.orig : { gross: r.gross, cost: r.cost, hours: r.hours };
  const clearing = a.hours == null && a.hourlyGross == null && a.hourlyCost == null;
  if (clearing) {
    if (!prev) return false;
    await db.prepare('UPDATE cost_rows SET gross = ?, cost = ?, hours = ?, manual_rates = NULL WHERE id = ?')
      .run(orig.gross, orig.cost, orig.hours, r.id);
    return true;
  }
  // ברירת המחדל לכל ערך שלא נערך — התעריף הנוכחי בשורה (שעתי מהמקור)
  const curHours = r.hours || orig.hours || 0;
  const curHG = curHours > 0 && r.gross != null ? r.gross / curHours : null;
  const curHC = curHours > 0 && r.cost != null ? r.cost / curHours : null;
  const hours = a.hours != null ? a.hours : curHours;
  const hg = a.hourlyGross != null ? a.hourlyGross : curHG;
  const hc = a.hourlyCost != null ? a.hourlyCost : curHC;
  const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
  await db.prepare('UPDATE cost_rows SET gross = ?, cost = ?, hours = ?, manual_rates = ? WHERE id = ?')
    .run(r2(hg != null ? hg * hours : r.gross), r2(hc != null ? hc * hours : r.cost), hours,
      JSON.stringify({ orig, set: { hours: a.hours ?? null, hourlyGross: a.hourlyGross ?? null, hourlyCost: a.hourlyCost ?? null } }), r.id);
  return true;
}

router.put('/:id/prep', ah(async (req, res) => {
  const parsed = prepSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'מבנה שיוך לא תקין' });
  const db = getDB();
  const id = parseInt(req.params.id);
  const putReport = await db.prepare('SELECT id, framework FROM reports WHERE id = ?').get(id);
  if (!putReport) return res.status(404).json({ error: 'דוח לא נמצא' });
  // עדכון ישיר עם תנאי report_id (בלי SELECT מקדים) ובמקביל בקבוצות —
  // כל סבב-רשת ל-DB בענן עולה ~50ms, ושמירת 90 שיוכים לקחה שניות
  let updated = 0;
  const entries = Object.entries(parsed.data.assignments);
  // כלל רעות 23.9: התפקידים אך ורק מהרשימה הנפתחת של תבנית הפרויקט —
  // כל ערך שנשמר מוצמד לרשימה (גם אם הגיע מזיכרון ישן או מקריאת API)
  for (const [, a] of entries) {
    if (a.staffType !== undefined || a.role !== undefined) {
      const c = clampStaffForFramework(putReport.framework, a.staffType || null, a.role || null);
      a.staffType = c.staffType; a.role = c.role;
    }
  }
  const CHUNK = 10;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const results = await Promise.all(entries.slice(i, i + CHUNK).map(([rowId, a]) =>
      db.prepare('UPDATE cost_rows SET symbol_override = ?, staff_type = ?, role = ? WHERE id = ? AND report_id = ?')
        .run(a.symbol || null, a.staffType || null, a.role || null, parseInt(rowId), id)
    ));
    updated += results.reduce((s, r) => s + (r.changes || 0), 0);
  }
  // תעריפים ידניים (שעות/ברוטו שעתי/עלות שעתית) — רק לשורות שנשלח בהן ערך
  for (const [rowId, a] of entries) {
    try { await applyManualRates(db, id, parseInt(rowId), a); }
    catch (e) { console.error('עדכון תעריפים ידני נכשל לשורה ' + rowId + ':', e.message); }
  }
  // תיקון ת.ז (כלל רעות 23.9): מעדכן את כל שורות העובד אצל הלקוח (בכל
  // הפרויקטים) ונלמד ב-client_mappings emp_id_fix — מוחל מחדש בכל קליטת קובץ
  for (const [rowId, a] of entries) {
    if (a.empId === undefined || a.empId === null) continue;
    const newId = String(a.empId).replace(/\D/g, '');
    if (!newId) continue;
    const row = await db.prepare('SELECT emp_id, client_id FROM cost_rows WHERE id = ? AND report_id = ?').get(parseInt(rowId), id);
    if (!row || String(row.emp_id) === newId) continue;
    await db.prepare('UPDATE cost_rows SET emp_id = ? WHERE client_id = ? AND emp_id = ?').run(newId, row.client_id, String(row.emp_id));
    await db.prepare(
      `INSERT INTO client_mappings (client_id, mapping_type, map_key, map_value) VALUES (?, 'emp_id_fix', ?, ?)
       ON CONFLICT(client_id, mapping_type, map_key) DO UPDATE SET map_value = excluded.map_value`
    ).run(row.client_id, String(row.emp_id), newId);
    updated++;
  }

  // זיכרון השיוך הידני פר-עובד/ת (כלל 22.9): נשמר ללקוח ושורד החלפת דוח עלות
  try {
    const ids = entries.map(([rowId]) => parseInt(rowId)).filter(Number.isFinite);
    const empRows = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      empRows.push(...await db.prepare(`SELECT id, emp_id, dept FROM cost_rows WHERE report_id = ? AND id IN (${chunk.map(() => '?').join(',')})`).all(id, ...chunk));
    }
    const rowOf = new Map(empRows.map((r) => [String(r.id), r]));
    await saveManualAssignments(db, id, entries
      .filter(([rowId]) => rowOf.has(String(parseInt(rowId))))
      .map(([rowId, a]) => {
        const r = rowOf.get(String(parseInt(rowId)));
        return { empId: r.emp_id, dept: r.dept, symbol: a.symbol, staffType: a.staffType, role: a.role };
      }));
  } catch (e) { console.error('שמירת זיכרון שיוכים נכשלה:', e.message); }
  res.json({ ok: true, updated });
}));

/* ---------- לשונית "דוח הוצאות בפועל" מהכרטסות (§6) ---------- */
const EXPENSE_BASKETS = ['enrichment', 'breakfast', 'scholarships', 'management'];
// מכינות קיץ: מהויות ההוצאה של התבנית — כולל פעילות חוץ (יום סיור) ו-AI;
// התוויות חייבות להתאים במדויק לרשימה הנפתחת של הלשונית
const PREP_EXPENSE_BASKETS = ['enrichment', 'scholarships', 'management', 'trip', 'ai'];
const EXPENSE_HE = { enrichment: 'העשרה', breakfast: 'ארוחת בוקר', scholarships: 'מלגות להורים', management: 'ניהול ותפעול', trip: 'פעילות חוץ', ai: 'AI' };
const OPERATION_SOURCE = 'קבלן משנה';

async function buildExpenseFill(db, report, client) {
  const basketList = report.framework === 'prep' ? PREP_EXPENSE_BASKETS : EXPENSE_BASKETS;
  const cards = (await db.prepare(
    `SELECT * FROM ledger_cards WHERE report_id = ? AND basket_type IN (${basketList.map(() => '?').join(',')})`
  ).all(report.id, ...basketList)).filter((c) => (c.net || 0) > 0);
  const vat = client && client.has_vat ? 1.18 : 1;
  const r2 = (n) => Math.round(n * vat * 100) / 100;
  const round2 = (n) => Math.round(n * 100) / 100;
  // ניהול ותפעול — בהתאם לתקציב (כלל רעות 16.9: התקורה ממולאת כ-100% תקציב);
  // מספר הכרטסת מצורף כשקיימת כרטסת ניהול
  const mgmtBudget = new Map((await db.prepare(
    `SELECT i.symbol s, COALESCE(SUM(b.budget_amount),0) a FROM baskets b
     JOIN institutions i ON i.id = b.institution_id
     WHERE i.report_id = ? AND b.basket_type = 'management' GROUP BY i.symbol`
  ).all(report.id)).map((r) => [String(r.s), Number(r.a) || 0]));
  const mgmtTotal = [...mgmtBudget.values()].reduce((s, v) => s + v, 0);
  const mgmtCards = cards.filter((c) => c.basket_type === 'management').map((c) => c.card_key).join(', ');
  if (!cards.length && !(mgmtTotal > 0)) return null;

  if (report.framework === 'gardens') {
    const aggregate = {};
    EXPENSE_BASKETS.forEach((b) => {
      if (b === 'management') return; // ניהול — מהתקציב, למטה
      const bs = cards.filter((c) => c.basket_type === b);
      if (!bs.length) return;
      aggregate[b] = {
        amount: r2(bs.reduce((s, c) => s + c.net, 0)),
        cards: bs.map((c) => c.card_key).join(', '),
        source: OPERATION_SOURCE,
      };
    });
    if (mgmtTotal > 0) aggregate.management = { amount: round2(mgmtTotal), cards: mgmtCards, source: OPERATION_SOURCE };
    return Object.keys(aggregate).length ? { aggregate } : null;
  }

  // בתי"ס: פר מוסד — כרטיס תואם-שם → מוסד; כרטיס כללי → פיצול יחסי לילדים
  const insts = await db.prepare('SELECT symbol, name, children_count FROM institutions WHERE report_id = ?').all(report.id);
  if (!insts.length) return null;
  const totalChildren = insts.reduce((s, i) => s + (i.children_count || 0), 0);
  const nameToSymbol = matchDeptsToInstitutions(insts, [...new Set(cards.map((c) => c.card_name))]);

  const rows = [];
  // ניהול ותפעול פר בי"ס — לפי תקציב סל הניהול של המוסד (לא לפי כרטסת)
  for (const inst of insts) {
    const mb = mgmtBudget.get(String(inst.symbol)) || 0;
    if (mb > 0) rows.push([inst.symbol, EXPENSE_HE.management, round2(mb), mgmtCards, OPERATION_SOURCE]);
  }
  cards.forEach((c) => {
    if (c.basket_type === 'management') return; // טופל מהתקציב למעלה
    const label = EXPENSE_HE[c.basket_type];
    const sym = nameToSymbol[c.card_name];
    if (sym) {
      rows.push([sym, label, r2(c.net), c.card_key, OPERATION_SOURCE]);
    } else if (totalChildren > 0) {
      let allocated = 0;
      const gross = c.net * vat;
      insts.forEach((inst, idx) => {
        let part = idx === insts.length - 1
          ? Math.round((gross - allocated) * 100) / 100
          : Math.round(gross * ((inst.children_count || 0) / totalChildren) * 100) / 100;
        allocated += part;
        if (part > 0) rows.push([inst.symbol, label, part, c.card_key, OPERATION_SOURCE]);
      });
    }
  });
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));
  return rows.length ? { perSchool: rows } : null;
}

/* ---------- לשונית "תשלומי הורים": גבייה = ילדים × תעריף + פרטי כרטיס ההכנסות ---------- */
async function buildIncomeFill(db, report) {
  const tariff = report.parent_tariff || 0;
  if (!tariff) return null;
  const insts = await db.prepare('SELECT symbol, children_count FROM institutions WHERE report_id = ?').all(report.id);
  if (!insts.length) return null;
  const incomeCards = await db.prepare("SELECT * FROM ledger_cards WHERE report_id = ? AND basket_type = 'income'").all(report.id);
  const card = incomeCards.map((c) => c.card_key).join(', ') || null;
  const cardName = incomeCards.length ? incomeCards[0].card_name : null;
  const r2 = (n) => Math.round(n * 100) / 100;

  if (report.framework === 'gardens') {
    const kids = insts.reduce((s, i) => s + (i.children_count || 0), 0);
    if (!kids) return null;
    return { aggregate: { amount: r2(kids * tariff), kids }, card, cardName };
  }
  const perSchool = {};
  insts.forEach((i) => {
    const kids = i.children_count || 0;
    if (kids > 0) perSchool[String(i.symbol)] = { amount: r2(kids * tariff), kids };
  });
  return Object.keys(perSchool).length ? { perSchool, card, cardName } : null;
}

/* ---------- מכתב שלב 1 ללקוח: סיכום בדיקות (HTML להדפסה/PDF) ---------- */
router.get('/:id/stage1-doc', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).send('דוח לא נמצא');
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(report.client_id);
  const authority = report.authority_id ? await db.prepare('SELECT * FROM authorities WHERE id = ?').get(report.authority_id) : null;
  const html = renderStage1Html(await stage1Data(db, report, client, authority));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

/* ---------- החלטת הלקוח על ניוד עובד (שלב 1) ---------- */
const moveSchema = z.object({
  rowId: z.number().int(),
  decision: z.enum(['move', 'decline']),
  toSymbol: z.string().optional(),
});
router.post('/:id/apply-move', ah(async (req, res) => {
  const parsed = moveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'בקשת ניוד לא תקינה' });
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  const row = await db.prepare('SELECT * FROM cost_rows WHERE id = ? AND report_id = ?').get(parsed.data.rowId, id);
  if (!row) return res.status(404).json({ error: 'שורת העובד לא נמצאה' });

  if (parsed.data.decision === 'decline') {
    await db.prepare('UPDATE cost_rows SET move_declined = 1 WHERE id = ?').run(row.id);
    return res.json({ ok: true, declined: true });
  }

  const toSymbol = String(parsed.data.toSymbol || '');
  if (!toSymbol) return res.status(400).json({ error: 'חסר סמל יעד' });

  // שם המחלקה של מוסד היעד: המחלקה הנפוצה ביותר בין העובדים שכבר משויכים אליו
  const insts = await db.prepare('SELECT symbol, name FROM institutions WHERE report_id = ?').all(id);
  const allRows = await db.prepare('SELECT * FROM cost_rows WHERE report_id = ?').all(id);
  const deptSymbol = insts.length ? matchDeptsToInstitutions(insts, [...new Set(allRows.map((r) => r.dept))]) : {};
  const deptCounts = {};
  allRows.forEach((r) => {
    const sym = r.symbol_override || deptSymbol[r.dept] || null;
    if (sym === toSymbol && r.dept) deptCounts[r.dept] = (deptCounts[r.dept] || 0) + 1;
  });
  const targetDept = Object.entries(deptCounts).sort((a, b) => b[1] - a[1]).map(([d]) => d)[0] || row.dept;

  await db.prepare(
    `UPDATE cost_rows SET moved_from_dept = COALESCE(moved_from_dept, dept),
      moved_from_symbol = COALESCE(moved_from_symbol, symbol_override),
      dept = ?, symbol_override = ?, move_declined = 0 WHERE id = ?`
  ).run(targetDept, toSymbol, row.id);
  res.json({ ok: true, moved: true, dept: targetDept, symbol: toSymbol });
}));

/* ---------- דוח התאמה לדוח עלות (להצגה למשרד החינוך) ---------- */
router.get('/:id/cost-match-doc', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).send('דוח לא נמצא');
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(report.client_id);
  const authority = report.authority_id ? await db.prepare('SELECT * FROM authorities WHERE id = ?').get(report.authority_id) : null;
  const rows = await db.prepare(
    'SELECT * FROM cost_rows WHERE report_id = ? ORDER BY emp_name'
  ).all(id);
  if (!rows.length) return res.status(422).send('אין שורות שכר מנותבות לדוח זה.');
  const { reportLabel } = require('../lib/domain');
  const html = renderCostMatchHtml({ report, client, authority, rows, label: reportLabel(report.framework, report.program) });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

/* דוח ההתאמה כקובץ אקסל להורדה (בנוסף לגרסת ה-PDF/הדפסה) */
/* שלב 2: דוח התאמת העשרה — ייחוס כרטסות ההעשרה למוסדות (דף להדפסה) */
router.get('/:id/enrich-match-doc', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(report.client_id);
  const authority = report.authority_id ? await db.prepare('SELECT * FROM authorities WHERE id = ?').get(report.authority_id) : null;
  const { enrichMatchData, renderEnrichMatchHtml } = require('../lib/enrichMatch');
  const d = await enrichMatchData(db, report, client, authority);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderEnrichMatchHtml(d));
}));

/* דוח שלב 2 — בקרות ותשלום צפוי (דף להדפסה) */
router.get('/:id/stage2-doc', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(report.client_id);
  const authority = report.authority_id ? await db.prepare('SELECT * FROM authorities WHERE id = ?').get(report.authority_id) : null;
  const { stage2Data, renderStage2Html } = require('../lib/stage2Report');
  const d = await stage2Data(db, report, client, authority);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderStage2Html(d));
}));

/* דוח התאמת ההעשרה כקובץ אקסל מעוצב */
router.get('/:id/enrich-match-xlsx', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(report.client_id);
  const authority = report.authority_id ? await db.prepare('SELECT * FROM authorities WHERE id = ?').get(report.authority_id) : null;
  const { enrichMatchData, buildEnrichMatchXlsx } = require('../lib/enrichMatch');
  const d = await enrichMatchData(db, report, client, authority);
  if (!d.perCard.length) return res.status(422).json({ error: 'לא נקלטו כרטסות העשרה לדוח זה.' });
  const buf = buildEnrichMatchXlsx(d);
  const { reportLabel } = require('../lib/domain');
  const outName = `דוח התאמת העשרה - ${downloadWho(client, authority)} - ${reportLabel(report.framework, report.program)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="enrich_match_${id}.xlsx"; filename*=UTF-8''${encodeURIComponent(outName)}`);
  res.send(buf);
}));

/* סעיף 5 של המכתב — טבלת יעדי הכרטסות — כקובץ אקסל מעוצב להנה"ח */
router.get('/:id/targets-xlsx', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(report.client_id);
  const authority = report.authority_id ? await db.prepare('SELECT * FROM authorities WHERE id = ?').get(report.authority_id) : null;
  const d = await stage1Data(db, report, client, authority);
  if (!d.units.length) return res.status(422).json({ error: 'טרם הועלה קובץ דוח ביצוע — אין יעדי כרטסות להפקה.' });
  const { buildTargetsXlsx } = require('../lib/targetsXlsx');
  const buf = buildTargetsXlsx(d);
  const outName = `יעדי כרטסות - ${downloadWho(client, authority)} - ${d.label}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="targets_${id}.xlsx"; filename*=UTF-8''${encodeURIComponent(outName)}`);
  res.send(buf);
}));

router.get('/:id/cost-match-xlsx', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(report.client_id);
  const authority = report.authority_id ? await db.prepare('SELECT * FROM authorities WHERE id = ?').get(report.authority_id) : null;
  const rows = await db.prepare('SELECT * FROM cost_rows WHERE report_id = ? ORDER BY emp_name').all(id);
  if (!rows.length) return res.status(422).json({ error: 'אין שורות שכר מנותבות לדוח זה.' });
  const { reportLabel } = require('../lib/domain');
  const label = reportLabel(report.framework, report.program);
  const buf = buildCostMatchXlsx({ report, client, authority, rows, label });
  const who = downloadWho(client, authority);
  const outName = `דוח התאמה לדוח עלות - ${who} - ${label}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="cost_match_${id}.xlsx"; filename*=UTF-8''${encodeURIComponent(outName)}`);
  res.send(buf);
}));

/* ---------- ייצוא: מילוי קובץ המשרד (כח אדם + רכזות + הוצאות + הכנסות) ---------- */
/* פותר הסמל של שורת עלות — שרשרת אחת לכל המסמכים (ייצוא, דוח עלות
   לאחר שיוכים): ידני-לשורה ← מיפוי מחלקה נלמד ← שיוך שנקלט ← קובץ
   הלקוח (ת"ז) ← התאמת שם. מחזיר גם את מקור השיוך לתצוגה. */
async function makeSymbolResolver(db, report, exMd, rows) {
  const exInstitutions = exMd.institutions;
  const exValid = new Set(exInstitutions.map((i) => i.symbol));
  const exNameSymbol = exInstitutions.length
    ? matchDeptsToInstitutions(exInstitutions, [...new Set(rows.map((r) => r.inst_name).filter(Boolean))]) : {};
  const exDeptSymbol = exInstitutions.length && report.framework !== 'gardens'
    ? matchDeptsToInstitutions(exInstitutions, [...new Set(rows.map((r) => r.dept))]) : {};
  // בתי ספר מאוחדים: בדוח הביצוע נרשם סמל מקום הפעילות, לא הסמל הרשמי
  const exFileSym = (r) => {
    const a = exMd.workerSyms && exMd.workerSyms[String(r.emp_id || '').replace(/\D/g, '')];
    return a && exValid.has(a.symbol) ? a.symbol : null;
  };
  // שיוך ידני מחלקה→סמל שאושר ע"י המשתמשת (כלל 17.9) — כמו במכתב (stage1)
  const exDeptManual = {};
  (await db.prepare("SELECT map_key, map_value FROM client_mappings WHERE client_id = ? AND mapping_type = 'dept_symbol'")
    .all(report.client_id)).forEach((m) => { exDeptManual[m.map_key] = m.map_value; });
  const resolveWithSource = (r) => {
    let s = null, source = null;
    if (r.symbol_override) { s = r.symbol_override; source = 'שיוך ידני'; }
    else if (exDeptManual[r.dept]) { s = exDeptManual[r.dept]; source = 'מיפוי מחלקה (אושר)'; }
    else if (r.inst_symbol && exValid.has(String(r.inst_symbol))) { s = String(r.inst_symbol); source = 'שיוך שנקלט'; }
    else if (exFileSym(r)) { s = exFileSym(r); source = 'קובץ הלקוח (ת"ז)'; }
    else if (r.inst_name && exNameSymbol[r.inst_name]) { s = exNameSymbol[r.inst_name]; source = 'התאמת שם'; }
    else if (exDeptSymbol[r.dept]) { s = exDeptSymbol[r.dept]; source = 'התאמת שם המחלקה'; }
    if (!s) return { symbol: null, source: null };
    return { symbol: exMd.redirect.get(String(s)) || s, source };
  };
  return { resolveSymbol: (r) => resolveWithSource(r).symbol, resolveWithSource };
}

/* ---------- דוח עלות לאחר שיוכים (כלל רעות 17.9) — אקסל להורדה: כל שורות
   דוח העלות עם בית הספר הסופי שאליו שויך כל עובד, ממוין ומסוכם פר מוסד ---------- */
router.get('/:id/cost-assigned-xlsx', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(report.client_id);
  const authority = report.authority_id ? await db.prepare('SELECT * FROM authorities WHERE id = ?').get(report.authority_id) : null;
  const exMd = await ministryData(db, report);
  if (!exMd.buf) return res.status(422).json({ error: 'אין קובץ דוח ביצוע שמור לדוח זה — יש להעלות קודם את קובץ המשרד.' });
  const rows = await db.prepare(
    `SELECT cr.*, cf.filename, cf.payer FROM cost_rows cr JOIN cost_files cf ON cf.id = cr.cost_file_id WHERE cr.report_id = ?`
  ).all(id);
  if (!rows.length) return res.status(422).json({ error: 'אין שורות שכר מנותבות לדוח זה.' });
  const { resolveWithSource } = await makeSymbolResolver(db, report, exMd, rows);
  const nameBySym = new Map(exMd.institutions.map((i) => [String(i.symbol), i.name]));
  const buf = buildCostAssignedXlsx({ report, client, authority, rows, resolveWithSource, nameBySym });
  const { reportLabel } = require('../lib/domain');
  const fname = `דוח עלות לאחר שיוכים - ${downloadWho(client, authority)} - ${reportLabel(report.framework, report.program)}.xlsx`;
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
}));

function buildCostAssignedXlsx({ report, client, authority, rows, resolveWithSource, nameBySym }) {
  const XLSXS = require('xlsx-js-style');
  const { reportLabel } = require('../lib/domain');
  const label = reportLabel(report.framework, report.program);
  const today = new Date().toLocaleDateString('he-IL');
  const who = downloadWho(client, authority);
  const GOLD = '9A7B2F', CHAMP = 'F4ECDA', SOFT = 'FBF7EC', LINE = 'D9CDB3', INK = '413A2F';
  const border = { top: { style: 'thin', color: { rgb: LINE } }, bottom: { style: 'thin', color: { rgb: LINE } }, left: { style: 'thin', color: { rgb: LINE } }, right: { style: 'thin', color: { rgb: LINE } } };
  const S = {
    title: { font: { bold: true, sz: 14, color: { rgb: INK } }, alignment: { horizontal: 'right' } },
    sub: { font: { bold: true, sz: 11, color: { rgb: GOLD } }, alignment: { horizontal: 'right' } },
    school: { font: { bold: true, sz: 12, color: { rgb: GOLD } }, alignment: { horizontal: 'right' } },
    head: { font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: GOLD } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border },
    cellR: (z) => ({ font: { sz: 10, color: { rgb: INK } }, alignment: { horizontal: 'right' }, border, ...(z ? { fill: { fgColor: { rgb: SOFT } } } : {}) }),
    cellN: (z) => ({ font: { sz: 10, color: { rgb: INK } }, alignment: { horizontal: 'center' }, border, numFmt: '#,##0.00', ...(z ? { fill: { fgColor: { rgb: SOFT } } } : {}) }),
    total: { font: { bold: true, sz: 10, color: { rgb: INK } }, fill: { fgColor: { rgb: CHAMP } }, alignment: { horizontal: 'center' }, border: { ...border, top: { style: 'medium', color: { rgb: GOLD } } }, numFmt: '#,##0.00' },
    totalR: { font: { bold: true, sz: 10, color: { rgb: INK } }, fill: { fgColor: { rgb: CHAMP } }, alignment: { horizontal: 'right' }, border: { ...border, top: { style: 'medium', color: { rgb: GOLD } } } },
  };
  const cell = (v, s) => ({ v: v == null ? '' : v, t: typeof v === 'number' ? 'n' : 's', s });

  // קיבוץ לפי הבי"ס הסופי
  const groups = new Map(); // symbol -> rows
  for (const r of rows) {
    const { symbol, source } = resolveWithSource(r);
    const key = symbol || '—';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ r, source });
  }
  const sorted = [...groups.entries()].sort((a, b) => {
    const na = nameBySym.get(a[0]) || '', nb = nameBySym.get(b[0]) || '';
    return na.localeCompare(nb, 'he');
  });

  const aoa = [
    [cell('דוח עלות לאחר שיוכים — כל עובד/ת ובית הספר שאליו שויך/ה', S.title)],
    [cell(`${who} — ${label} · ${today}`, S.sub)],
    [],
  ];
  const merges = [0, 1].map((r) => ({ s: { r, c: 0 }, e: { r, c: 8 } }));
  const HEAD = ['שם עובד/ת', 'ת.ז', 'מחלקה בדוח העלות', 'תפקיד', 'שעות', 'ברוטו', 'עלות', 'מקור השיוך'];
  let grand = 0;
  for (const [sym, list] of sorted) {
    const sName = nameBySym.get(sym) || (sym === '—' ? 'ללא שיוך' : sym);
    aoa.push([cell(`${sName}${sym !== '—' ? ` — סמל ${sym}` : ''} (${list.length} עובדים)`, S.school)]);
    merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: 7 } });
    aoa.push(HEAD.map((h) => cell(h, S.head)));
    let sub = 0;
    list.sort((a, b) => String(a.r.emp_name || '').localeCompare(String(b.r.emp_name || ''), 'he'));
    list.forEach(({ r, source }, i) => {
      const z = i % 2 === 1;
      sub += r.cost || 0;
      aoa.push([
        cell(r.emp_name || '', S.cellR(z)), cell(String(r.emp_id || ''), S.cellR(z)),
        cell(r.dept || '', S.cellR(z)), cell(r.staff_type || '', S.cellR(z)),
        cell(r.hours ?? '', S.cellN(z)), cell(r.gross ?? '', S.cellN(z)), cell(r.cost ?? '', S.cellN(z)),
        cell(source || '', S.cellR(z)),
      ]);
    });
    grand += sub;
    aoa.push([cell('סה"כ ' + sName, S.totalR), cell('', S.totalR), cell('', S.totalR), cell('', S.totalR), cell('', S.totalR), cell('', S.totalR), cell(Math.round(sub * 100) / 100, S.total), cell('', S.totalR)]);
    aoa.push([]);
  }
  aoa.push([cell(`סה"כ עלות בדוח: ₪${Math.round(grand).toLocaleString('he-IL')} · ${rows.length} שורות`, S.sub)]);
  merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: 7 } });

  const ws = XLSXS.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 22 }, { wch: 13 }, { wch: 30 }, { wch: 20 }, { wch: 9 }, { wch: 11 }, { wch: 12 }, { wch: 18 }];
  ws['!merges'] = merges;
  const wb = XLSXS.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSXS.utils.book_append_sheet(wb, ws, 'עלות לאחר שיוכים');
  return XLSXS.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

router.get('/:id/export', ah(async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id);
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });
  const exMd = await ministryData(db, report);
  const ministryBuf = exMd.buf;
  if (!ministryBuf) {
    return res.status(422).json({ error: 'אין קובץ דוח ביצוע שמור לדוח זה — יש להעלות קודם את קובץ המשרד.' });
  }

  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(report.client_id);
  const authority = report.authority_id ? await db.prepare('SELECT name FROM authorities WHERE id = ?').get(report.authority_id) : null;
  const employer = (authority && authority.name) || (client && client.name) || '';

  const rows = await db.prepare(
    `SELECT cr.*, cf.payer FROM cost_rows cr JOIN cost_files cf ON cf.id = cr.cost_file_id
     WHERE cr.report_id = ? ORDER BY COALESCE(cr.symbol_override, cr.inst_symbol, ''), cr.emp_name`
  ).all(id);
  if (!rows.length) return res.status(422).json({ error: 'אין שורות שכר מנותבות לדוח זה.' });

  const { resolveSymbol } = await makeSymbolResolver(db, report, exMd, rows);

  const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
  // רשימות איש-צוות/תפקיד של תבנית בתי הספר — מהקובץ עצמו (מחרוזות מדויקות)
  const exSchoolTypes = report.framework !== 'gardens' ? exMd.schoolTypes : null;
  // כלל רעות 23.9 (בתי"ס): רכזים עד תקרת שעות (7.6×ימים), סגן 0 או 1
  const demotedEx = new Set();
  if (report.framework !== 'gardens') {
    const bySchool = new Map();
    for (const r of rows) {
      const s = String(resolveSymbol(r) || '');
      if (!bySchool.has(s)) bySchool.set(s, []);
      bySchool.get(s).push(r);
    }
    const capEx = coordHoursCapFor(report);
    for (const g of bySchool.values()) for (const rid of demoteExtraSchoolRoles(g, capEx)) demotedEx.add(rid);
  }
  // ללקוח חייב מע"מ — העלות השעתית המדווחת למשרד כוללת מע"מ (הברוטו נשאר כפי שהוא).
  // העלות המדווחת מוגבלת לנמוך מבין עלות×מע"מ לבין ברוטו שעתי×140% (תקרת המשרד);
  // ההפרש מול דוח העלות מוסבר ב"דוח ההתאמה לדוח עלות".
  const vatFactor = client && client.has_vat ? 1.18 : 1;
  const execRows = rows.map((r) => {
    // הברוטו המדווח כולל התאמת ברוטו שאושרה (עד 5 ₪ לשעה) — מעלה את תקרת ה-140%
    const hourlyGross = r.gross != null && r.hours ? effectiveGross(r) / r.hours : null;
    const rawHourlyCost = r.cost != null && r.hours ? (r.cost / r.hours) * vatFactor : null;
    const cap140 = hourlyGross != null && hourlyGross > 0 ? hourlyGross * COST_MARKUP_LIMIT : null;
    const hourlyCost = rawHourlyCost != null && cap140 != null ? Math.min(rawHourlyCost, cap140) : rawHourlyCost;
    const sug = suggestRole(r.dept);
    const isSch = report.framework !== 'gardens';
    const byHours = isSch && !demotedEx.has(r.id) ? schoolsRoleByHours(r.hours) : null;
    // תפקיד שמולא בקובץ שהועלה (ת"ז): בגנים קודם לניחוש; בבתי"ס כלל השעות גובר
    const exWs = exMd.workerSyms && exMd.workerSyms[String(r.emp_id || '').replace(/\D/g, '')];
    let stVal = demotedEx.has(r.id) ? 'מורה'
      : isSch
        ? (r.staff_type || (byHours && byHours.staffType) || (exWs && exWs.staffType) || sug.staffType || '')
        : (r.staff_type || (exWs && exWs.staffType) || sug.staffType || '');
    let roleVal = demotedEx.has(r.id) ? 'מורה'
      : isSch
        ? (r.role || (byHours && byHours.role) || (exWs && exWs.role) || sug.role || '')
        : (r.role || (exWs && exWs.role) || sug.role || '');
    // בתי"ס בלי שום סיווג — ברירת מחדל לפי מדרגת הברוטו השעתי (כלל 22.9)
    if (isSch && !stVal) ({ staffType: stVal, role: roleVal } = defaultSchoolsStaff(hourlyGross || 0));
    if (isSch) ({ staffType: stVal, role: roleVal } = mapSchoolsStaff(stVal, roleVal, exSchoolTypes));
    else if (stVal) ({ staffType: stVal, role: roleVal } = mapGardensStaff(stVal, roleVal));
    return [
      resolveSymbol(r), null, r.emp_id,
      r.first_name || (r.emp_name || '').split(' ')[0] || '',
      r.last_name || (r.emp_name || '').split(' ').slice(1).join(' ') || '',
      r.payer || employer, // "הועסק ע"י" — המשלם של הקובץ (מתנ"ס/רשות), אם הוגדר
      stVal || '',
      roleVal || '',
      round2(hourlyGross), round2(hourlyCost), round2(r.hours),
      null,
    ];
  });

  const srcBuf = ministryBuf;
  let coordRows = null;
  if (report.framework === 'gardens') {
    coordRows = exMd.coordGardens.map((sym, i) => [i + 1, sym, 0.2]);
  }

  const expenses = await buildExpenseFill(db, report, client);
  const income = await buildIncomeFill(db, report);
  const filled = await fillMinistryReport(srcBuf, execRows, coordRows, expenses, income);
  const exAuthority = report.authority_id ? await db.prepare('SELECT name FROM authorities WHERE id = ?').get(report.authority_id) : null;
  // כשהקובץ שהועלה הוא בעצמו ייצוא קודם שלנו — לא לשרשר "דוח ביצוע ממולא" פעמיים
  const exBase = (report.budget_file_name || 'report.xlsx').replace(/\.xlsx?$/i, '').replace(/^(דוח ביצוע ממולא - )+/, '');
  const outName = `דוח ביצוע ממולא - ${downloadWho(client, exAuthority)} - ${exBase}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="filled_report_${id}.xlsx"; filename*=UTF-8''${encodeURIComponent(outName)}`);
  res.send(filled);
}));

router.delete('/:id', ah(async (req, res) => {
  const db = getDB();
  const report = await db.prepare('SELECT budget_file_path FROM reports WHERE id = ?').get(parseInt(req.params.id));
  if (report && report.budget_file_path) { try { fs.unlinkSync(report.budget_file_path); } catch { /* לא קיים */ } }
  await cascadeReport(db, parseInt(req.params.id));
  res.json({ ok: true });
}));

module.exports = router;
