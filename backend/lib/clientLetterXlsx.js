/* המכתב המרוכז ללקוח כאקסל (רעות 7.10) — אותן עמודות כמו בטבלת המכתב:
   רשות / פרויקט / סכום צפוי / מתוכו תקורה / סייעות רשות / לתשלום ללקוח.
   מעוצב בפלטת המשרד (זהב/שמפניה), RTL. */
const XLSXS = require('xlsx-js-style');

const GOLD = '9A7B2F', CHAMPAGNE = 'F4ECDA', SOFT = 'FBF7EC', INK = '37322A', LINE = 'EAE1CF';
const border = { style: 'thin', color: { rgb: LINE } };
const S = {
  title: { font: { bold: true, sz: 15, color: { rgb: INK } }, alignment: { horizontal: 'right' } },
  sub: { font: { sz: 11, color: { rgb: '7A7062' } }, alignment: { horizontal: 'right' } },
  head: { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: GOLD } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } },
  text: { font: { color: { rgb: INK } }, alignment: { horizontal: 'right' }, border: { bottom: border } },
  num: { font: { color: { rgb: INK } }, alignment: { horizontal: 'center' }, numFmt: '#,##0', border: { bottom: border } },
  sub2: { font: { bold: true, color: { rgb: INK } }, fill: { fgColor: { rgb: SOFT } }, alignment: { horizontal: 'right' } },
  subNum: { font: { bold: true, color: { rgb: INK } }, fill: { fgColor: { rgb: SOFT } }, alignment: { horizontal: 'center' }, numFmt: '#,##0' },
  total: { font: { bold: true, color: { rgb: INK } }, fill: { fgColor: { rgb: CHAMPAGNE } }, alignment: { horizontal: 'right' }, border: { top: { style: 'medium', color: { rgb: GOLD } } } },
  totalNum: { font: { bold: true, color: { rgb: INK } }, fill: { fgColor: { rgb: CHAMPAGNE } }, alignment: { horizontal: 'center' }, numFmt: '#,##0', border: { top: { style: 'medium', color: { rgb: GOLD } } } },
  note: { font: { sz: 10, color: { rgb: '7A7062' } }, alignment: { horizontal: 'right', wrapText: true, vertical: 'top' } },
};
const cell = (v, s) => ({ v, t: typeof v === 'number' ? 'n' : 's', s });
const sourceOf = (clientName, authorityName) =>
  (authorityName && authorityName !== clientName ? authorityName : 'משרד החינוך');

function buildClientLetterXlsx(d) {
  const clientName = d.client.name;
  const today = new Date().toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
  const groups = new Map();
  d.projects.forEach((p) => {
    if (!groups.has(p.authorityName)) groups.set(p.authorityName, []);
    groups.get(p.authorityName).push(p);
  });
  const multiAuth = groups.size > 1;
  const rows = [];
  let anyEstimate = false, anyNegative = false;
  for (const [auth, list] of groups) {
    const src = sourceOf(clientName, auth);
    for (const p of list) {
      const v = p.totals.expected || 0;
      const aides = p.totals.authorityAides || 0;
      if (p.isEstimate) anyEstimate = true;
      if (v < 0) anyNegative = true;
      rows.push([
        cell(src, S.text), cell(p.projectLabel + (p.isEstimate ? ' *' : ''), S.text),
        v < 0 ? cell('לבדיקה **', S.num) : cell(Math.round(v), S.num),
        cell(Math.round(p.totals.mgmtRecognized || 0), S.num),
        aides > 0 ? cell(Math.round(aides), S.num) : cell('—', S.num),
        v < 0 ? cell('לבדיקה **', S.num) : cell(Math.round(v - aides), S.num),
      ]);
    }
    if (multiAuth && list.length > 1) {
      const sum = (f) => list.reduce((s, p) => s + ((p.totals.expected || 0) < 0 ? 0 : f(p.totals)), 0);
      rows.push([
        cell(`סה"כ ${src}`, S.sub2), cell('', S.sub2),
        cell(Math.round(sum((t) => t.expected || 0)), S.subNum), cell(Math.round(sum((t) => t.mgmtRecognized || 0)), S.subNum),
        cell(Math.round(sum((t) => t.authorityAides || 0)), S.subNum), cell(Math.round(sum((t) => (t.expected || 0) - (t.authorityAides || 0))), S.subNum),
      ]);
    }
  }
  const counted = d.projects.filter((p) => (p.totals.expected || 0) >= 0);
  const total = counted.reduce((s, p) => s + (p.totals.expected || 0), 0);
  const totalMgmt = counted.reduce((s, p) => s + (p.totals.mgmtRecognized || 0), 0);
  const totalAides = counted.reduce((s, p) => s + (p.totals.authorityAides || 0), 0);
  const notes = [
    anyEstimate ? '* אומדן שלנו — קובץ דוח הביצוע לא כלל את חישוב התשלום של המשרד.' : '',
    anyNegative ? '** לפי הנתונים הקיימים הגבייה מההורים עולה על ההוצאות המוכרות — הסכום ייקבע לאחר השלמת הנתונים (לא נכלל בסה"כ).' : '',
    '"מתוכו תקורה" — תקורת הניהול והתפעול הכלולה בסכום הצפוי.',
    totalAides > 0 ? '"סייעות רשות" — עלות העובדים שהרשות משלמת ישירות; הרשות מעבירה את כספי המשרד בניכוי הוצאות אלו, ולכן הן מופחתות ב"לתשלום ללקוח".' : '',
    d.client.has_vat ? 'הסכומים כוללים מע"מ.' : '',
  ].filter(Boolean).join(' ');

  const head = [multiAuth ? 'רשות' : 'גורם משלם', 'פרויקט', 'סכום צפוי', 'מתוכו תקורה', 'סייעות רשות', 'לתשלום ללקוח'];
  const aoa = [
    [cell(`תוכנית החופש הגדול — סיכום התשלומים הצפויים — ${clientName}`, S.title)],
    [cell(`גוטליב את ביטון, רו"ח · ${today}`, S.sub)],
    [],
    head.map((h) => cell(h, S.head)),
    ...rows,
    [cell('סה"כ', S.total), cell('', S.total), cell(Math.round(total), S.totalNum), cell(Math.round(totalMgmt), S.totalNum),
      totalAides > 0 ? cell(Math.round(totalAides), S.totalNum) : cell('—', S.totalNum), cell(Math.round(total - totalAides), S.totalNum)],
    [],
    [cell(notes, S.note)],
  ];
  const ws = XLSXS.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 22 }, { wch: 30 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 16 }];
  ws['!rows'] = [{ hpt: 24 }, { hpt: 16 }, { hpt: 6 }, { hpt: 30 }];
  ws['!rows'][aoa.length - 1] = { hpt: 60 };
  ws['!merges'] = [0, 1, aoa.length - 1].map((r) => ({ s: { r, c: 0 }, e: { r, c: 5 } }));
  const wb = XLSXS.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSXS.utils.book_append_sheet(wb, ws, 'תשלומים צפויים');
  return XLSXS.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildClientLetterXlsx };
