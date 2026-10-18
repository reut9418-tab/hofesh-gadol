/* דוח התאמת שכר לבתי ספר (שלב 2) — הבדיקה שמשרד החינוך עושה (רעות 11.10):
   כרטסת השכר מול דוח העלות פר בית ספר (סמל מוסד).
   - כרטסת שכר אחת לכל בתי הספר ("כרטסת 1"): סה"כ הכרטסת, ומתחת רשימת
     סמלי המוסד, שמות בתי הספר וסכום השכר בכל אחד מדוח העלות, וסיכום
     שהסכומים שווים לכרטסת.
   - כרטיס לכל בית ספר (לפי השם / שיוך ידני / סמל באסמכתא): השוואה
     בית ספר מול בית ספר, והתרעה מסודרת על כל פער.
   - מעורב: כרטיסי בתי הספר מול בתי הספר שלהם, והכרטיסים הכלליים (למשל
     "רכזי קייטנות") מול היתרה שאינה מכוסה בכרטיס ייעודי.
   שיוך השורות לבתי ספר זהה לייצוא ולמכתב (schoolRowResolver).
   בגנים אין פירוט לפי מוסד — הבדיקה אינה רלוונטית. */

const { SALARY_BASKET_TYPES, BASKET_HE } = require('./ledger');
const { cardSymbolResolver } = require('./nameMatch');
const { cardSplits } = require('./ledgerSplit');
const { notClubSql } = require('./salaryCheck');
const { reportLabel } = require('./domain');

const r2 = (n) => Math.round((n || 0) * 100) / 100;
const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('he-IL'));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TOL_ABS = 200; // ₪ — כמו שאר בדיקות שלב 2
const levelOf = (diff, base) => {
  const a = Math.abs(diff || 0);
  if (a <= TOL_ABS) return 'ok';
  const p = base > 0 ? a / base : 1;
  return p <= 0.01 ? 'ok' : p <= 0.05 ? 'warn' : 'err';
};
const coversHe = (gc) => (gc.pattern === 'all' ? 'השכר שאינו מכוסה בכרטיסים הייעודיים' : 'השכר בבתי הספר ללא כרטיס ייעודי');
const listNames = (cards, max = 3) => cards.slice(0, max).map((c) => c.name).join(', ') + (cards.length > max ? ` ועוד ${cards.length - max}` : '');
const worst = (levels) => (levels.includes('err') ? 'err' : levels.includes('warn') ? 'warn' : 'ok');

/* withExec — עמודת דוח הביצוע (מחשבת את המכתב, ~2 שניות): בדוח/אקסל כן, בשורת שלב 2 לא */
async function salaryMatchData(db, report, client, authority, { withExec = true } = {}) {
  const base = { report, client, authority, applicable: report.framework !== 'gardens', hasCards: false, groups: [], summary: null };
  if (!base.applicable) return base;

  const cards = await db.prepare(
    `SELECT lc.*, lf.payer FROM ledger_cards lc JOIN ledger_files lf ON lf.id = lc.ledger_file_id
     WHERE lc.report_id = ? AND lc.basket_type IN (${SALARY_BASKET_TYPES.map(() => '?').join(',')}) ORDER BY lc.net DESC`
  ).all(report.id, ...SALARY_BASKET_TYPES);
  if (!cards.length) return base;
  base.hasCards = true;

  const insts = await db.prepare('SELECT id, symbol, name, salary_actual FROM institutions WHERE report_id = ? ORDER BY symbol').all(report.id);
  const rows = await db.prepare(
    `SELECT cr.*, cf.payer FROM cost_rows cr JOIN cost_files cf ON cf.id = cr.cost_file_id WHERE cr.report_id = ? AND ${notClubSql('cr.')}`
  ).all(report.id);
  const { schoolRowResolver } = require('./stage1');
  const { meta, matchInsts, rowSymbol } = await schoolRowResolver(db, report, rows, insts);
  // העובדים שכתובים בלשונית כח האדם של קובץ הביצוע שהועלה (ת"ז → שיוך) —
  // עובד/ת בדוח העלות שאינו/ה שם = לא נכנס/ה לדוח הביצוע (רעות 11.10)
  const fileWorkers = (meta && meta.workerSyms) || {};
  const hasFileWorkers = Object.keys(fileWorkers).length > 0;
  base.hasFileWorkers = hasFileWorkers;
  const { inWorkers } = require('./idMatch');
  const inFile = (r) => {
    if (!String(r.emp_id || '').replace(/\D/g, '')) return null; // ת.ז לא מספרית (דרכון) — אי אפשר להצליב
    return inWorkers(fileWorkers, r.emp_id); // סובלני לספרת ביקורת חסרה / אפס מוביל
  };
  // דוח הביצוע (קובץ המשרד שהועלה): ביצוע השכר פר מוסד (הדרכה+רכזים+סגנים),
  // מול הצפוי מדוח העלות — העלות המוכרת (×מע"מ ללקוח חייב, תקרת ברוטו+40%)
  const { recognizedRowCost } = require('./ingest');
  const hasVat = !!(client && client.has_vat);
  const vatFactor = hasVat ? 1.18 : 1;
  const execBy = {};
  for (const i of insts) if (Number(i.salary_actual) > 0) execBy[String(i.symbol)] = r2(Number(i.salary_actual));
  const hasExec = withExec && Object.keys(execBy).length > 0;
  base.hasExec = hasExec;
  base.hasVat = hasVat;
  // הצפוי בדוח הביצוע פר מוסד — בדיוק לפי כללי קובץ המשרד (סגן/ית מוכר/ת רק
  // במוסד זכאי ועם רכז/ת, תקרת ריכוז, מע"מ, תקרת 140%) — מיחידות מכתב שלב 1
  const unitActual = {};
  if (hasExec) {
    try {
      const { stage1Data } = require('./stage1');
      const s1 = await stage1Data(db, report, client, authority);
      for (const u of s1.units || []) if (u.symbol) unitActual[String(u.symbol)] = r2((u.salaryActual || 0) - (u.authEstAmount || 0));
    } catch (e) { console.warn('salaryMatch: stage1 units failed —', e.message); }
  }
  // רשימת בתי הספר: מוסדות הדוח + סמל פעילות שאליו הופנו שורות ואינו ברשימה
  const nameOf = new Map();
  for (const i of [...matchInsts, ...insts]) if (!nameOf.has(String(i.symbol))) nameOf.set(String(i.symbol), i.name || '');
  const symbols = [...new Set([...insts.map((i) => String(i.symbol)), ...rows.map(rowSymbol).filter(Boolean)])];
  const instList = symbols.map((s) => ({ symbol: s, name: nameOf.get(s) || '' }));

  // כרטסת משותפת לכמה פרויקטים של אותו לקוח (אלעד: כרטיס אחד לבתי"ס + מכינות)
  const sharedOf = async (cardKey) => {
    const others = await db.prepare(
      `SELECT DISTINCT r.id, r.framework, r.program FROM ledger_cards lc JOIN reports r ON r.id = lc.report_id
       WHERE lc.card_key = ? AND r.client_id = ? AND r.id <> ? AND lc.basket_type IN (${SALARY_BASKET_TYPES.map(() => '?').join(',')})`
    ).all(cardKey, report.client_id, report.id, ...SALARY_BASKET_TYPES);
    const out = [];
    for (const o of others) {
      const c = await db.prepare(`SELECT COALESCE(SUM(cost),0) s FROM cost_rows WHERE report_id = ? AND ${notClubSql()}`).get(o.id);
      out.push({ reportId: o.id, label: reportLabel(o.framework, o.program), cost: r2(Number(c.s)) });
    }
    return out;
  };

  // קבוצות לפי משלם — רק כשבאמת הוגדרו שני משלמים שונים (כמו בשאר הבדיקות)
  const DEFAULT_PAYER = (authority && authority.name) || (client && client.name) || 'המפעיל';
  const defined = new Set([...cards.map((c) => c.payer), ...rows.map((r) => r.payer)].filter(Boolean));
  const multiPayer = defined.size >= 2;
  const payerOf = (x) => (multiPayer ? (x.payer || DEFAULT_PAYER) : DEFAULT_PAYER);
  const payers = [...new Set([...cards, ...rows].map(payerOf))];

  const splits = await cardSplits(db, cards, instList);
  const symOf = cardSymbolResolver(instList, cards);

  const groups = [];
  for (const payer of payers) {
    const gCards = cards.filter((c) => payerOf(c) === payer);
    const gRows = rows.filter((r) => payerOf(r) === payer);
    if (!gCards.length && !gRows.length) continue;

    // דוח העלות פר בית ספר
    const costBy = {};
    const expectedExecBy = {}; // הצפוי בדוח הביצוע (העלות המוכרת) פר בית ספר
    let unassignedCost = 0, unassignedCount = 0;
    const missingBy = {}; // סמל → עובדים בדוח העלות שאינם בלשונית כח האדם של קובץ הביצוע
    const missingUnassigned = [];
    for (const r of gRows) {
      const s = rowSymbol(r);
      if (s) { costBy[s] = (costBy[s] || 0) + (r.cost || 0); expectedExecBy[s] = (expectedExecBy[s] || 0) + recognizedRowCost(r, vatFactor); }
      else { unassignedCost += r.cost || 0; unassignedCount++; }
      if (hasFileWorkers && inFile(r) === false) {
        const w = { name: r.emp_name || '—', empId: r.emp_id || '', dept: r.dept || '', cost: r2(r.cost), hours: r2(r.hours), expected: r2(recognizedRowCost(r, vatFactor)) };
        if (s) (missingBy[s] = missingBy[s] || []).push(w); else missingUnassigned.push(w);
      }
    }

    // ייחוס הכרטיסים: בית ספר / פיצול לפי אסמכתא / כללי
    const ledgerBy = {};
    const compBy = {}; // סמל → הרכב כרטסת השכר של בית הספר (רעות 18.10: "החלוקה לא ברורה")
    const addComp = (s, part) => { (compBy[s] = compBy[s] || []).push(part); };
    const cardsOut = [];
    const general = [];
    for (const c of gCards) {
      const sp = splits.get(c.id);
      const info = { id: c.id, key: c.card_key, name: c.card_name, net: r2(c.net), basket: BASKET_HE[c.basket_type] || c.basket_type };
      if (sp && sp.isSplit) {
        for (const [s, v] of Object.entries(sp.bySymbol)) { ledgerBy[s] = (ledgerBy[s] || 0) + v; addComp(s, { key: c.card_key, name: c.card_name, amount: r2(v), how: 'פיצול לפי אסמכתא' }); }
        cardsOut.push({ ...info, attribution: 'split', parts: Object.entries(sp.bySymbol).map(([s, v]) => ({ symbol: s, name: nameOf.get(s) || '', amount: r2(v) })),
          unassigned: sp.unassignedCount ? { count: sp.unassignedCount, amount: r2(sp.unassignedNet) } : null });
        continue;
      }
      const s = symOf(c);
      if (s) {
        ledgerBy[s] = (ledgerBy[s] || 0) + (c.net || 0);
        addComp(s, { key: c.card_key, name: c.card_name, amount: r2(c.net || 0), how: c.symbol_override ? 'שיוך ידני' : 'לפי השם' });
        cardsOut.push({ ...info, attribution: 'school', symbol: s, schoolName: nameOf.get(s) || '', method: c.symbol_override ? 'manual' : 'name' });
      } else {
        general.push(info);
        cardsOut.push({ ...info, attribution: 'general' });
      }
    }
    if (hasExec && !multiPayer) for (const [s, v] of Object.entries(unitActual)) if (expectedExecBy[s] != null) expectedExecBy[s] = v;
    const generalTotal = r2(general.reduce((s, c) => s + c.net, 0));
    const directTotal = r2(Object.values(ledgerBy).reduce((s, v) => s + v, 0));
    const costTotal = r2(Object.values(costBy).reduce((s, v) => s + v, 0) + unassignedCost);
    const mode = directTotal === 0 && general.length ? 'single' : general.length ? 'mixed' : 'perSchool';

    const schoolsRaw = instList
      .filter((i) => (costBy[i.symbol] || 0) !== 0 || (ledgerBy[i.symbol] || 0) !== 0 || mode === 'single')
      .map((i) => {
        const ledger = r2(ledgerBy[i.symbol] || 0);
        const cost = r2(costBy[i.symbol] || 0);
        // דוח הביצוע פר בית ספר (רק כשיש משלם אחד — בקובץ המשרד אין פיצול לפי משלם)
        const exec = hasExec && !multiPayer ? (execBy[i.symbol] ?? null) : null;
        const expectedExec = r2(expectedExecBy[i.symbol] || 0);
        const execDiff = exec != null ? r2(exec - expectedExec) : null;
        return {
          symbol: i.symbol, name: i.name, ledger, cost, diff: r2(ledger - cost), remainder: r2(Math.max(0, cost - ledger)),
          exec, expectedExec, execDiff, execLevel: execDiff == null ? 'none' : levelOf(execDiff, expectedExec),
          missing: missingBy[i.symbol] || [], // עובדים בדוח העלות שלא נמצאו בדוח הביצוע
        };
      })
      .sort((a, b) => b.cost - a.cost);

    /* מצב מעורב — מה הכרטיסים הכלליים מכסים? נקבע לפי הנתונים:
       'noCard' — את בתי הספר שאין להם כרטיס ייעודי (עכו: כרטיס שלא זוהה
       לפי השם); בתי ספר עם כרטיס ייעודי מושווים במדויק.
       'all' — חלק מהשכר בכל בית ספר (מעלה אדומים: "רכזי קייטנות" לכל
       בתי הספר); אז כרטיס ייעודי קטן מהעלות אינו פער אלא מכוסה. */
    const remAll = r2(schoolsRaw.reduce((s, x) => s + x.remainder, 0) + unassignedCost);
    const remNoCard = r2(schoolsRaw.filter((x) => x.ledger === 0).reduce((s, x) => s + x.cost, 0) + unassignedCost);
    let pattern = null;
    if (mode === 'mixed') {
      if (levelOf(generalTotal - remNoCard, remNoCard) === 'ok') pattern = 'noCard';
      else if (levelOf(generalTotal - remAll, remAll) === 'ok') pattern = 'all';
      else pattern = Math.abs(generalTotal - remNoCard) <= Math.abs(generalTotal - remAll) ? 'noCard' : 'all';
    }
    const schools = schoolsRaw.map((x) => {
      let level = 'none';
      if (mode !== 'single') {
        if (x.ledger === 0 && general.length) level = 'covered';
        else if (pattern === 'all' && x.diff < 0 && levelOf(x.diff, x.cost) !== 'ok') level = 'covered';
        else level = levelOf(x.diff, x.cost);
      }
      // הרכב הכרטסת של בית הספר + כמה מכוסה מהכרטיסים הכלליים
      const coveredByGeneral = level === 'covered' ? r2(x.ledger === 0 ? x.cost : Math.max(0, x.cost - x.ledger)) : 0;
      return { ...x, level, parts: compBy[x.symbol] || [], coveredByGeneral };
    });

    // הכרטיסים הכלליים מול מה שהם אמורים לכסות
    let generalCheck = null;
    if (general.length) {
      const expected = mode === 'single' ? costTotal : pattern === 'all' ? remAll : remNoCard;
      const shared = mode === 'single' && general.length === 1 ? await sharedOf(general[0].key) : [];
      const sharedCost = r2(shared.reduce((s, o) => s + o.cost, 0));
      const diff = r2(generalTotal - expected - sharedCost);
      // אילו בתי ספר הכרטיסים הכלליים מכסים ובכמה (לשקיפות החלוקה)
      const covers = schools.filter((s) => s.coveredByGeneral > 0).map((s) => ({ symbol: s.symbol, name: s.name, amount: s.coveredByGeneral }));
      generalCheck = { cards: general, total: generalTotal, expected, pattern, shared, sharedCost, diff, level: levelOf(diff, expected + sharedCost), covers };
    }

    const totalDiff = r2(directTotal + generalTotal - costTotal);
    const levels = [
      ...schools.map((s) => s.level).filter((l) => l !== 'none' && l !== 'covered'),
      generalCheck ? generalCheck.level : null,
      mode === 'perSchool' ? levelOf(totalDiff, costTotal) : null,
    ].filter(Boolean);
    // סיכום דוח הביצוע לקבוצה: הביצוע בקובץ מול הצפוי (רק בבתי ספר שיש להם ביצוע)
    const withExec = schools.filter((s) => s.exec != null);
    const execTotals = withExec.length ? (() => {
      const exec = r2(withExec.reduce((s, x) => s + x.exec, 0));
      const expected = r2(withExec.reduce((s, x) => s + x.expectedExec, 0));
      return { exec, expected, diff: r2(exec - expected), level: levelOf(exec - expected, expected), bad: withExec.filter((s) => s.execLevel !== 'ok') };
    })() : null;
    const missingAll = [...schools.flatMap((s) => s.missing.map((w) => ({ ...w, symbol: s.symbol, school: s.name }))), ...missingUnassigned.map((w) => ({ ...w, symbol: null, school: 'ללא בית ספר' }))];
    groups.push({
      payer: multiPayer ? payer : null, mode,
      cards: cardsOut, schools, generalCheck, execTotals,
      missing: missingAll, missingCost: r2(missingAll.reduce((s, w) => s + w.cost, 0)), missingExpected: r2(missingAll.reduce((s, w) => s + w.expected, 0)),
      unassignedCost: r2(unassignedCost), unassignedCount,
      splitUnassigned: cardsOut.filter((c) => c.unassigned).map((c) => ({ key: c.key, name: c.name, ...c.unassigned })),
      totals: { ledger: r2(directTotal + generalTotal), direct: directTotal, general: generalTotal, cost: costTotal, diff: totalDiff },
      level: worst(levels),
    });
  }

  base.groups = groups;
  base.summary = summarize(base);
  return base;
}

/* שורת סיכום אחת לרשימת "בדיקות שלב 2" — מסודרת: מה תואם, מה לא, ואיפה */
function summarize(d) {
  const parts = [];
  const levels = [];
  for (const g of d.groups) {
    const pre = g.payer ? `${g.payer}: ` : '';
    const n = g.schools.length;
    if (g.mode === 'single') {
      const gc = g.generalCheck;
      const names = gc.cards.map((c) => `${c.name} (${c.key})`).join(', ');
      const sharedTxt = gc.shared.length ? ` + ${gc.shared.map((o) => `${o.label} ₪${fmt(o.cost)}`).join(' + ')}` : '';
      parts.push(`${pre}כרטסת שכר אחת לכל ${n} בתי הספר — ${names}: ₪${fmt(gc.total)} מול דוח העלות ₪${fmt(g.totals.cost)}${sharedTxt} — ${gc.level === 'ok' ? 'תואם' : `הפרש ₪${fmt(gc.diff)}`}. הפירוט לפי בית ספר בדוח ההתאמה.`);
      levels.push(gc.level);
    } else {
      const bad = g.schools.filter((s) => s.level === 'warn' || s.level === 'err');
      const okN = g.schools.filter((s) => s.level === 'ok').length;
      const covered = g.schools.filter((s) => s.level === 'covered').length;
      const states = [];
      if (okN) states.push(`${okN} מתוך ${n} תואמים`);
      if (covered) states.push(`${covered === n ? `כל ${n}` : covered} ${covered === 1 ? 'מכוסה' : 'מכוסים'} ע"י הכרטיסים הכלליים`);
      if (bad.length) states.push(`פער ב-${bad.length}: ${bad.map((s) => `${s.name || s.symbol} (${s.diff > 0 ? '+' : ''}₪${fmt(s.diff)})`).join(', ')}`);
      let t = `${pre}כרטסת שכר לפי בתי ספר: ${states.join('; ')}`;
      if (g.generalCheck) {
        const gc = g.generalCheck;
        t += `; כרטיסים כלליים (${listNames(gc.cards)}) ₪${fmt(gc.total)} מול ${coversHe(gc)} ₪${fmt(gc.expected)} — ${gc.level === 'ok' ? 'תואם' : `הפרש ₪${fmt(gc.diff)}`}`;
        levels.push(gc.level);
      }
      if (g.mode === 'perSchool') {
        const lv = levelOf(g.totals.diff, g.totals.cost);
        t += `; סה"כ ₪${fmt(g.totals.ledger)} מול ₪${fmt(g.totals.cost)} — ${lv === 'ok' ? 'תואם' : `הפרש ₪${fmt(g.totals.diff)}`}`;
        levels.push(lv);
      }
      parts.push(t + '.');
      levels.push(...bad.map((s) => s.level));
    }
    const fileName = (d.report && d.report.budget_file_name) || 'קובץ המשרד';
    if (g.execTotals && g.execTotals.bad.length) {
      const et = g.execTotals;
      // הפער הכולל מול דוח הביצוע כבר מדווח בבדיקה "דוח ביצוע מול דוח העלות" —
      // כאן רק ההפניה לפירוט לפי בתי ספר, בלי להחמיר את הרמה (פחות רעש)
      const stale = g.missing && g.missing.length ? ` הקובץ השמור ישן יותר מדוח העלות (${g.missing.length} עובדים שבדוח העלות אינם בו) — זה מקור הפערים; הורדת דוח ביצוע מעודכן והעלאתו תיישר.` : '';
      parts.push(`דוח הביצוע בקובץ המשרד השמור ("${fileName}"): פער ב-${et.bad.length} ${et.bad.length === 1 ? 'בית ספר' : 'בתי ספר'} (${et.bad.slice(0, 3).map((s) => s.name || s.symbol).join(', ')}${et.bad.length > 3 ? ` ועוד ${et.bad.length - 3}` : ''}) — פירוט בדוח ההתאמה.${stale}`);
      levels.push('warn');
    }
    if (g.missing && g.missing.length) {
      const m = g.missing;
      parts.push(`${m.length} ${m.length === 1 ? 'עובד/ת' : 'עובדים'} מדוח העלות (₪${fmt(g.missingCost)}) עדיין לא בקובץ המשרד השמור במערכת ("${fileName}"): ${m.slice(0, 3).map((w) => `${w.name} (${w.school})`).join(', ')}${m.length > 3 ? ` ועוד ${m.length - 3}` : ''} — הם ייכנסו בהורדת דוח ביצוע מעודכן. פירוט בדוח ההתאמה.`);
      levels.push('warn');
    }
    if (g.unassignedCount) {
      parts.push(`${g.unassignedCount} ${g.unassignedCount === 1 ? 'עובד/ת' : 'עובדים'} בדוח העלות (₪${fmt(g.unassignedCost)}) ללא בית ספר — יש לשייך במסך ההכנה.`);
      levels.push('warn');
    }
    if (g.splitUnassigned.length) {
      parts.push(`תנועות ללא סמל בכרטיסים מפוצלים: ${g.splitUnassigned.map((c) => `${c.name} (${c.count}, ₪${fmt(c.amount)})`).join(', ')}.`);
      levels.push('warn');
    }
  }
  return { level: worst(levels), text: parts.join(' ') };
}

/* ---------- דף להדפסה / PDF ---------- */
function renderSalaryMatchHtml(d) {
  const today = new Date().toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
  const clientName = (d.client && d.client.name) || '';
  const authorityName = (d.authority && d.authority.name) || '';
  const who = authorityName && authorityName !== clientName ? `${clientName} — ${authorityName}` : clientName;
  const label = reportLabel(d.report.framework, d.report.program);
  const cls = (lv) => (lv === 'ok' ? 'ok' : lv === 'covered' ? 'cov' : lv === 'warn' ? 'warn' : lv === 'err' ? 'err' : '');
  const mark = (lv) => (lv === 'ok' ? '✓ תואם' : lv === 'covered' ? 'מכוסה בכרטיס כללי' : lv === 'warn' || lv === 'err' ? '⚠ פער' : '');
  // תא דוח הביצוע: הסכום בקובץ המשרד; כשאינו תואם לצפוי מדוח העלות — ההפרש
  const execCell = (s) => (s.exec == null ? '—'
    : s.execLevel === 'ok' ? `₪${fmt(s.exec)}`
    : `<span class="bad" title="צפוי לפי דוח העלות: ₪${fmt(s.expectedExec)}">₪${fmt(s.exec)} <small>(${s.execDiff > 0 ? '+' : ''}${fmt(s.execDiff)})</small></span>`)
    + (s.missing && s.missing.length ? ` <span class="bad" title="${esc(s.missing.map((w) => w.name).join(', '))}"><small>· ${s.missing.length} ${s.missing.length === 1 ? 'עובד/ת חסר/ה' : 'עובדים חסרים'}</small></span>` : '');
  const execBasis = [d.hasVat && 'כולל מע"מ 18%', 'אחרי תקרת ברוטו+40%'].filter(Boolean).join(', ');
  // עובדים מדוח העלות שלא נמצאו בלשונית כח האדם של קובץ הביצוע — לפי בית ספר
  const fileName = (d.report && d.report.budget_file_name) || 'קובץ המשרד';
  const missingBlock = (g) => {
    if (!g.missing || !g.missing.length) return d.hasFileWorkers ? `<div class="check ok">✓ כל העובדים מדוח העלות נמצאים בקובץ המשרד השמור (לשונית כח האדם של "${esc(fileName)}").</div>` : '';
    return `<div class="check warn">⚠ ${g.missing.length} ${g.missing.length === 1 ? 'עובד/ת מדוח העלות עדיין לא נמצא/ת' : 'עובדים מדוח העלות עדיין לא נמצאים'} בקובץ המשרד השמור במערכת ("${esc(fileName)}", לשונית כח האדם) — ₪${fmt(g.missingCost)} עלות מעביד${d.hasVat ? `, ₪${fmt(g.missingExpected)} כולל מע"מ` : ''}. הקובץ השמור ישן יותר מדוח העלות; הורדת דוח ביצוע מעודכן מהמערכת (והעלאתו) תכניס אותם.</div>
    <table class="small"><thead><tr><th>בית ספר</th><th>שם העובד/ת</th><th>ת.ז</th><th>מחלקה בדוח העלות</th><th class="num">שעות</th><th class="num">עלות מעביד</th></tr></thead><tbody>
      ${g.missing.map((w, i) => `<tr${i % 2 ? ' class="z"' : ''}><td>${esc(w.school)}${w.symbol ? ` (${esc(w.symbol)})` : ''}</td><td>${esc(w.name)}</td><td>${esc(w.empId)}</td><td>${esc(w.dept)}</td><td class="num">${fmt(w.hours)}</td><td class="num">₪${fmt(w.cost)}</td></tr>`).join('')}
    </tbody></table>`;
  };
  const execLine = (g) => {
    if (!g.execTotals) return missingBlock(g);
    const et = g.execTotals;
    const staleNote = g.missing && g.missing.length ? ` הקובץ השמור ישן יותר מדוח העלות (${g.missing.length} עובדים שבדוח העלות אינם בו) — זה מקור הפערים.` : '';
    return `<div class="check ${cls(et.level === 'ok' && !et.bad.length ? 'ok' : et.level === 'ok' ? 'warn' : et.level)}">${!et.bad.length
      ? `✓ דוח הביצוע בקובץ המשרד השמור ("${esc(fileName)}") ₪${fmt(et.exec)} תואם לצפוי מדוח העלות ₪${fmt(et.expected)} (${execBasis}) בכל בתי הספר.`
      : `⚠ דוח הביצוע בקובץ המשרד השמור ("${esc(fileName)}") ₪${fmt(et.exec)} מול הצפוי מדוח העלות ₪${fmt(et.expected)} (${execBasis}) — פער ב-${et.bad.length} בתי ספר (בעמודה "דוח ביצוע בקובץ השמור", הסכום בסוגריים = הפער מול הצפוי).${staleNote} הורדת דוח ביצוע מעודכן מהמערכת (והעלאתו) תיישר את הקובץ.`}</div>${missingBlock(g)}`;
  };
  // הרכב כרטסת השכר של כל בית ספר — איזה כרטיס, כמה, ואיך שויך (רעות 18.10)
  const compositionBlock = (g) => {
    const withParts = g.schools.filter((s) => (s.parts && s.parts.length) || s.coveredByGeneral > 0);
    if (!withParts.length) return '';
    return `<details open><summary>הרכב כרטסת השכר לכל בית ספר (${withParts.length})</summary><table class="small"><thead><tr><th>בית ספר</th><th>כרטיסים שמרכיבים את "כרטסת שכר"</th><th class="num">סה"כ כרטסת</th><th>מהכרטיסים הכלליים</th></tr></thead><tbody>
      ${withParts.map((s, i) => `<tr${i % 2 ? ' class="z"' : ''}><td>${esc(s.name)} (${esc(s.symbol)})</td><td>${s.parts.map((p) => `${esc(p.key)} ${esc(p.name)}: ₪${fmt(p.amount)} <small>(${esc(p.how)})</small>`).join('<br>') || '—'}</td><td class="num">${s.ledger ? `₪${fmt(s.ledger)}` : '—'}</td><td>${s.coveredByGeneral > 0 ? `₪${fmt(s.coveredByGeneral)}` : ''}</td></tr>`).join('')}
    </tbody></table></details>`;
  };

  const groupBlocks = d.groups.map((g) => {
    const head = g.payer ? `<h2>בספרי ${esc(g.payer)}</h2>` : '';
    let body = '';
    if (g.mode === 'single') {
      const gc = g.generalCheck;
      body += `<section class="block">
        <div class="cardline">${gc.cards.map((c) => `כרטסת <b>${esc(c.key)}</b> — ${esc(c.name)}: <b>₪${fmt(c.net)}</b>`).join('<br>')}</div>
        <div class="big">סה"כ בכרטסת השכר: ₪${fmt(gc.total)}</div>
        <table><thead><tr><th>סמל מוסד</th><th>שם בית הספר</th><th class="num">שכר בדוח העלות</th>${g.execTotals ? '<th class="num">דוח ביצוע (קובץ המשרד)</th>' : ''}</tr></thead><tbody>
          ${g.schools.map((s, i) => `<tr${i % 2 ? ' class="z"' : ''}><td>${esc(s.symbol)}</td><td>${esc(s.name)}</td><td class="num">₪${fmt(s.cost)}</td>${g.execTotals ? `<td class="num">${execCell(s)}</td>` : ''}</tr>`).join('')}
          ${g.unassignedCount ? `<tr class="warnrow"><td>—</td><td>ללא שיוך לבית ספר (${g.unassignedCount} עובדים)</td><td class="num">₪${fmt(g.unassignedCost)}</td>${g.execTotals ? '<td></td>' : ''}</tr>` : ''}
          ${gc.shared.map((o) => `<tr class="z"><td>—</td><td>${esc(o.label)} (אותה כרטסת, פרויקט אחר)</td><td class="num">₪${fmt(o.cost)}</td>${g.execTotals ? '<td></td>' : ''}</tr>`).join('')}
          <tr class="total"><td colspan="2">סה"כ בתי הספר</td><td class="num">₪${fmt(g.totals.cost + gc.sharedCost)}</td>${g.execTotals ? `<td class="num">₪${fmt(g.execTotals.exec)}</td>` : ''}</tr>
        </tbody></table>
        ${execLine(g)}
        <div class="check ${cls(gc.level)}">${gc.level === 'ok'
          ? `✓ סך השכר בבתי הספר (₪${fmt(g.totals.cost + gc.sharedCost)}) שווה לכרטסת (₪${fmt(gc.total)})${Math.abs(gc.diff) > 0.5 ? ` — הפרש זניח ₪${fmt(gc.diff)}` : ''}.`
          : `⚠ סך השכר בבתי הספר (₪${fmt(g.totals.cost + gc.sharedCost)}) אינו שווה לכרטסת (₪${fmt(gc.total)}) — הפרש ₪${fmt(gc.diff)}.`}</div>
      </section>`;
    } else {
      body += `<section class="block">
        <table><thead><tr><th>סמל מוסד</th><th>שם בית הספר</th><th class="num">כרטסת שכר</th><th class="num">דוח עלות</th><th class="num">הפרש</th>${g.execTotals ? '<th class="num" title="הסכום שכתוב בקובץ המשרד השמור במערכת; בסוגריים — הפער מול הצפוי מדוח העלות">דוח ביצוע בקובץ השמור (פער מול הצפוי)</th>' : ''}<th title="כרטסת השכר מול דוח העלות — בלי קשר לעמודת דוח הביצוע">כרטסת מול דוח עלות</th></tr></thead><tbody>
          ${g.schools.map((s, i) => `<tr class="${i % 2 ? 'z ' : ''}${cls(s.level)}"><td>${esc(s.symbol)}</td><td>${esc(s.name)}</td><td class="num">${s.ledger ? `₪${fmt(s.ledger)}` : '—'}</td><td class="num">₪${fmt(s.cost)}</td><td class="num">${s.ledger ? `₪${fmt(s.diff)}` : '—'}</td>${g.execTotals ? `<td class="num">${execCell(s)}</td>` : ''}<td>${mark(s.level)}</td></tr>`).join('')}
          ${g.unassignedCount ? `<tr class="warnrow"><td>—</td><td>ללא שיוך לבית ספר (${g.unassignedCount} עובדים)</td><td class="num">—</td><td class="num">₪${fmt(g.unassignedCost)}</td><td class="num">—</td>${g.execTotals ? '<td></td>' : ''}<td>⚠ לשייך במסך ההכנה</td></tr>` : ''}
          <tr class="total"><td colspan="2">סה"כ</td><td class="num">₪${fmt(g.totals.direct)}</td><td class="num">₪${fmt(g.totals.cost)}</td><td class="num">₪${fmt(g.totals.direct - g.totals.cost)}</td>${g.execTotals ? `<td class="num">₪${fmt(g.execTotals.exec)}</td>` : ''}<td></td></tr>
        </tbody></table>
        ${execLine(g)}
        ${g.generalCheck ? `<div class="sub2">כרטיסי שכר כלליים (לא לבית ספר מסוים): ${g.generalCheck.cards.map((c) => `${esc(c.name)} (${esc(c.key)}) ₪${fmt(c.net)}`).join(' · ')} — סה"כ <b>₪${fmt(g.generalCheck.total)}</b> מול ${coversHe(g.generalCheck)} <b>₪${fmt(g.generalCheck.expected)}</b>.${(g.generalCheck.covers || []).length ? `<br>מה הם מכסים: ${g.generalCheck.covers.map((c) => `${esc(c.name)} ₪${fmt(c.amount)}`).join(' · ')}.` : ''}</div>
        <div class="check ${cls(g.generalCheck.level)}">${g.generalCheck.level === 'ok' ? '✓ הכרטיסים הכלליים תואמים ליתרה.' : `⚠ הפרש ₪${fmt(g.generalCheck.diff)} בין הכרטיסים הכלליים ליתרה.`}</div>` : ''}
        <div class="check ${cls(levelOf(g.totals.diff, g.totals.cost))}">${levelOf(g.totals.diff, g.totals.cost) === 'ok' ? `✓ סה"כ כרטסות השכר ₪${fmt(g.totals.ledger)} מול דוח העלות ₪${fmt(g.totals.cost)} — תואם${Math.abs(g.totals.diff) > 0.5 ? ` (הפרש זניח ₪${fmt(g.totals.diff)})` : ''}.` : `⚠ סה"כ כרטסות השכר ₪${fmt(g.totals.ledger)} מול דוח העלות ₪${fmt(g.totals.cost)} — הפרש ₪${fmt(g.totals.diff)}.`}</div>
      </section>`;
    }
    // ייחוס הכרטיסים — שקיפות: איך כל כרטיס שויך (ההרכב לפי סמל — במסמך "התאמת כרטסות משותפות")
    body += `<details><summary>איך שויך כל כרטיס (${g.cards.length})</summary><table class="small"><thead><tr><th>מפתח</th><th>כרטסת</th><th class="num">נטו</th><th>שיוך</th></tr></thead><tbody>
      ${g.cards.map((c) => `<tr><td>${esc(c.key)}</td><td>${esc(c.name)}</td><td class="num">₪${fmt(c.net)}</td><td>${c.attribution === 'school' ? `${esc(c.schoolName)} (${esc(c.symbol)}) — ${c.method === 'manual' ? 'שיוך ידני' : 'לפי השם'}`
        : c.attribution === 'split' ? `מפוצל לפי סמל באסמכתא: ${c.parts.map((p) => `${esc(p.name || p.symbol)} ₪${fmt(p.amount)}`).join(', ')}${c.unassigned ? ` · ${c.unassigned.count} תנועות ללא סמל ₪${fmt(c.unassigned.amount)}` : ''}`
        : 'כללי — לכל בתי הספר'}</td></tr>`).join('')}
    </tbody></table></details>`;
    return head + body;
  }).join('');

  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<title>דוח התאמת שכר לבתי ספר — ${esc(who)} — ${esc(label)}</title>
<style>.bad{color:#B3362B;font-weight:600} .bad small{font-weight:400}</style>
<style>
  body{font-family:'Segoe UI',Arial,sans-serif;color:#37322A;max-width:900px;margin:0 auto;padding:30px;line-height:1.7;font-size:13.5px}
  h1{font-size:19px;margin:14px 0 2px}
  h2{font-size:14.5px;color:#9A7B2F;margin:14px 0 4px}
  .letterhead{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #9A7B2F;padding-bottom:8px;font-size:12.5px;color:#7A7062}
  .sub{font-size:12.5px;color:#7A7062;margin-bottom:18px}
  .block{border:1px solid #EAE1CF;border-radius:10px;padding:14px 18px;margin-bottom:12px;background:#FDFBF6}
  .cardline{font-size:12.5px;color:#5C5344}
  .big{font-size:15px;font-weight:700;margin:6px 0 8px}
  .sub2{font-size:12.5px;color:#5C5344;margin-top:8px}
  table{width:100%;border-collapse:collapse;font-size:12.5px;margin:6px 0}
  table.small{font-size:11.5px}
  th{background:#9A7B2F;color:#fff;text-align:right;padding:6px 10px;font-size:12px}
  th.num,td.num{text-align:center}
  td{border-bottom:1px solid #EAE1CF;padding:6px 10px}
  tr.z td{background:#FBF7EC}
  tr.total td{background:#F4ECDA;font-weight:700;border-top:2px solid #9A7B2F}
  tr.warn td,tr.err td,tr.warnrow td{background:#FBECE9}
  tr.cov td{color:#5C5344}
  .check{font-size:12.5px;font-weight:600;margin-top:6px}
  .check.ok{color:#4C7A45}.check.warn{color:#A8711E}.check.err{color:#B3362B}
  details{margin:4px 0 16px;font-size:12px;color:#5C5344}
  summary{cursor:pointer}
  .summary{background:#FAF6EE;border-radius:8px;padding:10px 16px;font-size:13px;margin-bottom:14px}
  @media print { body{padding:10px} details{display:none} }
</style></head><body>
<div class="letterhead"><span><b>גוטליב את ביטון, רו"ח</b></span><span>${today}</span></div>
<h1>דוח התאמת שכר לבתי ספר — כרטסת השכר מול דוח העלות${d.hasExec ? ' ודוח הביצוע' : ''}</h1>
<div class="sub">${esc(who)} · ${esc(label)} · כרטסת ודוח עלות נטו (עלות מעביד בספרים), לפי סמל מוסד — כבדיקת משרד החינוך.${d.hasExec ? ` דוח הביצוע = מה שכתוב בקובץ המשרד שהועלה (${execBasis}).` : ''}</div>
${!d.applicable ? '<p>בגנים הדיווח מרוכז לכל הגנים — אין התאמה לפי מוסד.</p>'
  : !d.hasCards ? '<p>לא נקלטו כרטסות שכר לדוח זה — מעלים כרטסת בלשונית שלב 2 והדוח ייבנה אוטומטית.</p>'
  : `<div class="summary ${cls(d.summary.level)}">${d.summary.level === 'ok' ? '✓' : '⚠'} ${esc(d.summary.text)}</div>${groupBlocks}`}
</body></html>`;
}

/* ---------- אקסל מעוצב (מותג המשרד) ---------- */
const XLSXS = require('xlsx-js-style');
function buildSalaryMatchXlsx(d) {
  const today = new Date().toLocaleDateString('he-IL');
  const clientName = (d.client && d.client.name) || '';
  const authorityName = (d.authority && d.authority.name) || '';
  const who = authorityName && authorityName !== clientName ? `${clientName} — ${authorityName}` : clientName;
  const label = reportLabel(d.report.framework, d.report.program);

  const GOLD = '9A7B2F', CHAMP = 'F4ECDA', SOFT = 'FBF7EC', LINE = 'D9CDB3', INK = '413A2F', RED = 'B3362B', GREEN = '4C7A45', REDBG = 'FBECE9';
  const border = { top: { style: 'thin', color: { rgb: LINE } }, bottom: { style: 'thin', color: { rgb: LINE } }, left: { style: 'thin', color: { rgb: LINE } }, right: { style: 'thin', color: { rgb: LINE } } };
  const S = {
    title: { font: { bold: true, sz: 14, color: { rgb: INK } }, alignment: { horizontal: 'right' } },
    sub: { font: { bold: true, sz: 11, color: { rgb: GOLD } }, alignment: { horizontal: 'right' } },
    meta: { font: { sz: 10, color: { rgb: '5C5344' } }, alignment: { horizontal: 'right', wrapText: true } },
    big: { font: { bold: true, sz: 12, color: { rgb: INK } }, alignment: { horizontal: 'right' } },
    head: { font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: GOLD } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border },
    cellR: (z, bad) => ({ font: { sz: 10, color: { rgb: INK } }, alignment: { horizontal: 'right' }, border, fill: { fgColor: { rgb: bad ? REDBG : z ? SOFT : 'FFFFFF' } } }),
    cellN: (z, bad) => ({ font: { sz: 10, color: { rgb: INK } }, alignment: { horizontal: 'center' }, border, numFmt: '#,##0.00', fill: { fgColor: { rgb: bad ? REDBG : z ? SOFT : 'FFFFFF' } } }),
    total: { font: { bold: true, sz: 10, color: { rgb: INK } }, fill: { fgColor: { rgb: CHAMP } }, alignment: { horizontal: 'center' }, border: { ...border, top: { style: 'medium', color: { rgb: GOLD } } }, numFmt: '#,##0.00' },
    totalR: { font: { bold: true, sz: 10, color: { rgb: INK } }, fill: { fgColor: { rgb: CHAMP } }, alignment: { horizontal: 'right' }, border: { ...border, top: { style: 'medium', color: { rgb: GOLD } } } },
    ok: { font: { bold: true, sz: 10, color: { rgb: GREEN } }, alignment: { horizontal: 'right' } },
    bad: { font: { bold: true, sz: 10, color: { rgb: RED } }, alignment: { horizontal: 'right' } },
  };
  const cell = (v, s) => ({ v: v == null ? '' : v, t: typeof v === 'number' ? 'n' : 's', s });
  const aoa = [
    [cell('דוח התאמת שכר לבתי ספר — כרטסת השכר מול דוח העלות', S.title)],
    [cell(`${who} — ${label} · ${today} · סכומים נטו (עלות מעביד בספרים) לפי סמל מוסד`, S.sub)],
    [],
  ];
  const W = 8;
  const merges = [0, 1].map((r) => ({ s: { r, c: 0 }, e: { r, c: W - 1 } }));
  const mergeLast = () => merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: W - 1 } });
  const statusHe = (lv) => (lv === 'ok' ? 'תואם' : lv === 'covered' ? 'מכוסה בכרטיס כללי' : lv === 'warn' || lv === 'err' ? 'פער' : '');
  const execBasis = [d.hasVat && 'כולל מע"מ 18%', 'אחרי תקרת ברוטו+40%'].filter(Boolean).join(', ');
  const execLineText = (g) => {
    const et = g.execTotals;
    return !et.bad.length
      ? `✓ דוח הביצוע (קובץ המשרד) ₪${fmt(et.exec)} תואם לצפוי מדוח העלות ₪${fmt(et.expected)} (${execBasis}) בכל בתי הספר`
      : `⚠ דוח הביצוע (קובץ המשרד) ₪${fmt(et.exec)} מול הצפוי מדוח העלות ₪${fmt(et.expected)} (${execBasis}) — פער ב-${et.bad.length} בתי ספר; הורדת דוח ביצוע מעודכן מהמערכת תיישר את הקובץ`;
  };

  if (d.summary) { aoa.push([cell(d.summary.text, S.meta)]); mergeLast(); aoa.push([]); }

  for (const g of d.groups) {
    if (g.payer) { aoa.push([cell(`בספרי ${g.payer}`, S.sub)]); mergeLast(); }
    if (g.mode === 'single') {
      const gc = g.generalCheck;
      for (const c of gc.cards) { aoa.push([cell(`כרטסת ${c.key} — ${c.name}: ₪${fmt(c.net)}`, S.meta)]); mergeLast(); }
      aoa.push([cell(`סה"כ בכרטסת השכר: ₪${fmt(gc.total)}`, S.big)]); mergeLast();
      const ex = !!g.execTotals;
      aoa.push([cell('סמל מוסד', S.head), cell('שם בית הספר', S.head), cell('שכר בדוח העלות', S.head), ...(ex ? [cell('דוח ביצוע (קובץ המשרד)', S.head), cell('הפרש מול הצפוי', S.head)] : [])]);
      g.schools.forEach((s, i) => aoa.push([cell(s.symbol, S.cellR(i % 2)), cell(s.name, S.cellR(i % 2)), cell(s.cost, S.cellN(i % 2)),
        ...(ex ? [cell(s.exec, S.cellN(i % 2, s.execLevel !== 'ok' && s.execLevel !== 'none')), cell(s.execDiff, S.cellN(i % 2, s.execLevel !== 'ok' && s.execLevel !== 'none'))] : [])]));
      if (g.unassignedCount) aoa.push([cell('—', S.cellR(0, true)), cell(`ללא שיוך לבית ספר (${g.unassignedCount} עובדים)`, S.cellR(0, true)), cell(g.unassignedCost, S.cellN(0, true))]);
      gc.shared.forEach((o) => aoa.push([cell('—', S.cellR(1)), cell(`${o.label} (אותה כרטסת, פרויקט אחר)`, S.cellR(1)), cell(o.cost, S.cellN(1))]));
      aoa.push([cell('סה"כ בתי הספר', S.totalR), cell('', S.totalR), cell(r2(g.totals.cost + gc.sharedCost), S.total), ...(ex ? [cell(g.execTotals.exec, S.total), cell(g.execTotals.diff, S.total)] : [])]);
      if (ex) { aoa.push([cell(execLineText(g), g.execTotals.bad.length ? S.bad : S.ok)]); mergeLast(); }
      aoa.push([cell(gc.level === 'ok' ? `✓ סך השכר בבתי הספר שווה לכרטסת (₪${fmt(gc.total)})` : `⚠ סך השכר בבתי הספר (₪${fmt(g.totals.cost + gc.sharedCost)}) אינו שווה לכרטסת (₪${fmt(gc.total)}) — הפרש ₪${fmt(gc.diff)}`, gc.level === 'ok' ? S.ok : S.bad)]); mergeLast();
    } else {
      const ex = !!g.execTotals;
      aoa.push([cell('סמל מוסד', S.head), cell('שם בית הספר', S.head), cell('כרטסת שכר', S.head), cell('דוח עלות', S.head), cell('הפרש', S.head), ...(ex ? [cell('דוח ביצוע (קובץ המשרד)', S.head), cell('הפרש מול הצפוי', S.head)] : []), cell('מצב', S.head)]);
      g.schools.forEach((s, i) => {
        const bad = s.level === 'warn' || s.level === 'err';
        const exBad = s.execLevel !== 'ok' && s.execLevel !== 'none';
        aoa.push([cell(s.symbol, S.cellR(i % 2, bad)), cell(s.name, S.cellR(i % 2, bad)), cell(s.ledger, S.cellN(i % 2, bad)), cell(s.cost, S.cellN(i % 2, bad)), cell(s.diff, S.cellN(i % 2, bad)),
          ...(ex ? [cell(s.exec, S.cellN(i % 2, exBad)), cell(s.execDiff, S.cellN(i % 2, exBad))] : []), cell(statusHe(s.level), S.cellR(i % 2, bad))]);
      });
      if (g.unassignedCount) aoa.push([cell('—', S.cellR(0, true)), cell(`ללא שיוך לבית ספר (${g.unassignedCount} עובדים)`, S.cellR(0, true)), cell('', S.cellR(0, true)), cell(g.unassignedCost, S.cellN(0, true)), cell('', S.cellR(0, true)), ...(ex ? [cell('', S.cellR(0, true)), cell('', S.cellR(0, true))] : []), cell('לשייך במסך ההכנה', S.cellR(0, true))]);
      aoa.push([cell('סה"כ', S.totalR), cell('', S.totalR), cell(g.totals.direct, S.total), cell(g.totals.cost, S.total), cell(r2(g.totals.direct - g.totals.cost), S.total), ...(ex ? [cell(g.execTotals.exec, S.total), cell(g.execTotals.diff, S.total)] : []), cell('', S.totalR)]);
      if (ex) { aoa.push([cell(execLineText(g), g.execTotals.bad.length ? S.bad : S.ok)]); mergeLast(); }
      if (g.generalCheck) {
        const gc = g.generalCheck;
        aoa.push([cell(`כרטיסי שכר כלליים: ${gc.cards.map((c) => `${c.name} (${c.key}) ₪${fmt(c.net)}`).join(' · ')} — סה"כ ₪${fmt(gc.total)} מול ${coversHe(gc)} ₪${fmt(gc.expected)}`, S.meta)]); mergeLast();
        aoa.push([cell(gc.level === 'ok' ? '✓ הכרטיסים הכלליים תואמים ליתרה' : `⚠ הפרש ₪${fmt(gc.diff)} בין הכרטיסים הכלליים ליתרה`, gc.level === 'ok' ? S.ok : S.bad)]); mergeLast();
      }
      const tl = levelOf(g.totals.diff, g.totals.cost);
      aoa.push([cell(tl === 'ok' ? `✓ סה"כ כרטסות השכר ₪${fmt(g.totals.ledger)} = דוח העלות ₪${fmt(g.totals.cost)}` : `⚠ סה"כ כרטסות השכר ₪${fmt(g.totals.ledger)} מול דוח העלות ₪${fmt(g.totals.cost)} — הפרש ₪${fmt(g.totals.diff)}`, tl === 'ok' ? S.ok : S.bad)]); mergeLast();
    }
    // עובדים מדוח העלות שלא נמצאו בדוח הביצוע (לשונית כח האדם)
    if (g.missing && g.missing.length) {
      aoa.push([]);
      aoa.push([cell(`⚠ ${g.missing.length} ${g.missing.length === 1 ? 'עובד/ת מדוח העלות עדיין לא נמצא/ת' : 'עובדים מדוח העלות עדיין לא נמצאים'} בקובץ המשרד השמור במערכת ("${(d.report && d.report.budget_file_name) || 'קובץ המשרד'}", לשונית כח האדם) — ₪${fmt(g.missingCost)} עלות מעביד. הקובץ השמור ישן יותר מדוח העלות; הורדת דוח ביצוע מעודכן מהמערכת תכניס אותם.`, S.bad)]); mergeLast();
      aoa.push([cell('בית ספר', S.head), cell('שם העובד/ת', S.head), cell('ת.ז', S.head), cell('מחלקה בדוח העלות', S.head), cell('שעות', S.head), cell('עלות מעביד', S.head)]);
      g.missing.forEach((w, i) => aoa.push([cell(`${w.school}${w.symbol ? ` (${w.symbol})` : ''}`, S.cellR(i % 2)), cell(w.name, S.cellR(i % 2)), cell(w.empId, S.cellR(i % 2)), cell(w.dept, S.cellR(i % 2)), cell(w.hours, S.cellN(i % 2)), cell(w.cost, S.cellN(i % 2))]));
    } else if (d.hasFileWorkers) {
      aoa.push([cell('✓ כל העובדים מדוח העלות נמצאים בקובץ המשרד השמור (לשונית כח האדם)', S.ok)]); mergeLast();
    }
    aoa.push([]);
    aoa.push([cell('איך שויך כל כרטיס', S.sub)]); mergeLast();
    aoa.push([cell('מפתח חשבון', S.head), cell('כרטסת', S.head), cell('נטו', S.head), cell('שיוך', S.head)]);
    g.cards.forEach((c, i) => aoa.push([cell(c.key, S.cellR(i % 2)), cell(c.name, S.cellR(i % 2)), cell(c.net, S.cellN(i % 2)),
      cell(c.attribution === 'school' ? `${c.schoolName} (${c.symbol}) — ${c.method === 'manual' ? 'שיוך ידני' : 'לפי השם'}`
        : c.attribution === 'split' ? `מפוצל לפי סמל באסמכתא: ${c.parts.map((p) => `${p.name || p.symbol} ₪${fmt(p.amount)}`).join(', ')}`
        : 'כללי — לכל בתי הספר', S.cellR(i % 2))]));
    aoa.push([]);
  }

  const ws = XLSXS.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 13 }, { wch: 36 }, { wch: 15 }, { wch: 15 }, { wch: 13 }, { wch: 18 }, { wch: 15 }, { wch: 18 }];
  ws['!merges'] = merges;
  const wb = XLSXS.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSXS.utils.book_append_sheet(wb, ws, 'התאמת שכר לבתי ספר');
  return XLSXS.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/* ---------- מסמך "התאמת כרטסות משותפות לסמלי מוסד" (רעות 18.10, ביתר) ----------
   למעלה: מספרי הכרטסות שמתפרסות על כמה בתי ספר והסה"כ שלהן; מתחת: סמלי המוסד
   והסכום המשויך לכל אחד; בסוף: סה"כ שתואם לסה"כ הכרטסות. */
function sharedCardsGroups(d) {
  const out = [];
  for (const g of d.groups || []) {
    const pre = g.payer ? `${g.payer}: ` : '';
    const push = (title, cards, rows, note) => {
      const cardsTotal = r2(cards.reduce((s, c) => s + (c.net || 0), 0));
      const rowsTotal = r2(rows.reduce((s, r) => s + (r.amount || 0), 0));
      out.push({ title: pre + title, cards, rows, note: note || null, cardsTotal, rowsTotal, diff: r2(rowsTotal - cardsTotal) });
    };
    if (g.mode === 'single' && g.generalCheck) {
      const gc = g.generalCheck;
      const rows = g.schools.map((s) => ({ symbol: s.symbol, name: s.name, amount: s.cost }));
      if (g.unassignedCount) rows.push({ symbol: '—', name: `ללא שיוך לבית ספר (${g.unassignedCount} עובדים)`, amount: g.unassignedCost });
      for (const o of gc.shared) rows.push({ symbol: '—', name: `${o.label} (אותה כרטסת, פרויקט אחר)`, amount: o.cost });
      push('כרטסת שכר אחת לכל בתי הספר', gc.cards, rows);
    }
    for (const c of g.cards) {
      if (c.attribution !== 'split') continue;
      const rows = c.parts.map((p) => ({ symbol: p.symbol, name: p.name, amount: p.amount }));
      push('כרטיס מפוצל לפי סמל המוסד באסמכתא', [c], rows, c.unassigned ? `${c.unassigned.count} תנועות ללא סמל באסמכתא (₪${fmt(c.unassigned.amount)}) — לא משויכות` : null);
    }
    if (g.mode === 'mixed' && g.generalCheck) {
      const gc = g.generalCheck;
      // אותו בסיס כמו בבדיקת הכרטיסים הכלליים: 'all' — יתרת השכר בכל בית ספר
      // שהכרטיס הייעודי שלו קטן מדוח העלות; 'noCard' — כל השכר בבתי ספר בלי כרטיס
      const rows = (gc.pattern === 'all'
        ? g.schools.filter((s) => s.remainder > 0).map((s) => ({ symbol: s.symbol, name: s.name, amount: s.remainder }))
        : g.schools.filter((s) => s.ledger === 0).map((s) => ({ symbol: s.symbol, name: s.name, amount: s.cost })));
      if (g.unassignedCount) rows.push({ symbol: '—', name: `ללא שיוך לבית ספר (${g.unassignedCount} עובדים)`, amount: g.unassignedCost });
      push('כרטיסים כלליים — ' + (gc.pattern === 'all' ? 'השכר שאינו מכוסה בכרטיסים הייעודיים של בתי הספר' : 'השכר בבתי הספר ללא כרטיס ייעודי'), gc.cards, rows,
        gc.pattern === 'all' ? 'הסכום לכל בית ספר = השכר בדוח העלות פחות הכרטיס הייעודי שלו' : 'הסכום לכל בית ספר = השכר בדוח העלות (אין לו כרטיס ייעודי)');
    }
  }
  return out;
}

function renderSharedCardsHtml(d) {
  const today = new Date().toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
  const clientName = (d.client && d.client.name) || '';
  const authorityName = (d.authority && d.authority.name) || '';
  const who = authorityName && authorityName !== clientName ? `${clientName} — ${authorityName}` : clientName;
  const label = reportLabel(d.report.framework, d.report.program);
  const groups = sharedCardsGroups(d);
  const blocks = groups.map((it) => `<section class="block">
    <h2>${esc(it.title)}</h2>
    <table class="cards"><thead><tr><th>מפתח חשבון</th><th>כרטסת</th><th class="num">סה"כ בכרטסת</th></tr></thead><tbody>
      ${it.cards.map((c) => `<tr><td>${esc(c.key)}</td><td>${esc(c.name)}</td><td class="num">₪${fmt(c.net)}</td></tr>`).join('')}
      <tr class="total"><td colspan="2">סה"כ בכרטסות</td><td class="num">₪${fmt(it.cardsTotal)}</td></tr>
    </tbody></table>
    <table><thead><tr><th>סמל מוסד</th><th>שם בית הספר</th><th class="num">סכום משויך</th></tr></thead><tbody>
      ${it.rows.map((r, i) => `<tr${i % 2 ? ' class="z"' : ''}><td>${esc(r.symbol)}</td><td>${esc(r.name)}</td><td class="num">₪${fmt(r.amount)}</td></tr>`).join('')}
      <tr class="total"><td colspan="2">סה"כ משויך לסמלי המוסד</td><td class="num">₪${fmt(it.rowsTotal)}</td></tr>
    </tbody></table>
    <div class="check ${Math.abs(it.diff) <= 1 ? 'ok' : levelOf(it.diff, it.cardsTotal) === 'ok' ? 'warn' : 'err'}">${Math.abs(it.diff) <= 1 ? '✓ סה"כ המשויך תואם לסה"כ הכרטסות.' : `הפרש ₪${fmt(it.diff)} בין המשויך לסה"כ הכרטסות${levelOf(it.diff, it.cardsTotal) === 'ok' ? ' (זניח)' : ''}.`}</div>
    ${it.note ? `<div class="note">${esc(it.note)}</div>` : ''}
  </section>`).join('');
  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<title>התאמת כרטסות משותפות לסמלי מוסד — ${esc(who)} — ${esc(label)}</title>
<style>
  body{font-family:'Segoe UI',Arial,sans-serif;color:#37322A;max-width:820px;margin:0 auto;padding:30px;line-height:1.7;font-size:13.5px}
  h1{font-size:19px;margin:14px 0 2px} h2{font-size:14.5px;color:#9A7B2F;margin:0 0 8px}
  .letterhead{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #9A7B2F;padding-bottom:8px;font-size:12.5px;color:#7A7062}
  .sub{font-size:12.5px;color:#7A7062;margin-bottom:18px}
  .block{border:1px solid #EAE1CF;border-radius:10px;padding:14px 18px;margin-bottom:16px;background:#FDFBF6;page-break-inside:avoid}
  table{width:100%;border-collapse:collapse;font-size:12.5px;margin:6px 0 10px}
  table.cards{background:#FAF6EE}
  th{background:#9A7B2F;color:#fff;text-align:right;padding:6px 10px;font-size:12px} th.num,td.num{text-align:center}
  td{border-bottom:1px solid #EAE1CF;padding:6px 10px} tr.z td{background:#FBF7EC}
  tr.total td{background:#F4ECDA;font-weight:700;border-top:2px solid #9A7B2F}
  .check{font-size:12.5px;font-weight:600} .check.ok{color:#4C7A45}.check.warn{color:#A8711E}.check.err{color:#B3362B}
  .note{font-size:12px;color:#7A7062;margin-top:4px}
  @media print { body{padding:10px} }
</style></head><body>
<div class="letterhead"><span><b>גוטליב את ביטון, רו"ח</b></span><span>${today}</span></div>
<h1>התאמת כרטסות שכר משותפות לסמלי מוסד</h1>
<div class="sub">${esc(who)} · ${esc(label)} · כרטסות שמתפרסות על כמה בתי ספר, והסכום המשויך לכל סמל מוסד (עלות מעביד בספרים, נטו)</div>
${!d.applicable ? '<p>בגנים הדיווח מרוכז לכל הגנים — אין חלוקה לפי מוסד.</p>'
  : !d.hasCards ? '<p>לא נקלטו כרטסות שכר לדוח זה.</p>'
  : !groups.length ? '<p>לכל בית ספר כרטסת שכר ייעודית משלו — אין כרטסות משותפות לחלק.</p>'
  : blocks}
</body></html>`;
}

function buildSharedCardsXlsx(d) {
  const GOLD = '9A7B2F', CHAMP = 'F4ECDA', SOFT = 'FBF7EC', LINE = 'D9CDB3', INK = '37322A';
  const border = { top: { style: 'thin', color: { rgb: LINE } }, bottom: { style: 'thin', color: { rgb: LINE } }, left: { style: 'thin', color: { rgb: LINE } }, right: { style: 'thin', color: { rgb: LINE } } };
  const S = {
    title: { font: { bold: true, sz: 14, color: { rgb: INK } }, alignment: { horizontal: 'right' } },
    sub: { font: { bold: true, sz: 11, color: { rgb: GOLD } }, alignment: { horizontal: 'right' } },
    head: { font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: GOLD } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border },
    cellR: (z) => ({ font: { sz: 10, color: { rgb: INK } }, alignment: { horizontal: 'right' }, border, ...(z ? { fill: { fgColor: { rgb: SOFT } } } : {}) }),
    cellN: (z) => ({ font: { sz: 10, color: { rgb: INK } }, alignment: { horizontal: 'center' }, border, numFmt: '#,##0.00', ...(z ? { fill: { fgColor: { rgb: SOFT } } } : {}) }),
    total: { font: { bold: true, sz: 10, color: { rgb: INK } }, fill: { fgColor: { rgb: CHAMP } }, alignment: { horizontal: 'center' }, border, numFmt: '#,##0.00' },
    totalR: { font: { bold: true, sz: 10, color: { rgb: INK } }, fill: { fgColor: { rgb: CHAMP } }, alignment: { horizontal: 'right' }, border },
    ok: { font: { bold: true, sz: 10, color: { rgb: '4C7A45' } } }, bad: { font: { bold: true, sz: 10, color: { rgb: 'B3362B' } } },
  };
  const cell = (v, s) => ({ v: v == null ? '' : v, t: typeof v === 'number' ? 'n' : 's', s });
  const clientName = (d.client && d.client.name) || '';
  const authorityName = (d.authority && d.authority.name) || '';
  const who = authorityName && authorityName !== clientName ? `${clientName} — ${authorityName}` : clientName;
  const aoa = [[cell('התאמת כרטסות שכר משותפות לסמלי מוסד', S.title)], [cell(`${who} — ${reportLabel(d.report.framework, d.report.program)} · ${new Date().toLocaleDateString('he-IL')}`, S.sub)], []];
  const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 2 } }];
  const mergeLast = () => merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: 2 } });
  for (const it of sharedCardsGroups(d)) {
    aoa.push([cell(it.title, S.sub)]); mergeLast();
    aoa.push([cell('מפתח חשבון', S.head), cell('כרטסת', S.head), cell('סה"כ בכרטסת', S.head)]);
    it.cards.forEach((c, i) => aoa.push([cell(c.key, S.cellR(i % 2)), cell(c.name, S.cellR(i % 2)), cell(c.net, S.cellN(i % 2))]));
    aoa.push([cell('סה"כ בכרטסות', S.totalR), cell('', S.totalR), cell(it.cardsTotal, S.total)]);
    aoa.push([]);
    aoa.push([cell('סמל מוסד', S.head), cell('שם בית הספר', S.head), cell('סכום משויך', S.head)]);
    it.rows.forEach((r, i) => aoa.push([cell(r.symbol, S.cellR(i % 2)), cell(r.name, S.cellR(i % 2)), cell(r.amount, S.cellN(i % 2))]));
    aoa.push([cell('סה"כ משויך לסמלי המוסד', S.totalR), cell('', S.totalR), cell(it.rowsTotal, S.total)]);
    aoa.push([cell(Math.abs(it.diff) <= 1 ? '✓ סה"כ המשויך תואם לסה"כ הכרטסות' : `הפרש ₪${fmt(it.diff)} בין המשויך לסה"כ הכרטסות`, Math.abs(it.diff) <= 1 ? S.ok : S.bad)]); mergeLast();
    if (it.note) { aoa.push([cell(it.note, S.cellR(0))]); mergeLast(); }
    aoa.push([]);
  }
  const ws = XLSXS.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 16 }, { wch: 44 }, { wch: 16 }];
  ws['!merges'] = merges;
  const wb = XLSXS.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSXS.utils.book_append_sheet(wb, ws, 'כרטסות משותפות');
  return XLSXS.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { salaryMatchData, renderSalaryMatchHtml, buildSalaryMatchXlsx, sharedCardsGroups, renderSharedCardsHtml, buildSharedCardsXlsx };
