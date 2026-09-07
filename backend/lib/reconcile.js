/* התאמת כרטסת ↔ דוח עלות ↔ דוח ביצוע (README §7, צעד 6-7 ראשוני).
   כלל המע"מ (§7): אצל לקוח החייב במע"מ הכרטסת ודוח העלות תמיד תואמים,
   אבל מול דוח הביצוע של המשרד יש הפרש של 18% (הביצוע כולל מע"מ). */

const { costDataForReport } = require('./reportCosts');
const { SALARY_BASKET_TYPES, BASKET_HE } = require('./ledger');

const VAT_RATE = 0.18;
const fmtN = (n) => Math.round(n).toLocaleString('he-IL');

async function ledgerReconcile(db, report, client) {
  const cards = await db.prepare(
    `SELECT lc.*, lf.payer FROM ledger_cards lc JOIN ledger_files lf ON lf.id = lc.ledger_file_id
     WHERE lc.report_id = ?`
  ).all(report.id);
  if (!cards.length) return { hasLedger: false };

  // סכומי הכרטסת לפי סל
  const byBasket = {};
  cards.forEach((c) => {
    if (!c.basket_type) return;
    byBasket[c.basket_type] = (byBasket[c.basket_type] || 0) + (c.net || 0);
  });
  const ledgerSalary = SALARY_BASKET_TYPES.reduce((s, t) => s + (byBasket[t] || 0), 0);

  const cost = await costDataForReport(db, report);
  const costTotal = cost.summary.totalCost;

  const hasVat = !!(client && client.has_vat);
  const vatFactor = hasVat ? 1 + VAT_RATE : 1;
  // דוח הביצוע צפוי = העלות (כרטסת/דוח עלות) בתוספת מע"מ ללקוח חייב
  const expectedExec = costTotal * vatFactor;
  const execActual = Number((await db.prepare('SELECT COALESCE(SUM(actual_total),0) a FROM institutions WHERE report_id = ?').get(report.id)).a);

  const checks = [];
  // בסיס אפס עם הפרש ממשי = אי-התאמה מלאה (לא "תקין")
  const pct = (diff, base) => (base > 0 ? Math.abs(diff) / base : (Math.abs(diff) > 200 ? 1 : 0));
  const level = (p, amt) => (p <= 0.01 || Math.abs(amt) <= 200 ? 'ok' : p <= 0.05 ? 'warn' : 'err');

  // בדיקה 1: כרטסת השכר מול דוח העלות — חייבים להתאים (גם אצל חייב מע"מ).
  // כשיש יותר ממשלם אחד (מתנ"ס/חברה + רשות) — הבדיקה נעשית לכל משלם בנפרד.
  // מפצלים לפי משלם רק כשבאמת הוגדרו שני משלמים שונים (מתנ"ס/חברה + רשות);
  // קובץ ללא הגדרה מצטרף למשלם ברירת המחדל (שם הרשות/הלקוח)
  const DEFAULT_PAYER = (client && client.name) || 'המפעיל';
  const distinctDefined = new Set([
    ...cards.map((c) => c.payer).filter(Boolean),
    ...cost.rows.map((r) => r.payer).filter(Boolean),
  ]);
  const multiPayer = distinctDefined.size >= 2;
  const salaryCardsByPayer = {};
  cards.forEach((c) => {
    if (!SALARY_BASKET_TYPES.includes(c.basket_type)) return;
    const p = c.payer || DEFAULT_PAYER;
    salaryCardsByPayer[p] = (salaryCardsByPayer[p] || 0) + (c.net || 0);
  });
  const costByPayer = {};
  cost.rows.forEach((r) => {
    const p = r.payer || DEFAULT_PAYER;
    costByPayer[p] = (costByPayer[p] || 0) + (r.cost || 0);
  });
  const payers = [...new Set([...Object.keys(salaryCardsByPayer), ...Object.keys(costByPayer)])];

  if (multiPayer) {
    payers.forEach((p) => {
      const L = salaryCardsByPayer[p] || 0;
      const C = costByPayer[p] || 0;
      if (L === 0 && C === 0) return;
      const diff = L - C;
      checks.push({
        id: `ledger_vs_cost:${p}`,
        level: level(pct(diff, C), diff),
        text: `${p}: כרטסת שכר ₪${fmtN(L)} מול דוח עלות ₪${fmtN(C)} — ${Math.abs(diff) <= 200 ? 'תואם' : `הפרש ₪${fmtN(diff)}`}.`,
        a: L, b: C, diff, payer: p,
      });
    });
  } else if (ledgerSalary > 0 || costTotal > 0) {
    const diff = ledgerSalary - costTotal;
    checks.push({
      id: 'ledger_vs_cost',
      level: level(pct(diff, costTotal), diff),
      text: `כרטסת שכר ₪${fmtN(ledgerSalary)} מול דוח עלות ₪${fmtN(costTotal)} — ${Math.abs(diff) <= 200 ? 'תואם' : `הפרש ₪${fmtN(diff)}`}.`,
      a: ledgerSalary, b: costTotal, diff,
    });
  }

  // בדיקה 3: הכנסות משתתפים — כרטסת ההכנסות מול הגבייה המדווחת (ילדים × תעריף).
  // לקוח חייב מע"מ: הדיווח כולל מע"מ, הכרטסת נטו → צפוי פער 18%.
  const incomeCards = cards.filter((c) => c.basket_type === 'income');
  const tariff = report.parent_tariff || 0;
  if (incomeCards.length && tariff > 0) {
    const kids = Number((await db.prepare('SELECT COALESCE(SUM(children_count),0) k FROM institutions WHERE report_id = ?').get(report.id)).k);
    const reported = kids * tariff; // הגבייה כפי שתדווח בדוח הביצוע
    const ledgerIncome = -incomeCards.reduce((s, c) => s + (c.net || 0), 0); // הכנסה = יתרת זכות
    if (reported > 0) {
      const expected = reported / vatFactor; // מה שצפוי בכרטסת
      const diff = ledgerIncome - expected;
      checks.push({
        id: 'income_vs_ledger',
        level: level(pct(diff, expected), diff),
        text: hasVat
          ? `כרטסת הכנסות ₪${fmtN(ledgerIncome)} מול גבייה מדווחת ₪${fmtN(reported)} בניכוי מע"מ (₪${fmtN(expected)}) — ${Math.abs(diff) <= 200 ? 'תואם (ההפרש מהדיווח הוא המע"מ, כצפוי)' : `הפרש ₪${fmtN(diff)}`}.`
          : `כרטסת הכנסות ₪${fmtN(ledgerIncome)} מול גבייה מדווחת (${kids.toLocaleString('he-IL')} ילדים × ₪${tariff}) ₪${fmtN(reported)} — ${Math.abs(diff) <= 200 ? 'תואם' : `הפרש ₪${fmtN(diff)}`}.`,
        a: ledgerIncome, b: expected, diff,
      });
    }
  }

  // בדיקה 2: מול דוח הביצוע של המשרד (אם נקלט ביצוע מהקובץ)
  if (execActual > 0 && costTotal > 0) {
    const diff = execActual - expectedExec;
    checks.push({
      id: 'exec_vs_cost',
      level: level(pct(diff, expectedExec), diff),
      text: hasVat
        ? `דוח ביצוע ₪${fmtN(execActual)} מול עלות + מע"מ 18% ₪${fmtN(expectedExec)} — ${Math.abs(diff) <= 200 ? 'תואם (ההפרש מהעלות הוא המע"מ, כצפוי)' : `הפרש ₪${fmtN(diff)}`}.`
        : `דוח ביצוע ₪${fmtN(execActual)} מול דוח העלות ₪${fmtN(expectedExec)} — ${Math.abs(diff) <= 200 ? 'תואם' : `הפרש ₪${fmtN(diff)}`}.`,
      a: execActual, b: expectedExec, diff,
    });
  }

  return {
    hasLedger: true,
    byBasket: Object.entries(byBasket).map(([t, amount]) => ({ type: t, label: BASKET_HE[t] || t, amount })),
    unassigned: cards.filter((c) => !c.basket_type).length,
    ledgerSalary, costTotal, execActual, expectedExec, hasVat, vatRate: VAT_RATE,
    payers, multiPayer,
    checks,
  };
}

module.exports = { ledgerReconcile, VAT_RATE };
