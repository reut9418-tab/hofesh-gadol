/* דוח העלות המאוחד של דוח בודד — כל השורות שנותבו אליו (מכל הקבצים) + בקרות.
   מרוכז כאן כדי שגם ראוט ה-/costs וגם מנוע הסטטוס ישתמשו באותו מקור. */

const { GROSS_CAP, programType } = require('./domain');
const { aggregateComponents, runChecks } = require('./ingest');

async function costDataForReport(db, report) {
  const raw = await db.prepare(
    `SELECT cr.*, cf.filename, cf.payer FROM cost_rows cr JOIN cost_files cf ON cf.id = cr.cost_file_id
     WHERE cr.report_id = ?`
  ).all(report.id);

  const shaped = raw.map((r) => ({
    id: r.emp_id, name: r.emp_name, firstName: r.first_name, lastName: r.last_name,
    dept: r.dept, instSymbol: r.inst_symbol, component: null,
    gross: r.gross, cost: r.cost, hours: r.hours, source: r.filename,
    payer: r.payer || null, // המשלם (מתנ"ס/רשות) — מוגדר ברמת הקובץ
  }));
  const aggregated = aggregateComponents(shaped);
  const grossCap = programType(report.framework) === 'summer_prep' ? GROSS_CAP.summer_prep : GROSS_CAP.schools_gardens;
  const rows = runChecks(aggregated, { grossCap });

  const summary = {
    workers: new Set(rows.map((r) => r.id)).size,
    rows: rows.length,
    totalCost: rows.reduce((s, r) => s + (r.cost || 0), 0),
    totalGross: rows.reduce((s, r) => s + (r.gross || 0), 0),
    totalHours: rows.reduce((s, r) => s + (r.hours || 0), 0),
    errors: rows.reduce((s, r) => s + r.flags.filter((f) => f.level === 'err').length, 0),
    warnings: rows.reduce((s, r) => s + r.flags.filter((f) => f.level === 'warn').length, 0),
    departments: [...new Set(rows.map((r) => r.dept))],
    grossCap,
  };
  return { rows, summary };
}

module.exports = { costDataForReport };
