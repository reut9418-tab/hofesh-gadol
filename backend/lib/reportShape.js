const { reportLabel, programType } = require('./domain');

/* מעשיר שורת דוח בשדות נגזרים אחידים לכל התגובות */
function shapeReport(r) {
  if (!r) return r;
  return {
    ...r,
    label: reportLabel(r.framework, r.program),
    program_type: programType(r.framework),
    ingest: {
      cost_report: !!r.has_cost_report,
      ledger: !!r.has_ledger,
      participants: !!r.has_participants,
    },
  };
}

module.exports = { shapeReport };
