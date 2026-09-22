/* היררכיית השיוכים (כלל רעות 22.9, גוש עציון):
   1. שיוך ידני של המשתמשת — נשמר בזיכרון פר-עובד/ת (client_mappings
      worker_assign) ושורד החלפת/מחיקת דוח עלות; גובר על הכול.
   2. דוח העלות האחרון — סמל/תפקיד שכתובים בו במפורש.
   3. קובץ הביצוע שהלקוח העלה (ת"ז→סמל/תפקיד, כלל 16.9) — משלים רק
      עובדים שאין להם ערך מפורש בדוח העלות.
   4. ניחושי המערכת (התאמת שמות, כלל שעות). */

const XLSX = require('xlsx');
const { extractWorkerAssignments } = require('./fillMinistry');

const digits = (v) => String(v || '').replace(/\D/g, '').replace(/^0+/, '');

async function applyFileAssignments(db, reportId, buf) {
  let ws;
  try { ws = extractWorkerAssignments(XLSX.read(buf, { type: 'buffer' })); } catch { return 0; }
  if (!Object.keys(ws).length) return 0;
  const rows = await db.prepare('SELECT id, emp_id, inst_symbol, staff_type, role, symbol_override FROM cost_rows WHERE report_id = ?').all(reportId);
  const updates = [];
  for (const r of rows) {
    const id = String(r.emp_id || '').replace(/\D/g, '');
    const a = ws[id] || (id.length === 9 ? ws[id.slice(0, 8)] : null) || ws['0' + id];
    if (!a) continue;
    // ההיררכיה (כלל 22.9): ידני (override קיים) גובר על הכול — קובץ הביצוע
    // לא דורס אותו (באג ביתר: קליטת קובץ קרסה פיצול רכזים לסמל יחיד);
    // דוח העלות האחרון (inst_symbol) גובר על קובץ ביצוע ישן
    const sym = r.symbol_override || (!r.inst_symbol ? a.symbol : null) || null;
    const st = r.staff_type || a.staffType || null;
    const role = r.role || a.role || null;
    if (sym === (r.symbol_override || null) && st === (r.staff_type || null) && role === (r.role || null)) continue;
    updates.push([sym, st, role, r.id]);
  }
  const CHUNK = 10;
  for (let i = 0; i < updates.length; i += CHUNK) {
    await Promise.all(updates.slice(i, i + CHUNK).map((u) =>
      db.prepare('UPDATE cost_rows SET symbol_override = ?, staff_type = ?, role = ? WHERE id = ?').run(...u)));
  }
  // השיוך הידני של המשתמשת מוחל אחרון — גובר על הקובץ
  await applyManualAssignments(db, reportId);
  return updates.length;
}

/* החלה לפי הקובץ השמור של הדוח (אחרי ניתוב/קליטה מחדש של דוח עלות) */
async function applyStoredFileAssignments(db, reportId) {
  const blob = await db.prepare('SELECT data FROM report_files WHERE report_id = ?').get(reportId);
  if (!blob || !blob.data) { await applyManualAssignments(db, reportId); return 0; }
  return applyFileAssignments(db, reportId, Buffer.isBuffer(blob.data) ? blob.data : Buffer.from(blob.data));
}

/* ---------- זיכרון השיוך הידני פר-עובד/ת (worker_assign) ----------
   מפתחות: "<דוח>:<ת"ז>" כשכל שורות העובד/ת באותו יעד; "<דוח>:<ת"ז>:<מחלקה>"
   כשהעובד/ת מפוצל/ת בין מוסדות לפי מחלקות. עובד/ת עם כמה שורות באותה
   מחלקה ליעדים שונים (פיצול רכזת) — לא נשמר/ת בזיכרון: אין דרך אמינה
   לזהות איזו שורה לאיזה יעד אחרי החלפת קובץ, ועדיף לא לדרוס. */
const normDept = (d) => String(d ?? '').replace(/["'״׳]/g, '').replace(/\s+/g, ' ').trim();

/* שמירה: נקראת מכל שמירת שיוכים ידנית. entries: [{empId, dept, symbol, staffType, role}] */
async function saveManualAssignments(db, reportId, entries) {
  const rep = await db.prepare('SELECT client_id FROM reports WHERE id = ?').get(reportId);
  if (!rep) return;
  const put = (key, val) => db.prepare(
    `INSERT INTO client_mappings (client_id, mapping_type, map_key, map_value) VALUES (?, 'worker_assign', ?, ?)
     ON CONFLICT(client_id, mapping_type, map_key) DO UPDATE SET map_value = excluded.map_value`
  ).run(rep.client_id, key, val);
  const del = (key) => db.prepare(
    "DELETE FROM client_mappings WHERE client_id = ? AND mapping_type = 'worker_assign' AND map_key = ?"
  ).run(rep.client_id, key);

  const byEmp = new Map();
  for (const e of entries) {
    const emp = digits(e.empId);
    if (!emp) continue;
    if (!byEmp.has(emp)) byEmp.set(emp, []);
    byEmp.get(emp).push(e);
  }
  for (const [emp, list] of byEmp) {
    const sig = (e) => JSON.stringify([e.symbol || null, e.staffType || null, e.role || null]);
    const uniform = new Set(list.map(sig)).size === 1;
    if (uniform) {
      const e = list[0];
      if (!e.symbol && !e.staffType && !e.role) { await del(`${reportId}:${emp}`); continue; }
      await put(`${reportId}:${emp}`, JSON.stringify({ symbol: e.symbol || null, staffType: e.staffType || null, role: e.role || null }));
      continue;
    }
    // פיצול בין מחלקות: מפתח פר (עובד, מחלקה) — רק כשהמחלקה עצמה אחידה
    await del(`${reportId}:${emp}`);
    const byDept = new Map();
    for (const e of list) {
      const dk = normDept(e.dept);
      if (!byDept.has(dk)) byDept.set(dk, []);
      byDept.get(dk).push(e);
    }
    for (const [dk, dl] of byDept) {
      if (new Set(dl.map(sig)).size !== 1) continue; // פיצול בתוך מחלקה — לא נשמר
      const e = dl[0];
      if (!e.symbol && !e.staffType && !e.role) { await del(`${reportId}:${emp}:${dk}`); continue; }
      await put(`${reportId}:${emp}:${dk}`, JSON.stringify({ symbol: e.symbol || null, staffType: e.staffType || null, role: e.role || null }));
    }
  }
}

/* החלה: השיוך הידני הזכור נמרח על שורות הדוח (גם אחרי החלפת דוח עלות) */
async function applyManualAssignments(db, reportId) {
  const rep = await db.prepare('SELECT client_id FROM reports WHERE id = ?').get(reportId);
  if (!rep) return 0;
  const saved = await db.prepare(
    "SELECT map_key, map_value FROM client_mappings WHERE client_id = ? AND mapping_type = 'worker_assign' AND map_key LIKE ?"
  ).all(rep.client_id, `${reportId}:%`);
  if (!saved.length) return 0;
  const byEmp = new Map(), byEmpDept = new Map();
  for (const s of saved) {
    const parts = s.map_key.split(':');
    const val = JSON.parse(s.map_value);
    if (parts.length >= 3) byEmpDept.set(`${parts[1]}|${parts.slice(2).join(':')}`, val);
    else byEmp.set(parts[1], val);
  }
  const rows = await db.prepare('SELECT id, emp_id, dept, symbol_override, staff_type, role FROM cost_rows WHERE report_id = ?').all(reportId);
  const updates = [];
  for (const r of rows) {
    const emp = digits(r.emp_id);
    const a = byEmpDept.get(`${emp}|${normDept(r.dept)}`) || byEmp.get(emp);
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

module.exports = { applyFileAssignments, applyStoredFileAssignments, saveManualAssignments, applyManualAssignments };
