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
