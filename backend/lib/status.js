/* מנוע הסטטוס (README §13) — גוזר אוטומטית מכל דוח:
   מצב, אחוז השלמה, "מה חסר", חריגות פתוחות, והתראות ללוח הראשי. */

const { reportLabel } = require('./domain');
const { costDataForReport } = require('./reportCosts');

/* דליים נגזרים ללוח הראשי */
const BUCKETS = {
  open: 'פתוחים',
  near: 'לקראת סיום',
  blocked: 'תקועים על חוסר',
  ready: 'מוכנים להגשה',
  submitted: 'הוגשו',
};

/* מטמון בריאות פר-דוח: הלוח, העץ ומסכי הלקוח מחשבים את אותם דוחות שוב
   ושוב (כל חישוב = שליפת שורות + בקרות). מתרוקן בכל בקשת-שינוי (server.js). */
const healthCache = new Map(); // reportId -> health
function bustHealthCache() { healthCache.clear(); }

/* בריאות דוח בודד — הלב של המנוע */
async function reportHealth(db, report) {
  const cached = healthCache.get(report.id);
  if (cached) return cached;
  const cost = await costDataForReport(db, report);
  const instRow = await db.prepare('SELECT COUNT(*) c, COALESCE(SUM(budget_total),0) budget FROM institutions WHERE report_id = ?').get(report.id);
  const instCount = Number(instRow.c);
  const totalBudget = Number(instRow.budget) || 0;
  // תת-ניצול = תקציב פחות הניצול המוכר (כולל מע"מ ללקוח חייב)
  const underUtil = totalBudget > 0 ? Math.max(0, totalBudget - (cost.summary.totalCostRecognized ?? cost.summary.totalCost)) : null;

  const ingest = {
    participants: !!report.has_participants,
    cost_report: !!report.has_cost_report,
    ledger: !!report.has_ledger,
  };
  const present = [ingest.participants, ingest.cost_report, ingest.ledger].filter(Boolean).length;
  const { errors, warnings } = cost.summary;

  // אחוז השלמה: 25% לכל קלט + 25% על בקרה נקייה (כשיש דוח עלות)
  let completion = present * 25;
  if (ingest.cost_report && errors === 0) completion += 25;
  completion = Math.min(100, completion);

  // גזירת דלי (עדיפות: הוגש ← מוכן ← תקוע על חוסר ← לקראת סיום ← פתוח)
  let bucket;
  if (report.status === 'submitted') bucket = 'submitted';
  else if (present === 3 && errors === 0) bucket = 'ready';
  else if (ingest.cost_report && (!ingest.ledger || !ingest.participants)) bucket = 'blocked';
  else if (present >= 2) bucket = 'near';
  else bucket = 'open';

  // "מה חסר לעשות"
  const todos = [];
  if (!ingest.participants) todos.push('להעלות את דוח הביצוע של המשרד (עם כמות הילדים) לבניית התקציב אוטומטית.');
  if (!ingest.cost_report) todos.push('להעלות דוח עלות שכר ולנתב אליו מחלקות.');
  if (!ingest.ledger) todos.push('להעלות כרטסת להתאמה התלת-כיוונית.');
  if (errors > 0) todos.push(`${errors} חריגות בקרה בדוח העלות — לטיפול לפני הגשה.`);
  if (warnings > 0) todos.push(`${warnings} אזהרות בדוח העלות — לבדיקה.`);
  if (underUtil != null && underUtil >= 1000) todos.push(`${Math.round(underUtil).toLocaleString('he-IL')} ₪ תת-ניצול תקציב הניתן למיצוי — ראו המלצות (בהמשך).`);
  if (todos.length === 0) todos.push('כל הקלטים נקלטו והבקרות נקיות — מוכן להגשה.');

  const h = {
    bucket, bucketLabel: BUCKETS[bucket], completion,
    ingest, present,
    exceptions: { errors, warnings },
    costWorkers: cost.summary.workers,
    costTotal: cost.summary.totalCost,
    totalBudget,
    institutions: instCount,
    underUtilization: underUtil, // תקציב מול ניצול (§9) — מזין "כסף על השולחן" בלוח
    todos,
  };
  healthCache.set(report.id, h);
  return h;
}

/* התראה בודדת ללוח הראשי (urgency גבוה = דחוף יותר) */
function reportAlerts(report, health) {
  const label = reportLabel(report.framework, report.program);
  const ctx = report._clientName ? `${report._clientName}${report._authorityName ? ' · ' + report._authorityName : ''} — ${label}` : label;
  const out = [];
  if (health.bucket === 'blocked') {
    const missing = [];
    if (!health.ingest.participants) missing.push('נתוני משתתפים');
    if (!health.ingest.ledger) missing.push('כרטסת');
    out.push({ urgency: 3, level: 'warn', reportId: report.id, clientId: report.client_id, text: `${ctx}: הועלה דוח עלות, חסר ${missing.join(' ו')}.` });
  }
  if (health.exceptions.errors > 0) {
    out.push({ urgency: 4, level: 'err', reportId: report.id, clientId: report.client_id, text: `${ctx}: ${health.exceptions.errors} חריגות בקרה לטיפול.` });
  }
  if (health.bucket === 'ready') {
    out.push({ urgency: 2, level: 'ok', reportId: report.id, clientId: report.client_id, text: `${ctx}: מוכן להגשה.` });
  }
  return out;
}

/* ---------- שלב הטיפול בלקוח (לשונית הניהול + לוח הלקוחות הראשי) ---------- */
const CLIENT_STAGES = {
  no_material: 'טרם הביא חומר',
  material: 'הביא חומר — טרם טופל',
  in_treatment: 'בטיפול',
  done: 'הטיפול הסתיים',
};

/* גזירת שלב אוטומטית מבריאות הדוחות + צ'ק-ליסט הניהול; דריסה ידנית גוברת */
function deriveClientStage(client, healths) {
  if (client && client.manage_status && CLIENT_STAGES[client.manage_status]) return client.manage_status;
  let md = {};
  try { md = client && client.manage_data ? JSON.parse(client.manage_data) : {}; } catch { /* ריק */ }
  if (healths.length && healths.every((h) => h.bucket === 'submitted')) return 'done';
  if (healths.some((h) => h.present >= 2 || h.completion >= 50)) return 'in_treatment';
  if (healths.some((h) => h.present >= 1) || md.material_arrived || md.got_exec_reports || md.got_cost_reports) return 'material';
  return 'no_material';
}

/* אגרגציה ללוח הראשי על פני כל הדוחות */
async function dashboardStatus(db) {
  const reports = await db.prepare('SELECT * FROM reports').all();
  const clientRows = await db.prepare('SELECT * FROM clients ORDER BY name').all();
  const clients = {};
  clientRows.forEach((c) => { clients[c.id] = c.name; });
  const auths = {};
  (await db.prepare('SELECT id, name FROM authorities').all()).forEach((a) => { auths[a.id] = a.name; });

  const buckets = { open: 0, near: 0, blocked: 0, ready: 0, submitted: 0 };
  const healthsByClient = {};
  let alerts = [];
  let moneyOnTable = 0;

  // חישוב הבריאות במקביל (בקבוצות) — כל דוח = כמה סבבי-רשת ל-DB
  const CHUNK = 8;
  const healths = [];
  for (let i = 0; i < reports.length; i += CHUNK) {
    healths.push(...await Promise.all(reports.slice(i, i + CHUNK).map((r) => reportHealth(db, r))));
  }
  reports.forEach((r, i) => {
    const health = healths[i];
    buckets[health.bucket] = (buckets[health.bucket] || 0) + 1;
    (healthsByClient[r.client_id] = healthsByClient[r.client_id] || []).push(health);
    r._clientName = clients[r.client_id];
    r._authorityName = r.authority_id ? auths[r.authority_id] : null;
    alerts = alerts.concat(reportAlerts(r, health));
    if (health.underUtilization) moneyOnTable += health.underUtilization;
  });

  // צנרת הלקוחות: מי הביא חומר, מי בטיפול, מי סיים
  const stageCounts = { no_material: 0, material: 0, in_treatment: 0, done: 0 };
  const pipelineClients = clientRows.map((c) => {
    const stage = deriveClientStage(c, healthsByClient[c.id] || []);
    stageCounts[stage]++;
    return { id: c.id, name: c.name, stage, stageLabel: CLIENT_STAGES[stage], manual: !!c.manage_status };
  });

  alerts.sort((a, b) => b.urgency - a.urgency);
  return {
    buckets, bucketLabels: BUCKETS,
    alerts: alerts.slice(0, 12),
    alertsTotal: alerts.length,
    moneyOnTable,
    totalReports: reports.length,
    pipeline: { counts: stageCounts, labels: CLIENT_STAGES, clients: pipelineClients },
  };
}

module.exports = { reportHealth, reportAlerts, dashboardStatus, deriveClientStage, bustHealthCache, BUCKETS, CLIENT_STAGES };
