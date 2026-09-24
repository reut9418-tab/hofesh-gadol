/* ייצוא סעיף 5 של המכתב — טבלת יעדי הכרטסות — כקובץ אקסל מעוצב (מותג
   המשרד: זהב/שמפניה/גרפיט, RTL). העמודות זהות לטבלה שבמכתב: שכר (פר
   משלם כשיש כמה), ארוחת בוקר (גנים), העשרה (כולל אופציית 75% כשיש חריגה),
   סל גמיש, הכנסות משתתפים — ושורת סה"כ. */
const XLSXS = require('xlsx-js-style');

function buildTargetsXlsx(d) {
  const today = new Date().toLocaleDateString('he-IL');
  const clientName = (d.client && d.client.name) || '';
  const authorityName = (d.authority && d.authority.name) || '';
  const who = authorityName && authorityName !== clientName ? `${clientName} — ${authorityName}` : clientName;

  const GOLD = '9A7B2F', CHAMP = 'F4ECDA', SOFT = 'FBF7EC', LINE = 'D9CDB3', INK = '413A2F';
  const border = { top: { style: 'thin', color: { rgb: LINE } }, bottom: { style: 'thin', color: { rgb: LINE } }, left: { style: 'thin', color: { rgb: LINE } }, right: { style: 'thin', color: { rgb: LINE } } };
  const S = {
    title: { font: { bold: true, sz: 14, color: { rgb: INK } }, alignment: { horizontal: 'right' } },
    sub: { font: { bold: true, sz: 11, color: { rgb: GOLD } }, alignment: { horizontal: 'right' } },
    note: { font: { sz: 9.5, color: { rgb: '7A7062' } }, alignment: { horizontal: 'right', wrapText: true, vertical: 'top' } },
    head: { font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: GOLD } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border },
    cellR: (z) => ({ font: { sz: 10, color: { rgb: INK } }, alignment: { horizontal: 'right' }, border, ...(z ? { fill: { fgColor: { rgb: SOFT } } } : {}) }),
    cellN: (z) => ({ font: { sz: 10, color: { rgb: INK } }, alignment: { horizontal: 'center' }, border, numFmt: '#,##0.00', ...(z ? { fill: { fgColor: { rgb: SOFT } } } : {}) }),
    total: { font: { bold: true, sz: 10, color: { rgb: INK } }, fill: { fgColor: { rgb: CHAMP } }, alignment: { horizontal: 'center' }, border: { ...border, top: { style: 'medium', color: { rgb: GOLD } } }, numFmt: '#,##0.00' },
    totalR: { font: { bold: true, sz: 10, color: { rgb: INK } }, fill: { fgColor: { rgb: CHAMP } }, alignment: { horizontal: 'right' }, border: { ...border, top: { style: 'medium', color: { rgb: GOLD } } } },
  };
  const cell = (v, s) => ({ v: v == null ? '' : v, t: typeof v === 'number' ? 'n' : 's', s });
  const num = (v) => (v > 0 ? Math.round(v * 100) / 100 : null);

  const isGardens = d.report.framework === 'gardens';
  const multiPayer = (d.payers || []).length > 1;
  const anyBreakfast = d.units.some((u) => u.targets.breakfast > 0);
  const anyFlex = d.units.some((u) => u.targets.flexRemain > 0);
  const anyIncome = d.units.some((u) => u.targets.income > 0);
  const anyShift = d.units.some((u) => u.enrichShift > 0);
  const salaryLabel = isGardens ? 'שכר מובילות + רכזים' : 'שכר מורים + רכזים';
  // פיצול יעד השכר (כלל רעות 24.9): הדרכה | ריכוז | סה"כ (לכרטסת משולבת)
  const instrLabel = isGardens ? 'שכר הדרכה (מובילות/סייעות)' : 'שכר הדרכה (מורים)';
  const coordLabel = isGardens ? 'שכר ריכוז (רכזות גנים)' : 'שכר ריכוז (רכז/ת וסגן/ית)';

  const head = [
    isGardens ? 'מסגרת' : 'בית ספר',
    instrLabel, coordLabel, `סה"כ ${salaryLabel} — כרטסת משולבת`,
    ...(multiPayer ? d.payers.map((p) => `${salaryLabel} — ${p}`) : []),
    ...(anyBreakfast ? ['ארוחת בוקר'] : []),
    ...(anyShift ? ['העשרה — מומלץ: 75%', 'העשרה — 100%'] : ['העשרה']),
    ...(anyFlex ? ['סל גמיש'] : []),
    ...(anyIncome ? ['הכנסות משתתפים'] : []),
  ];
  const W = head.length;

  const unitCells = (u, z) => [
    cell(u.symbol ? `${u.name} (${u.symbol})` : u.name, S.cellR(z)),
    cell(num(u.targets.salaryInstr), S.cellN(z)),
    cell(num(u.targets.salaryCoord), S.cellN(z)),
    cell(num(u.targets.salary), S.cellN(z)),
    ...(multiPayer ? d.payers.map((p) => cell(num(u.targets.salaryByPayer[p]), S.cellN(z))) : []),
    ...(anyBreakfast ? [cell(num(u.targets.breakfast), S.cellN(z))] : []),
    ...(anyShift
      ? [cell(num(u.targets.enrichmentReduced), S.cellN(z)), cell(num(u.targets.enrichment), S.cellN(z))]
      : [cell(num(u.targets.enrichment), S.cellN(z))]),
    ...(anyFlex ? [cell(num(u.targets.flexRemain), S.cellN(z))] : []),
    ...(anyIncome ? [cell(num(u.targets.income), S.cellN(z))] : []),
  ];

  const sum = (f) => d.units.reduce((s, u) => s + (f(u) || 0), 0);
  const totalsRow = d.units.length > 1 ? [
    cell('סה"כ', S.totalR),
    cell(num(sum((u) => u.targets.salaryInstr)), S.total),
    cell(num(sum((u) => u.targets.salaryCoord)), S.total),
    cell(num(sum((u) => u.targets.salary)), S.total),
    ...(multiPayer ? d.payers.map((p) => cell(num(sum((u) => u.targets.salaryByPayer[p])), S.total)) : []),
    ...(anyBreakfast ? [cell(num(sum((u) => u.targets.breakfast)), S.total)] : []),
    ...(anyShift
      ? [cell(num(sum((u) => u.targets.enrichmentReduced)), S.total), cell(num(sum((u) => u.targets.enrichment)), S.total)]
      : [cell(num(sum((u) => u.targets.enrichment)), S.total)]),
    ...(anyFlex ? [cell(num(sum((u) => u.targets.flexRemain)), S.total)] : []),
    ...(anyIncome ? [cell(num(sum((u) => u.targets.income)), S.total)] : []),
  ] : null;

  const noteText = [
    `שכר — יעד הכרטסת זהה לדוח העלות, בפיצול להדרכה ולריכוז (ללקוח עם כרטסות נפרדות) ובסה"כ (ללקוח עם כרטסת שכר משולבת)${multiPayer ? ', ובהפרדה לפי המשלם' : ''}.`,
    anyBreakfast ? 'ארוחת בוקר — התקציב בתוספת יתרת הסל הגמיש (בהנחת אופציה א\').' : '',
    'העשרה — כולל ניוד יתרת שכר היכן שקיימת (עד 25% מסל המקור).',
    anyShift ? 'בשל חריגת שכר מוצגות שתי אופציות להעשרה: 75% מהתקציב (מומלץ) או 100%.' : '',
    anyFlex ? 'סל גמיש — היתרה אחרי בליעת חריגות השכר.' : '',
    anyIncome ? `הכנסות משתתפים — ילדים × תעריף המשרד${d.tariff ? ` (₪${d.tariff} לילד)` : ''}.` : '',
    d.hasVat ? 'כל היעדים רשומים נטו, ללא מע"מ — כפי שנרשם בכרטסת.' : '',
  ].filter(Boolean).join(' ');

  const aoa = [
    [cell('יעדי הכרטסות — הנהלת חשבונות', S.title)],
    [cell(`${who} — ${d.label} · ${today}`, S.sub)],
    [cell(noteText, S.note)],
    [],
    head.map((h) => cell(h, S.head)),
    ...d.units.map((u, i) => unitCells(u, i % 2 === 1)),
    ...(totalsRow ? [totalsRow] : []),
  ];

  const ws = XLSXS.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 30 }, ...Array(W - 1).fill({ wch: 17 })];
  ws['!rows'] = [{ hpt: 22 }, { hpt: 16 }, { hpt: 42 }, { hpt: 6 }, { hpt: 30 }];
  ws['!merges'] = [0, 1, 2].map((r) => ({ s: { r, c: 0 }, e: { r, c: Math.max(W - 1, 4) } }));
  const wb = XLSXS.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSXS.utils.book_append_sheet(wb, ws, 'יעדי כרטסות');
  return XLSXS.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildTargetsXlsx };
