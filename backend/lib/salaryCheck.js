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
  // תקציבי הסלים מקובץ המשרד
  const budgets = {};
  (await db.prepare(
    `SELECT b.basket_type t, COALESCE(SUM(b.budget_amount),0) a
     FROM baskets b JOIN institutions i ON i.id = b.institution_id
     WHERE i.report_id = ? GROUP BY b.basket_type`
  ).all(report.id)).forEach((r) => { budgets[r.t] = Number(r.a); });

  // עלות בפועל מפוצלת לפי תפקיד (שיוך שמור, ואם אין — ברירת המחדל לפי המחלקה)
  const actual = { instruction: 0, coordinator: 0, deputy: 0 };
  const rows = await db.prepare('SELECT dept, staff_type, cost FROM cost_rows WHERE report_id = ?').all(report.id);
  rows.forEach((r) => {
    const st = r.staff_type || suggestRole(r.dept).staffType;
    actual[basketForStaff(st)] += r.cost || 0;
  });

  const labels = BASKET_LABELS[report.framework] || BASKET_LABELS.schools;
  const types = report.framework === 'gardens' ? ['instruction', 'coordinator'] : ['instruction', 'coordinator', 'deputy'];

  let overflow = 0;
  const items = types
    .filter((t) => (budgets[t] || 0) > 0 || actual[t] > 0)
    .map((t) => {
      const budget = budgets[t] || 0;
      const over = Math.max(0, actual[t] - budget);
      overflow += over;
      return { type: t, label: labels[t], budget, actual: actual[t], over, under: Math.max(0, budget - actual[t]) };
    });

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
    flexBudget,
    flexUsedForSalary, // "כמה ניצלתי מהסל הגמיש בגין שכר"
    flexRemaining: Math.max(0, flexBudget - flexUsedForSalary),
    overflow, unfunded, alerts,
    hasBudget: items.some((it) => it.budget > 0) || flexBudget > 0,
  };
}

module.exports = { salaryCheck, suggestRole, basketForStaff };
