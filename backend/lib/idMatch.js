/* הצלבת ת.ז בין דוח העלות ללשונית כח האדם של קובץ המשרד — סובלנית לספרת
   ביקורת חסרה (נתניה: בקובץ "2224291", בדוח העלות "22242911"), לאפס מוביל
   שנשמט ולאורך 8/9 ספרות. workerSyms — המילון מ-extractWorkerAssignments
   (מפתחות: ת.ז + כינוי 8 ספרות לאותו אובייקט). */
const digits = (v) => String(v || '').replace(/\D/g, '');
function idVariants(v) {
  const raw = digits(v);
  const k = raw.replace(/^0+/, '');
  if (!k) return [];
  // ת.ז לא תקנית (דרכון / מספר קצר — "5624" של אזרחית אמריקאית אצל לביא, 15.10):
  // נכתבת לדוח כמו שהיא, ולכן מוצלבת רק בהתאמה מדויקת
  if (k.length < 5) return [...new Set([raw, k])];
  return [...new Set([raw, k, k.slice(0, 8), k.slice(0, -1), k.padStart(9, '0'), k.padStart(8, '0')].filter((x) => x && x.length >= 5))];
}
/* העובד/ת מדוח העלות נמצא/ת בקובץ? */
function inWorkers(workerSyms, empId) {
  if (!workerSyms) return false;
  return idVariants(empId).some((x) => workerSyms[x]);
}
/* העובדים בקובץ (פעם אחת לכל עובד/ת, בלי כינויי 8 הספרות) → [{ id, a }] */
function distinctWorkers(workerSyms) {
  const seen = new Set();
  const out = [];
  for (const [id, a] of Object.entries(workerSyms || {})) {
    if (seen.has(a)) continue;
    seen.add(a);
    out.push({ id, a });
  }
  return out;
}
/* עובד/ת מהקובץ נמצא/ת בדוח העלות? costIds — Set של כל הווריאנטים של ת.ז דוח העלות */
function costIdSet(empIds) {
  const s = new Set();
  for (const v of empIds) for (const x of idVariants(v)) s.add(x);
  return s;
}
function inCost(costIds, fileId) {
  return idVariants(fileId).some((x) => costIds.has(x));
}
module.exports = { idVariants, inWorkers, distinctWorkers, costIdSet, inCost };
