/* נגזרות קובץ המשרד שמורות במסד (report_file_meta) — פענוח קובץ קר תופס
   ~250MB ושניות של CPU, והמטמונים בזיכרון מתרוקנים בכל אתחול/פריסה; כך
   המכתב המרוכז ומסך ההכנה לא מפענחים מחדש את כל הקבצים אחרי כל עדכון.
   הרשומה תקפה רק לשם הקובץ שממנו חושבה — קובץ חדש ⇒ מחושבת מחדש. */

async function loadFileMeta(db, reportId, mode, fileName) {
  try {
    const row = await db.prepare('SELECT file_name, data FROM report_file_meta WHERE report_id = ? AND mode = ?').get(reportId, mode);
    if (!row || row.file_name !== (fileName || '')) return null;
    return JSON.parse(row.data);
  } catch { return null; }
}

async function saveFileMeta(db, reportId, mode, fileName, data) {
  try {
    await db.prepare('DELETE FROM report_file_meta WHERE report_id = ? AND mode = ?').run(reportId, mode);
    await db.prepare('INSERT INTO report_file_meta (report_id, mode, file_name, data) VALUES (?, ?, ?, ?)')
      .run(reportId, mode, fileName || '', JSON.stringify(data));
  } catch { /* שמירה בלבד — המטמון בזיכרון ממשיך לעבוד */ }
}

async function clearFileMeta(db, reportId) {
  try { await db.prepare('DELETE FROM report_file_meta WHERE report_id = ?').run(reportId); } catch { /* אין טבלה */ }
}

module.exports = { loadFileMeta, saveFileMeta, clearFileMeta };

/* הנגזרות לשמירה מתוך חוברת שכבר פוענחה — בקליטת קובץ, כדי שמסך ההכנה
   והמכתבים לא יפענחו את הקובץ שוב (אותם שדות כמו ב-xlsxWorker.js) */
function fileMetaFromWorkbook(wb, framework) {
  const {
    extractInstitutions, extractSchoolStaffTypes,
    extractCoordinatorGardens, extractExecGardens, extractWorkerAssignments,
  } = require('./fillMinistry');
  const { parseGardenExecKids, parseDeputyEntitlement } = require('./budgetFile');
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const gardens = framework === 'gardens';
  const insts = safe(() => extractInstitutions(wb), []);
  const workerSyms = safe(() => extractWorkerAssignments(wb), {});
  return {
    ministry: {
      institutions: insts,
      schoolTypes: !gardens ? safe(() => extractSchoolStaffTypes(wb), null) : null,
      coordGardens: gardens ? safe(() => extractCoordinatorGardens(wb), []) : [],
      execGardens: gardens ? safe(() => extractExecGardens(wb), []) : [],
      workerSyms,
    },
    letter: {
      insts,
      depEntitled: !gardens ? safe(() => parseDeputyEntitlement(wb), {}) : {},
      gardensExec: gardens ? safe(() => parseGardenExecKids(wb), null) : null,
      workerSyms,
    },
  };
}

module.exports.fileMetaFromWorkbook = fileMetaFromWorkbook;
