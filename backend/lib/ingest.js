/* מנוע קליטת דוחות עלות שכר — הועבר מאב-הטיפוס (מנוע_קליטת_דוחות_עלות v12)
   לשירות ה-Backend עם התמדה (README §8, §14 צעד 3).
   כולל: זיהוי אוטומטי של מבנה, תיקון קידוד עברית, ריבוי לשוניות,
   נרמול, צבירת רכיבי שכר, ובקרות. */

const XLSX = require('xlsx');
const { GROSS_CAP } = require('./domain');

/* ---------- מילוני זיהוי עמודות (לב המתאם האוניברסלי) ---------- */
const FIELD_DEFS = [
  { key: 'id', label: 'תעודת זהות', syn: ['מספר זהות', 'תעודת זהות', 'ת.ז', 'ת"ז', 'ת.ז.', "מס' זהות", 'תז', 'ת.ז. עובד', 'זהות'] },
  { key: 'lastName', label: 'שם משפחה', syn: ['שם משפחה', 'משפחה'] },
  { key: 'firstName', label: 'שם פרטי', syn: ['שם פרטי', 'פרטי'] },
  { key: 'fullName', label: 'שם מלא', syn: ['שם עובד', 'שם העובד', 'שם מלא'] },
  { key: 'dept', label: 'מחלקה / סעיף', syn: ['תאור סעיף', 'תיאור סעיף', 'מחלקה', 'סעיף', 'שלוחה', 'כרטיס', 'שם מחלקה', 'פרויקט', 'תמחיר'] },
  { key: 'instSymbol', label: 'סמל מוסד (בדוח השכר)', syn: ['סמל מוסד', 'סמל מקום פעילות', 'סמל גן', 'סמל בית ספר', 'סמל מוסד לימוד', 'קוד מוסד', 'סמל'] },
  { key: 'component', label: 'שם רכיב שכר', syn: ['שם רכיב שכר', 'רכיב שכר', 'שם רכיב', 'תאור רכיב', 'תיאור רכיב', 'סוג רכיב', 'קוד רכיב', 'רכיב תשלום', 'רכיב'] },
  { key: 'roleText', label: 'תפקיד (בדוח השכר)', syn: ['תפקיד'] },
  { key: 'instName', label: 'שם גן/מוסד (בדוח השכר)', syn: ['שם מוסד', 'שם הגן', 'שם גן', 'שם בית ספר', 'שם מקום פעילות'] },
  { key: 'gross', label: 'סה"כ ברוטו', syn: ['סה"כ ברוטו', 'סהכ ברוטו', 'סה"כ סכום', 'סהכ סכום', 'ברוטו', 'שכר ברוטו', 'ריכוז תשלומים', 'ריכוז  תשלומים'] },
  { key: 'cost', label: 'עלות מעביד', syn: ['עלות עובד', 'עלות מעביד', 'סה"כ עלות', 'סהכ עלות', 'עלות שכר', 'עלות כוללת', 'עלות'] },
  { key: 'hours', label: 'שעות עבודה', syn: ['שעות עבודה', 'סך שעות', 'כמות שעות', 'שעות', 'סה"כ שעות', 'ש.עבודה'] },
];

const norm = (s) => String(s ?? '').replace(/["'״׳]/g, '').replace(/\s+/g, ' ').trim();

/* חתימות של תוכנות שכר מוכרות */
const SOFTWARE_SIGNATURES = [
  { name: 'דוח 66 — מל"ם / חשבשבת שכר', must: ['מספר זהות', 'עלות עובד', 'שעות עבודה', 'תאור סעיף'] },
  { name: 'דוח רכיבי שכר (לשונית לכל עיר)', must: ['מספר עובד', 'סה"כ סכום', 'ברוטו לשעה', 'תפקיד'] },
  { name: 'שקלולית', must: ['עלות מעביד', 'שם עובד'] },
  { name: 'עוקץ / מיכפל', must: ['עלות כוללת', "מס' זהות"] },
];

const EMPLOYER_FACTOR = 1.38; // מקדם עלות מעביד (ברוטו → עלות)
const HOURS_CAP = 90;         // תקרת שעות ברירת-מחדל (מדויק יותר לפי תפקיד בשלב הבקרה בדוח)

/* ---------- בקרת ת.ז ---------- */
function isValidIsraeliId(raw) {
  const s = String(raw ?? '').replace(/\D/g, '');
  if (s.length < 5 || s.length > 9) return false;
  const p = s.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = Number(p[i]) * (i % 2 === 0 ? 1 : 2);
    if (d > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

/* ---------- זיהוי מבנה הקובץ ---------- */
function detectStructure(rows, learned = {}) {
  let best = { rowIdx: -1, mapping: {}, score: 0 };
  const scanLimit = Math.min(rows.length, 12);
  for (let r = 0; r < scanLimit; r++) {
    const row = rows[r] || [];
    const mapping = {};
    let score = 0;
    row.forEach((cell, c) => {
      const cellN = norm(cell);
      if (!cellN) return;
      const learnedKey = learned[cellN];
      if (learnedKey && FIELD_DEFS.some((f) => f.key === learnedKey) && mapping[learnedKey] === undefined) {
        mapping[learnedKey] = c; score += 2; return;
      }
      for (const f of FIELD_DEFS) {
        if (mapping[f.key] !== undefined) continue;
        if (f.syn.some((s) => cellN === norm(s) || cellN.includes(norm(s)))) { mapping[f.key] = c; score++; break; }
      }
    });
    if (score > best.score) best = { rowIdx: r, mapping, score };
  }
  if (best.rowIdx < 0) {
    const firstData = rows.findIndex((r) => (r || []).filter((c) => norm(c) !== '').length >= 2);
    if (firstData >= 0) best = { rowIdx: firstData, mapping: {}, score: 0 };
  }
  // עידון מחלקה: כשיש כמה עמודות מתאימות (קוד + שם), ניתוב עובד לפי טקסט,
  // לכן בוחרים את העמודה עם הערכים הטקסטואליים ביותר (שם מחלקה ולא קוד).
  if (best.rowIdx >= 0) {
    const headerRow = (rows[best.rowIdx] || []).map(norm);
    const deptField = FIELD_DEFS.find((f) => f.key === 'dept');
    const candidates = [];
    headerRow.forEach((h, c) => {
      if (h && deptField.syn.some((s) => h === norm(s) || h.includes(norm(s)))) candidates.push(c);
    });
    if (candidates.length > 1) {
      const sample = rows.slice(best.rowIdx + 1, best.rowIdx + 201);
      const stat = (c) => {
        let text = 0, total = 0;
        const distinct = new Set();
        for (const row of sample) {
          const v = (row || [])[c];
          if (v === null || v === undefined || v === '') continue;
          total++;
          const sv = String(v).trim();
          if (!/^[\d.,\-]+$/.test(sv) && /[א-ת]/.test(sv)) { text++; distinct.add(sv); } // ערך עברי לא-מספרי
        }
        return { textScore: total ? text / total : 0, distinct: distinct.size };
      };
      // מבין העמודות הטקסטואליות — המפורטת ביותר (הכי הרבה ערכים שונים):
      // "מחלקה" גסה ("צהרונים") מול "תאור סעיף" מפורט — הציר המפורט הוא ציר הניתוב
      const scored = candidates.map((c) => ({ c, ...stat(c) })).filter((s) => s.textScore > 0.5);
      scored.sort((a, b) => b.distinct - a.distinct || a.c - b.c);
      if (scored.length) best.mapping.dept = scored[0].c;
    }
  }
  if (best.rowIdx >= 0) {
    const headerRowN = (rows[best.rowIdx] || []).map(norm);
    // פורמט "המשכיל" וכדומה: אין עמודת ת.ז, אבל "מספר עובד" מכיל בפועל ת.ז
    if (best.mapping.id === undefined) {
      const c = headerRowN.findIndex((h) => h === 'מספר עובד');
      if (c >= 0) best.mapping.id = c;
    }
    // עמודת סמל בשם "מוסד" בלבד (התאמה מדויקת — לא "שם מוסד")
    if (best.mapping.instSymbol === undefined) {
      const c = headerRowN.findIndex((h) => h === 'מוסד');
      if (c >= 0) best.mapping.instSymbol = c;
    }
    // סכומים: עדיפות לעמודות "סה"כ" על פני תעריפי "לשעה" ("סכום 100"/"ברוטו לשעה")
    for (const key of ['gross', 'cost', 'hours']) {
      const f = FIELD_DEFS.find((x) => x.key === key);
      const cands = [];
      headerRowN.forEach((h, c) => {
        if (h && f.syn.some((s) => h === norm(s) || h.includes(norm(s)))) cands.push(c);
      });
      if (cands.length > 1) {
        const score = (c) => {
          const h = headerRowN[c];
          let s = 0;
          if (/סהכ/.test(h)) s += 2;
          if (/לשעה|שעתי/.test(h)) s -= 3; // תעריף, לא סכום
          return s;
        };
        const bestCol = cands.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s || a.c - b.c)[0];
        best.mapping[key] = bestCol.c;
      }
    }
  }
  let software = 'מבנה לא מוכר — זוהה לפי מילון עמודות';
  if (best.rowIdx >= 0) {
    const headerCells = (rows[best.rowIdx] || []).map(norm);
    for (const sig of SOFTWARE_SIGNATURES) {
      if (sig.must.every((m) => headerCells.some((h) => h.includes(norm(m))))) { software = sig.name; break; }
    }
  }
  return { ...best, software };
}

/* ---------- נרמול שורות ----------
   defaultDept: כשאין עמודת מחלקה, שם הלשונית משמש כמחלקה (פורמט לשונית-לכל-עיר) */
function normalizeRows(rows, headerIdx, mapping, defaultDept) {
  const out = [];
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const get = (k) => (mapping[k] !== undefined ? row[mapping[k]] : null);
    const id = get('id');
    const cost = num(get('cost'));
    const gross = num(get('gross'));
    if (id === null && cost === null && gross === null) continue;
    const idStr = String(id ?? '').replace(/\D/g, '');
    if (!idStr) continue;
    const hours = num(get('hours'));
    const name = mapping.fullName !== undefined
      ? norm(get('fullName'))
      : [norm(get('firstName')), norm(get('lastName'))].filter(Boolean).join(' ');
    out.push({
      id: idStr, name,
      firstName: norm(get('firstName')) || null,
      lastName: norm(get('lastName')) || null,
      component: norm(get('component')) || null,
      roleText: norm(get('roleText')) || null, // תפקיד כפי שמופיע בדוח השכר (אם קיים)
      instName: norm(get('instName')) || null, // שם הגן/בי"ס בשורה — לשיוך סמל מול ההרשמה
      instSymbol: String(get('instSymbol') ?? '').replace(/\D/g, '') || null,
      dept: norm(get('dept')) || norm(defaultDept) || 'ללא מחלקה',
      gross, cost, hours,
    });
  }
  return out;
}

/* ---------- צבירת רכיבי שכר: קיבוץ שורות של אותו עובד באותה מחלקה ---------- */
function aggregateComponents(recs) {
  const m = new Map();
  recs.forEach((r) => {
    // עובד המשולם ע"י שני משלמים (מתנ"ס + רשות) נשאר בשורות נפרדות
    const key = `${r.id}||${r.dept}||${r.payer || ''}`;
    const cur = m.get(key);
    if (!cur) {
      m.set(key, { ...r, components: 1, componentNames: r.component ? [r.component] : [] });
    } else {
      cur.components += 1;
      cur.gross = cur.gross === null && r.gross === null ? null : (cur.gross ?? 0) + (r.gross ?? 0);
      cur.cost = cur.cost === null && r.cost === null ? null : (cur.cost ?? 0) + (r.cost ?? 0);
      cur.hours = cur.hours === null && r.hours === null ? null : (cur.hours ?? 0) + (r.hours ?? 0);
      if (!cur.name && r.name) cur.name = r.name;
      if (r.component && !cur.componentNames.includes(r.component)) cur.componentNames.push(r.component);
      if (!cur.instSymbol && r.instSymbol) cur.instSymbol = r.instSymbol;
    }
  });
  return [...m.values()].map((r) => ({
    ...r,
    hourlyCost: r.cost !== null && r.hours ? r.cost / r.hours : null,
    hourlyGross: r.gross !== null && r.hours ? r.gross / r.hours : null,
  }));
}

/* ---------- בקרות על הנתונים המנורמלים ----------
   grossCap: תקרת ברוטו שעתי לפי סוג התוכנית (120 בי"ס/גנים, 150 מכינות).
   vatFactor: 1.18 ללקוח חייב מע"מ — העלות המוכרת = עלות מעביד + מע"מ.
   כלל ה-40%: העלות השעתית המוכרת לא תחרוג מ-140% מהברוטו השעתי. */
const COST_MARKUP_LIMIT = 1.4;

/* העלות המוכרת של שורת עלות: עלות מעביד × מע"מ (ללקוח חייב), מוגבלת לתקרת
   ההכרה של המשרד — ברוטו × 140% (זהה להגבלה השעתית: השעות מצטמצמות).
   משמש בכל השוואת "ביצוע מוכר" מול תקציב: מכתב, בקרת שכר, המלצות, ייצוא. */
function recognizedRowCost(row, vatFactor = 1) {
  if (row.cost == null) return 0;
  const full = row.cost * vatFactor;
  return row.gross > 0 ? Math.min(full, row.gross * COST_MARKUP_LIMIT) : full;
}
function runChecks(recs, { grossCap = GROSS_CAP.schools_gardens, hoursCap = HOURS_CAP, vatFactor = 1 } = {}) {
  const costCap = grossCap * EMPLOYER_FACTOR;
  const seen = new Map();
  const hoursById = new Map();
  recs.forEach((r) => {
    seen.set(r.id, (seen.get(r.id) || 0) + 1);
    hoursById.set(r.id, (hoursById.get(r.id) || 0) + (r.hours || 0));
  });
  return recs.map((r) => {
    const flags = [];
    const hourlyCost = r.hourlyCost ?? (r.cost !== null && r.hours ? r.cost / r.hours : null);
    const hourlyGross = r.hourlyGross ?? (r.gross !== null && r.hours ? r.gross / r.hours : null);
    if (!isValidIsraeliId(r.id)) flags.push({ level: 'err', text: 'ת.ז לא תקינה' });
    if (seen.get(r.id) > 1) flags.push({ level: 'warn', text: 'מדווח ביותר ממחלקה אחת — לוודא פיצול שעות' });
    if (!r.name) flags.push({ level: 'warn', text: 'חסר שם עובד' });
    if (r.cost !== null && r.cost < 0) flags.push({ level: 'err', text: 'עלות שלילית — מיון שכר?' });
    if (r.cost !== null && r.gross !== null && r.gross > 0 && r.cost < r.gross)
      flags.push({ level: 'warn', text: 'עלות מעביד נמוכה מהברוטו — לבדוק' });
    if (r.cost !== null && (r.hours === null || r.hours === 0)) flags.push({ level: 'warn', text: 'חסרות שעות — אין עלות שעתית' });
    if ((hoursById.get(r.id) || 0) > hoursCap) flags.push({ level: 'warn', text: `סה"כ שעות מעל ${hoursCap} — לבדוק` });
    if (hourlyGross !== null && hourlyGross > grossCap) flags.push({ level: 'err', text: `ברוטו שעתי מעל ${grossCap} ₪` });
    if (hourlyCost !== null && hourlyCost > costCap) flags.push({ level: 'err', text: `עלות מעביד שעתית מעל ${costCap.toFixed(1)} ₪` });
    // כלל ה-40%: בדיווח נרשם הנמוך מבין עלות×מע"מ לבין ברוטו×1.40 — לכן זו
    // אינה שגיאה אלא מידע: העלות של העובד הוגבלה לתקרה (מוסבר בדוח ההתאמה)
    const recognizedHourlyCost = hourlyCost !== null ? hourlyCost * vatFactor : null;
    if (recognizedHourlyCost !== null && hourlyGross !== null && hourlyGross > 0 &&
        recognizedHourlyCost > hourlyGross * COST_MARKUP_LIMIT * 1.001) {
      flags.push({
        level: 'warn',
        text: `עלות שעתית ${Math.round((recognizedHourlyCost / hourlyGross) * 100)}% מהברוטו — דווחה לפי תקרת ברוטו+40% (הנמוך מבין)`,
      });
    }
    return { ...r, hourlyCost, hourlyGross, recognizedHourlyCost, flags };
  });
}

/* ---------- קריאת קובץ: כל הלשוניות + תיקון קידוד עברית (Windows-1255) ---------- */
function hasMojibake(rows) {
  const limit = Math.min(rows.length, 15);
  let suspicious = false, hebrew = false;
  for (let r = 0; r < limit; r++) {
    for (const c of rows[r] || []) {
      if (typeof c !== 'string') continue;
      if (c.includes('�')) return true;
      if (/[א-ת]/.test(c)) hebrew = true;
      if (/[À-ÿ]{2,}/.test(c)) suspicious = true;
    }
  }
  return suspicious && !hebrew;
}

/* מחזיר [{ sheetName, rows }] — כל לשונית בעלת נתונים בנפרד */
function readWorkbookSheets(buf) {
  const extract = (wb) =>
    wb.SheetNames.map((n) => ({
      sheetName: n,
      rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null }),
    })).filter((s) => s.rows.some((r) => r && r.some((c) => c !== null && c !== '')));

  let sheets = extract(XLSX.read(buf, { type: 'buffer' }));
  if (sheets.some((s) => hasMojibake(s.rows))) {
    try {
      const text = new TextDecoder('windows-1255').decode(buf);
      const retry = extract(XLSX.read(text, { type: 'string' }));
      if (retry.length && !retry.some((s) => hasMojibake(s.rows))) sheets = retry;
    } catch { /* נשארים עם הקריאה הראשונה */ }
  }
  return sheets;
}

function isPayrollSheet(det) {
  return det.rowIdx >= 0 && (det.mapping.id !== undefined || det.mapping.cost !== undefined || det.mapping.gross !== undefined);
}

/* מפענח קובץ שלם → שורות מנורמלות מאוחדות מכל הלשוניות בעלות נתוני שכר.
   מחזיר { software, sheetsUsed, records } */
function parseCostFile(buf, learned = {}) {
  const sheets = readWorkbookSheets(buf);
  const detected = sheets.map((s) => ({ ...s, det: detectStructure(s.rows, learned) }));
  let chosen = detected.filter((s) => isPayrollSheet(s.det));
  if (chosen.length === 0 && detected.length) {
    chosen = [detected.reduce((a, b) => (b.rows.length > a.rows.length ? b : a))];
  }
  const records = [];
  const sheetsUsed = [];
  let software = null;
  chosen.forEach((s) => {
    if (s.det.rowIdx < 0) return;
    sheetsUsed.push(s.sheetName);
    if (!software && s.det.software && !s.det.software.startsWith('מבנה לא מוכר')) software = s.det.software;
    records.push(...normalizeRows(s.rows, s.det.rowIdx, s.det.mapping, s.sheetName));
  });
  const aggregated = aggregateComponents(records);
  return { software: software || 'מבנה לא מוכר', sheetsUsed, records: aggregated };
}

module.exports = {
  FIELD_DEFS, SOFTWARE_SIGNATURES, norm, isValidIsraeliId,
  detectStructure, normalizeRows, aggregateComponents, runChecks,
  readWorkbookSheets, parseCostFile, EMPLOYER_FACTOR, HOURS_CAP, COST_MARKUP_LIMIT, recognizedRowCost,
};
