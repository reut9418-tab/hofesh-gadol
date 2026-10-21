/* בדיקת חריגות שכר לפני הגשה (README §5-§6) — משווה את העלות בפועל מדוח
   העלות (מפוצלת לפי תפקיד) מול תקציבי סלי השכר מקובץ המשרד:
   גנים: שכר מובילות וסייעות (instruction) + שכר רכזות גנים (coordinator)
   בתי ספר: שכר צוות חינוכי + שכר רכזים + שכר סגני רכזים (deputy)
   וחריגה מעבר לסלים נבלעת בסל הגמיש (flexible) — עד גובהו. */

/* ימי הפרויקט של הדוח — הבסיס לכללי השעות (מכינות 8, הרחבה לפי הדוח, אחרת 15) */
function projectDays(report) {
  if (!report) return 15;
  return report.framework === 'prep' ? 8 : report.program === 'extension' ? (report.extension_days || 6) : 15;
}

/* תגית תפקיד בסוף שם המחלקה — "110106^אגרון גרשון^הארכת ק^רכז" (לביא, רעות 11.10):
   המקטע האחרון אחרי ^ הוא התפקיד המפורש של השורה */
function deptRoleTag(dept) {
  const d = String(dept || '');
  if (!d.includes('^')) return null;
  const t = d.split('^').pop().trim();
  return t || null;
}
/* תפקיד מפורש מתגית המחלקה → איש צוות + תפקיד לפי רשימת תבנית בתי הספר.
   נשמר בקליטה כמו עמודת "תפקיד" (מקור מוסמך — לא נדרס בניחושי שעות/מחלקה) */
function staffFromDeptTag(dept) {
  const t = deptRoleTag(dept);
  if (!t) return null;
  if (/רשותי/.test(t)) return { staffType: 'רכז רשותי', role: 'רכז רשותי' };
  if (/סג[נן]/.test(t)) return { staffType: 'סגנית רכזת מעל 150', role: 'סגנ/ית רכ/זת>150' };
  if (/רכז/.test(t)) return { staffType: 'רכזת תכנית בבית הספר', role: 'רכז/ת תכנית בבית הספר' }; // "רכז" בלשון זכר — לא רק "רכזת"
  if (/ע\.?\s?חינוך|עוזר/.test(t)) return { staffType: 'מורה', role: 'עוזר/ת חינוך' };
  if (/מורה/.test(t)) return { staffType: 'מורה', role: 'מורה' };
  // "מדריך" בתגית המחלקה (לביא) = איש צוות חינוכי, לא סגן/ית: בהרחבה של 7 ימים
  // 42 שעות הן יום מלא של מורה, אבל כלל השעות (6 ימים × 6) סיווג 64 מדריכים
  // כסגנים — ו-15 בתי ספר נשארו בלי "שכר צוות חינוכי" בקובץ (רעות 13.10)
  if (/מדריך|מדריכ/.test(t)) return { staffType: 'מורה', role: 'בעל/ת תעודת הוראה שסיימ/ה 80% מהתואר' };
  return staffFromRoleText(t); // סייעת/מובילה/מד"צ — כמו עמודת תפקיד; "מדריך" וכד' — ברירת מחדל לפי ברוטו
}

/* ברירת מחדל לתפקיד לפי שם המחלקה (משמש גם את מסך ההכנה וגם את הייצוא) */
function suggestRole(dept) {
  const d = String(dept || '');
  const tag = staffFromDeptTag(d);
  if (tag) return tag;
  if (/רכזות גנים|רכזת גן/.test(d)) return { staffType: 'רכזת גן', role: 'רכז/ת גן' };
  // מחלקה של סייעות רפואיות/אישיות/משלבות (תל מונד 20.10) — לשונית (7), לא כח אדם
  if (/משלב/.test(d) || (/סייע/.test(d) && /רפואי|אישית|צמוד/.test(d))) return { staffType: 'סייעת רפואית או אישית', role: 'סייעת' };
  // "סייעת" כללית — ממשיכה/חדשה נקבע לפי המשלם (aideTypeForPayer) במסך ובייצוא
  if (/סייע/.test(d)) return { staffType: 'סייעת', role: 'סייעת' };
  if (/מוביל|גננת|גננות/.test(d)) return { staffType: 'גננת', role: 'גננת של הגן' };
  // "מורים +רכזות" = מחלקה משולבת של בי"ס — ברירת המחדל מורה (הרכזת תסומן ידנית)
  if (/מור(ה|ים)/.test(d)) return { staffType: 'מורה', role: 'מורה' };
  if (/רכז/.test(d)) return { staffType: 'רכזת תכנית בבית הספר', role: 'רכז/ת תכנית בבית הספר' }; // גם "רכז" בלשון זכר (לביא 11.10)
  return { staffType: null, role: null };
}

/* בתי ספר: זיהוי רכז/סגן לפי כמות שעות (כלל המשתמשת, תקף לכל דוחות בתי הספר):
   מעל 93 שעות = רכז/ת בי"ס; מעל 90 ועד 93 = סגן/ית רכז. בדיוק 90 שעות =
   יום עבודה מלא של מורה (15 יום × 6 שעות) — לא סגן. המשרד מציג את
   תקציב בית הספר רק כשמוגדר רכז בכל סמל מוסד. */
function schoolsRoleByHours(hours, days = 15) {
  if (!(hours > 0)) return null;
  if (days === 15) {
    if (hours > 93) return { staffType: 'רכזת תכנית בבית הספר', role: 'רכז/ת תכנית בבית הספר' };
    if (hours > 90) return { staffType: 'סגנית רכזת מעל 150', role: 'סגנ/ית רכז/ת>150' };
    return null;
  }
  // הרחבה/מכינות (כלל רעות 11.10): עד 6 שעות ליום = מורה; יותר מ-6 ועד 7 = סגנ/ית; יותר מ-7 = רכז/ת
  const perDay = hours / days;
  if (perDay > 7) return { staffType: 'רכזת תכנית בבית הספר', role: 'רכז/ת תכנית בבית הספר' };
  if (perDay > 6) return { staffType: 'סגנית רכזת מעל 150', role: 'סגנ/ית רכז/ת>150' };
  return null;
}

/* כלל רעות 23.9 (מחליף את "רכז אחד לבי"ס" מ-16.9): הרכזים בבי"ס מוגבלים
   בתקרת שעות — 7.6 שעות ליום × ימי הפרויקט (15 יום→114, הרחבה 6→45.6,
   7→53.2, מכינות 8→60.8) — כך שמותר יותר מרכז/ת אחד/ת כל עוד סך שעות
   הריכוז בתקרה. סגן/ית נשאר 0 או 1. מסווגי-שעות עודפים (בלי תפקיד שמור)
   יורדים למורה לפי שעות (הנמוכים קודם); שיוך שמור (ידני/קובץ) לעולם אינו
   נדרס, אך שעותיו נספרות לתקרה. מחזיר Set של row.id שהורדו למורה. */
const COORD_HOURS_PER_DAY = 7.6;
/* coordBudget (אופציונלי, בתי"ס): תקציב סל הריכוז של המוסד. מוסד "קיץ פלוס ד-ו"
   מקבל "תוספת שכר רכז ד-ו" (טבלת המשרד: 155.4 ₪ ליום, "15 ימים (20 ימים
   תוספת שכר רכז ד-ו)") — הרכז מתוקצב ל-20 ימים, ולכן תקרת השעות 7.6×20=152
   ולא 114 (ממלכתי ג מעלה אדומים: 11,810.4+2,331=14,141.4; רעות 6.10).
   זיהוי: תקציב ריכוז מעל ~870 ₪ ליום (רגיל ≈ 787 ₪ ליום) */
const DV_SUPPLEMENT_THRESHOLD_PER_DAY = 870;
function coordHoursCapFor(report, coordBudget = null) {
  const days = report.framework === 'prep' ? 8
    : report.program === 'extension' ? (report.extension_days || 6) : 15;
  let capDays = days;
  if (report.framework === 'schools' && Number(coordBudget) > DV_SUPPLEMENT_THRESHOLD_PER_DAY * days) {
    capDays = days * (20 / 15); // 15 יום → 20; הרחבה — אותו יחס
  }
  return Math.round(COORD_HOURS_PER_DAY * capDays * 100) / 100;
}
/* התפקיד המפורש של שורה: שמור (ידני/קובץ/עמודת תפקיד) או תגית המחלקה (^רכז) —
   כך דוח שנקלט לפני התיקון מתנהג נכון גם בלי קליטה מחדש */
const explicitStaff = (r) => (r.staff_type ? { staffType: r.staff_type, role: r.role || null } : staffFromDeptTag(r.dept));
const explicitType = (r) => { const e = explicitStaff(r); return e ? e.staffType : null; };
const isCoordType = (st) => /רכז/.test(st) && !/סג[נן]/.test(st) && !/רכזת גן/.test(st) && !/רשותי/.test(st); // רכז רשותי — לא בתקרת בי"ס
/* כלל רעות 11.10 (כל פרויקטי בתי הספר): רכז/ת שמופיע/ה בכמה שורות באותו
   בית ספר (שני תעריפים) הוא/היא רכז/ת בכולן. schoolRows — שורות של בי"ס אחד.
   מחזיר Set של row.id שחייבים להיות רכז כי שורה אחרת של אותו/ה עובד/ת
   (אותה ת.ז) היא רכז/ת — לפי שיוך שמור או לפי כלל השעות */
function coordinatorSiblingRows(schoolRows, days = 15) {
  const byWorker = new Map();
  for (const r of schoolRows) {
    const id = String(r.emp_id || '').replace(/\D/g, '').replace(/^0+/, '');
    if (!id) continue;
    if (!byWorker.has(id)) byWorker.set(id, []);
    byWorker.get(id).push(r);
  }
  const isCoord = (r) => {
    const st = explicitType(r) || (schoolsRoleByHours(r.hours, days) || {}).staffType;
    return !!st && isCoordType(String(st));
  };
  const out = new Set();
  for (const list of byWorker.values()) {
    if (list.length < 2 || !list.some(isCoord)) continue;
    for (const r of list) if (!isCoord(r)) out.add(r.id);
  }
  return out;
}

function demoteExtraSchoolRoles(schoolRows, coordCap = COORD_HOURS_PER_DAY * 15, days = 15) {
  const demoted = new Set();
  // שורות-אחיות של רכז/ת (כלל 11.10) נחשבות רכז מפורש: נספרות בתקרה ולא יורדות
  const siblings = coordinatorSiblingRows(schoolRows, days);
  const isExplicitCoord = (r) => (explicitType(r) && isCoordType(String(explicitType(r)))) || siblings.has(r.id);
  // רכזים — תקרת שעות: הידניים נספרים תחילה, ואז מסווגי-שעות לפי שעות יורד
  const explicitHours = schoolRows
    .filter(isExplicitCoord)
    .reduce((s, r) => s + (r.hours || 0), 0);
  const inferredCoords = schoolRows.filter((r) => {
    if (explicitType(r) || siblings.has(r.id)) return false;
    const bh = schoolsRoleByHours(r.hours, days);
    return bh && isCoordType(String(bh.staffType));
  });
  inferredCoords.sort((a, b) => (b.hours || 0) - (a.hours || 0) || (b.gross || 0) - (a.gross || 0));
  // הרכז/ת הראשון/ה נשאר/ת תמיד — גם מעל התקרה (אחרת בי"ס עם רכז יחיד של
  // 136 שעות נשאר בלי רכז והמשרד לא מתקצב אותו); התקרה מגבילה רכזים נוספים
  let used = explicitHours;
  let hasKept = schoolRows.some(isExplicitCoord);
  for (const r of inferredCoords) {
    if (!hasKept) { hasKept = true; used += r.hours || 0; continue; }
    if (used + (r.hours || 0) <= coordCap + 0.01) used += r.hours || 0;
    else demoted.add(r.id);
  }
  // סגנים — ללא שינוי: 0 או 1 (סג[נן] — נו"ן רגילה וסופית)
  const isDep = (st) => /סג[נן]/.test(st);
  const explicitDep = schoolRows.filter((r) => explicitType(r) && isDep(String(explicitType(r)))).length;
  const inferredDeps = schoolRows.filter((r) => {
    if (explicitType(r)) return false;
    const bh = schoolsRoleByHours(r.hours, days);
    return bh && isDep(String(bh.staffType));
  });
  inferredDeps.sort((a, b) => (b.hours || 0) - (a.hours || 0) || (b.gross || 0) - (a.gross || 0));
  for (const r of inferredDeps.slice(Math.max(0, 1 - explicitDep))) demoted.add(r.id);
  return demoted;
}

/* מפעיל/ת חוג (לפי עמודת התפקיד בדוח השכר) — אינם מדווחים בדוח הביצוע
   (כלל רעות 5.10: "להוציא מכל הדוחות ביצוע את מי שרשום כמפעילת חוג") */
function isClubOperator(roleText) {
  const t = String(roleText || '').trim();
  // גם "מדריכ/ת חוגים" (טירת הכרמל 18.10) ותפקיד שהוא רק "חוגים" (גוש עציון)
  return /חוג/.test(t) && (/מפעיל|מדריכ/.test(t) || /^חוגים?$/.test(t));
}
/* אותו כלל כתנאי SQL — מוציא מפעילי/ות חוג מכל חישובי השכר (מסך, מכתב,
   בקרות, המלצות) ולא רק מהייצוא (רעות 5.10). alias: "cr." כשיש JOIN */
/* וגם עובד/ת בלי עלות מעביד חיובית (0, חסרה או שלילית — זיכוי של אגורות בלי
   שעות, לביא 8.10) — לא נכנס/ת לדוח הביצוע ולחישובים (רעות 7-8.10) */
const notClubSql = (alias = '') =>
  `NOT (COALESCE(${alias}role_text,'') LIKE '%חוג%' AND (COALESCE(${alias}role_text,'') LIKE '%מפעיל%' OR COALESCE(${alias}role_text,'') LIKE '%מדריכ%' OR TRIM(COALESCE(${alias}role_text,'')) IN ('חוג','חוגים'))) AND COALESCE(${alias}cost,0) > 0`;

/* תפקיד כפי שמופיע בדוח השכר עצמו (עמודת "תפקיד") → איש צוות + תפקיד לפי רשימות המשרד */
function staffFromRoleText(text) {
  const t = String(text || '');
  if (!t) return null;
  // סיעת = שגיאת כתיב נפוצה של סייעת (אור עקיבא). "סייעת" כללית — ממשיכה
  // (רשות/מועצה) או חדשה (מתנ"ס/חברה/מפעיל) נקבע לפי משלם הקובץ במסך ובייצוא
  // "תומכת חינוך" = תואר הסייעת בשכר הרשויות (קריית מוצקין 13.10, עמודת "תאור דרוג")
  // סייעת רפואית/אישית (צמודה לילד) — תוספת 75 ₪ ליום מחוץ לסלי השכר; בגנים
  // נכתבת ללשונית "סייעות רפואיות או אישיות (7)" ולא לכח האדם (טירת הכרמל 18.10)
  // גם "סייעת משלבת" (תל מונד 20.10) — צמודה לילד, לשונית (7)
  if (/רפואי|אישית|צמוד|משלב/.test(t)) return { staffType: 'סייעת רפואית או אישית', role: 'סייעת' };
  if (/סייע|סיעת|תומכ.{0,3}\s?ח[יי]?נוך|תומכת חנוך/.test(t)) return { staffType: 'סייעת', role: 'סייעת' };
  if (/מוביל|גננת/.test(t)) return { staffType: 'גננת', role: 'גננת של הגן' };
  // סג[נן] — נו"ן רגילה וסופית: "סגן" וגם "סגנית"
  if (/סג[נן]/.test(t)) return { staffType: 'סגנית רכזת מעל 150', role: 'סגנ/ית רכז/ת>150' };
  if (/רכזת גן|רכז גן/.test(t)) return { staffType: 'רכזת גן', role: 'רכז/ת גן' };
  // "רכזת"/"רכז" סתמי — רכז/ת התכנית (בגנים הסל זהה: רכז ⇒ סל ריכוז)
  if (/רכז/.test(t)) return { staffType: 'רכזת תכנית בבית הספר', role: 'רכז/ת תכנית בבית הספר' };
  if (/מורה/.test(t)) return { staffType: 'מורה', role: 'מורה' };
  // מד"צ / "כח עזר" (נבון) בדוח השכר = מד"צ בקובץ המשרד (איש צוות "מדצ",
  // תפקיד "מדצ/ית") — כלל רעות 12.10, מחליף את כלל 4.10 שרשם מד"צ כסייעת.
  // "כל עזר" — שגיאת כתיב נפוצה של "כח עזר"
  // גם "מד" לבדו — קיצור/שיבוש של מד"צ בדוח השכר (גדרה, רעות 21.10)
  if (/מדצ|מד"צ|מד״צ|כו?[חל]\s*עזר|^מד["״']?$/.test(t.trim())) return { staffType: 'מדצ', role: 'מדצ/ית' };
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
  if (/רשותי/.test(st)) return 'authority'; // רכז רשותי — שורת הרשות בקובץ, לא בסלי המוסדות (רעות 8.10)
  if (/רפואי|אישית/.test(st)) return 'aides'; // סייעת רפואית/אישית — תוספת המשרד (75 ₪ ליום), מחוץ לסל ההדרכה
  if (/רכז/.test(st)) return 'coordinator'; // רכזת גן / רכזת תכנית בבית הספר
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
  const rows = await db.prepare(`SELECT dept, staff_type, cost, gross, hours, gross_bump, vat FROM cost_rows WHERE report_id = ? AND ${notClubSql()}`).all(report.id);
  const hoursRule = report.framework !== 'gardens';
  rows.forEach((r) => {
    const byHours = hoursRule ? schoolsRoleByHours(r.hours) : null;
    const st = r.staff_type || (byHours && byHours.staffType) || suggestRole(r.dept).staffType;
    const b = basketForStaff(st);
    if (b in actual) actual[b] += recognizedRowCost(r, vatFactor); // 'authority' — מחוץ לסלים
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

module.exports = { isClubOperator, notClubSql, salaryCheck, suggestRole, basketForStaff, staffFromRoleText, staffFromDeptTag, deptRoleTag, explicitStaff, projectDays, schoolsRoleByHours, demoteExtraSchoolRoles, coordinatorSiblingRows, defaultSchoolsStaff, coordHoursCapFor, isCoordType };
