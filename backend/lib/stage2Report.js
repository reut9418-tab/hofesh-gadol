/* דוח שלב 2 — "בקרות ותשלום צפוי" (הפלט המרכזי של שלב 2):
   א. הבקרות שבוצעו והפערים (כרטסת ↔ דוח עלות ↔ דוח ביצוע, העשרה, הכנסות)
   ב. ניצול מול תקציב בכל סל — בגנים במרוכז, בבתי ספר פר מוסד
   ג. התשלום הצפוי מהמשרד — פר מוסד, מרוכז לפרויקט, ובסיכום הלקוח מרוכז לכל
      הפרויקטים. ההכרה משחזרת את כללי דוח הביצוע: שכר מוכר עד התקציב +
      הסל הגמיש (חריגה מעבר לגמיש אינה מוכרת), העשרה/ארוחות בוקר מוכרים
      לפי הכרטסות עד תקרת הסל, תקורת הניהול מוכרת ב-100% מהתקציב (כלל
      רעות 16.9.2026), בניכוי השתתפות ההורים. */

const { stage1Data } = require('./stage1');
const { ledgerReconcile, payerBreakdown, expenseComparison } = require('./reconcile');
const { enrichMatchData } = require('./enrichMatch');
const { reportLabel } = require('./domain');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('he-IL'));
const r2 = (n) => Math.round((n || 0) * 100) / 100;

/* נתוני שלב 2 לפרויקט אחד */
async function stage2Data(db, report, client, authority) {
  const d = await stage1Data(db, report, client, authority);
  const reconcile = await ledgerReconcile(db, report, client);
  const payerMatrix = await payerBreakdown(db, report, client);
  const expenseMatrix = await expenseComparison(db, report, client);
  const enrich = await enrichMatchData(db, report, client, authority);
  const vat = d.hasVat ? 1.18 : 1;

  // הקצאת העשרה מהכרטסות פר סמל (בתי"ס) / במרוכז (גנים)
  const enrichBySymbol = {};
  let enrichTotal = 0;
  for (const c of enrich.perCard) {
    for (const row of c.rows) {
      enrichTotal += row.amount;
      if (row.symbol) enrichBySymbol[String(row.symbol)] = (enrichBySymbol[String(row.symbol)] || 0) + row.amount;
    }
  }

  // כרטסות סלים נוספים (ארוחות בוקר/מלגות) — ברמת הפרויקט
  const cards = await db.prepare("SELECT basket_type, COALESCE(SUM(net),0) s FROM ledger_cards WHERE report_id = ? AND net > 0 GROUP BY basket_type").all(report.id);
  const cardSum = Object.fromEntries(cards.map((c) => [c.basket_type, Number(c.s) * vat]));
  const breakfastScholarLedger = (cardSum.breakfast || 0) + (cardSum.scholarships || 0);

  // שורות התשלום מקובץ המשרד (כלל רעות 16.9): "סה"כ לתשלום בתוספת גמישות 25%
  // במעבר בין הסלים" + "תוספת סייעות רפואיות או אישיות" — כשהקובץ חושב, אלו
  // הם ה"צפוי לקבל"; האומדן המחושב שלנו נשאר כבסיס השוואה וכגיבוי לקובץ קפוא
  const instPay = await db.prepare('SELECT symbol, payment_total, payment_aides, payment_note FROM institutions WHERE report_id = ?').all(report.id);
  const payBySym = Object.fromEntries(instPay.map((i) => [String(i.symbol), i]));
  const aggPay = instPay.length === 1 ? instPay[0] : null;

  const units = d.units.map((u) => {
    // שכר מוכר: הביצוע עד התקציב (אחרי הניודים הפנימיים) + כיסוי הגמיש;
    // מה שמעבר (uncovered) אינו מוכר
    const salaryActual = u.instrActual + u.coordActual;
    const salaryRecognized = r2(salaryActual - u.uncovered);
    // העשרה מוכרת: מה שיוחס מהכרטסות, עד תקרת הסל (+ניוד יתרת השכר)
    const enrichAllocated = u.symbol == null ? enrichTotal : (enrichBySymbol[String(u.symbol)] || 0);
    const enrichCap = u.enrichBudget + (u.optionA ? u.optionA.enrichBonus : 0);
    const enrichRecognized = r2(Math.min(enrichAllocated, enrichCap));
    // ארוחות בוקר/מלגות (גנים, במרוכז): עד יתרת הסל הגמיש
    const bfsAllocated = u.symbol == null ? breakfastScholarLedger : 0;
    const bfsRecognized = r2(Math.min(bfsAllocated, u.flexAvailable));
    // ניהול ותפעול (תקורת ה-7%): מוכרת במלואה — 100% מתקציב הסל (כלל רעות
    // 16.9.2026, "ברוב המקרים") — ללא תלות בכרטסות; פר מוסד בבתי"ס, במרוכז בגנים
    const mgmtRecognized = r2(u.management || 0);
    const income = (u.children && d.tariff) ? r2(u.children * d.tariff) : 0;
    const computedExpected = r2(salaryRecognized + enrichRecognized + bfsRecognized + mgmtRecognized - income);
    // "צפוי לקבל" מהקובץ: סה"כ לתשלום בתוספת גמישות 25% + תוספת סייעות (בנפרד)
    const ip = u.symbol != null ? payBySym[String(u.symbol)] : aggPay;
    const paymentTotal = ip && ip.payment_total != null ? r2(Number(ip.payment_total)) : null;
    const paymentAides = ip && ip.payment_aides != null ? r2(Number(ip.payment_aides)) : 0;
    // קובץ קפוא/מאופס (0 או טקסט "לא קיימת זכאות") — האומדן שלנו הוא הצפי,
    // כמו בתקציב (תקדים אור עקיבא: קובץ מאופס ⇒ המכתב הוא האומדן)
    const expected = paymentTotal > 0 ? r2(paymentTotal + paymentAides) : computedExpected;
    return {
      ...u,
      salaryActual, salaryRecognized,
      enrichAllocated: r2(enrichAllocated), enrichRecognized,
      bfsRecognized, mgmtRecognized,
      income, computedExpected,
      paymentTotal, paymentAides, paymentNote: (ip && ip.payment_note) || null,
      expected,
    };
  });

  const total = (f) => r2(units.reduce((s, u) => s + (f(u) || 0), 0));
  const totals = {
    salaryBudget: total((u) => u.salaryBudget), salaryActual: total((u) => u.salaryActual),
    salaryRecognized: total((u) => u.salaryRecognized), uncovered: total((u) => u.uncovered),
    enrichBudget: total((u) => u.enrichBudget), enrichRecognized: total((u) => u.enrichRecognized),
    flexBudget: total((u) => u.flexBudget), flexConsumed: total((u) => u.flexConsumed), flexAvailable: total((u) => u.flexAvailable),
    bfsRecognized: total((u) => u.bfsRecognized), mgmtRecognized: total((u) => u.mgmtRecognized),
    income: total((u) => u.income), expected: total((u) => u.expected),
    computedExpected: total((u) => u.computedExpected),
    paymentTotal: units.some((u) => u.paymentTotal != null) ? total((u) => u.paymentTotal) : null,
    paymentAides: total((u) => u.paymentAides),
  };

  return {
    report, client, authority, label: reportLabel(report.framework, report.program),
    hasVat: d.hasVat, tariff: d.tariff,
    checks: reconcile.hasLedger ? (reconcile.checks || []) : [],
    hasLedger: !!reconcile.hasLedger,
    payerMatrix, expenseMatrix,
    units, totals,
  };
}

/* סיכום מרוכז ללקוח — כל הפרויקטים */
async function clientStage2Data(db, clientId) {
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return null;
  const reports = await db.prepare('SELECT * FROM reports WHERE client_id = ? ORDER BY id').all(clientId);
  const projects = [];
  for (const report of reports) {
    const authority = report.authority_id ? await db.prepare('SELECT * FROM authorities WHERE id = ?').get(report.authority_id) : null;
    try {
      const s2 = await stage2Data(db, report, client, authority);
      if (!s2.units.length) continue;
      projects.push({
        reportId: report.id,
        label: `${authority && authority.name !== client.name ? authority.name + ' — ' : ''}${s2.label}`,
        totals: s2.totals,
        gaps: s2.checks.filter((c) => c.level !== 'ok').length,
      });
    } catch { /* פרויקט בלי נתונים — מדלגים */ }
  }
  const total = (f) => r2(projects.reduce((s, p) => s + (f(p.totals) || 0), 0));
  return {
    client, projects,
    totals: {
      salaryBudget: total((t) => t.salaryBudget), salaryRecognized: total((t) => t.salaryRecognized),
      uncovered: total((t) => t.uncovered),
      enrichRecognized: total((t) => t.enrichRecognized), bfsRecognized: total((t) => t.bfsRecognized),
      mgmtRecognized: total((t) => t.mgmtRecognized), income: total((t) => t.income),
      expected: total((t) => t.expected),
    },
  };
}

/* ---------- רינדור הדוח לפרויקט ---------- */
const CSS = `
  body{font-family:'Segoe UI',Arial,sans-serif;color:#37322A;max-width:940px;margin:0 auto;padding:30px;line-height:1.7;font-size:13.5px}
  h1{font-size:19px;margin:14px 0 2px}
  h2{font-size:15px;color:#9A7B2F;margin:24px 0 6px}
  .letterhead{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #9A7B2F;padding-bottom:8px;font-size:12.5px;color:#7A7062}
  .sub{font-size:12.5px;color:#7A7062;margin-bottom:10px}
  table{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0}
  th{background:#9A7B2F;color:#fff;text-align:right;padding:6px 9px;font-size:11.5px}
  th.num,td.num{text-align:center}
  td{border-bottom:1px solid #EAE1CF;padding:6px 9px}
  tr.z td{background:#FBF7EC}
  tr.total td{background:#F4ECDA;font-weight:700;border-top:2px solid #9A7B2F}
  .ok{color:#4C7A45;background:#EEF5EC}
  .warn{color:#8A6D1A;background:#FBF3DC}
  .err{color:#B3261E;background:#FBECEA}
  .check{border-radius:6px;padding:7px 11px;font-size:12.5px;margin-bottom:5px}
  .expected{background:#FAF6EE;border:1px solid #9A7B2F;border-radius:10px;padding:12px 18px;font-size:14px;margin-top:10px}
  .soft{color:#7A7062;font-size:11px}
  .red{color:#B3261E;font-weight:600}
  @media print { body{padding:10px} }
`;

function renderStage2Html(d) {
  const today = new Date().toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
  const clientName = (d.client && d.client.name) || '';
  const authorityName = (d.authority && d.authority.name) || '';
  const who = authorityName && authorityName !== clientName ? `${clientName} — ${authorityName}` : clientName;

  const checksHtml = d.hasLedger
    ? d.checks.map((c) => `<div class="check ${c.level}">${c.level === 'ok' ? '✓' : '⚠'} ${c.title ? `<b>${esc(c.title)}:</b> ` : ''}${esc(c.text)}</div>`).join('')
    : '<div class="check warn">⚠ טרם נקלטו כרטסות לדוח זה — הבקרות ירוצו לאחר העלאתן בלשונית שלב 2.</div>';

  const isSingle = d.units.length === 1;
  const unitRows = d.units.map((u, i) => {
    const name = u.symbol ? `${esc(u.name)} <span class="soft">(${esc(u.symbol)})</span>` : esc(u.name);
    return `<tr${i % 2 ? ' class="z"' : ''}>
      <td>${name}</td>
      <td class="num">₪${fmt(u.salaryBudget)}</td>
      <td class="num">₪${fmt(u.salaryActual)}</td>
      <td class="num">${u.salaryBudget > 0 ? Math.round((u.salaryActual / u.salaryBudget) * 100) + '%' : '—'}</td>
      <td class="num">₪${fmt(u.flexBudget)}</td>
      <td class="num">₪${fmt(u.flexConsumed)}</td>
      <td class="num">${u.uncovered > 0 ? `<span class="red">₪${fmt(u.uncovered)}</span>` : '—'}</td>
      <td class="num">₪${fmt(u.enrichBudget)}</td>
      <td class="num">₪${fmt(u.enrichRecognized)}</td>
      <td class="num"><b>₪${fmt(u.salaryRecognized)}</b></td>
    </tr>`;
  }).join('');
  const t = d.totals;
  const totalsRow = isSingle ? '' : `<tr class="total">
    <td>סה"כ</td>
    <td class="num">₪${fmt(t.salaryBudget)}</td><td class="num">₪${fmt(t.salaryActual)}</td>
    <td class="num">${t.salaryBudget > 0 ? Math.round((t.salaryActual / t.salaryBudget) * 100) + '%' : '—'}</td>
    <td class="num">₪${fmt(t.flexBudget)}</td><td class="num">₪${fmt(t.flexConsumed)}</td>
    <td class="num">${t.uncovered > 0 ? `<span class="red">₪${fmt(t.uncovered)}</span>` : '—'}</td>
    <td class="num">₪${fmt(t.enrichBudget)}</td><td class="num">₪${fmt(t.enrichRecognized)}</td>
    <td class="num">₪${fmt(t.salaryRecognized)}</td>
  </tr>`;

  const payRows = d.units.map((u, i) => `<tr${i % 2 ? ' class="z"' : ''}>
      <td>${u.symbol ? `${esc(u.name)} <span class="soft">(${esc(u.symbol)})</span>` : esc(u.name)}</td>
      <td class="num">₪${fmt(u.salaryRecognized)}</td>
      <td class="num">${u.enrichRecognized > 0 ? '₪' + fmt(u.enrichRecognized) : '—'}</td>
      <td class="num">${u.bfsRecognized > 0 ? '₪' + fmt(u.bfsRecognized) : '—'}</td>
      <td class="num">${u.mgmtRecognized > 0 ? '₪' + fmt(u.mgmtRecognized) : '—'}</td>
      <td class="num">${u.income > 0 ? '−₪' + fmt(u.income) : '—'}</td>
      <td class="num"><b>₪${fmt(u.expected)}</b></td>
    </tr>`).join('');
  const payTotals = isSingle ? '' : `<tr class="total"><td>סה"כ לפרויקט</td>
    <td class="num">₪${fmt(t.salaryRecognized)}</td><td class="num">₪${fmt(t.enrichRecognized)}</td>
    <td class="num">₪${fmt(t.bfsRecognized)}</td><td class="num">₪${fmt(t.mgmtRecognized)}</td>
    <td class="num">−₪${fmt(t.income)}</td><td class="num">₪${fmt(t.expected)}</td></tr>`;

  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<title>דוח בקרות ותשלום צפוי — ${esc(who)} — ${esc(d.label)}</title>
<style>${CSS}</style></head><body>
<div class="letterhead"><span><b>גוטליב את ביטון, רו"ח</b></span><span>${today}</span></div>
<h1>דוח שלב 2 — בקרות ותשלום צפוי</h1>
<div class="sub">${esc(who)} · ${esc(d.label)}${d.hasVat ? ' · לקוח חייב מע"מ — הסכומים המוכרים כוללים מע"מ 18%' : ''}</div>

<h2>א. הבקרות שבוצעו והפערים</h2>
${checksHtml}
${(d.payerMatrix && d.payerMatrix.rows.length) ? `
<h2>א2. השוואה פר משלם — דוח עלות ↔ כרטסת שכר ↔ דוח ביצוע</h2>
<table>
  <thead><tr><th>משלם</th><th class="num">עובדים</th><th class="num">שעות</th>
    <th class="num">דוח עלות (עלות מעביד)</th><th class="num">כרטסת שכר</th><th class="num">פער</th>
    <th class="num">מדווח בדוח הביצוע${d.hasVat ? ' (כולל מע"מ)' : ''}</th></tr></thead>
  <tbody>
  ${d.payerMatrix.rows.map((p, i) => `<tr${i % 2 ? ' class="z"' : ''}>
    <td>${esc(p.payer)}</td>
    <td class="num">${p.rows}</td><td class="num">${fmt(p.hours)}</td>
    <td class="num">₪${fmt(p.costNet)}</td>
    <td class="num">${p.ledgerSalary != null ? '₪' + fmt(p.ledgerSalary) : '<span class="soft">אין כרטסת</span>'}</td>
    <td class="num">${p.diff == null ? '—' : Math.abs(p.diff) <= 200 ? '<span style="color:#4C7A45">תואם ✓</span>' : `<span class="${p.level === 'err' ? 'red' : ''}">₪${fmt(p.diff)}</span>`}</td>
    <td class="num">₪${fmt(p.reported)}</td>
  </tr>`).join('')}
  ${d.payerMatrix.rows.length > 1 ? `<tr class="total"><td>סה"כ</td>
    <td class="num">${d.payerMatrix.rows.reduce((s, p) => s + p.rows, 0)}</td>
    <td class="num">${fmt(d.payerMatrix.rows.reduce((s, p) => s + p.hours, 0))}</td>
    <td class="num">₪${fmt(d.payerMatrix.rows.reduce((s, p) => s + p.costNet, 0))}</td>
    <td class="num">₪${fmt(d.payerMatrix.rows.reduce((s, p) => s + (p.ledgerSalary || 0), 0))}</td><td></td>
    <td class="num">₪${fmt(d.payerMatrix.rows.reduce((s, p) => s + p.reported, 0))}</td></tr>` : ''}
  </tbody>
</table>
<div class="soft">המשלם נקבע בשדה "משלם" של כל קובץ עלות וכרטסת. "מדווח בדוח הביצוע" = העלות המוכרת (אחרי תקרת 140%${d.hasVat ? ' וכולל מע"מ' : ''}) — הסכום שנרשם בעמודת "הועסק ע"י" של אותו משלם בייצוא.</div>
` : ''}
${(d.expenseMatrix && d.expenseMatrix.rows.length) ? `
<h2>א3. העשרה וארוחות בוקר — כרטסת מול דוח הביצוע</h2>
<table>
  <thead><tr><th>סעיף</th><th class="num">כרטסת (נטו)</th>${d.hasVat ? '<th class="num">צפוי בדוח (כולל מע"מ)</th>' : ''}
    <th class="num">ממולא בלשונית "הוצאות בפועל"</th><th class="num">פער</th></tr></thead>
  <tbody>
  ${d.expenseMatrix.rows.map((p, i) => `<tr${i % 2 ? ' class="z"' : ''}>
    <td>${esc(p.label)}</td>
    <td class="num">₪${fmt(p.ledger)}</td>${d.hasVat ? `<td class="num">₪${fmt(p.expected)}</td>` : ''}
    <td class="num">${p.file != null ? '₪' + fmt(p.file) : '<span class="soft">טרם מולא</span>'}</td>
    <td class="num">${p.diff == null ? '—' : Math.abs(p.diff) <= 200 ? '<span style="color:#4C7A45">תואם ✓</span>' : `<span class="${p.level === 'err' ? 'red' : ''}">₪${fmt(p.diff)}</span>`}</td>
  </tr>`).join('')}
  </tbody>
</table>
<div class="soft">"ממולא בלשונית" = הערכים הקיימים כרגע בקובץ הביצוע שהועלה; הייצוא שלנו משלים תאים ריקים בלבד (לא דורס), עם מספרי הכרטסות.</div>
` : ''}
<h2>ב. ניצול מול תקציב — ${d.report.framework === 'gardens' ? 'כל הגנים במרוכז' : 'פר בית ספר'}</h2>
<table>
  <thead><tr><th>${d.report.framework === 'gardens' ? 'מסגרת' : 'בית ספר'}</th>
    <th class="num">תקציב שכר</th><th class="num">ניצול שכר</th><th class="num">% ניצול</th>
    <th class="num">סל גמיש</th><th class="num">גמיש שנוצל לשכר</th><th class="num">חריגה לא מוכרת</th>
    <th class="num">תקציב העשרה</th><th class="num">העשרה מוכרת</th><th class="num">שכר מוכר</th></tr></thead>
  <tbody>${unitRows}${totalsRow}</tbody>
</table>

<h2>ג. התשלום הצפוי מהמשרד — מתוך קובץ דוח הביצוע</h2>
<table>
  <thead><tr><th>${d.report.framework === 'gardens' ? 'מסגרת' : 'בית ספר'}</th>
    <th class="num">סה"כ לתשלום בתוספת גמישות 25% במעבר בין הסלים</th>
    <th class="num">תוספת סייעות רפואיות או אישיות</th>
    <th class="num">אומדן המערכת</th><th class="num">פער</th></tr></thead>
  <tbody>
  ${d.units.map((u, i) => `<tr${i % 2 ? ' class="z"' : ''}>
    <td>${u.symbol ? `${esc(u.name)} <span class="soft">(${esc(u.symbol)})</span>` : esc(u.name)}</td>
    <td class="num">${u.paymentTotal != null ? `<b>₪${fmt(u.paymentTotal)}</b>` : u.paymentNote ? `<span class="soft">${esc(u.paymentNote)}</span>` : '<span class="soft">לא חושב בקובץ</span>'}</td>
    <td class="num">${u.paymentAides > 0 ? '₪' + fmt(u.paymentAides) : '—'}</td>
    <td class="num">₪${fmt(u.computedExpected)}</td>
    <td class="num">${u.paymentTotal != null ? (Math.abs(u.paymentTotal + u.paymentAides - u.computedExpected) <= 200 ? '<span style="color:#4C7A45">תואם ✓</span>' : `₪${fmt(u.paymentTotal + u.paymentAides - u.computedExpected)}`) : '—'}</td>
  </tr>`).join('')}
  ${isSingle ? '' : `<tr class="total"><td>סה"כ</td>
    <td class="num">${t.paymentTotal != null ? '₪' + fmt(t.paymentTotal) : '—'}</td>
    <td class="num">${t.paymentAides > 0 ? '₪' + fmt(t.paymentAides) : '—'}</td>
    <td class="num">₪${fmt(t.computedExpected)}</td><td></td></tr>`}
  </tbody>
</table>
<div class="soft">"סה"כ לתשלום" ו"תוספת סייעות" נקראים משורות הסיכום של קובץ דוח הביצוע (${d.report.framework === 'gardens' ? 'כל הגנים במרוכז' : 'פר בית ספר'}); כשהקובץ לא חושב — "צפוי לקבל" נשען על אומדן המערכת.</div>

<h3 style="font-size:13.5px;color:#9A7B2F;margin:18px 0 4px">פירוט ההכרה — אומדן המערכת</h3>
<table>
  <thead><tr><th>${d.report.framework === 'gardens' ? 'מסגרת' : 'בית ספר'}</th>
    <th class="num">שכר מוכר</th><th class="num">העשרה</th><th class="num">ארוחות בוקר/מלגות</th>
    <th class="num">ניהול ותפעול</th><th class="num">השתתפות הורים</th><th class="num">אומדן מחושב</th></tr></thead>
  <tbody>${payRows}${payTotals}</tbody>
</table>
<div class="expected">💰 <b>סה"כ צפוי להתקבל מהמשרד בפרויקט זה: ₪${fmt(t.expected)}</b>
  <span class="soft">— ${t.paymentTotal > 0
    ? `מתוך קובץ דוח הביצוע: סה"כ לתשלום בתוספת גמישות 25% ₪${fmt(t.paymentTotal)}${t.paymentAides > 0 ? ` + תוספת סייעות רפואיות/אישיות ₪${fmt(t.paymentAides)}` : ''} (אומדן המערכת: ₪${fmt(t.computedExpected)}).`
    : `אומדן המערכת (הקובץ לא חושב): שכר מוכר ₪${fmt(t.salaryRecognized)} + העשרה ₪${fmt(t.enrichRecognized)}${t.bfsRecognized > 0 ? ` + ארוחות בוקר/מלגות ₪${fmt(t.bfsRecognized)}` : ''}${t.mgmtRecognized > 0 ? ` + ניהול ₪${fmt(t.mgmtRecognized)}` : ''} − השתתפות הורים ₪${fmt(t.income)}.`} תקורת הניהול מוכרת ב-100% מתקציב הסל.</span>
</div>
</body></html>`;
}

/* ---------- סיכום מרוכז ללקוח ---------- */
function renderClientStage2Html(d) {
  const today = new Date().toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
  const rows = d.projects.map((p, i) => `<tr${i % 2 ? ' class="z"' : ''}>
      <td>${esc(p.label)}</td>
      <td class="num">₪${fmt(p.totals.salaryBudget)}</td>
      <td class="num">₪${fmt(p.totals.salaryRecognized)}</td>
      <td class="num">${p.totals.uncovered > 0 ? `<span class="red">₪${fmt(p.totals.uncovered)}</span>` : '—'}</td>
      <td class="num">₪${fmt(p.totals.enrichRecognized)}</td>
      <td class="num">−₪${fmt(p.totals.income)}</td>
      <td class="num"><b>₪${fmt(p.totals.expected)}</b></td>
      <td class="num">${p.gaps > 0 ? `<span class="red">${p.gaps} פערים</span>` : '✓'}</td>
    </tr>`).join('');
  const t = d.totals;
  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<title>סיכום תשלום צפוי — ${esc(d.client.name)}</title>
<style>${CSS}</style></head><body>
<div class="letterhead"><span><b>גוטליב את ביטון, רו"ח</b></span><span>${today}</span></div>
<h1>סיכום שלב 2 — תשלום צפוי מרוכז ללקוח</h1>
<div class="sub">${esc(d.client.name)} · ${d.projects.length} פרויקטים${d.client.has_vat ? ' · לקוח חייב מע"מ' : ''}</div>
<table>
  <thead><tr><th>פרויקט</th><th class="num">תקציב שכר</th><th class="num">שכר מוכר</th>
    <th class="num">חריגה לא מוכרת</th><th class="num">העשרה מוכרת</th><th class="num">השתתפות הורים</th>
    <th class="num">צפוי לקבל</th><th class="num">בקרות</th></tr></thead>
  <tbody>${rows}
    <tr class="total"><td>סה"כ ללקוח</td>
      <td class="num">₪${fmt(t.salaryBudget)}</td><td class="num">₪${fmt(t.salaryRecognized)}</td>
      <td class="num">${t.uncovered > 0 ? `<span class="red">₪${fmt(t.uncovered)}</span>` : '—'}</td>
      <td class="num">₪${fmt(t.enrichRecognized)}</td><td class="num">−₪${fmt(t.income)}</td>
      <td class="num">₪${fmt(t.expected)}</td><td></td></tr>
  </tbody>
</table>
<div class="expected">💰 <b>סה"כ צפוי להתקבל מהמשרד בכל הפרויקטים: ₪${fmt(t.expected)}</b></div>
</body></html>`;
}

module.exports = { stage2Data, clientStage2Data, renderStage2Html, renderClientStage2Html };
