/* ניוד שעות של עובד/ת מדוח 15 יום לדוח ההרחבה (רעות 12-13.10, אלקנה):
   "העברת עלות שכר מדוח 15 יום לדוח הרחבה" — X שעות של עובד/ת עוברות
   מהדוח הבסיסי לדוח ההרחבה באותו תעריף שעתי. הניוד נשמר ללקוח
   (client_mappings 'hour_transfer') ומוחל מחדש אחרי כל קליטה/ניתוב של
   דוח עלות — אחרת העלאה מחדש של הקובץ מחזירה את השעות ל-15 יום.
   - שורת הבסיס מקוצצת דרך applyManualRates (התעריפים נשמרים, ↺ משחזר).
   - שורת ההרחבה נוצרת באותו קובץ עלות (נמחקת איתו) עם moved_from_report
     = דוח הבסיס, אותו גן/איש צוות/תפקיד, ושעות הניוד × התעריף השעתי. */

const r2 = (n) => Math.round((n || 0) * 100) / 100;
const digits = (v) => String(v || '').replace(/\D/g, '');
const KEY = (fromReportId, empId) => `${fromReportId}:${digits(empId)}`;

async function listTransfers(db, fromReportId) {
  const rep = await db.prepare('SELECT client_id FROM reports WHERE id = ?').get(fromReportId);
  if (!rep) return [];
  const rows = await db.prepare(
    "SELECT map_key, map_value FROM client_mappings WHERE client_id = ? AND mapping_type = 'hour_transfer' AND map_key LIKE ?"
  ).all(rep.client_id, `${fromReportId}:%`);
  return rows.map((r) => ({ empId: r.map_key.split(':')[1], ...JSON.parse(r.map_value) }));
}

async function saveTransfer(db, fromReportId, empId, toReportId, hours) {
  const rep = await db.prepare('SELECT client_id FROM reports WHERE id = ?').get(fromReportId);
  if (!rep) throw new Error('דוח לא נמצא');
  const key = KEY(fromReportId, empId);
  if (!(hours > 0)) {
    await db.prepare("DELETE FROM client_mappings WHERE client_id = ? AND mapping_type = 'hour_transfer' AND map_key = ?").run(rep.client_id, key);
    return;
  }
  await db.prepare(
    `INSERT INTO client_mappings (client_id, mapping_type, map_key, map_value) VALUES (?, 'hour_transfer', ?, ?)
     ON CONFLICT(client_id, mapping_type, map_key) DO UPDATE SET map_value = excluded.map_value`
  ).run(rep.client_id, key, JSON.stringify({ toReportId, hours: r2(hours) }));
}

/* מחיל את הניודים השמורים של דוח בסיס: מקצץ את שורת הבסיס ומוודא שורת
   הרחבה מעודכנת. אידמפוטנטי — אפשר להריץ אחרי כל קליטה. מחזיר מספר ניודים שהוחלו. */
async function applyHourTransfers(db, fromReportId) {
  const transfers = await listTransfers(db, fromReportId);
  if (!transfers.length) return 0;
  const { applyManualRates } = require('./manualRates');
  let applied = 0;
  for (const t of transfers) {
    const target = await db.prepare('SELECT id FROM reports WHERE id = ?').get(t.toReportId);
    if (!target) continue;
    // שורת הבסיס: של העובד/ת בדוח הבסיס, לא שורת ניוד בעצמה; כמה שורות — הגדולה בשעות
    const bases = (await db.prepare('SELECT * FROM cost_rows WHERE report_id = ? AND moved_from_report IS NULL').all(fromReportId))
      .filter((r) => digits(r.emp_id) === digits(t.empId))
      .sort((a, b) => (b.hours || 0) - (a.hours || 0));
    const base = bases[0];
    if (!base) continue;
    const prev = base.manual_rates ? JSON.parse(base.manual_rates) : null;
    const origHours = prev ? (prev.orig.hours || 0) : (base.hours || 0);
    const origGross = prev ? prev.orig.gross : base.gross;
    const origCost = prev ? prev.orig.cost : base.cost;
    if (!(origHours > t.hours)) continue; // אין מספיק שעות לנייד
    const hg = origGross != null ? origGross / origHours : null;
    const hc = origCost != null ? origCost / origHours : null;
    const after = r2(origHours - t.hours);
    // קיצוץ הבסיס (רק כשצריך) — דרך התעריפים הידניים, כדי שהמקור ישוחזר ב-↺
    if (Math.abs((base.hours || 0) - after) > 0.001) {
      await applyManualRates(db, fromReportId, base.id, { hours: after, hourlyGross: hg != null ? r2(hg) : undefined, hourlyCost: hc != null ? r2(hc) : undefined });
    }
    // שורת ההרחבה — עדכון או יצירה
    const existing = (await db.prepare('SELECT * FROM cost_rows WHERE report_id = ? AND moved_from_report = ?').all(t.toReportId, fromReportId))
      .find((r) => digits(r.emp_id) === digits(t.empId));
    const vals = [r2(t.hours), hg != null ? r2(hg * t.hours) : null, hc != null ? r2(hc * t.hours) : null, base.symbol_override, base.staff_type, base.role];
    if (existing) {
      await db.prepare('UPDATE cost_rows SET hours = ?, gross = ?, cost = ?, symbol_override = COALESCE(symbol_override, ?), staff_type = COALESCE(staff_type, ?), role = COALESCE(role, ?) WHERE id = ?')
        .run(...vals, existing.id);
    } else {
      await db.prepare(
        `INSERT INTO cost_rows (cost_file_id, client_id, report_id, emp_id, emp_name, first_name, last_name, dept, inst_symbol, inst_name,
           component_names, hours, gross, cost, symbol_override, staff_type, role, role_text, moved_from_report)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(base.cost_file_id, base.client_id, t.toReportId, base.emp_id, base.emp_name, base.first_name, base.last_name,
        `${base.dept} — ניוד להרחבה`, base.inst_symbol, base.inst_name, base.component_names || '[]', ...vals, base.role_text, fromReportId);
    }
    applied++;
  }
  if (applied) {
    for (const rid of new Set([fromReportId, ...transfers.map((t) => t.toReportId)])) {
      const c = Number((await db.prepare('SELECT COUNT(*) c FROM cost_rows WHERE report_id = ?').get(rid)).c);
      await db.prepare('UPDATE reports SET has_cost_report = ? WHERE id = ?').run(c > 0 ? 1 : 0, rid);
    }
  }
  return applied;
}

module.exports = { listTransfers, saveTransfer, applyHourTransfers };
