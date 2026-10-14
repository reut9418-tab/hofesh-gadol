#!/usr/bin/env node
/* בקרה יומית — שכבה 2 (רעות 14.10.2026): סוכן מתוזמן שבודק את האתר החי,
   את המסד ואת אבטחת המערכת, מדווח ומציע בלבד. שום דבר כאן לא משנה נתונים,
   קוד או הגדרות — ההחלטות של בן אדם.

   מה נבדק:
     אתר     — זמינות ומהירות (ממשק, /api/health, רשימת לקוחות, מסך הכנה אחד),
               כותרות אבטחה, CORS, גישה ללא אימות
     מסד     — נפח מול מכסת Supabase, RLS, הרשאות anon, חיבורים, תקינות נתונים
               (שורות לא מנותבות, שורות סיכום, כפילויות, קבצים חסרים במסד...)
     היגיינה — סודות בקוד, .env, npm audit, קומיטים שלא נדחפו, גיל תמונת הרגרסיה,
               hook pre-push, גיבוי

   פלט: תיקיית "בקרה יומית" (ברירת מחדל: ..\..\בקרה יומית ליד תיקיית הפרויקט)
     YYYY-MM-DD.json — הממצאים והמדדים (לסוכן ולהשוואה למחרת)
     YYYY-MM-DD.html — דוח קריא בעברית לרעות
   ההשוואה נעשית מול הריצה הקודמת באותה תיקייה: ממצאים חדשים / שנפתרו / שינויי מדדים.

   החלטות שאושרו (ממצאים "מוכרים" שלא מוצגים כחדשים): backend/scripts/daily-check-accepted.json
     { "<finding id>": { "note": "...", "at": "YYYY-MM-DD" } }

   שימוש:
     node backend/scripts/daily-check.js                 # ריצה מלאה (כ-2 דקות, רוב הזמן npm audit)
     node backend/scripts/daily-check.js --no-audit      # בלי npm audit
     node backend/scripts/daily-check.js --out <dir>     # תיקיית פלט אחרת
     node backend/scripts/daily-check.js --site https://... # אתר אחר (למשל שרת מקומי)
   יציאה: 0 תמיד כשהדוח נכתב; 2 כשהסקריפט עצמו נכשל. */

const path = require('path');
const fs = require('fs');
const { execSync, spawnSync } = require('child_process');

const BACKEND = path.join(__dirname, '..');
const ROOT = path.join(BACKEND, '..');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env') });

const args = process.argv.slice(2);
const argVal = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const SITE = argVal('--site', 'https://summer-vacation.gebmgroup.com').replace(/\/$/, '');
const OUT_DIR = argVal('--out', path.join(ROOT, '..', 'בקרה יומית'));
const NO_AUDIT = args.includes('--no-audit');
const ACCEPTED_PATH = path.join(__dirname, 'daily-check-accepted.json');
const SUPABASE_FREE_LIMIT = 500 * 1024 * 1024; // מכסת הדיסק של Supabase Free
const SAMPLE_REPORT = 92; // עכו בתי ספר 15 יום — מסך הכנה בינוני לבדיקת מהירות

const today = new Date();
const ymd = (d) => d.toISOString().slice(0, 10);
const DATE = ymd(today);

const findings = []; // { id, area, level, title, detail, proposal }
const metrics = {}; // מספרים להשוואה יומית
const LEVELS = { crit: 3, warn: 2, info: 1, ok: 0 };
function add(id, area, level, title, detail, proposal) {
  findings.push({ id, area, level, title, detail: detail || '', proposal: proposal || '' });
}

const fmtMB = (b) => `${Math.round(Number(b) / 1024 / 1024)}MB`;
const r0 = (n) => Math.round(Number(n) || 0);

/* ------------------------------------------------------------------ אתר חי */
async function timedFetch(url, opts, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, headers: new Headers(), text: '', ms: Date.now() - t0, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

async function checkSite() {
  // 1. הממשק
  const home = await timedFetch(`${SITE}/`);
  metrics.site_home_ms = home.ms;
  if (home.status !== 200) add('site.home', 'site', 'crit', 'הממשק לא נטען', `${SITE}/ החזיר ${home.status || home.error}`);
  else if (!/<div id="root"/.test(home.text)) add('site.home', 'site', 'warn', 'הממשק נטען אבל התוכן לא נראה כמו האפליקציה', `אורך ${home.text.length} תווים`);
  else add('site.home', 'site', 'ok', 'הממשק נטען', `${home.ms}ms`);

  // 2. /api/health — פעמיים: הראשונה חושפת התנעה קרה של Render
  const h1 = await timedFetch(`${SITE}/api/health`);
  const h2 = await timedFetch(`${SITE}/api/health`);
  metrics.site_health_ms = h1.ms;
  metrics.site_health_warm_ms = h2.ms;
  if (h1.status !== 200) add('site.health', 'site', 'crit', 'השרת (Render) לא עונה', `/api/health החזיר ${h1.status || h1.error} אחרי ${h1.ms}ms`, 'לבדוק את לוג Render; אם השרת קרס מזיכרון (512MB) — להעלות תוכנית או להקטין עומס');
  else if (h1.ms > 5000) add('site.health.cold', 'site', 'warn', 'השרת ישן והתעורר לאט', `הקריאה הראשונה ${h1.ms}ms, השנייה ${h2.ms}ms`, 'Render Free מרדים את השרת אחרי חוסר פעילות; ping כל 10 דקות או תוכנית בתשלום ימנעו "האתר חושב" בבוקר');
  else add('site.health', 'site', 'ok', 'השרת עונה', `${h1.ms}ms / ${h2.ms}ms`);

  // 3. רשימת לקוחות (קריאה אמיתית מהמסד דרך השרת)
  const cl = await timedFetch(`${SITE}/api/clients`, {}, 30000);
  metrics.site_clients_ms = cl.ms;
  let clientsCount = null;
  if (cl.status === 200) {
    try { const j = JSON.parse(cl.text); clientsCount = Array.isArray(j) ? j.length : (j.clients || []).length; } catch { /* לא JSON */ }
    metrics.site_clients = clientsCount;
    if (cl.ms > 8000) add('site.clients.slow', 'site', 'warn', 'רשימת הלקוחות איטית', `${cl.ms}ms`, 'מטמון העץ אמור להגיש מיד; אם זה חוזר — לבדוק עומס/זיכרון בשרת');
    else add('site.clients', 'site', 'ok', 'רשימת הלקוחות נטענת', `${clientsCount ?? '?'} לקוחות, ${cl.ms}ms`);
  } else add('site.clients', 'site', 'crit', 'רשימת הלקוחות לא נטענת', `/api/clients החזיר ${cl.status || cl.error}`);

  // 4. מסך הכנה לדוגמה — הנתיב הכבד ביותר שמשתמשים בו כל היום
  const prep = await timedFetch(`${SITE}/api/reports/${SAMPLE_REPORT}/prep`, {}, 60000);
  metrics.site_prep_ms = prep.ms;
  if (prep.status === 200) {
    let rows = null; try { rows = (JSON.parse(prep.text).rows || []).length; } catch { /* */ }
    metrics.site_prep_rows = rows;
    if (prep.ms > 15000) add('site.prep.slow', 'site', 'warn', `מסך ההכנה (דוח ${SAMPLE_REPORT}) איטי`, `${prep.ms}ms`, 'לבדוק אם השרת מחשב מחדש בריאות של כל הדוחות (מטמון התרוקן) או שהזיכרון קרוב ל-512MB');
    else add('site.prep', 'site', 'ok', `מסך ההכנה (דוח ${SAMPLE_REPORT}) עונה`, `${rows ?? '?'} שורות, ${prep.ms}ms`);
  } else add('site.prep', 'site', 'crit', `מסך ההכנה (דוח ${SAMPLE_REPORT}) נכשל`, `${prep.status || prep.error} אחרי ${prep.ms}ms`, 'להריץ node backend/scripts/regress.js --reports ' + SAMPLE_REPORT + ' מקומית כדי לראות את השגיאה');

  // 5. אבטחת HTTP
  const H = (name) => (h1.headers.get(name) || home.headers.get(name) || '');
  if (!home.headers.get('strict-transport-security')) add('sec.hsts', 'security', 'info', 'אין כותרת HSTS', 'הדפדפן לא מחויב ל-HTTPS בביקורים הבאים', 'להפעיל HSTS ב-Cloudflare (SSL/TLS ← Edge Certificates ← HSTS) — שינוי הגדרה, בלי קוד');
  if (!home.headers.get('content-security-policy')) add('sec.csp', 'security', 'info', 'אין Content-Security-Policy', 'הממשק טוען סקריפטים בלי מדיניות מקור', 'להוסיף כותרת CSP ב-Worker (worker/index.js) — לבדוק שהממשק עדיין עובד');
  if (!home.headers.get('x-content-type-options')) add('sec.nosniff', 'security', 'info', 'אין X-Content-Type-Options', '', 'להוסיף nosniff ב-Worker');
  if (!home.headers.get('x-frame-options') && !/frame-ancestors/.test(home.headers.get('content-security-policy') || '')) add('sec.frame', 'security', 'info', 'אפשר להטמיע את האתר ב-iframe באתר אחר (clickjacking)', '', 'להוסיף X-Frame-Options: DENY ב-Worker');
  if (H('x-powered-by')) add('sec.poweredby', 'security', 'info', 'השרת מזהה את עצמו (x-powered-by: Express)', 'מידע לתוקף על הטכנולוגיה', 'app.disable("x-powered-by") ב-server.js — שורה אחת, בלי סיכון');

  // CORS: האם השרת משקף כל מקור? (קריאה בלבד עם Origin זר)
  const cors = await timedFetch(`${SITE}/api/health`, { headers: { Origin: 'https://evil.example' } });
  const acao = cors.headers.get('access-control-allow-origin') || '';
  metrics.site_cors_origin = acao;
  if (acao === '*' || acao === 'https://evil.example') add('sec.cors', 'security', 'crit', 'CORS פתוח לכל מקור', `Access-Control-Allow-Origin: ${acao}`, 'לקבוע CORS_ORIGIN לדומיין האתר בלבד ב-Render');
  else if (acao && !acao.includes(new URL(SITE).hostname)) add('sec.cors.mismatch', 'security', 'info', 'CORS_ORIGIN בשרת אינו הדומיין של האתר', `מוגדר ${acao}; האתר ${SITE}. לא מזיק (הקריאות עוברות דרך ה-Worker באותו דומיין), אבל מבלבל`, 'לעדכן CORS_ORIGIN ב-Render לדומיין הנכון — או להשאיר ולתעד');

  // אימות: ה-API פתוח לכל מי שיודע את הכתובת
  if (cl.status === 200 && clientsCount) add('sec.noauth', 'security', 'crit', 'ה-API נגיש ללא אימות', `כל מי שמכיר את הכתובת יכול לקרוא ולשנות את נתוני כל ${clientsCount} הלקוחות (שמות עובדים, ת.ז, שכר)`, 'אופציות לפי סדר קושי: (א) Cloudflare Access על הדומיין — כניסה במייל של GEBM בלבד, בלי שינוי קוד; (ב) סיסמה משותפת ב-Worker; (ג) כניסת משתמשים אמיתית באפליקציה. המלצה: (א)');
}

/* ----------------------------------------------------------------------- מסד */
async function checkDb() {
  const { initDatabase } = require(path.join(BACKEND, 'db.js'));
  let db;
  try { db = await initDatabase(); }
  catch (e) {
    add('db.connect', 'data', 'crit', 'אין חיבור למסד', e.message, 'ה-DNS של Supabase נופל לפעמים — להריץ שוב; אם זה חוזר, לבדוק את מצב הפרויקט ב-Supabase');
    return;
  }
  const q = async (sql, ...p) => (await db.prepare(sql).all(...p));
  const one = async (sql, ...p) => (await db.prepare(sql).get(...p)) || {};
  const n = async (sql, ...p) => Number((await one(sql, ...p)).n || 0);
  const pg = db.kind === 'postgres';
  add('db.connect', 'data', 'ok', 'חיבור למסד', pg ? 'Supabase Postgres' : 'SQLite מקומי');

  if (pg) {
    // נפח מול מכסה
    const sz = await one('SELECT pg_database_size(current_database()) b');
    metrics.db_bytes = Number(sz.b);
    const pct = Math.round(100 * Number(sz.b) / SUPABASE_FREE_LIMIT);
    const big = await q("SELECT c.relname, pg_total_relation_size(c.oid) b FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY 2 DESC LIMIT 3");
    const bigTxt = big.map((t) => `${t.relname} ${fmtMB(t.b)}`).join(', ');
    const lvl = pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok';
    add('db.size', 'data', lvl, `נפח המסד ${fmtMB(sz.b)} — ${pct}% ממכסת Supabase Free (500MB)`, `הגדולות: ${bigTxt}`,
      lvl === 'ok' ? '' : 'report_files שומרת את קובצי המשרד המקוריים (2-3MB כל אחד). אפשרויות: (א) למחוק קבצים של דוחות שהוגשו ונסגרו אחרי ייצוא; (ב) לדחוס (gzip) לפני שמירה — חוסך כ-70%; (ג) לעבור ל-Supabase Pro (8GB). כש-Supabase עובר ל-read-only, האתר מפסיק לשמור.');

    // RLS
    const rls = await one("SELECT COUNT(*) FILTER (WHERE NOT c.relrowsecurity) off_, COUNT(*) total, string_agg(c.relname, ', ') FILTER (WHERE NOT c.relrowsecurity) names FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'");
    metrics.db_tables = Number(rls.total); metrics.db_rls_off = Number(rls.off_);
    if (Number(rls.off_)) add('sec.rls', 'security', 'crit', `RLS כבוי ב-${rls.off_} טבלאות`, rls.names, 'ALTER TABLE <שם> ENABLE ROW LEVEL SECURITY — כמו שנעשה ב-14.10 לכל הטבלאות');
    else add('sec.rls', 'security', 'ok', `RLS פעיל בכל ${rls.total} הטבלאות`);

    // מדיניות שמאפשרת ל-anon
    const pol = await q("SELECT tablename, policyname, roles::text r FROM pg_policies WHERE schemaname='public'");
    const anonPol = pol.filter((p) => /anon|public|authenticated/.test(p.r));
    if (anonPol.length) add('sec.rls.policies', 'security', 'warn', `${anonPol.length} מדיניות RLS פותחות גישה ל-anon/authenticated`, anonPol.map((p) => `${p.tablename}: ${p.policyname} (${p.r})`).join('; '), 'לבדוק מי יצר אותן; השרת מתחבר כ-postgres ולא צריך מדיניות');

    // הרשאות anon/authenticated (RLS חוסם אותן בפועל, אבל עדיף לא להסתמך על זה בלבד)
    const grants = await q("SELECT grantee, COUNT(DISTINCT table_name) t FROM information_schema.role_table_grants WHERE grantee IN ('anon','authenticated') AND table_schema='public' GROUP BY 1");
    const gt = grants.map((g) => `${g.grantee}: ${g.t} טבלאות`).join(', ');
    if (grants.length) add('sec.grants', 'security', 'info', 'ל-anon/authenticated יש הרשאות מלאות על הטבלאות (ברירת מחדל של Supabase)', `${gt}. RLS פעיל בלי מדיניות — לכן בפועל הם חסומים. שכבת הגנה אחת בלבד.`, 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated; — האתר לא ישתנה (השרת = postgres). שכבת הגנה שנייה.');

    // תפקידים עם BYPASSRLS מעבר לברירות המחדל של Supabase
    const roles = await q("SELECT rolname FROM pg_roles WHERE rolbypassrls AND rolname NOT IN ('supabase_admin','service_role','postgres','supabase_read_only_user','supabase_etl_admin','supabase_storage_admin','supabase_auth_admin')");
    if (roles.length) add('sec.roles', 'security', 'warn', 'תפקידים לא מוכרים עם BYPASSRLS', roles.map((r) => r.rolname).join(', '), 'לבדוק מי יצר אותם ולמחוק אם לא נדרשים');

    // חיבורים
    const conns = await one("SELECT COUNT(*) n, COUNT(*) FILTER (WHERE state='active') act FROM pg_stat_activity WHERE datname=current_database()");
    metrics.db_connections = Number(conns.n);
    if (Number(conns.n) > 40) add('db.conns', 'data', 'warn', `${conns.n} חיבורים פתוחים למסד`, `${conns.act} פעילים. Supabase Free מוגבל ל-60`, 'לבדוק אם שרתים ישנים (Render ישן / Worker ניסיוני) עדיין מחוברים');
    else add('db.conns', 'data', 'ok', `${conns.n} חיבורים למסד`, `${conns.act} פעילים`);
  }

  // --- תקינות נתונים (אותן בדיקות כמו שער הרגרסיה + נוספות) ---
  metrics.clients = await n('SELECT COUNT(*) n FROM clients');
  metrics.reports = await n('SELECT COUNT(*) n FROM reports');
  metrics.reports_with_rows = await n('SELECT COUNT(DISTINCT report_id) n FROM cost_rows WHERE report_id IS NOT NULL');
  metrics.cost_rows = await n('SELECT COUNT(*) n FROM cost_rows');
  metrics.cost_files = await n('SELECT COUNT(*) n FROM cost_files');

  const unroutedBy = await q('SELECT c.name client, cf.filename, COUNT(*) n FROM cost_rows r JOIN cost_files cf ON cf.id = r.cost_file_id JOIN clients c ON c.id = cf.client_id WHERE r.report_id IS NULL AND cf.routed = 1 GROUP BY 1,2 ORDER BY 3 DESC');
  const unrouted = unroutedBy.reduce((s, t) => s + Number(t.n), 0);
  metrics.unrouted_rows = unrouted;
  metrics.unrouted_files = unroutedBy.length;
  if (unrouted) add('data.unrouted', 'data', 'warn', `${unrouted} שורות עובדים ב-${unroutedBy.length} קבצים מנותבים לא שייכות לאף דוח`, 'השורות לא מופיעות באף מסך הכנה. ' + unroutedBy.slice(0, 6).map((t) => `${t.client} — ${t.filename}: ${t.n}`).join('; ') + (unroutedBy.length > 6 ? '…' : ''), 'חלקן מכוונות (מחלקות שלא בתכנית, קבצים של חודשים קודמים). במסך "דוחות עלות" של הלקוח — לנתב מחדש, או למחוק קובץ ישן שהוחלף');

  const totals = await q("SELECT cf.client_id, c.name client, cf.filename, COUNT(*) n FROM cost_rows r JOIN cost_files cf ON cf.id = r.cost_file_id JOIN clients c ON c.id = cf.client_id WHERE COALESCE(r.cost,0) > 0 AND (COALESCE(r.emp_name,'') = '' OR LENGTH(COALESCE(r.emp_id,'')) < 5) GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 5");
  metrics.totals_like_rows = totals.reduce((s, t) => s + Number(t.n), 0);
  if (totals.length) add('data.totals', 'data', 'warn', `${metrics.totals_like_rows} שורות שנראות כשורת סיכום (בלי שם / ת.ז קצרה)`, totals.map((t) => `${t.client} — ${t.filename}: ${t.n}`).join('; '), 'לקלוט מחדש את הקובץ (הקליטה החדשה מדלגת על שורות סיכום) או למחוק את השורות');

  const dups = await q("SELECT r.report_id, COUNT(*) n FROM (SELECT report_id, emp_id, dept, COALESCE(symbol_override, inst_symbol, '') s FROM cost_rows WHERE report_id IS NOT NULL AND emp_id IS NOT NULL GROUP BY 1,2,3,4 HAVING COUNT(*) > 1) r GROUP BY 1 ORDER BY 2 DESC LIMIT 5");
  metrics.dup_rows = dups.reduce((s, t) => s + Number(t.n), 0);
  if (dups.length) add('data.dups', 'data', 'warn', `${metrics.dup_rows} עובדים כפולים (אותה ת.ז + מחלקה + סמל) בדוח`, dups.map((d) => `דוח ${d.report_id}: ${d.n}`).join('; '), 'לבדוק במסך ההכנה של הדוח — כפילות מקליטה כפולה או שני קבצים לאותה תקופה');

  const orphans = await n('SELECT COUNT(*) n FROM cost_rows WHERE report_id IS NOT NULL AND report_id NOT IN (SELECT id FROM reports)');
  if (orphans) add('data.orphans', 'data', 'warn', `${orphans} שורות עובדים משויכות לדוח שנמחק`, '', 'DELETE FROM cost_rows WHERE report_id NOT IN (SELECT id FROM reports) — אחרי אישור');

  const noFile = await q('SELECT r.id, r.budget_file_name FROM reports r LEFT JOIN report_files f ON f.report_id = r.id WHERE r.budget_file_name IS NOT NULL AND f.report_id IS NULL');
  metrics.reports_missing_file = noFile.length;
  if (noFile.length) add('data.missing_budget_file', 'data', 'crit', `${noFile.length} דוחות עם קובץ משרד שלא שמור במסד`, noFile.map((r) => `דוח ${r.id}: ${r.budget_file_name}`).join('; '), 'הדיסק של Render מתאפס בכל פריסה — הייצוא של הדוחות האלה ייכשל. להעלות את קובץ המשרד מחדש');

  const noBlob = await q('SELECT cf.id, cf.filename, c.name client FROM cost_files cf JOIN clients c ON c.id = cf.client_id LEFT JOIN cost_file_blobs b ON b.cost_file_id = cf.id WHERE b.cost_file_id IS NULL');
  metrics.cost_files_missing_blob = noBlob.length;
  if (noBlob.length) add('data.missing_cost_blob', 'data', 'info', `${noBlob.length} דוחות עלות בלי הקובץ המקורי במסד`, noBlob.slice(0, 5).map((r) => `${r.client}: ${r.filename}`).join('; ') + (noBlob.length > 5 ? '…' : ''), 'קליטה מחדש / שיוך עמודות לא יעבדו להם; לא דחוף אם הנתונים כבר נקלטו');

  const stale = await q(pg
    ? "SELECT cf.id, cf.filename, c.name client, cf.created_at FROM cost_files cf JOIN clients c ON c.id = cf.client_id WHERE cf.routed = 0 AND cf.created_at < now() - interval '3 days'"
    : "SELECT cf.id, cf.filename, c.name client, cf.created_at FROM cost_files cf JOIN clients c ON c.id = cf.client_id WHERE cf.routed = 0 AND cf.created_at < datetime('now','-3 days')");
  metrics.stale_unrouted_files = stale.length;
  if (stale.length) add('data.stale_files', 'data', 'info', `${stale.length} דוחות עלות שהועלו לפני יותר מ-3 ימים ולא נותבו`, stale.slice(0, 5).map((r) => `${r.client}: ${r.filename}`).join('; '), 'לנתב או למחוק — קובץ שלא נותב לא נכנס לשום דוח');

  const emptyReports = await q("SELECT r.id, c.name client, r.framework, r.program FROM reports r JOIN clients c ON c.id = r.client_id WHERE r.has_cost_report = 1 AND NOT EXISTS (SELECT 1 FROM cost_rows x WHERE x.report_id = r.id)");
  if (emptyReports.length) add('data.empty_reports', 'data', 'info', `${emptyReports.length} דוחות מסומנים "יש דוח עלות" בלי שורות`, emptyReports.slice(0, 5).map((r) => `דוח ${r.id} ${r.client}`).join('; '), 'הדגל has_cost_report נשאר אחרי מחיקת קובץ — לאפס אחרי אישור');

  const noPayer = await q("SELECT lf.id, lf.filename, c.name client FROM ledger_files lf JOIN reports r ON r.id = lf.report_id JOIN clients c ON c.id = r.client_id WHERE COALESCE(lf.payer,'') = ''");
  metrics.ledgers_no_payer = noPayer.length;
  if (noPayer.length) add('data.ledger_payer', 'data', 'info', `${noPayer.length} כרטסות בלי משלם`, noPayer.slice(0, 5).map((r) => `${r.client}: ${r.filename}`).join('; '), 'ידוע (המשכיל חולון, יבנה גנים) — לקבוע משלם במסך הכרטסות');

  const dupClients = await q('SELECT name, COUNT(*) n, string_agg(id::text, \',\') ids FROM clients GROUP BY name HAVING COUNT(*) > 1').catch(() => []);
  if (dupClients.length) add('data.dup_clients', 'data', 'info', `${dupClients.length} שמות לקוח כפולים`, dupClients.map((c) => `${c.name} (${c.ids})`).join('; '), 'למחוק את הכפיל הריק (ידוע: לביא 71)');

  const emptyClients = await q('SELECT c.id, c.name FROM clients c WHERE NOT EXISTS (SELECT 1 FROM reports r WHERE r.client_id = c.id)');
  if (emptyClients.length) add('data.empty_clients', 'data', 'info', `${emptyClients.length} לקוחות בלי דוחות`, emptyClients.map((c) => `${c.name} (${c.id})`).join(', '));

  const badIds = await n("SELECT COUNT(*) n FROM cost_rows WHERE report_id IS NOT NULL AND emp_id IS NOT NULL AND emp_id <> '' AND emp_id ~ '[^0-9]'").catch(() => 0);
  metrics.nondigit_ids = badIds;
  if (badIds) add('data.nondigit_ids', 'data', 'info', `${badIds} שורות עם ת.ז שאינה ספרות בלבד`, 'דרכונים / תווים זרים — הייצוא כותב אותם כפי שהם', 'לבדוק שיש הסבר (exp_note) לכל אחת');

  const wildHours = await q('SELECT r.report_id, COUNT(*) n FROM cost_rows r WHERE r.report_id IS NOT NULL AND (r.hours > 250 OR r.cost < 0 OR r.gross < 0) GROUP BY 1 ORDER BY 2 DESC LIMIT 5');
  metrics.wild_rows = wildHours.reduce((s, t) => s + Number(t.n), 0);
  if (wildHours.length) add('data.wild_values', 'data', 'warn', `${metrics.wild_rows} שורות עם ערכים חשודים (מעל 250 שעות או עלות שלילית)`, wildHours.map((d) => `דוח ${d.report_id}: ${d.n}`).join('; '), 'לבדוק שיוך עמודות של הקובץ — שעות שנקראו מעמודת סכום?');

  // פעילות אחרונה — כדי לדעת שהמערכת בשימוש ושהקליטה עובדת
  const last = await one('SELECT (SELECT MAX(created_at) FROM cost_rows) rows_at, (SELECT MAX(created_at) FROM cost_files) files_at, (SELECT MAX(created_at) FROM reports) rep_at');
  metrics.last_cost_file_at = last.files_at ? new Date(last.files_at).toISOString() : null;
  const daysSince = last.files_at ? Math.floor((Date.now() - new Date(last.files_at).getTime()) / 86400000) : null;
  add('data.activity', 'data', 'ok', 'פעילות אחרונה', `דוח עלות אחרון הועלה ${daysSince == null ? '-' : daysSince === 0 ? 'היום' : daysSince === 1 ? 'אתמול' : `לפני ${daysSince} ימים`}; ${metrics.clients} לקוחות, ${metrics.reports} דוחות (${metrics.reports_with_rows} עם עובדים), ${metrics.cost_rows} שורות עובדים`);

  if (db.pool) await db.pool.end().catch(() => {});
}

/* -------------------------------------------------------------- היגיינה/קוד */
function sh(cmd, cwd, timeout = 120000) {
  try { return execSync(cmd, { cwd: cwd || ROOT, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); }
  catch (e) { return (e.stdout || '').toString().trim(); }
}

function checkRepo() {
  // סודות בקבצים שבגיט
  const tracked = sh('git ls-files', ROOT).split('\n').filter(Boolean);
  if (tracked.some((f) => /(^|\/)\.env$/.test(f))) add('sec.env_tracked', 'security', 'crit', 'קובץ .env נמצא בגיט', 'מחרוזת החיבור למסד חשופה בריפו', 'git rm --cached backend/.env, להחליף את סיסמת המסד ב-Supabase');
  else add('sec.env_tracked', 'security', 'ok', '.env לא בגיט');
  const secretRe = /(postgres(ql)?:\/\/[^\s'"]+:[^\s'"]+@|eyJhbGciOi[A-Za-z0-9_-]{20,}|sb_secret_|service_role)/;
  const leaks = [];
  for (const f of tracked) {
    if (!/\.(js|ts|tsx|json|jsonc|md|yml|yaml|html|bat|toml|env\.example)$/i.test(f)) continue;
    try { const txt = fs.readFileSync(path.join(ROOT, f), 'utf8'); if (secretRe.test(txt) && !/\.example$/.test(f)) leaks.push(f); } catch { /* */ }
  }
  if (leaks.length) add('sec.secrets_in_code', 'security', 'crit', 'מחרוזות שנראות כסודות בקבצים שבגיט', leaks.join(', '), 'להסיר מהקוד, לעבור ל-.env, ולהחליף את הסוד (הוא כבר בהיסטוריה)');
  else add('sec.secrets_in_code', 'security', 'ok', 'לא נמצאו סודות בקוד שבגיט');

  // גיט: לא נדחף / לא קומט
  const unpushed = sh('git log --oneline @{u}..HEAD', ROOT).split('\n').filter(Boolean);
  metrics.git_unpushed = unpushed.length;
  if (unpushed.length) add('hyg.unpushed', 'hygiene', 'info', `${unpushed.length} קומיטים מקומיים שלא נדחפו`, unpushed.slice(0, 5).join(' | '), 'לדחוף בזמן שקט (כל דחיפה מאתחלת את השרת לדקה-שתיים)');
  const dirty = sh('git status --porcelain', ROOT).split('\n').filter(Boolean);
  const dirtyTracked = dirty.filter((l) => !l.startsWith('??'));
  metrics.git_dirty = dirtyTracked.length;
  if (dirtyTracked.length) add('hyg.dirty', 'hygiene', 'info', `${dirtyTracked.length} קבצים בגיט עם שינויים לא שמורים`, dirtyTracked.map((l) => l.slice(3)).join(', '), 'שינויים מקומיים לא נמצאים באתר ולא מגובים — לקמט או לבטל');

  // hook pre-push
  const hook = path.join(ROOT, '.git', 'hooks', 'pre-push');
  const src = path.join(BACKEND, 'scripts', 'pre-push.sh');
  if (!fs.existsSync(hook)) add('hyg.hook', 'hygiene', 'warn', 'שער הרגרסיה (pre-push) לא מותקן', '', 'cp backend/scripts/pre-push.sh .git/hooks/pre-push');
  else if (fs.existsSync(src) && fs.readFileSync(hook, 'utf8') !== fs.readFileSync(src, 'utf8')) add('hyg.hook', 'hygiene', 'info', 'ה-hook המותקן שונה מהגרסה שבריפו', '', 'cp backend/scripts/pre-push.sh .git/hooks/pre-push');
  else add('hyg.hook', 'hygiene', 'ok', 'שער הרגרסיה מותקן');

  // גיל תמונת הרגרסיה
  const snap = path.join(BACKEND, 'scripts', 'regress-snapshot.json');
  if (fs.existsSync(snap)) {
    try {
      const s = JSON.parse(fs.readFileSync(snap, 'utf8'));
      const age = Math.floor((Date.now() - new Date(s.savedAt).getTime()) / 86400000);
      metrics.regress_snapshot_age_days = age;
      if (age > 14) add('hyg.snapshot_age', 'hygiene', 'info', `תמונת הרגרסיה בת ${age} ימים`, 'נתוני הלקוחות משתנים — סטיות "מכוונות" מתערבבות עם רגרסיות', 'node backend/scripts/regress.js --update אחרי אימות שהכול תקין');
    } catch { /* */ }
  } else add('hyg.snapshot', 'hygiene', 'warn', 'אין תמונת רגרסיה', '', 'node backend/scripts/regress.js --update');

  // גיבוי
  const backupDir = path.join(OUT_DIR, 'גיבויים');
  const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => /\.(json|sql|gz|zip)$/.test(f)).sort() : [];
  metrics.backups = backups.length;
  if (!backups.length) add('hyg.backup', 'hygiene', 'warn', 'אין גיבוי של המסד מחוץ ל-Supabase', 'Supabase Free שומר גיבוי יומי ל-7 ימים בלבד ואין שחזור לנקודת זמן', 'סקריפט גיבוי יומי של הטבלאות (בלי הקבצים הבינאריים — כ-15MB) לתיקיית "בקרה יומית\\גיבויים" + העתק ל-Google Drive. אפשר להוסיף לסוכן הזה בריצה הבאה אחרי אישור');
  else {
    const lastB = backups[backups.length - 1];
    const ageDays = Math.floor((Date.now() - fs.statSync(path.join(backupDir, lastB)).mtimeMs) / 86400000);
    if (ageDays > 2) add('hyg.backup', 'hygiene', 'warn', `הגיבוי האחרון בן ${ageDays} ימים`, lastB, 'להריץ את סקריפט הגיבוי');
    else add('hyg.backup', 'hygiene', 'ok', `גיבוי אחרון: ${lastB}`);
  }
}

function checkAudit() {
  for (const dir of ['backend', 'frontend']) {
    const cwd = path.join(ROOT, dir);
    if (!fs.existsSync(path.join(cwd, 'package-lock.json'))) continue;
    const res = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--json', '--omit=dev'], { cwd, encoding: 'utf8', timeout: 180000, shell: process.platform === 'win32', windowsHide: true });
    let j = null;
    try { j = JSON.parse(res.stdout || '{}'); } catch { /* */ }
    if (!j || !j.metadata) { add(`hyg.audit.${dir}`, 'hygiene', 'info', `npm audit (${dir}) לא רץ`, (res.stderr || '').slice(0, 200) || 'אין רשת / npm לא זמין'); continue; }
    const v = j.metadata.vulnerabilities || {};
    metrics[`audit_${dir}_high`] = (v.high || 0) + (v.critical || 0);
    metrics[`audit_${dir}_total`] = v.total || 0;
    const names = Object.entries(j.vulnerabilities || {}).filter(([, x]) => /high|critical/.test(x.severity)).map(([k, x]) => `${k} (${x.severity}${x.fixAvailable ? ', יש תיקון' : ''})`);
    if (v.critical) add(`hyg.audit.${dir}`, 'hygiene', 'warn', `npm audit (${dir}): ${v.critical} פגיעויות קריטיות, ${v.high || 0} גבוהות`, names.join(', '), `npm audit fix ב-${dir} — ואז להריץ את שער הרגרסיה לפני דחיפה`);
    else if (v.high) add(`hyg.audit.${dir}`, 'hygiene', 'info', `npm audit (${dir}): ${v.high} פגיעויות גבוהות`, names.join(', '), `npm audit fix ב-${dir} בזמן שקט (רוב הפגיעויות בחבילות שרת פנימיות, לא חשופות למשתמש)`);
    else add(`hyg.audit.${dir}`, 'hygiene', 'ok', `npm audit (${dir}): ${v.total || 0} פגיעויות, אף אחת גבוהה`);
  }
}

/* ------------------------------------------------------------ השוואה/פלט */
function loadPrevious() {
  if (!fs.existsSync(OUT_DIR)) return null;
  const files = fs.readdirSync(OUT_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== `${DATE}.json`).sort();
  if (!files.length) return null;
  try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, files[files.length - 1]), 'utf8')); } catch { return null; }
}

function compare(prev) {
  if (!prev) return null;
  const prevIds = new Map((prev.findings || []).filter((f) => f.level !== 'ok').map((f) => [f.id, f]));
  const curIds = new Map(findings.filter((f) => f.level !== 'ok').map((f) => [f.id, f]));
  const newF = [...curIds.values()].filter((f) => !prevIds.has(f.id));
  const resolved = [...prevIds.values()].filter((f) => !curIds.has(f.id));
  const escalated = [...curIds.values()].filter((f) => prevIds.has(f.id) && LEVELS[f.level] > LEVELS[prevIds.get(f.id).level]);
  const deltas = [];
  for (const k of Object.keys(metrics)) {
    const a = prev.metrics ? prev.metrics[k] : undefined, b = metrics[k];
    if (typeof a === 'number' && typeof b === 'number' && a !== b && !/_ms$/.test(k)) deltas.push({ key: k, from: a, to: b });
  }
  return { date: prev.date, new: newF.map((f) => f.id), resolved: resolved.map((f) => f.id), escalated: escalated.map((f) => f.id), deltas };
}

const AREA = { site: 'האתר החי', data: 'המסד והנתונים', security: 'אבטחה', hygiene: 'קוד וגיבוי' };
const LEVEL_HE = { crit: 'קריטי', warn: 'אזהרה', info: 'לידיעה', ok: 'תקין' };
const METRIC_HE = {
  db_bytes: 'נפח המסד (בתים)', clients: 'לקוחות', reports: 'דוחות', reports_with_rows: 'דוחות עם עובדים', cost_rows: 'שורות עובדים', cost_files: 'דוחות עלות',
  unrouted_rows: 'שורות לא מנותבות', totals_like_rows: 'שורות סיכום', dup_rows: 'כפילויות', db_connections: 'חיבורים למסד', db_rls_off: 'טבלאות בלי RLS',
  git_unpushed: 'קומיטים לא נדחפו', git_dirty: 'קבצים לא שמורים', backups: 'גיבויים', site_clients: 'לקוחות באתר', site_prep_rows: 'שורות במסך ההכנה לדוגמה',
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderHtml(result) {
  const { findings: F, comparison: C, accepted } = result;
  const counts = { crit: 0, warn: 0, info: 0, ok: 0 };
  for (const f of F) counts[f.level]++;
  const badge = (lvl) => `<span class="lvl ${lvl}">${LEVEL_HE[lvl]}</span>`;
  const isNew = (id) => C && C.new.includes(id);
  const row = (f) => `<li class="f ${f.level}${accepted[f.id] ? ' acc' : ''}">${badge(f.level)} <b>${esc(f.title)}</b>${isNew(f.id) ? ' <span class="new">חדש</span>' : ''}${accepted[f.id] ? ` <span class="accn" title="${esc(accepted[f.id].note)}">מוכר · ${esc(accepted[f.id].at)}</span>` : ''}${f.detail ? `<div class="d">${esc(f.detail)}</div>` : ''}${f.proposal ? `<div class="p">💡 ${esc(f.proposal)}</div>` : ''}</li>`;
  const sections = Object.keys(AREA).map((a) => {
    const fs_ = F.filter((f) => f.area === a).sort((x, y) => LEVELS[y.level] - LEVELS[x.level]);
    return `<h2>${AREA[a]}</h2><ul>${fs_.map(row).join('')}</ul>`;
  }).join('');
  const proposals = F.filter((f) => f.proposal && f.level !== 'ok' && !accepted[f.id]).sort((x, y) => LEVELS[y.level] - LEVELS[x.level]);
  const propHtml = proposals.length ? `<ol class="props">${proposals.map((f) => `<li>${badge(f.level)} <b>${esc(f.title)}</b><br>${esc(f.proposal)}<div class="id">מזהה: <code>${f.id}</code></div></li>`).join('')}</ol>` : '<p>אין הצעות פתוחות.</p>';
  const cmp = C ? `<p>מול ${C.date}: ${C.new.length ? `<b>${C.new.length} ממצאים חדשים</b>` : 'אין ממצאים חדשים'}, ${C.resolved.length} נפתרו${C.escalated.length ? `, ${C.escalated.length} החמירו` : ''}.${C.deltas.length ? ' שינויים: ' + C.deltas.map((d) => `${METRIC_HE[d.key] || d.key} ${d.from}→${d.to}`).join(', ') : ''}</p>` : '<p>ריצה ראשונה — אין השוואה.</p>';
  const worst = counts.crit ? 'crit' : counts.warn ? 'warn' : 'ok';
  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>בקרה יומית ${DATE}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#222;background:#fff}
h1{margin:0 0 4px}h2{margin:28px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px;font-size:1.1em}
.sum{padding:12px 16px;border-radius:8px;margin:12px 0;background:#f3f4f6;border-right:6px solid #9ca3af}.sum.crit{border-color:#dc2626;background:#fef2f2}.sum.warn{border-color:#d97706;background:#fffbeb}.sum.ok{border-color:#16a34a;background:#f0fdf4}
ul{list-style:none;padding:0;margin:0}.f{padding:8px 10px;border-bottom:1px solid #f1f1f1}.f.ok{color:#555}.f.acc{opacity:.7}
.lvl{display:inline-block;font-size:.75em;padding:1px 8px;border-radius:10px;color:#fff;background:#9ca3af;vertical-align:middle}.lvl.crit{background:#dc2626}.lvl.warn{background:#d97706}.lvl.info{background:#2563eb}.lvl.ok{background:#16a34a}
.new{background:#fde68a;font-size:.75em;padding:1px 6px;border-radius:6px}.accn{font-size:.75em;color:#666}.d{color:#444;font-size:.92em;margin-top:3px}.p{margin-top:4px;font-size:.92em;color:#1e3a8a}
.props li{margin:8px 0;padding:8px 10px;background:#f8fafc;border-radius:6px}.id{font-size:.75em;color:#888;margin-top:2px}code{font-size:.9em}
.meta{color:#777;font-size:.85em}</style></head><body>
<h1>בקרה יומית — בקרת והכנת דוחות חופש גדול</h1>
<div class="meta">${DATE} · ${new Date(result.startedAt).toLocaleTimeString('he-IL')} · ${Math.round(result.ms / 1000)} שניות · ${esc(SITE)}</div>
<div class="sum ${worst}"><b>${counts.crit} קריטי · ${counts.warn} אזהרות · ${counts.info} לידיעה · ${counts.ok} תקין</b>${cmp}</div>
<h2>הצעות לביצוע — ממתינות להחלטה של רעות</h2>${propHtml}
<p class="meta">כשמחליטים "לא עכשיו / מקובל", מוסיפים את המזהה ל-backend/scripts/daily-check-accepted.json והממצא יוצג כ"מוכר" ולא כהצעה.</p>
${sections}
<p class="meta">הסוכן קורא בלבד. שום נתון, קוד או הגדרה לא השתנו בריצה הזאת.</p>
</body></html>`;
}

/* ------------------------------------------------------------------ ראשי */
(async () => {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  console.log(`▶ בקרה יומית ${DATE} — ${SITE}`);
  const step = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}: ${e.message}`); add(`run.${name}`, 'hygiene', 'warn', `בדיקת "${name}" נכשלה`, e.message, 'להריץ שוב; אם חוזר — באג בסקריפט הבקרה'); }
  };
  await step('אתר', checkSite);
  await step('מסד', checkDb);
  await step('קוד', () => checkRepo());
  if (!NO_AUDIT) await step('npm audit', () => checkAudit());

  let accepted = {};
  try { accepted = JSON.parse(fs.readFileSync(ACCEPTED_PATH, 'utf8')); } catch { /* אין קובץ */ }
  const prev = loadPrevious();
  const comparison = compare(prev);
  const result = { date: DATE, startedAt, ms: Date.now() - t0, site: SITE, metrics, findings, comparison, accepted };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${DATE}.json`), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, `${DATE}.html`), renderHtml(result));

  const counts = { crit: 0, warn: 0, info: 0, ok: 0 };
  for (const f of findings) counts[f.level]++;
  console.log(`\n${counts.crit} קריטי · ${counts.warn} אזהרות · ${counts.info} לידיעה · ${counts.ok} תקין`);
  for (const f of findings.filter((x) => x.level !== 'ok').sort((a, b) => LEVELS[b.level] - LEVELS[a.level])) {
    console.log(`  [${LEVEL_HE[f.level]}] ${f.title}${accepted[f.id] ? ' (מוכר)' : ''}${comparison && comparison.new.includes(f.id) ? ' (חדש)' : ''}`);
  }
  if (comparison) console.log(`\nמול ${comparison.date}: ${comparison.new.length} חדשים, ${comparison.resolved.length} נפתרו, ${comparison.deltas.length} מדדים השתנו`);
  console.log(`\n📄 ${path.join(OUT_DIR, `${DATE}.html`)}\n⏱ ${Math.round((Date.now() - t0) / 1000)}s`);
  process.exit(0);
})().catch((e) => { console.error('✗ הבקרה נכשלה:', e.stack || e.message); process.exit(2); });
