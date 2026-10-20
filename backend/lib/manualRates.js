/* תעריפים ידניים לשורת עלות (שעות / ברוטו שעתי / עלות שעתית) — מה שנקבע
   כאן הוא הקובע במכתב, בבקרות ובייצוא; המקור נשמר ב-manual_rates.orig
   לשחזור (↺). משותף למסך ההכנה ולניוד השעות להרחבה (lib/hourTransfers). */
async function applyManualRates(db, reportId, rowId, a) {
  if (a.hours === undefined && a.hourlyGross === undefined && a.hourlyCost === undefined) return false;
  const r = await db.prepare('SELECT id, gross, cost, hours, manual_rates FROM cost_rows WHERE id = ? AND report_id = ?').get(rowId, reportId);
  if (!r) return false;
  const prev = r.manual_rates ? JSON.parse(r.manual_rates) : null;
  const orig = prev ? prev.orig : { gross: r.gross, cost: r.cost, hours: r.hours };
  const clearing = a.hours == null && a.hourlyGross == null && a.hourlyCost == null;
  if (clearing) {
    if (!prev) return false;
    // שחזור של קיצוץ אוטומטי לתקרה (↺) — נרשם כביטול מפורש, אחרת בקרת השעות
    // תקצץ שוב בטעינה הבאה (lib/hourCaps.js מדלג על auto שאינו 'cap')
    const keep = prev.auto === 'cap' ? JSON.stringify({ orig, auto: 'cap-off' }) : null;
    await db.prepare('UPDATE cost_rows SET gross = ?, cost = ?, hours = ?, manual_rates = ? WHERE id = ?')
      .run(orig.gross, orig.cost, orig.hours, keep, r.id);
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

module.exports = { applyManualRates };
