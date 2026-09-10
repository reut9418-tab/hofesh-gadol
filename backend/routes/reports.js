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
const { parseBudgetFile, extractTariff } = require('../lib/budgetFile');
const { fillMinistryReport, extractInstitutions, extractCoordinatorGardens, extractExecGardens, STAFF_TYPES, SCHOOL_STAFF_TYPES, extractSchoolStaffTypes } = require('../lib/fillMinistry');

/* בבתי ספר אין "גננת"/"סייעת" — תרגום סוגי צוות של גנים (שמגיעים מדוח
   העלות) לערכי הרשימה של תבנית בתי הספר, והצמדה למחרוזות המדויקות בקובץ */
const SCHOOL_TYPE_MAP = {
  'גננת': { staffType: 'מורה', role: 'בעל/ת תעודת הוראה שסיימ/ה 80% מהתואר' },
  'סייעת חדשה': { staffType: 'מורה', role: 'עוזר/ת חינוך' },
  'סייעת ממשיכה': { staffType: 'מורה', role: 'עוזר/ת חינוך' },
  'רכזת גן': { staffType: 'רכזת תכנית בבית הספר', role: 'רכז/ת תכנית בבית הספר' },
};
function mapSchoolsStaff(staffType, role, schoolTypes) {
  let st = staffType, rl = role;
  const m = st && SCHOOL_TYPE_MAP[String(st).trim()];
  if (m) { st = m.staffType; rl = m.role; }
  const list = schoolTypes || SCHOOL_STAFF_TYPES;
  if (st) {
    const entry = list.find((x) => x.type.trim() === String(st).trim());
    if (entry) {
      st = entry.type; // המחרוזת המדויקת של הקובץ — ההשוואות בו תו-בתו
      const exact = rl && entry.roles.find((r) => r.trim() === String(rl).trim());
      rl = exact || entry.roles[0];
    }
  }
  return { staffType: st, role: rl };
}
const { salaryCheck, suggestRole, schoolsRoleByHours } = require('../lib/salaryCheck');
const { COST_MARKUP_LIMIT, effectiveGross } = require('../lib/ingest');
const { renderCostMatchHtml } = require('../lib/costMatch');
const { recommendations } = require('../lib/recommend');
const { matchDeptsToInstitutions } = require('../lib/nameMatch');
const { stage1Data, renderStage1Html } = require('../lib/stage1');

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
  const entry = { fileName: report.budget_file_name || '', buf, institutions: [], schoolTypes: null, redirect: new Map(), coordGardens: [], execGardens: [] };
  if (buf) {
    try { entry.institutions = extractInstitutions(buf); } catch { /* בלי רשימה */ }
    // בתי ספר מאוחדים: הסמל הרשמי מפנה לסמל שבו מתקיימת הפעילות
    entry.redirect = new Map(entry.institutions.filter((i) => i.activitySymbol).map((i) => [String(i.symbol), String(i.activitySymbol)]));
    if (report.framework !== 'gardens') {
      try { entry.schoolTypes = extractSchoolStaffTypes(buf); } catch { /* ברירת מחדל */ }
    } else {
      try { entry.coordGardens = extractCoordinatorGardens(buf); } catch { /* ריק */ }
      try { entry.execGardens = extractExecGardens(buf); } catch { /* ריק */ }
    }
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
  const r = await db.prepare(
    'INSERT INTO reports (client_id, authority_id, framework, program, extension_days) VALUES (?, ?, ?, ?, ?)'
  ).run(d.client_id, d.authority_id ?? null, d.framework, program, program === 'extension' ? (d.extension_days || 0) : 0);
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
  try { parsed = parseBudgetFile(req.file.buffer, { program: report.program }); }
  catch { return res.status(422).json({ error: 'לא הצלחתי לקרוא את קובץ דוח הביצוע.' }); }
  if (parsed.error) return res.status(422).json({ error: parsed.error });
  if (!parsed.institutions.length) {
    if (parsed.schoolsNotComputed) {
      return res.status(422).json({ error: 'לשונית "תקצוב לפי מוסד" בקובץ לא חושבה (אין סמלי מוסדות — הנוסחאות קפואות). יש לפתוח את הקובץ ב-Excel, לוודא שנבחרה הרשות בגיליון "נתונים כלליים", להקיש Ctrl+Alt+F9 לשמור — ולהעלות שוב.' });
    }
    return res.status(422).json({ error: 'לא נמצאו מוסדות עם תקציב מחושב בקובץ. ודאי שכמות הילדים מולאה ב"מצבת והרשמה" ושהקובץ נשמר ב-Excel.' });
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
    const iid = (await db.prepare(
      `INSERT INTO institutions (report_id, symbol, name, size_type, children_count, children_regular, children_special, budget_total, actual_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, inst.symbol, inst.name || '', inst.size || 'small', reg + spec, reg, spec, inst.total || 0, inst.totalActual || 0)).lastInsertRowid;
    for (const [type, amount] of Object.entries(inst.baskets || {})) {
      if (amount > 0) await db.prepare('INSERT INTO baskets (institution_id, basket_type, budget_amount) VALUES (?, ?, ?)').run(iid, type, amount);
    }
  }

  // שומרים את קובץ המשרד בדיסק — ממלאים אותו בחזרה בייצוא (§9)
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const savedPath = path.join(UPLOADS_DIR, `report_${id}_budget.xlsx`);
  fs.writeFileSync(savedPath, req.file.buffer);
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

  // דוח הביצוע מספק את כמות המשתתפים; התעריף לילד מחולץ ללשונית ההכנסות
  const tariff = extractTariff(req.file.buffer) || 0;
  await db.prepare('UPDATE reports SET has_participants = 1, budget_file_name = ?, budget_file_path = ?, parent_tariff = ? WHERE id = ?')
    .run(originalName, savedPath, tariff, id);
  // עותק קבוע במסד — שורד את איפוס הדיסק של הענן בכל פריסה
  await db.prepare('DELETE FROM report_files WHERE report_id = ?').run(id);
  await db.prepare('INSERT INTO report_files (report_id, data) VALUES (?, ?)').run(id, req.file.buffer);
  ministryCache.delete(id); // הקובץ התחלף — הנגזרות ייבנו מחדש

  const totalBudget = parsed.institutions.reduce((s, i) => s + (i.total || 0), 0);
  const fallbackInst = parsed.institutions.find((i) => i.ratesFallback);
  res.status(201).json({
    authority: parsed.authority,
    institutions: parsed.institutions.length,
    totalBudget,
    warning: fallbackInst
      ? `שימי לב: בקובץ המשרד "בקרת האיוש" איפסה את חישוב התקציב, ולכן המערכת חישבה אותו לבד — ${fallbackInst.eligibleReg?.toLocaleString('he-IL')} ילדים בהרשמה × התעריף לילד שבקובץ. כדאי להשלים את גיליון "איוש משרות" בקובץ ולרענן, אך אפשר להמשיך לעבוד כרגיל.`
      : undefined,
    health: await reportHealth(db, await db.prepare('SELECT * FROM reports WHERE id = ?').get(id)),
  });
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
  const report = await db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'דוח לא נמצא' });

  // רשימת המוסדות מקובץ המשרד השמור (מצבת והרשמה) — לבחירת סמל מקום פעילות
  const md = await ministryData(db, report);
  const institutions = md.institutions;
  const prepBuf = md.buf;
  const validSymbols = new Set(institutions.map((i) => i.symbol));
  const toActivity = (s) => (s ? (md.redirect.get(String(s)) || s) : s);

  const rawRows = await db.prepare(
    `SELECT cr.id, cr.emp_id, cr.emp_name, cr.first_name, cr.last_name, cr.dept,
            cr.inst_symbol, cr.inst_name, cr.symbol_override, cr.staff_type, cr.role,
            cr.gross, cr.cost, cr.hours, cr.gross_bump
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
  const rows = rawRows.map((r) => {
    const sug = suggestRole(r.dept);
    // בתי ספר: רכז/סגן מזוהים לפי שעות (מעל 114 = רכז, ~93 = סגן) —
    // המשרד מציג את תקציב בית הספר רק כשמוגדר רכז בכל סמל
    const byHours = isSchools ? schoolsRoleByHours(r.hours) : null;
    let stVal = r.staff_type || (byHours && byHours.staffType) || sug.staffType;
    let roleVal = r.role || (byHours && byHours.role) || sug.role;
    if (isSchools) ({ staffType: stVal, role: roleVal } = mapSchoolsStaff(stVal, roleVal, schoolTypes));
    const fileSymbol = r.inst_symbol && validSymbols.has(String(r.inst_symbol)) ? String(r.inst_symbol) : null;
    return {
      rowId: r.id, empId: r.emp_id, name: r.emp_name,
      firstName: r.first_name, lastName: r.last_name, dept: r.dept, instName: r.inst_name,
      symbol: toActivity(r.symbol_override || fileSymbol || (r.inst_name && nameSymbol[r.inst_name]) || deptSymbol[r.dept] || null),
      staffType: stVal,
      role: roleVal,
      saved: !!(r.symbol_override || r.staff_type || r.role),
      gross: r.gross, cost: r.cost, hours: r.hours,
      hourlyGross: r.gross != null && r.hours ? r.gross / r.hours : null,
      hourlyCost: r.cost != null && r.hours ? r.cost / r.hours : null,
    };
  });

  // הבדיקות רצות במקביל — כל אחת עושה כמה סבבי-רשת ל-DB בענן
  const [client, authority, salaryRes, recsRes] = await Promise.all([
    db.prepare('SELECT name, has_vat FROM clients WHERE id = ?').get(report.client_id),
    report.authority_id ? db.prepare('SELECT name FROM authorities WHERE id = ?').get(report.authority_id) : null,
    salaryCheck(db, report),
    recommendations(db, report),
  ]);

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

  /* בתי ספר: מוודאים שלכל בי"ס יש רכז — מי שמעל 114 שעות מזוהה ממילא;
     בבי"ס בלי רכז, העובד/ת עם הכי הרבה שעות (ואז עלות) מקודם/ת לרכז/ת. */
  if (report.framework !== 'gardens') {
    const schoolSyms = (await db.prepare('SELECT symbol FROM institutions WHERE report_id = ?').all(id)).map((i) => String(i.symbol));
    if (!schoolSyms.length) return res.status(422).json({ error: 'אין מוסדות לדוח — יש להעלות קודם את קובץ המשרד.' });
    const rows2 = await db.prepare('SELECT * FROM cost_rows WHERE report_id = ?').all(id);
    const nameSym = aaMd.institutions.length
      ? matchDeptsToInstitutions(aaMd.institutions, [...new Set(rows2.map((r) => r.inst_name).filter(Boolean))]) : {};
    const validS = new Set(schoolSyms);
    const symOf = (r) => {
      const s = r.symbol_override
        || (r.inst_symbol && validS.has(String(r.inst_symbol)) ? String(r.inst_symbol) : null)
        || (r.inst_name && nameSym[r.inst_name]) || null;
      return s ? (aaMd.redirect.get(String(s)) || s) : null;
    };
    const isCoord = (r) => {
      const st = r.staff_type || (schoolsRoleByHours(r.hours) || {}).staffType;
      return st === 'רכזת תכנית בבית הספר';
    };
    const bySchool = new Map();
    for (const r of rows2) {
      const s = symOf(r);
      if (!s) continue;
      if (!bySchool.has(s)) bySchool.set(s, []);
      bySchool.get(s).push(r);
    }
    let promoted = 0;
    for (const [, list] of bySchool) {
      if (list.some(isCoord)) continue;
      const pick = list.slice().sort((a, b) => (b.hours || 0) - (a.hours || 0) || (b.cost || 0) - (a.cost || 0))[0];
      if (!pick) continue;
      await db.prepare("UPDATE cost_rows SET staff_type = 'רכזת תכנית בבית הספר', role = 'רכז/ת תכנית בבית הספר' WHERE id = ?").run(pick.id);
      promoted++;
    }
    return res.json({ ok: true, assigned: promoted, gardens: bySchool.size, mode: 'schools' });
  }

  let gardens = aaMd.execGardens.length ? aaMd.execGardens : aaMd.institutions.map((i) => i.symbol);
  if (!gardens.length) return res.status(422).json({ error: 'לא נמצאו סמלי גנים בלשונית "גנים - דוח ביצוע" של הקובץ.' });

  const rows = await db.prepare('SELECT * FROM cost_rows WHERE report_id = ?').all(id);
  const exNameSymbol = aaMd.institutions.length
    ? matchDeptsToInstitutions(aaMd.institutions, [...new Set(rows.map((r) => r.inst_name).filter(Boolean))])
    : {};
  const validSet = new Set(gardens);
  const symbolOf = (r) => r.symbol_override
    || (r.inst_symbol && validSet.has(String(r.inst_symbol)) ? String(r.inst_symbol) : null)
    || (r.inst_name && exNameSymbol[r.inst_name]) || null;
  const staffOf = (r) => r.staff_type || suggestRole(r.dept).staffType || 'גננת';

  // ספירת האיוש הקיים פר גן
  const staffed = new Map(gardens.map((g) => [g, { gan: 0, say: 0 }]));
  const unassigned = [];
  for (const r of rows) {
    const sym = symbolOf(r);
    const st = staffOf(r);
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
  res.json({ ok: true, assigned, gardens: gardens.length });
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
  })),
});

router.put('/:id/prep', ah(async (req, res) => {
  const parsed = prepSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'מבנה שיוך לא תקין' });
  const db = getDB();
  const id = parseInt(req.params.id);
  if (!(await db.prepare('SELECT id FROM reports WHERE id = ?').get(id))) return res.status(404).json({ error: 'דוח לא נמצא' });
  // עדכון ישיר עם תנאי report_id (בלי SELECT מקדים) ובמקביל בקבוצות —
  // כל סבב-רשת ל-DB בענן עולה ~50ms, ושמירת 90 שיוכים לקחה שניות
  let updated = 0;
  const entries = Object.entries(parsed.data.assignments);
  const CHUNK = 10;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const results = await Promise.all(entries.slice(i, i + CHUNK).map(([rowId, a]) =>
      db.prepare('UPDATE cost_rows SET symbol_override = ?, staff_type = ?, role = ? WHERE id = ? AND report_id = ?')
        .run(a.symbol || null, a.staffType || null, a.role || null, parseInt(rowId), id)
    ));
    updated += results.reduce((s, r) => s + (r.changes || 0), 0);
  }
  res.json({ ok: true, updated });
}));

/* ---------- לשונית "דוח הוצאות בפועל" מהכרטסות (§6) ---------- */
const EXPENSE_BASKETS = ['enrichment', 'breakfast', 'scholarships', 'management'];
const EXPENSE_HE = { enrichment: 'העשרה', breakfast: 'ארוחת בוקר', scholarships: 'מלגות להורים', management: 'ניהול ותפעול' };
const OPERATION_SOURCE = 'קבלן משנה';

async function buildExpenseFill(db, report, client) {
  const cards = (await db.prepare(
    `SELECT * FROM ledger_cards WHERE report_id = ? AND basket_type IN (${EXPENSE_BASKETS.map(() => '?').join(',')})`
  ).all(report.id, ...EXPENSE_BASKETS)).filter((c) => (c.net || 0) > 0);
  if (!cards.length) return null;
  const vat = client && client.has_vat ? 1.18 : 1;
  const r2 = (n) => Math.round(n * vat * 100) / 100;

  if (report.framework === 'gardens') {
    const aggregate = {};
    EXPENSE_BASKETS.forEach((b) => {
      const bs = cards.filter((c) => c.basket_type === b);
      if (!bs.length) return;
      aggregate[b] = {
        amount: r2(bs.reduce((s, c) => s + c.net, 0)),
        cards: bs.map((c) => c.card_key).join(', '),
        source: OPERATION_SOURCE,
      };
    });
    return Object.keys(aggregate).length ? { aggregate } : null;
  }

  // בתי"ס: פר מוסד — כרטיס תואם-שם → מוסד; כרטיס כללי → פיצול יחסי לילדים
  const insts = await db.prepare('SELECT symbol, name, children_count FROM institutions WHERE report_id = ?').all(report.id);
  if (!insts.length) return null;
  const totalChildren = insts.reduce((s, i) => s + (i.children_count || 0), 0);
  const nameToSymbol = matchDeptsToInstitutions(insts, [...new Set(cards.map((c) => c.card_name))]);

  const rows = [];
  cards.forEach((c) => {
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

/* ---------- ייצוא: מילוי קובץ המשרד (כח אדם + רכזות + הוצאות + הכנסות) ---------- */
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

  // שיוך סמל אוטומטי גם בייצוא: שם הגן/בי"ס שבשורה מול לשונית ההרשמה
  const exInstitutions = exMd.institutions;
  const exValid = new Set(exInstitutions.map((i) => i.symbol));
  const exNameSymbol = exInstitutions.length
    ? matchDeptsToInstitutions(exInstitutions, [...new Set(rows.map((r) => r.inst_name).filter(Boolean))]) : {};
  const exDeptSymbol = exInstitutions.length && report.framework !== 'gardens'
    ? matchDeptsToInstitutions(exInstitutions, [...new Set(rows.map((r) => r.dept))]) : {};
  // בתי ספר מאוחדים: בדוח הביצוע נרשם סמל מקום הפעילות, לא הסמל הרשמי
  const resolveSymbol = (r) => {
    const s = r.symbol_override
      || (r.inst_symbol && exValid.has(String(r.inst_symbol)) ? String(r.inst_symbol) : null)
      || (r.inst_name && exNameSymbol[r.inst_name])
      || exDeptSymbol[r.dept]
      || null;
    return s ? (exMd.redirect.get(String(s)) || s) : null;
  };

  const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
  // רשימות איש-צוות/תפקיד של תבנית בתי הספר — מהקובץ עצמו (מחרוזות מדויקות)
  const exSchoolTypes = report.framework !== 'gardens' ? exMd.schoolTypes : null;
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
    const byHours = report.framework !== 'gardens' ? schoolsRoleByHours(r.hours) : null;
    let stVal = r.staff_type || (byHours && byHours.staffType) || sug.staffType || '';
    let roleVal = r.role || (byHours && byHours.role) || sug.role || '';
    if (report.framework !== 'gardens') ({ staffType: stVal, role: roleVal } = mapSchoolsStaff(stVal, roleVal, exSchoolTypes));
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
  const outName = `דוח ביצוע ממולא - ${(report.budget_file_name || 'report.xlsx').replace(/\.xlsx?$/i, '')}.xlsx`;
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
