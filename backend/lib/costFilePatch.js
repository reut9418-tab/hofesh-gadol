/* הורדת דוח העלות המקורי עם השינויים הידניים (כלל רעות 15.10): "התוכנה עובדת
   לפי הקובץ למעט שינויים ידניים" — ולכן הקובץ שיורד הוא הקובץ שהועלה, בדיוק
   באותו עיצוב, ורק התאים שהמשתמשת שינתה בתוכנה מתעדכנים בו:
     • סמל מוסד — השיוך הסופי בתוכנה כשהוא שונה מהסמל שבקובץ
     • ת.ז — תיקון ת.ז שנלמד ללקוח (emp_id_fix)
     • שעות — תעריף ידני (manual_rates), רק לעובד/ת עם שורה אחת לסמל
   פיצולים, ניודים ותפקידים שהתוכנה גזרה לבד אינם נכתבים — הם נגזרים מהקובץ. */
const JSZip = require('jszip');
const XLSX = require('xlsx');
const { detectStructure, inferMissingColumns, norm } = require('./ingest');
const { setCellsInSheetXml, resolveSheetPath } = require('./fillMinistry');

const digits = (v) => String(v || '').replace(/\D/g, '');
const numToCol = (n) => { let s = ''; n += 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* rows — שורות cost_rows של הקובץ; idFixes — { ת.ז בקובץ → ת.ז מתוקנת }.
   מחזיר { buffer, patched: { symbol, id, hours, sheets } } */
async function patchCostFile(buf, { learned = {}, rows = [], idFixes = {}, sheetsUsed = [] }) {
  const wb = XLSX.read(buf, { type: 'buffer', cellStyles: false });
  const byWorker = new Map(); // ת.ז (מתוקנת) → שורות
  for (const r of rows) {
    const k = digits(r.emp_id).replace(/^0+/, '');
    if (!byWorker.has(k)) byWorker.set(k, []);
    byWorker.get(k).push(r);
  }
  const counts = { symbol: 0, id: 0, hours: 0, sheets: 0 };
  const writesBySheet = new Map(); // sheetName → [{row, col, kind, value}]

  for (const sheetName of wb.SheetNames) {
    if (sheetsUsed.length && !sheetsUsed.includes(sheetName)) continue;
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const det = inferMissingColumns(aoa, detectStructure(aoa, learned));
    if (det.rowIdx < 0 || det.mapping.id === undefined) continue;
    const m = det.mapping;
    const rowNumOf = (i) => range.s.r + i + 1; // אינדקס במערך → מספר שורה בגיליון (1-based)
    const colOf = (c) => numToCol(range.s.c + c);
    const writes = [];
    // עמודת סמל: קיימת — או נוספת בסוף (רק עמודה נוספת, בלי לגעת בשאר)
    let symCol = m.instSymbol;
    let addedSymCol = false;
    const lastCol = Math.max(...aoa.map((r) => (r || []).length), 1);
    for (let i = det.rowIdx + 1; i < aoa.length; i++) {
      const row = aoa[i] || [];
      const fid = digits(row[m.id]);
      if (!fid) continue;
      const fixed = idFixes[fid] || idFixes[fid.replace(/^0+/, '')] || null;
      const key = (fixed || fid).replace(/^0+/, '');
      const cands = byWorker.get(key) || [];
      if (!cands.length) continue;
      const fileSym = symCol !== undefined ? digits(row[symCol]) : '';
      // השורה בתוכנה שמתאימה לשורת הקובץ: לפי סמל הקובץ, ואם אין — היחידה
      let r = cands.find((x) => fileSym && digits(x.inst_symbol) === fileSym) || (cands.length === 1 ? cands[0] : null);
      if (!r && fileSym === '') r = cands.find((x) => !x.inst_symbol) || cands[0];
      if (!r) continue;
      const finalSym = digits(r.symbol_override || r.inst_symbol || '');
      if (finalSym && finalSym !== fileSym) {
        if (symCol === undefined) { symCol = lastCol; addedSymCol = true; }
        writes.push({ row: rowNumOf(i), col: colOf(symCol), kind: 'num', value: finalSym });
        counts.symbol++;
      }
      if (fixed && fixed !== fid) {
        writes.push({ row: rowNumOf(i), col: colOf(m.id), kind: /^0/.test(fixed) ? 'text' : 'num', value: fixed });
        counts.id++;
      }
      // שעות — רק עריכה ידנית של המשתמשת; קיצוץ אוטומטי לתקרה (manual_rates.auto)
      // הוא נגזרת של התוכנה ולא נכתב לקובץ הלקוח
      let manualHours = false;
      if (r.manual_rates) { try { manualHours = !JSON.parse(r.manual_rates).auto; } catch { manualHours = false; } }
      if (manualHours && m.hours !== undefined) {
        const sameWorkerRows = cands.filter((x) => digits(x.inst_symbol) === digits(r.inst_symbol)).length;
        const fileRowsOfWorker = aoa.slice(det.rowIdx + 1).filter((rr) => rr && digits(rr[m.id]) === fid && (symCol === undefined || digits(rr[symCol]) === fileSym)).length;
        const fileHours = Number(row[m.hours]);
        if (sameWorkerRows === 1 && fileRowsOfWorker === 1 && r.hours != null && Math.abs((Number.isFinite(fileHours) ? fileHours : -1) - Number(r.hours)) > 0.001) {
          writes.push({ row: rowNumOf(i), col: colOf(m.hours), kind: 'num', value: Math.round(Number(r.hours) * 100) / 100 });
          counts.hours++;
        }
      }
    }
    if (addedSymCol) writes.push({ row: rowNumOf(det.rowIdx), col: colOf(symCol), kind: 'text', value: 'סמל מוסד' });
    if (writes.length) { writesBySheet.set(sheetName, writes); counts.sheets++; }
    if (addedSymCol) writes.newLastCol = colOf(symCol); // להרחבת טווח הגיליון (dimension) — אחרת העמודה "מחוץ לטווח"
  }

  if (!writesBySheet.size) return { buffer: buf, patched: counts };
  const zip = await JSZip.loadAsync(buf);
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  for (const [sheetName, writes] of writesBySheet) {
    const path = resolveSheetPath(wbXml, relsXml, escRe(sheetName.replace(/&/g, '&amp;').replace(/"/g, '&quot;')));
    if (!path || !zip.file(path)) continue;
    let xml = await zip.file(path).async('string');
    xml = setCellsInSheetXml(xml, writes);
    if (writes.newLastCol) {
      // <dimension ref="A1:I140"/> → עד העמודה החדשה, כדי שקוראי אקסל יראו אותה
      xml = xml.replace(/<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"\s*\/>/, (all, from, endCol, endRow) => {
        const colNum = (s) => s.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
        return colNum(writes.newLastCol) > colNum(endCol) ? `<dimension ref="${from}:${writes.newLastCol}${endRow}"/>` : all;
      });
    }
    zip.file(path, xml);
  }
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer: out, patched: counts };
}

module.exports = { patchCostFile };
