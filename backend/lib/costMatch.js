/* דוח התאמה לדוח עלות — מסמך להצגה למשרד החינוך:
   מסביר, עובד-עובד, איך נגזרה העלות השעתית שדווחה בדוח הביצוע מדוח עלות
   השכר: הנמוך מבין עלות שכר שעתית (בתוספת מע"מ 18% ללקוח חייב) לבין
   שכר ברוטו שעתי בתוספת 40% (תקרת המשרד). מופק כדף HTML להדפסה/PDF. */

const XLSX = require('xlsx');
const { COST_MARKUP_LIMIT, effectiveGross } = require('./ingest');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt0 = (n) => (n == null ? '—' : Math.round(n).toLocaleString('he-IL'));
const fmt2 = (n) => (n == null ? '—' : (Math.round(n * 100) / 100).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/* החישוב המשותף לשני הפורמטים (HTML/PDF ואקסל) */
function computeCostMatch(rows, vatFactor) {
  const calc = rows.map((r) => {
    // הברוטו האפקטיבי כולל התאמת ברוטו שאושרה (עד 5 ₪ לשעה)
    const hourlyGross = r.gross != null && r.hours ? effectiveGross(r) / r.hours : null;
    const hourlyCostNet = r.cost != null && r.hours ? r.cost / r.hours : null;
    const hourlyCostVat = hourlyCostNet != null ? hourlyCostNet * vatFactor : null;
    const cap140 = hourlyGross != null && hourlyGross > 0 ? hourlyGross * COST_MARKUP_LIMIT : null;
    const reported = hourlyCostVat != null && cap140 != null ? Math.min(hourlyCostVat, cap140) : hourlyCostVat;
    const capped = reported != null && hourlyCostVat != null && reported < hourlyCostVat - 0.005;
    const totalReported = reported != null && r.hours ? reported * r.hours : null;
    const totalDiff = capped && r.hours ? (hourlyCostVat - reported) * r.hours : 0;
    return { r, hourlyGross, hourlyCostNet, hourlyCostVat, cap140, reported, capped, totalReported, totalDiff };
  });

  const cappedCount = calc.filter((c) => c.capped).length;
  const totals = calc.reduce((a, c) => ({
    hours: a.hours + (c.r.hours || 0),
    booksNet: a.booksNet + (c.r.cost || 0),
    booksVat: a.booksVat + (c.r.cost || 0) * vatFactor,
    reported: a.reported + (c.totalReported || 0),
    diff: a.diff + c.totalDiff,
  }), { hours: 0, booksNet: 0, booksVat: 0, reported: 0, diff: 0 });
  return { calc, totals, cappedCount };
}

function renderCostMatchHtml({ report, client, authority, rows, label }) {
  const hasVat = !!(client && client.has_vat);
  const vatFactor = hasVat ? 1.18 : 1;
  const today = new Date().toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
  const who = (authority && authority.name) || (client && client.name) || '';
  const { calc, totals, cappedCount } = computeCostMatch(rows, vatFactor);

  const vatCols = hasVat ? '<th class="num">עלות שעתית כולל מע"מ 18%</th>' : '';
  const bodyRows = calc.map((c) => `<tr${c.capped ? ' class="capped"' : ''}>
    <td>${esc(c.r.emp_name || '—')}</td><td dir="ltr">${esc(c.r.emp_id)}</td><td>${esc(c.r.dept || '')}</td>
    <td class="num">${fmt2(c.r.hours)}</td>
    <td class="num">${fmt2(c.hourlyGross)}</td>
    <td class="num">${fmt2(c.hourlyCostNet)}</td>
    ${hasVat ? `<td class="num">${fmt2(c.hourlyCostVat)}</td>` : ''}
    <td class="num">${fmt2(c.cap140)}</td>
    <td class="num"><b>${fmt2(c.reported)}</b></td>
    <td class="num">${c.capped ? fmt2(c.hourlyCostVat - c.reported) : '—'}</td>
    <td class="num">${c.capped ? fmt0(c.totalDiff) : '—'}</td>
  </tr>`).join('');

  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<title>דוח התאמה לדוח עלות — ${esc(who)} — ${esc(label)}</title>
<style>
  body{font-family:'Segoe UI',Arial,sans-serif;color:#37322A;max-width:1100px;margin:0 auto;padding:26px;line-height:1.6;font-size:13px}
  h1{font-size:18px;margin:14px 0 2px}
  .letterhead{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #9A7B2F;padding-bottom:8px;font-size:12.5px;color:#7A7062}
  .subject{background:#FAF6EE;border-radius:8px;padding:10px 16px;margin:14px 0;font-size:14px}
  .method{border:1px solid #EAE1CF;border-radius:9px;padding:10px 16px;background:#FAF6EE;margin:12px 0}
  table{width:100%;border-collapse:collapse;font-size:11.5px;margin:10px 0}
  th{background:#9A7B2F;color:#fff;text-align:right;padding:5px 8px;font-size:11px}
  td{border-bottom:1px solid #EAE1CF;padding:4px 8px;vertical-align:top}
  th.num,td.num{text-align:center}
  tr.capped td{background:#FDF6EC}
  tr.total td{background:#F4ECDA;font-weight:700;border-top:2px solid #9A7B2F}
  .note{font-size:11.5px;color:#7A7062;background:#FAF6EE;border-radius:6px;padding:7px 11px}
  .footer{margin-top:22px;font-size:11px;color:#7A7062;border-top:1px solid #EAE1CF;padding-top:8px}
  .printbtn{position:fixed;top:14px;left:14px;background:#9A7B2F;color:#fff;border:none;border-radius:7px;padding:9px 16px;font-size:13px;cursor:pointer;font-family:inherit}
  @media print{.printbtn{display:none}body{padding:0;font-size:11px}}
</style></head><body>
<button class="printbtn" onclick="window.print()">🖨 הדפסה / שמירה כ-PDF</button>

<div class="letterhead"><span><b>${esc(who)}</b> — ${esc(label)}</span><span>${today}</span></div>
<div class="subject"><b>הנדון: דוח התאמה — דוח עלות השכר מול העלות השעתית שדווחה בדוח הביצוע</b></div>

<div class="method">
<b>שיטת הדיווח:</b> העלות השעתית שדווחה בדוח הביצוע לכל עובד/ת היא <b>הנמוך מבין</b>:<br>
(א) עלות השכר השעתית על פי דוח עלות השכר${hasVat ? ' בתוספת מע"מ 18% (המפעיל חברה החייבת במע"מ)' : ''};<br>
(ב) שכר הברוטו השעתי בתוספת 40% — בהתאם לתקרת ההכרה של משרד החינוך.<br>
ההפרש בין עלות השכר בספרים לבין העלות שדווחה מפורט בטבלה שלהלן, לכל עובד/ת שהעלות בגינו/ה הוגבלה לתקרה (שורות מודגשות).
</div>

<p><b>סיכום:</b> ${calc.length} עובדים · ${cappedCount} מהם הוגבלו לתקרת ה-140% · סה"כ עלות בדוח העלות: ₪${fmt0(totals.booksNet)}${hasVat ? ` (בתוספת מע"מ: ₪${fmt0(totals.booksVat)})` : ''} · סה"כ שדווח בדוח הביצוע: ₪${fmt0(totals.reported)} · סה"כ ההפרש בגין התקרה: ₪${fmt0(totals.diff)}.</p>

<table>
<thead><tr>
  <th>עובד/ת</th><th>ת.ז</th><th>מחלקה</th><th class="num">שעות</th>
  <th class="num">ברוטו שעתי</th><th class="num">עלות שעתית (דוח עלות)</th>
  ${vatCols}
  <th class="num">תקרה: ברוטו + 40%</th><th class="num">עלות שעתית שדווחה</th>
  <th class="num">הפרש לשעה</th><th class="num">הפרש כולל</th>
</tr></thead>
<tbody>
${bodyRows}
<tr class="total"><td>סה"כ</td><td></td><td></td><td class="num">${fmt2(totals.hours)}</td><td></td><td></td>${hasVat ? '<td></td>' : ''}<td></td><td class="num">₪${fmt0(totals.reported)}</td><td></td><td class="num">₪${fmt0(totals.diff)}</td></tr>
</tbody>
</table>

<p class="note">הדוח הופק על בסיס דוח עלות השכר של המפעיל ודוח הביצוע של משרד החינוך. ${hasVat ? 'הכרטסות בהנהלת החשבונות מתנהלות לפני מע"מ; העלויות בדוח זה מוצגות גם לפני וגם אחרי מע"מ לצורך ההתאמה. ' : ''}שורות מודגשות — עובדים שעלותם השעתית הוגבלה לתקרת ה-140%.</p>

<p>בברכה,<br><b>גוטליב את ביטון, רו"ח</b></p>
<div class="footer">דוח התאמה לדוח עלות · ${esc(who)} · ${esc(label)} · ${today}</div>
</body></html>`;
}

/* דוח ההתאמה כקובץ אקסל (xlsx) — אותם נתונים וחישובים כמו גרסת ה-PDF */
function buildCostMatchXlsx({ report, client, authority, rows, label }) {
  const hasVat = !!(client && client.has_vat);
  const vatFactor = hasVat ? 1.18 : 1;
  const today = new Date().toLocaleDateString('he-IL');
  const who = (authority && authority.name) || (client && client.name) || '';
  const { calc, totals, cappedCount } = computeCostMatch(rows, vatFactor);
  const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

  const head = [
    'עובד/ת', 'ת.ז', 'מחלקה', 'שעות', 'ברוטו שעתי', 'עלות שעתית (דוח עלות)',
    ...(hasVat ? ['עלות שעתית כולל מע"מ 18%'] : []),
    'תקרה: ברוטו + 40%', 'עלות שעתית שדווחה', 'הוגבל לתקרה', 'הפרש לשעה', 'הפרש כולל',
  ];
  const aoa = [
    [`דוח התאמה — דוח עלות השכר מול העלות השעתית שדווחה בדוח הביצוע`],
    [`${who} — ${label} · ${today}`],
    [`שיטת הדיווח: העלות השעתית שדווחה לכל עובד/ת היא הנמוך מבין (א) עלות השכר השעתית לפי דוח העלות${hasVat ? ' בתוספת מע"מ 18%' : ''}, לבין (ב) שכר הברוטו השעתי בתוספת 40% — תקרת ההכרה של משרד החינוך.`],
    [`סיכום: ${calc.length} עובדים · ${cappedCount} הוגבלו לתקרת ה-140% · עלות בדוח העלות: ₪${Math.round(totals.booksNet).toLocaleString('he-IL')}${hasVat ? ` (כולל מע"מ: ₪${Math.round(totals.booksVat).toLocaleString('he-IL')})` : ''} · דווח בדוח הביצוע: ₪${Math.round(totals.reported).toLocaleString('he-IL')} · הפרש בגין התקרה: ₪${Math.round(totals.diff).toLocaleString('he-IL')}`],
    [],
    head,
    ...calc.map((c) => [
      c.r.emp_name || '—', String(c.r.emp_id || ''), c.r.dept || '', r2(c.r.hours),
      r2(c.hourlyGross), r2(c.hourlyCostNet),
      ...(hasVat ? [r2(c.hourlyCostVat)] : []),
      r2(c.cap140), r2(c.reported), c.capped ? 'כן' : '', c.capped ? r2(c.hourlyCostVat - c.reported) : null,
      c.capped ? r2(c.totalDiff) : null,
    ]),
    [
      'סה"כ', '', '', r2(totals.hours), '', '',
      ...(hasVat ? [''] : []),
      '', r2(totals.reported), '', '', r2(totals.diff),
    ],
    [],
    ['הופק ע"י גוטליב את ביטון, רו"ח · על בסיס דוח עלות השכר של המפעיל ודוח הביצוע של משרד החינוך' + (hasVat ? ' · הכרטסות בהנהלת החשבונות מתנהלות לפני מע"מ' : '')],
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 22 }, { wch: 12 }, { wch: 14 }, { wch: 8 }, { wch: 11 }, { wch: 18 },
    ...(hasVat ? [{ wch: 18 }] : []),
    { wch: 16 }, { wch: 16 }, { wch: 11 }, { wch: 11 }, { wch: 11 },
  ];
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] }; // גיליון מימין לשמאל
  XLSX.utils.book_append_sheet(wb, ws, 'דוח התאמה');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { renderCostMatchHtml, buildCostMatchXlsx };
