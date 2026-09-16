/* דוח שלב 2 — "בקרות ותשלום צפוי" (הפלט המרכזי של שלב 2):
   א. הבקרות שבוצעו והפערים (כרטסת ↔ דוח עלות ↔ דוח ביצוע, העשרה, הכנסות)
   ב. ניצול מול תקציב בכל סל — בגנים במרוכז, בבתי ספר פר מוסד
   ג. התשלום הצפוי מהמשרד — פר מוסד, מרוכז לפרויקט, ובסיכום הלקוח מרוכז לכל
      הפרויקטים. ההכרה משחזרת את כללי דוח הביצוע: שכר מוכר עד התקציב +
      הסל הגמיש (חריגה מעבר לגמיש אינה מוכרת), העשרה/ארוחות בוקר מוכרים
      לפי הכרטסות עד תקרת הסל, תקורת הניהול מוכרת ב-100% מהתקציב (כלל
      רעות 16.9.2026), בניכוי השתתפות ההורים. */

const { stage1Data } = require('./stage1');
const { ledgerReconcile } = require('./reconcile');
const { enrichMatchData } = require('./enrichMatch');
const { reportLabel } = require('./domain');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('he-IL'));
const r2 = (n) => Math.round((n || 0) * 100) / 100;

/* נתוני שלב 2 לפרויקט אחד */
async function stage2Data(db, report, client, authority) {
  const d = await stage1Data(db, report, client, authority);
  const reconcile = await ledgerReconcile(db, report, client);
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
    const expected = r2(salaryRecognized + enrichRecognized + bfsRecognized + mgmtRecognized - income);
    return {
      ...u,
      salaryActual, salaryRecognized,
      enrichAllocated: r2(enrichAllocated), enrichRecognized,
      bfsRecognized, mgmtRecognized,
      income, expected,
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
  };

  return {
    report, client, authority, label: reportLabel(report.framework, report.program),
    hasVat: d.hasVat, tariff: d.tariff,
    checks: reconcile.hasLedger ? (reconcile.checks || []) : [],
    hasLedger: !!reconcile.hasLedger,
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

<h2>ב. ניצול מול תקציב — ${d.report.framework === 'gardens' ? 'כל הגנים במרוכז' : 'פר בית ספר'}</h2>
<table>
  <thead><tr><th>${d.report.framework === 'gardens' ? 'מסגרת' : 'בית ספר'}</th>
    <th class="num">תקציב שכר</th><th class="num">ניצול שכר</th><th class="num">% ניצול</th>
    <th class="num">סל גמיש</th><th class="num">גמיש שנוצל לשכר</th><th class="num">חריגה לא מוכרת</th>
    <th class="num">תקציב העשרה</th><th class="num">העשרה מוכרת</th><th class="num">שכר מוכר</th></tr></thead>
  <tbody>${unitRows}${totalsRow}</tbody>
</table>

<h2>ג. התשלום הצפוי מהמשרד</h2>
<table>
  <thead><tr><th>${d.report.framework === 'gardens' ? 'מסגרת' : 'בית ספר'}</th>
    <th class="num">שכר מוכר</th><th class="num">העשרה</th><th class="num">ארוחות בוקר/מלגות</th>
    <th class="num">ניהול ותפעול</th><th class="num">השתתפות הורים</th><th class="num">צפוי לקבל</th></tr></thead>
  <tbody>${payRows}${payTotals}</tbody>
</table>
<div class="expected">💰 <b>סה"כ צפוי להתקבל מהמשרד בפרויקט זה: ₪${fmt(t.expected)}</b>
  <span class="soft">— שכר מוכר ₪${fmt(t.salaryRecognized)} + העשרה ₪${fmt(t.enrichRecognized)}${t.bfsRecognized > 0 ? ` + ארוחות בוקר/מלגות ₪${fmt(t.bfsRecognized)}` : ''}${t.mgmtRecognized > 0 ? ` + ניהול ₪${fmt(t.mgmtRecognized)}` : ''} − השתתפות הורים ₪${fmt(t.income)}. תקורת הניהול הוכרה במלואה — 100% מתקציב הסל (ברירת המחדל; במקרים חריגים יש לעדכן ידנית).</span>
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
