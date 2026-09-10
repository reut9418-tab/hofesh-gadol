/* המלצות ניוד בין פרויקטים ברמת הלקוח (§דרישת 2026-09-10):
   באותה רשות ובאותה מסגרת (גנים/בתי"ס), כשפרויקט אחד (למשל 15 יום) חורג
   בשכר ופרויקט אחר (הרחבה) בתת-ביצוע — ממליצים להעביר עובדים מדוח העלות
   של החורג לדוח העלות של השני. הביצוע רק באישור הלקוח/המשתמשת. */

const { recognizedRowCost } = require('./ingest');
const { suggestRole, basketForStaff, schoolsRoleByHours } = require('./salaryCheck');
const { reportLabel } = require('./domain');

/* תקרת השכר של דוח: סלי השכר + הסל הגמיש (שבולע חריגות שכר) */
async function salaryCapOf(db, reportId) {
  const rows = await db.prepare(
    `SELECT b.basket_type t, COALESCE(SUM(b.budget_amount),0) a
     FROM baskets b JOIN institutions i ON i.id = b.institution_id
     WHERE i.report_id = ? GROUP BY b.basket_type`
  ).all(reportId);
  let cap = 0;
  for (const r of rows) {
    if (['instruction', 'coordinator', 'deputy', 'flexible'].includes(r.t)) cap += Number(r.a);
  }
  return cap;
}

async function crossMoveRecommendations(db, clientId) {
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return { pairs: [] };
  const vatFactor = client.has_vat ? 1.18 : 1;

  const reports = await db.prepare(
    `SELECT r.id, r.framework, r.program, r.authority_id, a.name AS authority
     FROM reports r LEFT JOIN authorities a ON a.id = r.authority_id
     WHERE r.client_id = ?`
  ).all(clientId);

  // רק דוחות עם תקציב וגם שורות עלות
  const info = new Map();
  for (const r of reports) {
    const cap = await salaryCapOf(db, r.id);
    if (!(cap > 0)) continue;
    const rows = await db.prepare(
      'SELECT id, emp_name, dept, staff_type, cost, gross, hours, gross_bump, cross_declined FROM cost_rows WHERE report_id = ?'
    ).all(r.id);
    if (!rows.length) continue;
    const actual = rows.reduce((s, x) => s + recognizedRowCost(x, vatFactor), 0);
    info.set(r.id, { report: r, cap, rows, actual, label: reportLabel(r.framework, r.program) });
  }

  // זוגות באותה רשות ובאותה מסגרת (בסיס ↔ הרחבה)
  const pairs = [];
  const list = [...info.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = 0; j < list.length; j++) {
      if (i === j) continue;
      const src = list[i], dst = list[j];
      if (src.report.authority_id !== dst.report.authority_id) continue;
      if (src.report.framework !== dst.report.framework) continue;
      const overflow = src.actual - src.cap;
      const slack = dst.cap - dst.actual;
      if (!(overflow > 500 && slack > 500)) continue; // מתחת לזה אין טעם להטריח

      // מועמדים: עובדי סל ההדרכה בדוח החורג, מהעלות הגדולה לקטנה
      const cands = src.rows
        .filter((w) => {
          if (w.cross_declined || !((w.cost || 0) > 0)) return false;
          const byHours = src.report.framework !== 'gardens' ? schoolsRoleByHours(w.hours) : null;
          return basketForStaff(w.staff_type || (byHours && byHours.staffType) || suggestRole(w.dept).staffType) === 'instruction';
        })
        .map((w) => ({ ...w, rec: recognizedRowCost(w, vatFactor) }))
        .sort((a, b) => b.rec - a.rec);

      const moves = [];
      let rem = overflow, room = slack;
      for (const w of cands) {
        if (rem <= 0 || room <= 0) break;
        if (w.rec > room) continue; // לא נכניס את היעד לחריגה
        moves.push({
          rowId: w.id, name: w.emp_name || '', cost: Math.round(w.rec),
          fromReportId: src.report.id, fromLabel: src.label,
          toReportId: dst.report.id, toLabel: dst.label,
          reduces: Math.round(Math.min(w.rec, rem)),
        });
        rem -= w.rec;
        room -= w.rec;
      }
      if (moves.length) {
        pairs.push({
          authority: src.report.authority,
          from: { reportId: src.report.id, label: src.label, overflow: Math.round(overflow) },
          to: { reportId: dst.report.id, label: dst.label, slack: Math.round(slack) },
          moves,
        });
      }
    }
  }
  return { pairs, vatFactor };
}

module.exports = { crossMoveRecommendations };
