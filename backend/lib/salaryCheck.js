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
   מעל 114 שעות = רכז/ת בי"ס; סביב 93 שעות = סגן/ית רכז. המשרד מציג את
   תקציב בית הספר רק כשמוגדר רכז בכל סמל מוסד. */
function schoolsRoleByHours(hours) {
  if (!(hours > 0)) return null;
  if (hours >= 114) return { staffType: 'רכזת תכנית בבית הספר', role: 'רכז/ת תכנית בבית הספר' };
  if (hours >= 90 && hours <= 96) return { staffType: 'סגנית רכזת מעל 150', role: 'סגנ/ית רכז/ת>150' };
  return null;
}

/* תפקיד כפי שמופיע בדוח השכר עצמו (עמודת "תפקיד") → איש צוות + תפקיד לפי רשימות המשרד */
function staffFromRoleText(text) {
  const t = String(text || '');
  if (!t) return null;
  if (/סייע/.test(t)) return { staffType: 'סייעת ממשיכה', role: 'סייעת' };
  if (/מוביל|גננת/.test(t)) return { staffType: 'גננת', role: 'גננת של הגן' };
  if (/סגן/.test(t)) return { staffType: 'סגנית רכזת מעל 150', role: 'סגנ/ית רכז/ת>150' };
  if (/רכזת גן/.test(t)) return { staffType: 'רכזת גן', role: 'רכז/ת גן' };
  if (/מורה/.test(t)) return { staffType: 'מורה', role: 'מורה' };
  if (/מדצ|מד"צ/.test(t)) return { staffType: 'מדצ', role: 'מדצ/ית' };
  return null;
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

module.exports = { salaryCheck, suggestRole, basketForStaff, staffFromRoleText, schoolsRoleByHours };
