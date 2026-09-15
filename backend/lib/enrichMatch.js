/* דוח התאמת העשרה (שלב 2): איך כרטסות ההעשרה מהלקוח מתחלקות בין המוסדות
   בדוח הביצוע. הכללים זהים למילוי לשונית "דוח הוצאות בפועל" בייצוא
   (buildExpenseFill): גנים — במרוכז לכל הגנים; בתי"ס — כרטסת ששמה תואם
   בי"ס משויכת אליו, וכרטסת כללית מפוצלת יחסית לכמות הילדים (או לתקציב
   כשאין ילדים). לכל כרטסת: מספר ושם בכותרת, טבלת סמל/בי"ס/סכום, וסה"כ
   שחייב להיות שווה לסך הכרטסת. */
const { matchDeptsToInstitutions } = require('./nameMatch');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('he-IL'));

async function enrichMatchData(db, report, client, authority) {
  const cards = (await db.prepare(
    "SELECT * FROM ledger_cards WHERE report_id = ? AND basket_type = 'enrichment'"
  ).all(report.id)).filter((c) => (c.net || 0) > 0);
  const insts = await db.prepare('SELECT symbol, name, children_count, budget_total FROM institutions WHERE report_id = ? ORDER BY symbol').all(report.id);
  const hasVat = !!(client && client.has_vat);
  const vat = hasVat ? 1.18 : 1;
  const r2 = (n) => Math.round(n * 100) / 100;

  const totalChildren = insts.reduce((s, i) => s + (i.children_count || 0), 0);
  const totalBudget = insts.reduce((s, i) => s + (Number(i.budget_total) || 0), 0);
  const nameToSymbol = report.framework !== 'gardens' && insts.length
    ? matchDeptsToInstitutions(insts, [...new Set(cards.map((c) => c.card_name))])
    : {};

  const perCard = cards.map((c) => {
    const gross = r2(c.net * vat);
    if (report.framework === 'gardens') {
      return {
        cardKey: c.card_key, cardName: c.card_name, net: r2(c.net), gross,
        method: 'aggregate',
        rows: [{ symbol: null, name: 'כל הגנים (במרוכז)', amount: gross }],
      };
    }
    const sym = nameToSymbol[c.card_name];
    if (sym) {
      const inst = insts.find((i) => String(i.symbol) === String(sym));
      return {
        cardKey: c.card_key, cardName: c.card_name, net: r2(c.net), gross,
        method: 'name',
        rows: [{ symbol: sym, name: (inst && inst.name) || '', amount: gross }],
      };
    }
    // כרטסת כללית — פיצול יחסי (ילדים; כשאין נתוני ילדים — לפי התקציב)
    const byChildren = totalChildren > 0;
    const base = byChildren ? totalChildren : totalBudget;
    const weight = (i) => (byChildren ? (i.children_count || 0) : (Number(i.budget_total) || 0));
    const rows = [];
    let allocated = 0;
    insts.forEach((inst, idx) => {
      const amount = idx === insts.length - 1
        ? r2(gross - allocated)
        : r2(gross * (weight(inst) / (base || 1)));
      allocated = r2(allocated + amount);
      rows.push({ symbol: inst.symbol, name: inst.name, children: inst.children_count, amount });
    });
    return {
      cardKey: c.card_key, cardName: c.card_name, net: r2(c.net), gross,
      method: byChildren ? 'children' : 'budget',
      rows,
    };
  });

  return { report, client, authority, perCard, hasVat, insts };
}

function renderEnrichMatchHtml(d) {
  const today = new Date().toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
  const clientName = (d.client && d.client.name) || '';
  const authorityName = (d.authority && d.authority.name) || '';
  const who = authorityName && authorityName !== clientName ? `${clientName} — ${authorityName}` : clientName;
  const { reportLabel } = require('./domain');
  const label = reportLabel(d.report.framework, d.report.program);

  const methodHe = {
    aggregate: 'כל הגנים במרוכז',
    name: 'שיוך לפי שם הכרטסת',
    children: 'פיצול יחסי לפי כמות הילדים בכל מוסד',
    budget: 'פיצול יחסי לפי תקציב כל מוסד',
  };

  const cardBlocks = d.perCard.map((c) => {
    const rows = c.rows.map((r, i) => `<tr${i % 2 ? ' class="z"' : ''}>
      <td>${r.symbol ? esc(r.symbol) : '—'}</td>
      <td>${esc(r.name)}</td>
      ${c.method === 'children' ? `<td class="num">${fmt(r.children)}</td>` : ''}
      <td class="num">₪${fmt(r.amount)}</td>
    </tr>`).join('');
    const total = c.rows.reduce((s, r) => s + r.amount, 0);
    return `<section class="cardblock">
      <h2>כרטסת ${esc(c.cardKey)} — ${esc(c.cardName)}</h2>
      <div class="meta">סכום הכרטסת (נטו): <b>₪${fmt(c.net)}</b>${d.hasVat ? ` · מדווח בדוח הביצוע כולל מע"מ 18%: <b>₪${fmt(c.gross)}</b>` : ''} · אופן הייחוס: ${methodHe[c.method]}</div>
      <table>
        <thead><tr><th>סמל מוסד</th><th>${d.report.framework === 'gardens' ? 'מסגרת' : 'שם בית הספר'}</th>${c.method === 'children' ? '<th class="num">ילדים</th>' : ''}<th class="num">העשרה שיוחסה</th></tr></thead>
        <tbody>${rows}
          <tr class="total"><td colspan="${c.method === 'children' ? 3 : 2}">סה"כ</td><td class="num">₪${fmt(total)}</td></tr>
        </tbody>
      </table>
      <div class="check">${Math.abs(total - c.gross) < 1
        ? `✓ הסה"כ תואם לסך הכרטסת${d.hasVat ? ' (בתוספת מע"מ)' : ''}.`
        : `⚠ הסה"כ (₪${fmt(total)}) שונה מסך הכרטסת (₪${fmt(c.gross)}).`}</div>
    </section>`;
  }).join('');

  const totalNet = d.perCard.reduce((s, c) => s + c.net, 0);
  const totalGross = d.perCard.reduce((s, c) => s + c.gross, 0);

  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<title>דוח התאמת העשרה — ${esc(who)} — ${esc(label)}</title>
<style>
  body{font-family:'Segoe UI',Arial,sans-serif;color:#37322A;max-width:880px;margin:0 auto;padding:30px;line-height:1.7;font-size:13.5px}
  h1{font-size:19px;margin:14px 0 2px}
  h2{font-size:14.5px;color:#9A7B2F;margin:0 0 4px}
  .letterhead{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #9A7B2F;padding-bottom:8px;font-size:12.5px;color:#7A7062}
  .sub{font-size:12.5px;color:#7A7062;margin-bottom:18px}
  .cardblock{border:1px solid #EAE1CF;border-radius:10px;padding:14px 18px;margin-bottom:18px;background:#FDFBF6}
  .meta{font-size:12.5px;color:#5C5344;margin-bottom:8px}
  table{width:100%;border-collapse:collapse;font-size:12.5px;margin:6px 0}
  th{background:#9A7B2F;color:#fff;text-align:right;padding:6px 10px;font-size:12px}
  th.num,td.num{text-align:center}
  td{border-bottom:1px solid #EAE1CF;padding:6px 10px}
  tr.z td{background:#FBF7EC}
  tr.total td{background:#F4ECDA;font-weight:700;border-top:2px solid #9A7B2F}
  .check{font-size:12.5px;font-weight:600;color:#4C7A45;margin-top:4px}
  .summary{background:#FAF6EE;border-radius:8px;padding:10px 16px;font-size:13px}
  @media print { body{padding:10px} }
</style></head><body>
<div class="letterhead"><span><b>גוטליב את ביטון, רו"ח</b></span><span>${today}</span></div>
<h1>דוח התאמת העשרה — ייחוס כרטסות ההעשרה למוסדות</h1>
<div class="sub">${esc(who)} · ${esc(label)} · הסכומים המיוחסים נרשמים בלשונית "דוח הוצאות בפועל" בדוח הביצוע${d.hasVat ? ' בתוספת מע"מ 18% (הכרטסת נטו)' : ''}.</div>
${d.perCard.length ? cardBlocks : '<p>לא נקלטו כרטסות העשרה לדוח זה — מעלים כרטסת בלשונית שלב 2 והדוח ייבנה אוטומטית.</p>'}
${d.perCard.length ? `<div class="summary">סה"כ העשרה בכל הכרטסות: נטו ₪${fmt(totalNet)}${d.hasVat ? ` · מדווח כולל מע"מ: ₪${fmt(totalGross)}` : ''} · ${d.perCard.length} כרטסות</div>` : ''}
</body></html>`;
}

module.exports = { enrichMatchData, renderEnrichMatchHtml };
