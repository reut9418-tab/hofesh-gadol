/* פענוח קובץ דוח הביצוע ב-worker thread — פענוח מלא של קובץ 2-3MB חוסם
   את ה-event loop לשניות (נמדד: health קופץ מ-85ms ל-1.8 שניות), וכאן הוא
   רץ בחוט נפרד. מקבל { mode, framework, buf } ומחזיר נתונים סיריאליים. */
const { parentPort, workerData } = require('worker_threads');
const XLSX = require('xlsx');

function run({ mode, framework, buf }) {
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const {
    extractInstitutions, extractSchoolStaffTypes,
    extractCoordinatorGardens, extractExecGardens,
  } = require('./fillMinistry');
  const { parseGardenExecKids, parseDeputyEntitlement } = require('./budgetFile');
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  if (mode === 'letter') {
    return {
      insts: safe(() => extractInstitutions(wb), []),
      depEntitled: framework !== 'gardens' ? safe(() => parseDeputyEntitlement(wb), {}) : {},
      gardensExec: framework === 'gardens' ? safe(() => parseGardenExecKids(wb), null) : null,
    };
  }
  // mode === 'ministry' — הנגזרות של מסך ההכנה והייצוא
  return {
    institutions: safe(() => extractInstitutions(wb), []),
    schoolTypes: framework !== 'gardens' ? safe(() => extractSchoolStaffTypes(wb), null) : null,
    coordGardens: framework === 'gardens' ? safe(() => extractCoordinatorGardens(wb), []) : [],
    execGardens: framework === 'gardens' ? safe(() => extractExecGardens(wb), []) : [],
  };
}

try {
  parentPort.postMessage({ ok: true, data: run(workerData) });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message });
}
