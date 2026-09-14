/* הרצת פענוח ה-XLSX ב-worker thread חד-פעמי. עלות ההקמה (~0.2s) זניחה מול
   הפענוח (שניות), וקורית רק בהחטאת מטמון. כישלון → החריגה מטופלת אצל הקורא
   בנפילה חזרה לנתיב הסינכרוני. */
const { Worker } = require('worker_threads');
const path = require('path');

function parseXlsxOffloaded(payload, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); worker.terminate().catch(() => {}); fn(v); } };
    const worker = new Worker(path.join(__dirname, 'xlsxWorker.js'), { workerData: payload });
    const timer = setTimeout(() => done(reject, new Error('פסק זמן בפענוח הקובץ')), timeoutMs);
    worker.once('message', (m) => (m && m.ok ? done(resolve, m.data) : done(reject, new Error((m && m.error) || 'שגיאת worker'))));
    worker.once('error', (e) => done(reject, e));
    worker.once('exit', (code) => { if (code !== 0) done(reject, new Error('ה-worker הסתיים בקוד ' + code)); });
  });
}

module.exports = { parseXlsxOffloaded };
