/* החוק של רעות (16.9): מה שהלקוח כבר מילא בלשונית כח האדם של קובץ הביצוע —
   סמל מוסד ותפקיד פר ת"ז — מוחל אוטומטית על שורות דוח העלות ברגע שהקובץ
   עולה (או כשמנתבים/קולטים מחדש דוח עלות). הלקוח לא עובד פעמיים, ורעות
   לא צריכה לבקש. ערך מהקובץ גובר על שיוך קודם (הקובץ הוא מקור האמת);
   עובדת שאינה בקובץ שומרת את השיוך הקיים. */

const XLSX = require('xlsx');
const { extractWorkerAssignments } = require('./fillMinistry');

async function applyFileAssignments(db, reportId, buf) {
  let ws;
  try { ws = extractWorkerAssignments(XLSX.read(buf, { type: 'buffer' })); } catch { return 0; }
  if (!Object.keys(ws).length) return 0;
  const rows = await db.prepare('SELECT id, emp_id, staff_type, role, symbol_override FROM cost_rows WHERE report_id = ?').all(reportId);
  const updates = [];
  for (const r of rows) {
    const id = String(r.emp_id || '').replace(/\D/g, '');
    const a = ws[id] || (id.length === 9 ? ws[id.slice(0, 8)] : null) || ws['0' + id];
    if (!a) continue;
    const sym = a.symbol || r.symbol_override || null;
    const st = a.staffType || r.staff_type || null;
    const role = a.role || r.role || null;
    if (sym === (r.symbol_override || null) && st === (r.staff_type || null) && role === (r.role || null)) continue;
    updates.push([sym, st, role, r.id]);
  }
  const CHUNK = 10;
  for (let i = 0; i < updates.length; i += CHUNK) {
    await Promise.all(updates.slice(i, i + CHUNK).map((u) =>
      db.prepare('UPDATE cost_rows SET symbol_override = ?, staff_type = ?, role = ? WHERE id = ?').run(...u)));
  }
  return updates.length;
}

/* החלה לפי הקובץ השמור של הדוח (אחרי ניתוב/קליטה מחדש של דוח עלות) */
async function applyStoredFileAssignments(db, reportId) {
  const blob = await db.prepare('SELECT data FROM report_files WHERE report_id = ?').get(reportId);
  if (!blob || !blob.data) return 0;
  return applyFileAssignments(db, reportId, Buffer.isBuffer(blob.data) ? blob.data : Buffer.from(blob.data));
}

module.exports = { applyFileAssignments, applyStoredFileAssignments };
