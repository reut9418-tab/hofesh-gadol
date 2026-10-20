/* בקרת שעות אוטומטית (רעות 20.10): עובד/ת שמעל תקרת השעות של התפקיד מקוצץ/ת
   לתקרה — והסה"כ (ברוטו ועלות) לא משתנה: התעריפים השעתיים מחושבים מחדש
   (ברוטו ÷ תקרה, עלות ÷ תקרה). מעל התקרה המשרד ממילא לא מכיר.
   תקרות: גנים — 6 שעות ליום לכולם (15 יום → 90; הרחבה → 6 × ימי ההרחבה).
   בתי ספר — רכז/ת 7.6 ליום (15 יום → 114; מוסד ד-ו → 20 ימים), סגן/ית 6.2 ליום
   (93), עובדים 6 ליום (90). בהרחבה אותו יחס ליום × ימי ההרחבה.
   לא מקוצצים: רכז רשותי, סייעת רפואית/אישית (לפי ימים, לשונית 7), שורות
   שנערכו ידנית במסך או שקוצצו ע"י ניוד שעות (manual_rates ללא auto='cap').
   מסומן manual_rates.auto='cap' — המקור ניתן לשחזור ב-↺ כמו תעריף ידני. */
const { applyManualRates } = require('./manualRates');
const { explicitStaff, schoolsRoleByHours, projectDays, coordHoursCapFor, isCoordType, notClubSql, demoteExtraSchoolRoles, coordinatorSiblingRows } = require('./salaryCheck');

const DEPUTY_HOURS_PER_DAY = 6.2; // 93 ÷ 15
const WORKER_HOURS_PER_DAY = 6;
const MAX_HOURLY_GROSS = 120; // תקרת המשרד לברוטו שעתי (רעות 20.10)

/* opts.demoted / opts.sibling — כמו במסך ההכנה ובייצוא: מסווג/ת-שעות עודף/ת יורד/ת
   למורה (תקרה 6 ליום), שורה-אחות של רכז/ת היא רכז/ת */
function capForRow(report, r, coordBudget, opts = {}) {
  const days = projectDays(report);
  const st = String((explicitStaff(r) || {}).staffType || '');
  if (/רשותי/.test(st) || /רפואי|אישית/.test(st)) return null;
  if (report.framework === 'gardens') return WORKER_HOURS_PER_DAY * days;
  const byHours = !st ? schoolsRoleByHours(r.hours, days) : null;
  let eff = st || (byHours && byHours.staffType) || 'מורה';
  if (opts.demoted && opts.demoted.has(r.id)) eff = 'מורה';
  else if (opts.sibling && opts.sibling.has(r.id)) eff = 'רכזת תכנית בבית הספר';
  if (isCoordType(eff)) return coordHoursCapFor(report, coordBudget);
  if (/סג[נן]/.test(eff)) return Math.round(DEPUTY_HOURS_PER_DAY * days * 100) / 100;
  return WORKER_HOURS_PER_DAY * days;
}

/* coordBudgets: Map סמל → תקציב ריכוז (לתקרת רכז ד-ו); symbolOf(r) — הסמל הפעיל של השורה */
async function autoApplyHourCaps(db, report, { coordBudgets = new Map(), symbolOf = () => null } = {}) {
  const rows = await db.prepare(
    `SELECT id, emp_id, emp_name, dept, staff_type, role, hours, gross, cost, manual_rates, role_text, symbol_override, inst_symbol FROM cost_rows WHERE report_id = ? AND ${notClubSql()}`
  ).all(report.id);
  let capped = 0;
  const done = [];
  // בתי ספר: אותה לוגיקת תפקידים כמו במסך/בייצוא — הורדת רכזים עודפים למורה ושורות-אחיות
  const demoted = new Set(), sibling = new Set();
  if (report.framework !== 'gardens') {
    const bySchool = new Map();
    for (const r of rows) { const s = String(symbolOf(r) || ''); if (!bySchool.has(s)) bySchool.set(s, []); bySchool.get(s).push(r); }
    for (const [s, g] of bySchool) {
      for (const id of demoteExtraSchoolRoles(g, coordHoursCapFor(report, coordBudgets.get(s)), projectDays(report))) demoted.add(id);
      for (const id of coordinatorSiblingRows(g, projectDays(report))) sibling.add(id);
    }
  }
  for (const r of rows) {
    if (!(r.hours > 0)) continue;
    let mr = null; try { mr = r.manual_rates ? JSON.parse(r.manual_rates) : null; } catch { mr = null; }
    if (mr && mr.auto !== 'cap') continue; // עריכה ידנית / ניוד שעות — לא נוגעים
    const cap = capForRow(report, r, coordBudgets.get(String(symbolOf(r) || '')), { demoted, sibling });
    if (!(cap > 0)) continue;
    // רעות 20.10: השעות עד התקרה; העלות לעובד/ת לא משתנה לעולם (התעריף השעתי = עלות ÷ שעות);
    // הברוטו השעתי עד 120 ₪ בלי קשר לדוח העלות (אז הברוטו לתקופה = 120 × שעות). בלי עיגול
    // מעבר ל-120 — התעריפים נשמרים בדיוק מלא והסה"כ מחושב מהם
    const hours = Math.min(r.hours, cap);
    const curHG = r.gross != null ? r.gross / r.hours : null;
    const curHC = r.cost != null ? r.cost / r.hours : null;
    // התעריפים מחושבים מהסה"כ המקורי של דוח העלות (לא מערכים שכבר קוצצו) — בלי סחיפה בין הרצות
    const og = mr && mr.orig ? mr.orig : r;
    const hg = og.gross != null ? Math.min(og.gross / hours, MAX_HOURLY_GROSS) : undefined;
    const hc = og.cost != null ? og.cost / hours : undefined; // העלות נשמרת בדיוק
    const hoursChange = r.hours > cap + 0.001;
    const rateChange = curHG != null && curHG > MAX_HOURLY_GROSS + 0.0001;
    void curHC;
    if (!hoursChange && !rateChange) continue;
    try {
      const ok = await applyManualRates(db, report.id, r.id, { hours, hourlyGross: hg, hourlyCost: hc });
      if (!ok) continue;
      // סימון שהקיצוץ אוטומטי (לתצוגה ולהרצה חוזרת), בלי לאבד את המקור
      const row = await db.prepare('SELECT manual_rates FROM cost_rows WHERE id = ?').get(r.id);
      const j = JSON.parse(row.manual_rates); j.auto = 'cap'; j.capFrom = r.hours; if (rateChange) j.rateCapped = true;
      await db.prepare('UPDATE cost_rows SET manual_rates = ? WHERE id = ?').run(JSON.stringify(j), r.id);
      capped++; done.push({ id: r.id, name: r.emp_name, from: r.hours, to: hours, hg, hc });
    } catch (e) { console.error(`[hourCaps ${report.id}] קיצוץ לתקרה נכשל לשורה ${r.id}:`, e.message); }
  }
  if (capped) console.log(`[hourCaps ${report.id}] קוצצו לתקרה ${capped} שורות: ${done.slice(0, 5).map((d) => `${d.name} ${d.from}→${d.to} (${d.hg}/${d.hc})`).join(' | ')}${done.length > 5 ? ' ...' : ''}`);
  return capped;
}

module.exports = { autoApplyHourCaps, capForRow };
