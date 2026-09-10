/* מילוי גיליון "פירוט עלויות כח אדם" בקובץ דוח הביצוע של המשרד (README §9, צעד 9).
   הגיליון מוגן ע"י המשרד (אין סיסמה) — לכן הכתיבה נעשית ישירות ל-XML שבתוך
   ה-xlsx: עורכים אך ורק את תאי הקלט (B, D-L) בגיליון היעד, ומשאירים את כל
   השאר — נוסחאות C (שם מוסד) ו-M (עלות לתקופה), עמודות הבקרה, שאר הגיליונות,
   העיצוב וההגנה — ללא שינוי. הועבר מאב-הטיפוס (v12, נבדק 8/8 מול קובץ אמיתי). */

const JSZip = require('jszip');
const XLSX = require('xlsx');
const { norm } = require('./budgetFile');

// בגנים הלשונית נקראת "פירוט עלויות כח אדם", בבתי"ס "עלויות כח אדם" — המכנה המשותף
const MINISTRY_SHEET_HINT = 'עלויות כח אדם';

/* אינדקס בשורת הייצוא → היסט מעמודת הסמל (גנים: הסמל ב-B, בתי"ס: ב-A —
   סדר העמודות זהה, רק ההתחלה זזה). היסטים 1 (שם מוסד) ו-11 (עלות לתקופה)
   הן נוסחאות של המשרד — לא נוגעים. */
const MINISTRY_OFFSETS = [
  { src: 0, off: 0, kind: 'num' },   // סמל מקום פעילות
  { src: 2, off: 2, kind: 'id' },    // ת.ז עובד
  { src: 3, off: 3, kind: 'text' },  // שם פרטי
  { src: 4, off: 4, kind: 'text' },  // שם משפחה
  { src: 5, off: 5, kind: 'text' },  // הועסק ע"י
  { src: 6, off: 6, kind: 'text' },  // איש צוות
  { src: 7, off: 7, kind: 'text' },  // תפקיד
  { src: 8, off: 8, kind: 'num' },   // שכר ברוטו שעתי
  { src: 9, off: 9, kind: 'num' },   // עלות שכר שעתית
  { src: 10, off: 10, kind: 'num' }, // סך שעות
];

const colToNum = (c) => { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parseRowCells(inner) {
  const cells = {};
  const re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    const refM = /\br="([A-Z]+)(\d+)"/.exec(m[1]);
    if (!refM) continue;
    cells[refM[1]] = { colLetter: refM[1], attrs: m[1], full: m[0] };
  }
  return cells;
}

function buildCell(colLetter, rowNum, style, kind, value) {
  const ref = `${colLetter}${rowNum}`;
  const sAttr = style != null ? ` s="${style}"` : '';
  if (value === null || value === undefined || value === '') return `<c r="${ref}"${sAttr}/>`;
  if (kind === 'text') return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(value)}</t></is></c>`;
  const str = String(value);
  const asNum = Number(str);
  // ערך עם אפס מוביל (ת.ז) או שאינו מספרי — נשמר כטקסט כדי לא לאבד ספרות
  if (!Number.isFinite(asNum) || /^0\d/.test(str)) return `<c r="${ref}"${sAttr} t="inlineStr"><is><t>${xmlEsc(str)}</t></is></c>`;
  return `<c r="${ref}"${sAttr}><v>${asNum}</v></c>`;
}

/* סריקת תאי גיליון לפי כתובות אמיתיות (A1) — עמיד לטווחים שלא מתחילים ב-A
   (בתבנית בתי הספר טווח הגיליון מתחיל ב-B ואינדקסים של sheet_to_json מטעים) */
function scanCells(ws, maxRow = 60) {
  const out = [];
  for (const addr of Object.keys(ws)) {
    if (addr[0] === '!') continue;
    const { c, r } = XLSX.utils.decode_cell(addr);
    if (r >= maxRow) continue;
    const v = norm(ws[addr].v ?? ws[addr].w ?? '');
    if (v) out.push({ c, r, v }); // c/r אפס-מבוססים
  }
  return out;
}

/* איתור שורת ההתחלה ועמודת הבסיס: תא הכותרת "סמל [מוסד] מקום פעילות",
   דילוג על שורת "רכז רשותי" אם קיימת מיד אחריה. שאר העמודות בהיסט קבוע. */
function detectStartRow(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', sheetRows: 60 });
  const sheetName = wb.SheetNames.find((n) => n.includes(MINISTRY_SHEET_HINT));
  if (!sheetName) return { error: `לא נמצא גיליון "${MINISTRY_SHEET_HINT}" בקובץ.` };
  const cells = scanCells(wb.Sheets[sheetName]);
  const head = cells.find((x) => x.v.startsWith('סמל') && x.v.includes('מקום פעילות'));
  if (!head) return { error: 'לא נמצאה שורת הכותרות ("סמל מקום פעילות") בגיליון עלויות כח האדם.' };
  const skipCoord = cells.some((x) => x.r === head.r + 1 && x.v.includes('רכז רשותי'));
  const colSpecs = MINISTRY_OFFSETS.map(({ src, off, kind }) => ({ src, col: XLSX.utils.encode_col(head.c + off), kind }));
  return { sheetName, headerRow: head.r + 1, startRow: head.r + (skipCoord ? 3 : 2), baseCol: head.c, colSpecs }; // 1-based
}

/* מאתר את קובץ ה-XML הפנימי של גיליון לפי רמז-שם */
function resolveSheetPath(wbXml, relsXml, hint) {
  const sheetM = new RegExp(`<sheet[^>]*name="([^"]*${hint}[^"]*)"[^>]*r:id="(rId\\d+)"`).exec(wbXml);
  if (!sheetM) return null;
  const relM = new RegExp(`<Relationship[^>]*Id="${sheetM[2]}"[^>]*Target="([^"]+)"`).exec(relsXml);
  if (!relM) return null;
  return 'xl/' + relM[1].replace(/^\/?xl\//, '');
}

/* ליבת הכתיבה: ממלא rows (מערכי ערכים לפי colSpecs.src) מ-startRow, ואז מרוקן
   תאי קלט בשורות עודפות מתחת (שאריות ממילוי ידני קודם). נוסחאות בעמודות אחרות
   לא נגועות. */
function applyRowsToSheetXml(xml, colSpecs, startRow, rows, clearBelow = 500) {
  // סגנונות ייחוס משורת הנתונים הראשונה, כדי שהעיצוב יישמר
  const refStyles = {};
  const refRowM = new RegExp(`<row r="${startRow}"[^>]*>([\\s\\S]*?)</row>`).exec(xml);
  if (refRowM) {
    const rc = parseRowCells(refRowM[1]);
    for (const { col } of colSpecs) {
      const cm = /\bs="(\d+)"/.exec((rc[col] || {}).attrs || '');
      if (cm) refStyles[col] = cm[1];
    }
  }

  const renderRow = (cellsMap, rowNum, values) => {
    for (const { src, col, kind } of colSpecs) {
      const style = refStyles[col] != null ? refStyles[col] : (/(\bs=")(\d+)/.exec((cellsMap[col] || {}).attrs || '') || [])[2];
      cellsMap[col] = { colLetter: col, full: buildCell(col, rowNum, style, kind, values ? values[src] : null) };
    }
    return Object.values(cellsMap)
      .sort((a, b) => colToNum(a.colLetter) - colToNum(b.colLetter))
      .map((c) => c.full)
      .join('');
  };

  rows.forEach((row, i) => {
    const rowNum = startRow + i;
    const rowRe = new RegExp(`<row r="${rowNum}"([^>]*)>([\\s\\S]*?)</row>`);
    const rm = rowRe.exec(xml);
    if (rm) {
      xml = xml.replace(rowRe, `<row r="${rowNum}"${rm[1]}>${renderRow(parseRowCells(rm[2]), rowNum, row)}</row>`);
    } else {
      const newRow = `<row r="${rowNum}" spans="1:28">${renderRow({}, rowNum, row)}</row>`;
      const re = /<row r="(\d+)"/g;
      let insertAt = -1, mm;
      while ((mm = re.exec(xml)) !== null) { if (parseInt(mm[1]) > rowNum) { insertAt = mm.index; break; } }
      xml = insertAt >= 0 ? xml.slice(0, insertAt) + newRow + xml.slice(insertAt) : xml.replace('</sheetData>', newRow + '</sheetData>');
    }
  });

  // ריקון שאריות: שורות קיימות מתחת לאזור שמולא שעדיין מכילות ערכי קלט
  for (let rowNum = startRow + rows.length; rowNum < startRow + rows.length + clearBelow; rowNum++) {
    const rowRe = new RegExp(`<row r="${rowNum}"([^>]*)>([\\s\\S]*?)</row>`);
    const rm = rowRe.exec(xml);
    if (!rm) continue;
    const cells = parseRowCells(rm[2]);
    const hasValue = colSpecs.some(({ col }) => cells[col] && /<v>|<is>/.test(cells[col].full));
    if (!hasValue) continue;
    xml = xml.replace(rowRe, `<row r="${rowNum}"${rm[1]}>${renderRow(cells, rowNum, null)}</row>`);
  }
  return xml;
}

/* rows: מערך של מערכים בסדר MINISTRY_COLS.src (אינדקסים 1 ו-11 מדולגים).
   coordRows (אופציונלי, גנים): [[מס' סידורי, סמל גן, היקף משרה], ...] ללשונית רכזות הגנים.
   expenses (אופציונלי): { aggregate: {basketKey: {amount, cards, source}} } לגנים,
   או { perSchool: [[סמל, מהות, סכום, כרטיס, מקור], ...] } לבתי"ס — ללשונית הוצאות בפועל.
   מחזיר Buffer של ה-xlsx הממולא. */
async function fillMinistryReport(buf, rows, coordRows = null, expenses = null, income = null) {
  const det = detectStartRow(buf);
  if (det.error) throw new Error(det.error);

  const zip = await JSZip.loadAsync(buf);
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');

  const sheetPath = resolveSheetPath(wbXml, relsXml, MINISTRY_SHEET_HINT);
  if (!sheetPath) throw new Error(`לא נמצא גיליון "${MINISTRY_SHEET_HINT}" בקובץ — ודאי שזה קובץ דוח הביצוע של המשרד.`);
  let xml = await zip.file(sheetPath).async('string');
  xml = applyRowsToSheetXml(xml, det.colSpecs, det.startRow, rows);
  zip.file(sheetPath, xml);

  // לשונית רכזות הגנים (§ גנים בלבד): B=מס' סידורי, C=סמל גן, G=היקף משרה. D/E/F/I/J נוסחאות.
  if (coordRows && coordRows.length) {
    const coordDet = detectCoordStart(buf);
    if (!coordDet.error) {
      const coordPath = resolveSheetPath(wbXml, relsXml, COORD_SHEET_HINT);
      if (coordPath) {
        let cxml = await zip.file(coordPath).async('string');
        cxml = applyRowsToSheetXml(cxml, COORD_COLS, coordDet.startRow, coordRows);
        zip.file(coordPath, cxml);
      }
    }
  }

  // לשונית "דוח הוצאות בפועל" — מהכרטסות המשויכות
  if (expenses) {
    const expDet = detectExpenseSheet(buf);
    if (!expDet.error) {
      const expPath = resolveSheetPath(wbXml, relsXml, EXPENSE_SHEET_HINT);
      if (expPath) {
        let exml = await zip.file(expPath).async('string');
        if (expDet.mode === 'aggregate' && expenses.aggregate) {
          const writes = [];
          for (const [key, data] of Object.entries(expenses.aggregate)) {
            const rowNum = expDet.labelRows[key];
            if (!rowNum) continue;
            if (expDet.amountCol >= 0) writes.push({ row: rowNum, col: colLetter(expDet.amountCol), kind: 'num', value: data.amount });
            if (expDet.cardCol >= 0) writes.push({ row: rowNum, col: colLetter(expDet.cardCol), kind: 'text', value: data.cards });
            if (expDet.sourceCol >= 0) writes.push({ row: rowNum, col: colLetter(expDet.sourceCol), kind: 'text', value: data.source });
          }
          exml = setCellsInSheetXml(exml, writes);
        } else if (expDet.mode === 'perSchool' && expenses.perSchool) {
          exml = applyRowsToSheetXml(exml, expDet.colSpecs, expDet.startRow, expenses.perSchool);
        }
        zip.file(expPath, exml);
      }
    }
  }

  // לשונית "תשלומי הורים" — גבייה = ילדים × תעריף, ופרטי כרטיס ההכנסות מהכרטסת
  if (income) {
    const incDet = detectIncomeSheet(buf);
    if (!incDet.error) {
      const incPath = resolveSheetPath(wbXml, relsXml, INCOME_SHEET_HINT);
      if (incPath) {
        let ixml = await zip.file(incPath).async('string');
        const writes = [];
        const pushRow = (rowNum, data) => {
          if (incDet.cols.amount >= 0) writes.push({ row: rowNum, col: colLetter(incDet.cols.amount), kind: 'num', value: data.amount });
          if (incDet.cols.kidsPaid >= 0) writes.push({ row: rowNum, col: colLetter(incDet.cols.kidsPaid), kind: 'num', value: data.kids });
          if (incDet.cols.card >= 0) writes.push({ row: rowNum, col: colLetter(incDet.cols.card), kind: 'text', value: income.card });
          if (incDet.cols.cardName >= 0) writes.push({ row: rowNum, col: colLetter(incDet.cols.cardName), kind: 'text', value: income.cardName });
        };
        if (incDet.mode === 'aggregate' && income.aggregate) {
          pushRow(incDet.row, income.aggregate);
        } else if (incDet.mode === 'perSchool' && income.perSchool) {
          for (const [symbol, data] of Object.entries(income.perSchool)) {
            const rowNum = incDet.rowsBySymbol[symbol];
            if (rowNum) pushRow(rowNum, data);
          }
        }
        if (writes.length) { ixml = setCellsInSheetXml(ixml, writes); zip.file(incPath, ixml); }
      }
    }
  }

  // כפיית חישוב מחדש בפתיחה — שם המוסד, העלות לתקופה והבקרות יתעדכנו לבד
  let wb2 = wbXml;
  if (/<calcPr\b/.test(wb2)) {
    if (!/fullCalcOnLoad/.test(wb2)) wb2 = wb2.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
  } else {
    wb2 = wb2.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
  }
  zip.file('xl/workbook.xml', wb2);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/* ---------- לשונית "דוח הוצאות בפועל" ----------
   גנים: 4 שורות סלים קבועות לכל הרשות (סכום/כרטיס ספק/מקור הפעלה).
   בתי"ס: שורה פר מוסד × מהות הוצאה (סמל/מהות/סכום/כרטיס/מקור); C נוסחת שם. */
const EXPENSE_SHEET_HINT = 'הוצאות בפועל';
const EXPENSE_LABEL_HE = { enrichment: 'העשרה', breakfast: 'ארוחת בוקר', scholarships: 'מלגות להורים', management: 'ניהול ותפעול' };

/* היסטים מעמודת הסמל בלשונית הוצאות בתי"ס: [סמל, (שם=נוסחה), מהות, סכום, כרטיס, מקור] */
const EXPENSE_OFFSETS = [
  { src: 0, off: 0, kind: 'num' },
  { src: 1, off: 2, kind: 'text' },
  { src: 2, off: 3, kind: 'num' },
  { src: 3, off: 4, kind: 'text' },
  { src: 4, off: 5, kind: 'text' },
];

/* מזהה את מבנה לשונית ההוצאות: perSchool (בתי"ס) או aggregate (גנים) — לפי כתובות אמיתיות */
function detectExpenseSheet(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', sheetRows: 40 });
  const sheetName = wb.SheetNames.find((n) => n.includes(EXPENSE_SHEET_HINT));
  if (!sheetName) return { error: 'אין לשונית הוצאות בפועל' };
  const cells = scanCells(wb.Sheets[sheetName], 40);

  const perSchoolHead = cells.find((x) => x.v.includes('סמל מוסד מקום פעילות'));
  if (perSchoolHead) {
    const colSpecs = EXPENSE_OFFSETS.map(({ src, off, kind }) => ({ src, col: XLSX.utils.encode_col(perSchoolHead.c + off), kind }));
    return { sheetName, mode: 'perSchool', startRow: perSchoolHead.r + 2, colSpecs }; // 1-based
  }

  const amountHead = cells.find((x) => x.v.includes('סכום ההוצאה בפועל'));
  if (amountHead) {
    const inRow = (needle) => cells.find((x) => x.r === amountHead.r && x.v.includes(needle));
    const cardHead = inRow('כרטיס ספק');
    const sourceHead = inRow('מקור הפעלה');
    const labelRows = {};
    for (const [key, label] of Object.entries(EXPENSE_LABEL_HE)) {
      const hit = cells.find((x) => x.r > amountHead.r && x.r <= amountHead.r + 15 && x.v === norm(label));
      if (hit) labelRows[key] = hit.r + 1; // 1-based
    }
    return {
      sheetName, mode: 'aggregate', labelRows,
      amountCol: amountHead.c, cardCol: cardHead ? cardHead.c : -1, sourceCol: sourceHead ? sourceHead.c : -1,
    };
  }
  return { error: 'לא זוהה מבנה לשונית ההוצאות' };
}

const colLetter = (idx) => XLSX.utils.encode_col(idx);

/* כתיבת תאים בודדים בשורות קיימות (משאיר את שאר התאים בשורה כמו שהם) */
function setCellsInSheetXml(xml, writes) {
  const byRow = new Map();
  writes.forEach((w) => { if (!byRow.has(w.row)) byRow.set(w.row, []); byRow.get(w.row).push(w); });
  for (const [rowNum, ws] of byRow) {
    const rowRe = new RegExp(`<row r="${rowNum}"([^>]*)>([\\s\\S]*?)</row>`);
    const rm = rowRe.exec(xml);
    const cells = rm ? parseRowCells(rm[2]) : {};
    ws.forEach((w) => {
      const style = (/(\bs=")(\d+)/.exec((cells[w.col] || {}).attrs || '') || [])[2];
      cells[w.col] = { colLetter: w.col, full: buildCell(w.col, rowNum, style, w.kind, w.value) };
    });
    const inner = Object.values(cells).sort((a, b) => colToNum(a.colLetter) - colToNum(b.colLetter)).map((c) => c.full).join('');
    if (rm) xml = xml.replace(rowRe, `<row r="${rowNum}"${rm[1]}>${inner}</row>`);
    else {
      const newRow = `<row r="${rowNum}" spans="1:28">${inner}</row>`;
      const re = /<row r="(\d+)"/g;
      let insertAt = -1, mm;
      while ((mm = re.exec(xml)) !== null) { if (parseInt(mm[1]) > rowNum) { insertAt = mm.index; break; } }
      xml = insertAt >= 0 ? xml.slice(0, insertAt) + newRow + xml.slice(insertAt) : xml.replace('</sheetData>', newRow + '</sheetData>');
    }
  }
  return xml;
}

/* ---------- לשונית "תשלומי הורים ומלגות להורים" (הכנסות משתתפים) ----------
   גבייה מדווחת = כמות ילדים (מדוח הביצוע) × תעריף לילד. גנים: שורה מרוכזת
   אחת לרשות; בתי"ס: שורה פר מוסד (הסמלים כבר בלשונית). */
const INCOME_SHEET_HINT = 'תשלומי הורים';

function detectIncomeSheet(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', sheetRows: 120 });
  const sheetName = wb.SheetNames.find((n) => n.includes(INCOME_SHEET_HINT));
  if (!sheetName) return { error: 'אין לשונית תשלומי הורים' };
  const cells = scanCells(wb.Sheets[sheetName], 120);
  // העוגן: "שם כרטיס" קיים רק בשורת הכותרות האמיתית (הכותרת "דוח ביצוע כספי -
  // הכנסות בפועל" מעל המקטע מכילה גם היא "הכנסות בפועל" ומטעה)
  const nameHead = cells.find((x) => x.v === 'שם כרטיס');
  if (!nameHead) return { error: 'לא זוהתה שורת הכותרות בלשונית ההכנסות' };
  const headerRow = nameHead.r;
  const colOf = (...needles) => {
    const hit = cells.find((x) => x.r === headerRow && needles.some((nd) => x.v.includes(nd)));
    return hit ? hit.c : -1;
  };
  const cols = {
    amount: colOf('גבייה מההורים', 'הכנסות בפועל'),
    card: colOf('נרשם ברשות'),
    cardName: nameHead.c,
    kidsPaid: colOf('כמות ילדים - גביה', 'כמות ילדים גביה'),
  };
  if (cols.amount < 0) return { error: 'לא זוהתה עמודת הגבייה בלשונית ההכנסות' };
  const symHead = cells.find((x) => x.r === headerRow && x.v.includes('סמל מוסד'));
  if (symHead) {
    // בתי"ס: הסמלים כבר ממולאים בעמודה — מאתרים את השורה של כל מוסד
    const rowsBySymbol = {};
    cells.forEach((x) => { if (x.c === symHead.c && x.r > headerRow && /^\d{4,7}$/.test(x.v)) rowsBySymbol[x.v] = x.r + 1; }); // 1-based
    return { sheetName, mode: 'perSchool', cols, rowsBySymbol };
  }
  const label = cells.find((x) => x.v.includes('גבייה בפועל מהורים'));
  if (!label) return { error: 'לא נמצאה שורת הגבייה בלשונית ההכנסות' };
  return { sheetName, mode: 'aggregate', cols, row: label.r + 1 }; // 1-based
}

/* ---------- לשונית "רכזות גנים - דוח ביצוע" (גנים) ---------- */
const COORD_SHEET_HINT = 'רכזות גנים';
const COORD_COLS = [
  { src: 0, col: 'B', kind: 'num' },  // מס' סידורי
  { src: 1, col: 'C', kind: 'num' },  // סמל גן בו מתקיימת הפעילות
  { src: 2, col: 'G', kind: 'num' },  // היקף המשרה של הרכזת המועסקת
];

function detectCoordStart(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', sheetRows: 40 });
  const sheetName = wb.SheetNames.find((n) => n.includes(COORD_SHEET_HINT));
  if (!sheetName) return { error: `לא נמצאה לשונית "${COORD_SHEET_HINT}" בקובץ.` };
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null });
  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] || []).map(norm);
    if (cells.some((c) => c.includes('סמל גן בו מתקיימת הפעילות'))) return { sheetName, startRow: i + 2 }; // 1-based
  }
  return { error: 'לא נמצאה שורת הכותרות בלשונית רכזות הגנים.' };
}

/* הגנים הזכאים לרכזת: מלשונית "גנים - דוח ביצוע" — סמלי הגנים שבהם
   "המובילה אינה גננת. סייעת=1" (עמודת הדגל = 1). */
function extractCoordinatorGardens(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheetName = wb.SheetNames.find((n) => n.includes('דוח ביצוע') && n.includes('גנים') && !n.includes('רכזות'));
  if (!sheetName) return [];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null });
  let symCol = -1, flagCol = -1, headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = (rows[i] || []).map(norm);
    const s = cells.findIndex((c) => c.includes('סמל גן בו מתקיימת הפעילות'));
    const f = cells.findIndex((c) => c.includes('המובילה אינה גננת'));
    if (s >= 0 && f >= 0) { symCol = s; flagCol = f; headerIdx = i; break; }
  }
  if (headerIdx < 0) return [];
  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const sym = norm(row[symCol]);
    if (!/^\d{3,}$/.test(sym)) continue;
    if (Number(row[flagCol]) === 1) out.push(sym);
  }
  return out;
}

/* כל סמלי הגנים הפעילים מלשונית "גנים - דוח ביצוע" — לשיוך אוטומטי של
   עובדים לגנים (איוש משרות דורש גננת + סייעת בכל גן) */
function extractExecGardens(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheetName = wb.SheetNames.find((n) => n.includes('דוח ביצוע') && n.includes('גנים') && !n.includes('רכזות'));
  if (!sheetName) return [];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null });
  let symCol = -1, headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = (rows[i] || []).map(norm);
    const s = cells.findIndex((c) => c.includes('סמל גן בו מתקיימת הפעילות') || c === 'סמל גן' || c.includes('סמל מוסד'));
    if (s >= 0) { symCol = s; headerIdx = i; break; }
  }
  if (headerIdx < 0) return [];
  const out = [];
  const seen = new Set();
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const sym = norm((rows[i] || [])[symCol]);
    if (/^\d{3,}$/.test(sym) && !seen.has(sym)) { seen.add(sym); out.push(sym); }
  }
  return out;
}

/* רשימות "איש צוות" והתפקידים המותרים — מגיליון העזר של קובץ המשרד (גנים).
   בתבניות בתי ספר הרשימות שונות מעט — יזוהו מהקובץ בהמשך; אלו ברירות המחדל. */
const STAFF_TYPES = [
  { type: 'גננת', roles: ['גננת של הגן', 'בעל/ת תעודת הוראה שסיימ/ה 80% מהתואר', 'סייעת', 'סטודנט/ית', 'מדריכ/ה מוסמכ/ת', 'אחר'] },
  { type: 'סייעת חדשה', roles: ['סייעת'] },
  { type: 'סייעת ממשיכה', roles: ['סייעת'] },
  { type: 'מדצ', roles: ['מדצ/ית'] },
  { type: 'רכזת גן', roles: ['רכז/ת גן'] },
  { type: 'תוספת כח אדם', roles: ['יועצ/ת', 'קלינאי/ת תקשורת', 'מנתח/ת התנהגות', 'מרפא/ה בעיסוק', 'גננת שילוב', 'אחר'] },
  // בתי ספר — הערכים המדויקים של רשימות המשרד בתבנית תשפ"ו
  { type: 'מורה', roles: ['מורה'] },
  { type: 'רכזת תכנית בבית הספר', roles: ['רכז/ת תכנית בבית הספר'] },
  { type: 'סגנית רכזת מעל 150', roles: ['סגנ/ית רכז/ת>150'] },
];

/* רשימת המוסדות (סמל + שם) מקובץ דוח הביצוע — מגיליון "מצבת והרשמה" של הרשות.
   נעצרים בגיליון הראשון שמניב תוצאות כדי לא לגרוף את הרשימה הארצית הנסתרת. */
function extractInstitutions(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const fromSheet = (n) => {
    const out = new Map();
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null });
    for (let r = 0; r < Math.min(rows.length, 30); r++) {
      const cells = (rows[r] || []).map(norm);
      const symCol = cells.findIndex((c) => c === 'סמל גן' || c === 'סמל מוסד' || c === 'סמל בית ספר');
      const nameCol = cells.findIndex((c) => c === 'שם הגן' || c === 'שם מוסד' || c === 'שם המוסד' || c === 'שם בית הספר');
      if (symCol < 0 || nameCol < 0) continue;
      const actCol = cells.findIndex((c) => c.includes('מתקיימת הפעילות') || c.includes('סמל מקום פעילות'));
      for (let i = r + 1; i < rows.length; i++) {
        const row = rows[i] || [];
        const name = norm(row[nameCol]);
        if (!name) continue;
        [norm(row[symCol]), actCol >= 0 ? norm(row[actCol]) : ''].forEach((s) => {
          if (/^\d{3,}$/.test(s) && !out.has(s)) out.set(s, { symbol: s, name });
        });
      }
      break; // שורת כותרות אחת לגיליון
    }
    return [...out.values()];
  };
  const priority = (n) => (n.includes('מצבת והרשמה') ? 0 : n.includes('מצבת') ? 1 : 2);
  const ordered = [...wb.SheetNames].sort((a, b) => priority(a) - priority(b));
  for (const n of ordered) {
    const list = fromSheet(n);
    if (list.length) return list;
  }
  return [];
}

module.exports = {
  fillMinistryReport, detectStartRow, extractInstitutions, extractCoordinatorGardens, extractExecGardens,
  detectExpenseSheet, EXPENSE_LABEL_HE,
  STAFF_TYPES, MINISTRY_SHEET_HINT, COORD_SHEET_HINT,
};
