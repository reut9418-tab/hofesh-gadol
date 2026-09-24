/* בדיקת חריגות שכר לפני הגשה (README §5-§6) — משווה את העלות בפועל מדוח
   העלות (מפוצלת לפי תפקיד) מול תקציבי סלי השכר מקובץ המשרד:
   גנים: שכר מובילות וסייעות (instruction) + שכר רכזות גנים (coordinator)
   בתי ספר: שכר צוות חינוכי + שכר רכזים + שכר סגני רכזים (deputy)
   וחריגה מעבר לסלים נבלעת בסל הגמיש (flexible) — עד גובהו. */

/* ברירת מחדל לתפקיד לפי שם המחלקה (משמש גם את מסך ההכנה וגם את הייצוא) */
function suggestRole(dept) {
  const d = String(dept || '');
  if (/רכזות גנים|רכזת גן/.test(d)) return { staffType: 'רכזת גן', role: 'רכז/ת גן' };
  if (/סייע/.test(d)) return { staffType: 'סייעת ממשיכה', role: 'סייעת' };
  if (/מוביל|גננת|גננות/.test(d)) return { staffType: 'גננת', role: 'גננת של הגן' };
  // "מורים +רכזות" = מחלקה משולבת של בי"ס — ברירת המחדל מורה (הרכזת תסומן ידנית)
  if (/מור(ה|ים)/.test(d)) return { staffType: 'מורה', role: 'מורה' };
  if (/רכזת|רכזות/.test(d)) return { staffType: 'רכזת תכנית בבית הספר', role: 'רכז/ת תכנית בבית הספר' };
  return { staffType: null, role: null };
}

/* בתי ספר: זיהוי רכז/סגן לפי כמות שעות (כלל המשתמשת, תקף לכל דוחות בתי הספר):
   מעל 93 שעות = רכז/ת בי"ס; מעל 90 ועד 93 = סגן/ית רכז. בדיוק 90 שעות =
   יום עבודה מלא של מורה (15 יום × 6 שעות) — לא סגן. המשרד מציג את
   תקציב בית הספר רק כשמוגדר רכז בכל סמל מוסד. */
function schoolsRoleByHours(hours) {
  if (!(hours > 0)) return null;
  if (hours > 93) return { staffType: 'רכזת תכנית בבית הספר', role: 'רכז/ת תכנית בבית הספר' };
  if (hours > 90) return { staffType: 'סגנית רכזת מעל 150', role: 'סגנ/ית רכז/ת>150' };
  return null;
}

/* כלל רעות 23.9 (מחליף את "רכז אחד לבי"ס" מ-16.9): הרכזים בבי"ס מוגבלים
   בתקרת שעות — 7.6 שעות ליום × ימי הפרויקט (15 יום→114, הרחבה 6→45.6,
   7→53.2, מכינות 8→60.8) — כך שמותר יותר מרכז/ת אחד/ת כל עוד סך שעות
   הריכוז בתקרה. סגן/ית נשאר 0 או 1. מסווגי-שעות עודפים (בלי תפקיד שמור)
   יורדים למורה לפי שעות (הנמוכים קודם); שיוך שמור (ידני/קובץ) לעולם אינו
   נדרס, אך שעותיו נספרות לתקרה. מחזיר Set של row.id שהורדו למורה. */
const COORD_HOURS_PER_DAY = 7.6;
function coordHoursCapFor(report) {
  const days = report.framework === 'prep' ? 8
    : report.program === 'extension' ? (report.extension_days || 6) : 15;
  return Math.round(COORD_HOURS_PER_DAY * days * 100) / 100;
}
const isCoordType = (st) => /רכז/.test(st) && !/סג[נן]/.test(st) && !/רכזת גן/.test(st);
function demoteExtraSchoolRoles(schoolRows, coordCap = COORD_HOURS_PER_DAY * 15) {
  const demoted = new Set();
  // רכזים — תקרת שעות: הידניים נספרים תחילה, ואז מסווגי-שעות לפי שעות יורד
  const explicitHours = schoolRows
    .filter((r) => r.staff_type && isCoordType(String(r.staff_type)))
    .reduce((s, r) => s + (r.hours || 0), 0);
  const inferredCoords = schoolRows.filter((r) => {
    if (r.staff_type) return false;
    const bh = schoolsRoleByHours(r.hours);
    return bh && isCoordType(String(bh.staffType));
  });
  inferredCoords.sort((a, b) => (b.hours || 0) - (a.hours || 0) || (b.gross || 0) - (a.gross || 0));
  // הרכז/ת הראשון/ה נשאר/ת תמיד — גם מעל התקרה (אחרת בי"ס עם רכז יחיד של
  // 136 שעות נשאר בלי רכז והמשרד לא מתקצב אותו); התקרה מגבילה רכזים נוספים
  let used = explicitHours;
  let hasKept = schoolRows.some((r) => r.staff_type && isCoordType(String(r.staff_type)));
  for (const r of inferredCoords) {
    if (!hasKept) { hasKept = true; used += r.hours || 0; continue; }
    if (used + (r.hours || 0) <= coordCap + 0.01) used += r.hours || 0;
    else demoted.add(r.id);
  }
  // סגנים — ללא שינוי: 0 או 1 (סג[נן] — נו"ן רגילה וסופית)
  const isDep = (st) => /סג[נן]/.test(st);
  const explicitDep = schoolRows.filter((r) => r.staff_type && isDep(String(r.staff_type))).length;
  const inferredDeps = schoolRows.filter((r) => {
    if (r.staff_type) return false;
    const bh = schoolsRoleByHours(r.hours);
    return bh && isDep(String(bh.staffType));
  });
  inferredDeps.sort((a, b) => (b.hours || 0) - (a.hours || 0) || (b.gross || 0) - (a.gross || 0));
  for (const r of inferredDeps.slice(Math.max(0, 1 - explicitDep))) demoted.add(r.id);
  return demoted;
}

/* תפקיד כפי שמופיע בדוח השכר עצמו (עמודת "תפקיד") → איש צוות + תפקיד לפי רשימות המשרד */
function staffFromRoleText(text) {
  const t = String(text || '');
  if (!t) return null;
  // סיעת = שגיאת כתיב נפוצה של סייעת (אור עקיבא)
  if (/סייע|סיעת/.test(t)) return { staffType: 'סייעת ממשיכה', role: 'סייעת' };
  if (/מוביל|גננת/.test(t)) return { staffType: 'גננת', role: 'גננת של הגן' };
  // סג[נן] — נו"ן רגילה וסופית: "סגן" וגם "סגנית"
  if (/סג[נן]/.test(t)) return { staffType: 'סגנית רכזת מעל 150', role: 'סגנ/ית רכז/ת>150' };
  if (/רכזת גן|רכז גן/.test(t)) return { staffType: 'רכזת גן', role: 'רכז/ת גן' };
  // "רכזת"/"רכז" סתמי — רכז/ת התכנית (בגנים הסל זהה: רכז ⇒ סל ריכוז)
  if (/רכז/.test(t)) return { staffType: 'רכזת תכנית בבית הספר', role: 'רכז/ת תכנית בבית הספר' };
  if (/מורה/.test(t)) return { staffType: 'מורה', role: 'מורה' };
  if (/מדצ|מד"צ/.test(t)) return { staffType: 'מדצ', role: 'מדצ/ית' };
  return null;
}

/* בתי"ס: ברירת מחדל לעובד/ת בלי תפקיד בדוח העלות (ובלי סיווג שעות) —
   איש צוות "מורה", והתפקיד לפי מדרגות התעריף המינימלי של תבנית המשרד:
   ברוטו שעתי ≥75 = בעל/ת תעודת הוראה; ≥50 = עוזר/ת חינוך; מתחת =
   סטודנט/ית — כך בקרת השכר-לתפקיד בקובץ עוברת (כלל רעות 22.9, גוש עציון) */
function defaultSchoolsStaff(hourlyGross) {
  const h = Number(hourlyGross) || 0;
  const role = h >= 75 ? 'בעל/ת תעודת הוראה שסיימ/ה 80% מהתואר' : h >= 50 ? 'עוזר/ת חינוך' : 'סטודנט/ית';
  return { staffType: 'מורה', role };
}

/* איש צוות → סל השכר שאליו העלות שלו נזקפת */
function basketForStaff(staffType) {
  const st = String(staffType || '');
  if (/סגנית|סגן/.test(st)) return 'deputy';
  if (/רכז/.test(st)) return 'coordinator'; // רכזת גן / רכזת תכנית בבית הספר / רכז רשותי
  return 'instruction'; // גננת / סייעת / מדצ / מורה / תוספת כח אדם
}

const BASKET_LABELS = {
  gardens: { instruction: 'שכר מובילות וסייעות', coordinator: 'שכר רכזות גנים', deputy: 'שכר סגני רכזים' },
  schools: { instruction: 'שכר צוות חינוכי', coordinator: 'שכר רכזים', deputy: 'שכר סגני רכזים' },
  prep: { instruction: 'שכר צוות חינוכי', coordinator: 'שכר רכזים', deputy: 'שכר סגני רכזים' },
};

async function salaryCheck(db, report) {
  // התקציב מוכר כולל מע"מ — לכן ללקוח חייב מע"מ הניצול מוכפל ב-1.18
  const client = await db.prepare('SELECT has_vat FROM clients WHERE id = ?').get(report.client_id);
  const vatFactor = client && client.has_vat ? 1.18 : 1;
  // תקציבי הסלים מקובץ המשרד
  const budgets = {};
  (await db.prepare(
    `SELECT b.basket_type t, COALESCE(SUM(b.budget_amount),0) a
     FROM baskets b JOIN institutions i ON i.id = b.institution_id
     WHERE i.report_id = ? GROUP BY b.basket_type`
  ).all(report.id)).forEach((r) => { budgets[r.t] = Number(r.a); });

  // עלות בפועל מפוצלת לפי תפקיד (שיוך שמור, ואם אין — ברירת המחדל לפי המחלקה);
  // הניצול המוכר מוגבל פר-עובד לתקרת ה-140% מהברוטו — כמו בדיווח בפועל
  const { recognizedRowCost } = require('./ingest');
  const actual = { instruction: 0, coordinator: 0, deputy: 0 };
  const rows = await db.prepare('SELECT dept, staff_type, cost, gross, hours FROM cost_rows WHERE report_id = ?').all(report.id);
  const hoursRule = report.framework !== 'gardens';
  rows.forEach((r) => {
    const byHours = hoursRule ? schoolsRoleByHours(r.hours) : null;
    const st = r.staff_type || (byHours && byHours.staffType) || suggestRole(r.dept).staffType;
    actual[basketForStaff(st)] += recognizedRowCost(r, vatFactor);
  });

  const labels = BASKET_LABELS[report.framework] || BASKET_LABELS.schools;
  // רכזים וסגני רכזים = משפחת "שכר ריכוז" אחת: יתרה אצל הרכזים מכסה את
  // הסגנים (ולהפך) לפני שנוגעים בסל הגמיש — כך המשרד מתקצב אותם (קבוע למוסד)
  const groups = report.framework === 'gardens'
    ? [['instruction'], ['coordinator']]
    : [['instruction'], ['coordinator', 'deputy']];

  let overflow = 0;
  const items = groups
    .map((g) => {
      const budget = g.reduce((s, t) => s + (budgets[t] || 0), 0);
      const act = g.reduce((s, t) => s + (actual[t] || 0), 0);
      if (!(budget > 0) && !(act > 0)) return null;
      const over = Math.max(0, act - budget);
      overflow += over;
      const label = g.length > 1 ? 'שכר רכזים וסגני רכזים' : labels[g[0]];
      return { type: g[0], label, budget, actual: act, over, under: Math.max(0, budget - act) };
    })
    .filter(Boolean);

  const flexBudget = budgets.flexible || 0;
  const flexUsedForSalary = Math.min(overflow, flexBudget);
  const unfunded = Math.max(0, overflow - flexBudget);

  const alerts = [];
  items.forEach((it) => {
    if (it.over > 0) alerts.push({ level: 'warn', text: `חריגה ב${it.label}: ניצול ₪${Math.round(it.actual).toLocaleString('he-IL')} מול תקציב ₪${Math.round(it.budget).toLocaleString('he-IL')} (חריגה ₪${Math.round(it.over).toLocaleString('he-IL')}).` });
  });
  if (overflow > 0 && flexBudget > 0) {
    alerts.push({ level: unfunded > 0 ? 'err' : 'warn', text: `הסל הגמיש מכסה ₪${Math.round(flexUsedForSalary).toLocaleString('he-IL')} מתוך חריגת השכר (תקציב הסל: ₪${Math.round(flexBudget).toLocaleString('he-IL')}).` });
  }
  if (unfunded > 0) {
    alerts.push({ level: 'err', text: `נותרה חריגת שכר של ₪${Math.round(unfunded).toLocaleString('he-IL')} שאינה מכוסה — המשרד לא יכיר בה.` });
  }

  return {
    items, // פר-סל: תקציב / ניצול / חריגה / תת-ניצול
    vatFactor, // 1.18 ללקוח חייב — הניצול המוצג כולל מע"מ
    flexBudget,
    flexUsedForSalary, // "כמה ניצלתי מהסל הגמיש בגין שכר"
    flexRemaining: Math.max(0, flexBudget - flexUsedForSalary),
    overflow, unfunded, alerts,
    hasBudget: items.some((it) => it.budget > 0) || flexBudget > 0,
  };
}

module.exports = { salaryCheck, suggestRole, basketForStaff, staffFromRoleText, schoolsRoleByHours, demoteExtraSchoolRoles, defaultSchoolsStaff, coordHoursCapFor, isCoordType };
