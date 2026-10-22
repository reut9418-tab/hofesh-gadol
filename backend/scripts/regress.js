#!/usr/bin/env node
/* שער רגרסיה לפני דחיפה (רעות 14.10.2026): מריץ את כל המסכים על דוחות
   אמיתיים קבועים מול המסד החי, מודד מספרים (שורות, שעות, עלות, סוגי צוות,
   עובדים חסרים בקובץ, בדיקות שלב 2, שורות בייצוא) ומשווה לתמונת מצב שמורה.
   כל סטייה שלא אושרה עוצרת את הדחיפה (hook pre-push).

   שימוש:
     node backend/scripts/regress.js             # השוואה לתמונת המצב — יציאה 1 בסטייה
     node backend/scripts/regress.js --update    # שמירת תמונת מצב חדשה (אחרי שינוי מכוון)
     node backend/scripts/regress.js --reports 92,117   # תת-קבוצה
     REGRESS_SKIP=1 git push                     # עקיפה מפורשת של השער

   הסקריפט מרים שרת פרטי על פורט 3198 (אותו קוד, אותו מסד) וסוגר אותו בסוף.
   הוא קורא בלבד — אינו משנה נתונים. */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const BACKEND = path.join(__dirname, '..');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env') });
const XLSX = require(path.join(BACKEND, 'node_modules', 'xlsx'));

const PORT = 3198;
const BASE = `http://localhost:${PORT}/api`;
const SNAPSHOT = path.join(__dirname, 'regress-snapshot.json');

/* הדוחות שנבדקים — לקוחות גדולים וכל סוגי המבנה (בתי"ס/גנים/מכינות, 15 יום/הרחבה,
   קבצים דו-מחזוריים, לשוניות לתקופות, כרטסות, סייעות רשות) */
const DEFAULT_REPORTS = [
  { id: 116, label: 'לביא בתי ספר 15 יום' }, { id: 117, label: 'לביא בתי ספר הרחבה' },
  { id: 114, label: 'לביא גנים 15 יום' }, { id: 115, label: 'לביא גנים הרחבה' },
  { id: 92, label: 'עכו בתי ספר 15 יום' }, { id: 136, label: 'אלקנה גנים 15 יום' }, { id: 137, label: 'אלקנה גנים הרחבה' },
  { id: 87, label: 'נבון חבל יבנה גנים הרחבה' }, { id: 88, label: 'נבון יואב גנים 15 יום' },
  { id: 127, label: 'קדימה גנים 15 יום' }, { id: 105, label: 'מעלה אדומים בתי ספר 15 יום' },
  { id: 7, label: 'נתניה בתי ספר 15 יום' }, { id: 70, label: 'קריית מוצקין גנים 15 יום' },
];

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const onlyArg = args.find((a) => a.startsWith('--reports'));
const only = onlyArg ? (onlyArg.split('=')[1] || args[args.indexOf(onlyArg) + 1] || '').split(',').map(Number).filter(Boolean) : null;
const REPORTS = only ? DEFAULT_REPORTS.filter((r) => only.includes(r.id)) : DEFAULT_REPORTS;

const r0 = (n) => Math.round(Number(n) || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const proc = spawn(process.execPath, ['server.js'], { cwd: BACKEND, env: { ...process.env, PORT: String(PORT), EXPORT_READONLY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try { const res = await fetch(`${BASE}/clients`); if (res.ok) return proc; } catch { /* עדיין עולה */ }
    if (proc.exitCode !== null) break;
  }
  proc.kill();
  throw new Error('השרת הפרטי לא עלה:\n' + log.slice(-800));
}

/* מדדים לדוח אחד */
async function measure(rep) {
  const m = { label: rep.label };
  const t0 = Date.now();
  // מסך ההכנה
  const prepRes = await fetch(`${BASE}/reports/${rep.id}/prep`);
  m.prep_status = prepRes.status;
  if (prepRes.ok) {
    const d = await prepRes.json();
    const rows = d.rows || [];
    m.prep_rows = rows.length;
    m.prep_hours = r0(rows.reduce((s, r) => s + (r.hours || 0), 0));
    m.prep_cost = r0(rows.reduce((s, r) => s + (r.cost || 0), 0));
    m.prep_no_symbol = rows.filter((r) => !r.symbol && !r.clubOperator && !r.zeroCost).length;
    m.prep_zero_cost = rows.filter((r) => r.zeroCost).length;
    const st = {}; for (const r of rows) st[r.staffType || '-'] = (st[r.staffType || '-'] || 0) + 1;
    m.prep_staff = st;
    m.prep_dup_workers = (() => { const c = {}; for (const r of rows) { const k = `${String(r.empId || '').replace(/\D/g, '')}|${r.dept}|${r.symbol}`; c[k] = (c[k] || 0) + 1; } return Object.values(c).filter((n) => n > 1).length; })();
    m.file_missing = d.fileDiff ? d.fileDiff.missingInFile.length : null;
    m.file_extra = d.fileDiff ? d.fileDiff.extraInFile.length : null;
    m.salary_overflow = d.salary ? r0(d.salary.overflow) : null;
    m.salary_unfunded = d.salary ? r0(d.salary.unfunded) : null;
  }
  // מכתב שלב 1
  const s1 = await fetch(`${BASE}/reports/${rep.id}/stage1-doc`);
  m.stage1_status = s1.status;
  if (s1.ok) { const html = await s1.text(); m.stage1_kb = Math.round(html.length / 1024); m.stage1_has_total = /סה"כ/.test(html); }
  // כרטסות + בדיקות שלב 2
  const lg = await fetch(`${BASE}/reports/${rep.id}/ledger`);
  m.ledger_status = lg.status;
  if (lg.ok) {
    const d = await lg.json();
    m.ledger_cards = (d.cards || []).length;
    m.ledger_checks = (d.reconcile && d.reconcile.checks || []).map((c) => `${c.id}:${c.level}`).sort().join(' ');
  }
  // ייצוא — לשונית כח האדם
  const ex = await fetch(`${BASE}/reports/${rep.id}/export`);
  m.export_status = ex.status;
  if (ex.ok) {
    const buf = Buffer.from(await ex.arrayBuffer());
    m.export_kb = Math.round(buf.length / 1024);
    try {
      const wb = XLSX.read(buf, { type: 'buffer' });
      const sn = wb.SheetNames.find((n) => /כח אדם/.test(n));
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null });
      const hi = aoa.findIndex((r) => r && r.some((c) => typeof c === 'string' && c.includes('סמל') && c.includes('מקום פעילות')));
      const head = aoa[hi] || [];
      const idc = head.findIndex((x) => typeof x === 'string' && /ת\.?ז/.test(x));
      const hc = head.findIndex((x) => typeof x === 'string' && /סך שעות|שעות/.test(x));
      const symc = 0;
      const rows = aoa.slice(hi + 1).filter((r) => String(r[idc] ?? '').replace(/\D/g, ''));
      m.export_rows = rows.length;
      m.export_hours = r0(rows.reduce((s, r) => s + (Number(r[hc]) || 0), 0));
      m.export_no_symbol = rows.filter((r) => !String(r[symc] ?? '').replace(/\D/g, '')).length;
      // ת.ז קצרה בלי הסבר בעמודת "הסבר במידה ולא תקין" — עם הסבר (דרכון/אזרחות זרה) היא לגיטימית (רעות 15.10)
      const expc = head.findIndex((x) => typeof x === 'string' && /הסבר/.test(x));
      m.export_short_ids = rows.filter((r) => String(r[idc] ?? '').replace(/\D/g, '').length < 5 && !(expc >= 0 && String(r[expc] ?? '').trim())).length;
      // סייעות רפואיות/אישיות נכתבות ללשונית (7) ולא לכח האדם — נספרות בנפרד (קדימה 23.10)
      const an = wb.SheetNames.find((n) => /רפואיות/.test(n));
      m.export_aides = 0;
      if (an) {
        const a2 = XLSX.utils.sheet_to_json(wb.Sheets[an], { header: 1, defval: null });
        const ah = a2.findIndex((r) => r && r.some((c) => typeof c === 'string' && /ת\.?ז\.? סייעת/.test(c)));
        const aid = (a2[ah] || []).findIndex((x) => typeof x === 'string' && /ת\.?ז\.? סייעת/.test(x));
        if (ah >= 0 && aid >= 0) m.export_aides = a2.slice(ah + 1).filter((r) => r && String(r[aid] ?? '').replace(/\D/g, '')).length;
      }
    } catch (e) { m.export_parse_error = e.message; }
  }
  // דוח התאמת שכר לבתי ספר (לא בגנים)
  const sm = await fetch(`${BASE}/reports/${rep.id}/salary-match-doc`);
  m.salary_match_status = sm.status;
  m.ms = Date.now() - t0;
  return m;
}

/* בדיקות תקינות במסד (קריאה בלבד) */
async function dbChecks() {
  const { initDatabase } = require(path.join(BACKEND, 'db.js'));
  const db = await initDatabase();
  const out = {};
  out.unrouted_rows = Number((await db.prepare('SELECT COUNT(*) n FROM cost_rows WHERE report_id IS NULL AND cost_file_id IN (SELECT id FROM cost_files WHERE routed = 1)').get()).n);
  // רק שורות שנותבו לדוח — לשונית שלא נותבה (קרית ביאליק 14.10: "גיליון1" בלי
  // עמודת שם מזוהה) אינה נכתבת לשום קובץ ואינה כשל
  out.totals_like_rows = Number((await db.prepare("SELECT COUNT(*) n FROM cost_rows WHERE report_id IS NOT NULL AND COALESCE(cost,0) > 0 AND COALESCE(exp_note,'') = '' AND (COALESCE(emp_name,'') = '' OR LENGTH(COALESCE(emp_id,'')) < 5)").get()).n);
  out.dup_rows = Number((await db.prepare("SELECT COUNT(*) n FROM (SELECT report_id, emp_id, dept, COALESCE(symbol_override, inst_symbol, '') s, COUNT(*) c FROM cost_rows WHERE report_id IS NOT NULL AND emp_id IS NOT NULL GROUP BY 1,2,3,4 HAVING COUNT(*) > 1) x").get()).n);
  out.reports_with_rows = Number((await db.prepare('SELECT COUNT(DISTINCT report_id) n FROM cost_rows WHERE report_id IS NOT NULL').get()).n);
  out.clients = Number((await db.prepare('SELECT COUNT(*) n FROM clients').get()).n);
  if (db.kind === 'postgres') {
    const rls = await db.prepare("SELECT COUNT(*) FILTER (WHERE NOT c.relrowsecurity) off_, COUNT(*) total FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'").get();
    out.rls_tables_off = Number(rls.off_);
    out.tables = Number(rls.total);
  }
  return out;
}

/* השוואה: מספרים — שווים (סכומים עד ±1); מחרוזות/אובייקטים — זהים */
function diffObj(prev, cur, prefix, diffs) {
  for (const k of new Set([...Object.keys(prev || {}), ...Object.keys(cur || {})])) {
    if (k === 'ms' || k === 'label') continue;
    const a = prev ? prev[k] : undefined, b = cur ? cur[k] : undefined;
    if (a && typeof a === 'object' && !Array.isArray(a)) { diffObj(a, b || {}, `${prefix}${k}.`, diffs); continue; }
    if (typeof a === 'number' && typeof b === 'number') {
      const tol = /hours|cost|kb|overflow|unfunded/.test(k) ? 1 : 0;
      if (Math.abs(a - b) > tol) diffs.push(`${prefix}${k}: ${a} → ${b}`);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${prefix}${k}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  }
}

(async () => {
  const started = Date.now();
  console.log(`▶ שער רגרסיה — ${REPORTS.length} דוחות${UPDATE ? ' (עדכון תמונת מצב)' : ''}`);
  let proc;
  const results = { db: null, reports: {} };
  try {
    results.db = await dbChecks();
    proc = await startServer();
    for (const rep of REPORTS) {
      const m = await measure(rep);
      results.reports[rep.id] = m;
      const bad = [m.prep_status, m.stage1_status, m.ledger_status, m.export_status].some((s) => s !== 200) || m.export_parse_error;
      console.log(`${bad ? '✗' : '✓'} ${rep.id} ${rep.label}: שורות ${m.prep_rows} | שעות ${m.prep_hours} | עלות ${m.prep_cost} | ייצוא ${m.export_rows} שורות | חסרים בקובץ ${m.file_missing ?? '-'} | ${Math.round(m.ms / 1000)}s${bad ? '  ← שגיאה' : ''}`);
    }
  } finally {
    if (proc) proc.kill();
  }

  // כשלים מוחלטים — בלי קשר לתמונת המצב
  const hard = [];
  for (const [id, m] of Object.entries(results.reports)) {
    for (const k of ['prep_status', 'stage1_status', 'ledger_status', 'export_status']) if (m[k] !== 200) hard.push(`${id}: ${k} = ${m[k]}`);
    if (m.export_parse_error) hard.push(`${id}: הייצוא לא נקרא — ${m.export_parse_error}`);
    if (m.export_short_ids) hard.push(`${id}: ${m.export_short_ids} שורות בייצוא עם ת.ז קצרה (שורת סיכום?)`);
    if (m.prep_rows != null && m.export_rows != null && m.prep_rows - m.prep_zero_cost - m.export_rows - (m.export_aides || 0) > 2) hard.push(`${id}: ${m.prep_rows - m.prep_zero_cost} שורות במסך אבל ${m.export_rows + (m.export_aides || 0)} בייצוא (כולל ${m.export_aides || 0} סייעות בלשונית 7)`);
  }
  if (results.db.totals_like_rows) hard.push(`מסד: ${results.db.totals_like_rows} שורות שנראות כשורת סיכום (בלי שם / ת.ז קצרה)`);
  if (results.db.rls_tables_off) hard.push(`אבטחה: RLS כבוי ב-${results.db.rls_tables_off} טבלאות`);

  if (UPDATE) {
    fs.writeFileSync(SNAPSHOT, JSON.stringify({ savedAt: new Date().toISOString(), ...results }, null, 2));
    console.log(`\n💾 תמונת מצב נשמרה: ${path.relative(process.cwd(), SNAPSHOT)}`);
    if (hard.length) { console.log('\n⚠ כשלים שנשמרו בתמונת המצב (לתקן!):'); hard.forEach((h) => console.log('   ' + h)); }
    console.log(`⏱ ${Math.round((Date.now() - started) / 1000)}s`);
    process.exit(hard.length ? 1 : 0);
  }

  const diffs = [];
  if (fs.existsSync(SNAPSHOT)) {
    const prev = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    diffObj(prev.db, results.db, 'מסד.', diffs);
    for (const rep of REPORTS) diffObj(prev.reports[rep.id], results.reports[rep.id], `${rep.id} ${rep.label} › `, diffs);
  } else console.log('\n(אין תמונת מצב — הרצה ראשונה; שמרי עם --update)');

  console.log('');
  if (hard.length) { console.log('✗ כשלים:'); hard.forEach((h) => console.log('   ' + h)); }
  if (diffs.length) { console.log(`✗ ${diffs.length} סטיות מתמונת המצב:`); diffs.forEach((d) => console.log('   ' + d)); console.log('   אם השינוי מכוון — node backend/scripts/regress.js --update'); }
  if (!hard.length && !diffs.length) console.log('✓ הכול תואם לתמונת המצב — אפשר לדחוף.');
  console.log(`⏱ ${Math.round((Date.now() - started) / 1000)}s`);
  process.exit(hard.length || diffs.length ? 1 : 0);
})().catch((e) => { console.error('✗ השער נכשל:', e.message); process.exit(1); });
