/* מכתב שלב 1 ללקוח — מופק לכל פרויקט (דוח) בנפרד:
   פתיחה (מה נבדק ומסגרת הבדיקות) → נקודות חשובות → פירוט הבקרות →
   טבלת יעדי כרטסות ברורה: שכר / ארוחת בוקר / העשרה / הכנסות משתתפים —
   בתי"ס פר סמל מוסד, גנים במרוכז. מוגש כדף HTML להדפסה/PDF. */

const { costDataForReport } = require('./reportCosts');
const { salaryCheck } = require('./salaryCheck');
const { recommendations } = require('./recommend');
const { matchDeptsToInstitutions } = require('./nameMatch');
const { reportLabel } = require('./domain');
const { recognizedRowCost, COST_MARKUP_LIMIT } = require('./ingest');

const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('he-IL'));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clientName = (client, authority) => (authority && authority.name) || (client && client.name) || 'המפעיל';

/* ---------- איסוף הנתונים ---------- */
async function stage1Data(db, report, client, authority) {
  const cost = await costDataForReport(db, report);

  // בקרות פר-עובד
  const collect = (re) => cost.rows
    .filter((r) => r.flags.some((f) => re.test(f.text)))
    .map((r) => ({ name: r.name || '—', id: r.id, dept: r.dept, issues: r.flags.filter((f) => re.test(f.text)).map((f) => f.text) }));
  const rateIssues = collect(/ברוטו שעתי מעל|עלות מעביד שעתית מעל|עלות מעביד נמוכה/);
  const hoursIssues = collect(/שעות מעל|חסרות שעות/);
  const idIssues = collect(/ת\.ז לא תקינה/);

  const salary = await salaryCheck(db, report);
  const recs = await recommendations(db, report);
  const hasVat = !!(client && client.has_vat);
  const vatFactor = hasVat ? 1.18 : 1;

  // עובדים שעלותם דווחה לפי תקרת ברוטו+40% (הנמוך מבין) — מידע, לא חריגה
  const cappedRows = cost.rows.filter((r) =>
    r.gross > 0 && r.cost != null && r.cost * vatFactor > r.gross * COST_MARKUP_LIMIT * 1.001);
  const cappedCount = cappedRows.length;
  const cappedReduction = cappedRows.reduce((s, r) => s + (r.cost * vatFactor - r.gross * COST_MARKUP_LIMIT), 0);
  const tariff = report.parent_tariff || 0;

  const insts = await db.prepare('SELECT * FROM institutions WHERE report_id = ? ORDER BY symbol').all(report.id);
  const basketsOf = async (instId) => {
    const m = {};
    (await db.prepare('SELECT basket_type, budget_amount FROM baskets WHERE institution_id = ?').all(instId))
      .forEach((b) => { m[b.basket_type] = (m[b.basket_type] || 0) + Number(b.budget_amount); });
    return m;
  };

  // שיוך שורות עלות לסמל (override ← התאמת שם, כמו במסך ההכנה) + המשלם מהקובץ
  const rows = await db.prepare(
    `SELECT cr.*, cf.payer FROM cost_rows cr JOIN cost_files cf ON cf.id = cr.cost_file_id WHERE cr.report_id = ?`
  ).all(report.id);
  const DEFAULT_PAYER = clientName(client, authority);
  // עמודות שכר נפרדות רק כשבאמת מוגדרים שני משלמים שונים
  const definedPayers = new Set(rows.map((r) => r.payer).filter(Boolean));
  const payers = definedPayers.size >= 2 ? [...new Set(rows.map((r) => r.payer || DEFAULT_PAYER))] : [DEFAULT_PAYER];
  const deptSymbol = report.framework !== 'gardens' && insts.length
    ? matchDeptsToInstitutions(insts, [...new Set(rows.map((r) => r.dept))])
    : {};
  const nameSymbol = insts.length
    ? matchDeptsToInstitutions(insts, [...new Set(rows.map((r) => r.inst_name).filter(Boolean))])
    : {};
  const rowSymbol = (r) => r.symbol_override || (r.inst_name && nameSymbol[r.inst_name]) || deptSymbol[r.dept] || null;

  const mkUnit = (name, symbol, baskets, salaryNet, salaryRecognized, children, salaryByPayer) => {
    // מול התקציב משווים את הניצול המוכר: עלות + מע"מ ללקוח חייב, מוגבל
    // פר-עובד לתקרת 140% מהברוטו (כמו בדיווח בפועל);
    // יעד הכרטסת נשאר נטו מלא — כך נרשם בהנהלת החשבונות
    const salaryActual = salaryRecognized;
    const salaryBudget = (baskets.instruction || 0) + (baskets.coordinator || 0) + (baskets.deputy || 0);
    const enrichB = baskets.enrichment || 0;
    const flexB = baskets.flexible || 0;
    const breakfastB = baskets.breakfast || 0;
    const salaryUnused = Math.max(0, salaryBudget - salaryActual);
    const overflow = Math.max(0, salaryActual - salaryBudget);
    // דוח הביצוע של המשרד בולע חריגת שכר בסל הגמיש אוטומטית — היתרה הזמינה
    // באמת לניצול (ארוחות בוקר/מלגות/גמיש) היא מה שנשאר אחרי הבליעה
    const flexConsumed = Math.min(overflow, flexB);
    const flexAvailable = Math.max(0, flexB - flexConsumed);
    // שורת "ארוחת בוקר" בקובץ המשרד היא ייעוד של הסל הגמיש (אותו סכום בדיוק),
    // לא תקציב נפרד — אין לספור פעמיים, והיתרה לארוחות בוקר = יתרת הסל הגמיש
    const breakfastPot = Math.abs(breakfastB - flexB) < 1 ? flexB : breakfastB + flexB;
    const breakfastAvailable = Math.max(0, breakfastPot - flexConsumed);
    // אופציה א: הסל הגמיש לארוחות בוקר/מלגות → תוספת העשרה = הנמוך מבין
    // 25% מתקציב ההעשרה לבין יתרת השכר שטרם נוצלה
    const enrichBonus = salaryUnused > 0 ? Math.min(0.25 * enrichB, salaryUnused) : 0;
    // חריגת שכר גדולה (מעבר לסל הגמיש): ממליצים להכיר ב-75% מתקציב ההעשרה
    // ולנתב 25% ממנו לכיסוי החריגה
    const uncovered = Math.max(0, overflow - flexConsumed);
    const enrichShift = uncovered > 0 && enrichB > 0 ? Math.min(0.25 * enrichB, uncovered) : 0;
    // יעדי הכרטסת רשומים תמיד נטו: התקציבים של המשרד מוכרים כולל מע"מ ללקוח
    // חייב, ולכן ההוצאה נטו בכרטסת = התקציב חלקי 1.18 (השכר ממילא נטו מהדוח)
    const net = (v) => Math.round((v / vatFactor) * 100) / 100;
    return {
      name, symbol, children: children || 0,
      salaryBudget, salaryActual, salaryUnused, overflow,
      enrichBudget: enrichB, flexBudget: flexB, breakfastBudget: breakfastB,
      flexConsumed, flexAvailable, uncovered, enrichShift,
      management: baskets.management || 0,
      optionA: { enrich: enrichB + enrichBonus, enrichBonus, flexForFood: flexAvailable },
      optionB: { enrich: enrichB, flexRemaining: flexAvailable },
      // יעדי הכרטסות (הטבלה המסכמת): שכר = דוח העלות (נטו); ארוחת בוקר = תקציב +
      // יתרת הסל הגמיש שנותרה אחרי בליעת חריגת השכר (בהנחת אופציה א');
      // העשרה = כולל התוספת; הכנסות = ילדים × תעריף. ללקוח חייב מע"מ — הכול נטו.
      targets: {
        salary: salaryNet, // יעד הכרטסת = העלות נטו (הכרטסת מתנהלת בלי מע"מ)
        salaryByPayer: salaryByPayer || {}, // הפרדה בין משלמים (מתנ"ס/רשות) כשקיימים שניים
        breakfast: net(breakfastAvailable),
        enrichment: net(enrichB + enrichBonus),
        // אופציית 75% — הכרה מופחתת בהעשרה כשקיימת חריגת שכר לא מכוסה
        enrichmentReduced: net(enrichB - enrichShift),
        income: children && tariff ? Math.round((children * tariff / vatFactor) * 100) / 100 : 0,
      },
    };
  };

  const payerSplit = (rowsSubset) => {
    const m = {};
    rowsSubset.forEach((r) => { const p = r.payer || DEFAULT_PAYER; m[p] = (m[p] || 0) + (r.cost || 0); });
    return m;
  };

  let units = [];
  if (report.framework === 'gardens') {
    const baskets = {};
    let kids = 0;
    for (const i of insts) {
      kids += i.children_count || 0;
      const b = await basketsOf(i.id);
      Object.entries(b).forEach(([k, v]) => { baskets[k] = (baskets[k] || 0) + v; });
    }
    const recognized = rows.reduce((s, r) => s + recognizedRowCost(r, vatFactor), 0);
    units = [mkUnit('כל הגנים (במרוכז)', null, baskets, cost.summary.totalCost, recognized, kids, payerSplit(rows))];
  } else {
    for (const i of insts) {
      const unitRows = rows.filter((r) => rowSymbol(r) === String(i.symbol));
      const actual = unitRows.reduce((s, r) => s + (r.cost || 0), 0);
      const recognized = unitRows.reduce((s, r) => s + recognizedRowCost(r, vatFactor), 0);
      units.push(mkUnit(i.name || i.symbol, String(i.symbol), await basketsOf(i.id), actual, recognized, i.children_count || 0, payerSplit(unitRows)));
    }
  }

  return {
    report, client, authority, cost, salary, recs, hasVat, tariff, payers,
    rateIssues, hoursIssues, idIssues, units, cappedCount, cappedReduction,
    label: reportLabel(report.framework, report.program),
    unassignedCost: report.framework !== 'gardens'
      ? rows.filter((r) => !rowSymbol(r)).reduce((s, r) => s + (r.cost || 0), 0)
      : 0,
  };
}

/* ---------- רינדור המכתב ---------- */
function issuesTable(list) {
  const rows = list.map((w) => `<tr><td>${esc(w.name)}</td><td dir="ltr">${esc(w.id)}</td><td>${esc(w.dept)}</td><td>${esc(w.issues.join(' · '))}</td></tr>`).join('');
  return `<table><thead><tr><th>עובד/ת</th><th>ת.ז</th><th>מחלקה</th><th>הממצא</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderStage1Html(d) {
  const today = new Date().toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
  const clientName = (d.client && d.client.name) || '';
  const authorityName = (d.authority && d.authority.name) || '';
  const to = authorityName && authorityName !== clientName ? `${clientName} — ${authorityName}` : clientName;

  /* --- נקודות חשובות (תמצית) --- */
  const highlights = [];
  if (d.rateIssues.length) highlights.push(`נמצאו <b>${d.rateIssues.length} עובדים</b> עם שכר לשעה מעל תקרת המשרד — יש לתקן לפני ההגשה (פירוט בסעיף 1).`);
  if (d.cappedCount > 0) highlights.push(`אצל <b>${d.cappedCount} עובדים</b> העלות השעתית עלתה על 140% מהברוטו — בדוח הביצוע דווח עבורם, בהתאם לכלל, <b>הנמוך מבין</b> העלות${d.hasVat ? ' כולל מע"מ' : ''} לבין ברוטו + 40% (הפחתה כוללת של ₪${fmt(d.cappedReduction)}; הפירוט בדוח ההתאמה לדוח העלות).`);
  if (d.hoursIssues.length) highlights.push(`נמצאו <b>${d.hoursIssues.length} עובדים</b> עם כמות שעות הדורשת בדיקה (פירוט בסעיף 2).`);
  if (d.idIssues.length) highlights.push(`נמצאו <b>${d.idIssues.length} עובדים</b> עם תעודת זהות שאינה תקינה (פירוט בסעיף 1).`);
  const hasOverflow = d.units.some((u) => u.overflow > 0) || (d.recs && d.recs.relevant && (d.recs.moves || []).length > 0);
  if (hasOverflow) highlights.push(`קיימת <b>חריגת שכר</b> מול התקציב — מצורפות המלצות לניוד דיווח בין מוסדות (סעיף 3).`);
  if (d.units.some((u) => u.enrichShift > 0))
    highlights.push(`בשל היקף חריגת השכר אנו ממליצים <b>להכיר ב-75% מתקציב ההעשרה</b> ולנתב 25% ממנו לכיסוי החריגה — פירוט והשוואת האופציות בסעיפים 4–5.`);
  const totalUnused = d.units.reduce((s, u) => s + u.salaryUnused, 0);
  if (totalUnused > 1000) highlights.push(`קיימות <b>יתרות תקציב לניצול</b> בסך כ-₪${fmt(totalUnused)} בשכר — ראו יתרות ההעשרה והסל הגמיש (סעיף 4).`);
  if (!highlights.length) highlights.push('כל הבדיקות עברו תקין — ניתן להתקדם לשלב הכרטסות.');

  /* --- סעיף 1+2: בקרות פר-עובד --- */
  const cappedNote = d.cappedCount > 0
    ? `<p class="note">ℹ אצל ${d.cappedCount} עובדים העלות השעתית${d.hasVat ? ' (כולל מע"מ)' : ''} עלתה על 140% מהברוטו השעתי. בהתאם לכלל הדיווח, בדוח הביצוע נרשמה עבורם העלות <b>הנמוכה מבין</b> העלות בפועל${d.hasVat ? ' בתוספת מע"מ' : ''} לבין הברוטו בתוספת 40% — סה"כ הפחתה של ₪${fmt(d.cappedReduction)}. הפירוט המלא מצורף ב"דוח ההתאמה לדוח עלות".</p>`
    : '';
  const sec1 = (d.rateIssues.length || d.idIssues.length
    ? `${issuesTable([...d.rateIssues, ...d.idIssues])}
       <p class="note">שכר מעל התקרה לא יוכר ע"י המשרד — מומלץ לתקן את הדיווח או לעדכן את חלוקת השעות.</p>`
    : `<p class="okline">✓ כל העובדים נמצאים בתקרות התעריף של המשרד (ברוטו לשעה ועלות לשעה) — תקין.</p>`) + cappedNote;
  const sec2 = d.hoursIssues.length
    ? issuesTable(d.hoursIssues)
    : `<p class="okline">✓ כמות השעות של כל העובדים בטווח התקין — תקין.</p>`;

  /* --- סעיף 3: תקציב מול ביצוע + ניוד --- */
  let sec3;
  if (d.recs && d.recs.relevant && (d.recs.moves || []).length) {
    const rws = d.recs.moves.map((m) =>
      `<tr><td>${esc(m.name)}</td><td>₪${fmt(m.cost)}</td><td>${esc(m.fromName || m.from)} (${esc(m.from)})</td><td>${esc(m.toName || m.to)} (${esc(m.to)})</td><td>₪${fmt(m.reduces)}</td></tr>`).join('');
    sec3 = `<p>בהשוואת עלות השכר בפועל מול תקציב השכר והסל הגמיש של כל מוסד, נמצאה חריגה. כדי למצות את התקציב אנו ממליצים לנייד את דיווח העובדים הבאים:</p>
    <table><thead><tr><th>עובד/ת</th><th>עלות</th><th>מסמל מוסד</th><th>לסמל מוסד</th><th>מקטין חריגה ב-</th></tr></thead><tbody>${rws}</tbody></table>
    <p class="note">נבקש את אישורכם להעברות; לאחר האישור דוח העלות יעודכן בהתאם.</p>`;
  } else if (hasOverflow) {
    sec3 = `<p>קיימת חריגת שכר מול התקציב (ראו פירוט היתרות בסעיף 4). חלק מהחריגה נבלע בסל הגמיש; יתרה שאינה מכוסה לא תוכר ע"י המשרד.</p>`;
  } else {
    sec3 = `<p class="okline">✓ עלות השכר בפועל נמצאת בגבולות התקציב — אין חריגה.</p>`;
  }

  /* --- סעיף 4: יתרות (שתי אופציות הסל הגמיש) — תצוגה מילולית ברורה --- */
  const unitOptions = d.units.map((u) => {
    const title = u.symbol ? `${esc(u.name)} — סמל ${esc(u.symbol)}` : esc(u.name);
    const salaryLine = u.overflow > 0
      ? `בשכר נוצלו <b>₪${fmt(u.salaryActual)}</b> מתוך תקציב של ₪${fmt(u.salaryBudget)} — <span class="red">חריגה של ₪${fmt(u.overflow)}</span>${u.flexConsumed > 0 ? `, ממנה ₪${fmt(u.flexConsumed)} נבלעים אוטומטית בסל הגמיש` : ''}${u.overflow > u.flexConsumed ? ` <span class="red">(₪${fmt(u.overflow - u.flexConsumed)} נותרים ללא כיסוי ולא יוכרו)</span>` : ''}.`
      : u.salaryUnused > 0
        ? `בשכר נוצלו <b>₪${fmt(u.salaryActual)}</b> מתוך תקציב של ₪${fmt(u.salaryBudget)} — נותרה יתרה של <b class="green">₪${fmt(u.salaryUnused)}</b>.`
        : `השכר נוצל במלואו: ₪${fmt(u.salaryActual)} מתוך ₪${fmt(u.salaryBudget)}.`;
    // כשהסל הגמיש נבלע כולו בחריגת השכר — אין שתי אופציות, רק מצב נתון
    const optionsBlock = u.flexAvailable <= 0 && u.overflow > 0
      ? `<div class="opt" style="flex:none">
          <div class="opt-title">הסל הגמיש נוצל במלואו על ידי השכר</div>
          <ul>
            <li>עלות השכר עלתה על תקציב השכר, ולכן הסל הגמיש (₪${fmt(u.flexBudget)}) נוצל <b>במלואו</b> לכיסוי עלויות השכר — לא נותרה בו יתרה לארוחות בוקר, מלגות או שימוש אחר.</li>
            ${u.enrichShift > 0
              ? `<li><b>המלצתנו:</b> להכיר בהעשרה ב-<b>75% מהתקציב</b> בלבד (₪${fmt(u.enrichBudget - u.enrichShift)}) ולנתב ₪${fmt(u.enrichShift)} לכיסוי חריגת השכר — כך החריגה שאינה מוכרת קטנה מ-₪${fmt(u.uncovered)} ל-<b>₪${fmt(u.uncovered - u.enrichShift)}</b>. לחלופין ניתן לנצל את מלוא ההעשרה (₪${fmt(u.enrichBudget)}) ולהותיר את מלוא החריגה ללא כיסוי — שתי האופציות מוצגות בטבלת היעדים בסעיף 5.</li>`
              : `<li>העשרה: עד <b>₪${fmt(u.optionB.enrich)}</b> <span class="soft">(לפי התקציב)</span></li>`}
          </ul>
        </div>`
      : `<div class="opts">
      <div class="opt">
        <div class="opt-title">אופציה א' — הסל הגמיש ינוצל לארוחות בוקר ומלגות</div>
        <ul>
          <li>ארוחות בוקר ומלגות: עד <b>₪${fmt(u.optionA.flexForFood)}</b> ${u.flexConsumed > 0 ? `<span class="soft">(יתרת הסל הגמיש אחרי כיסוי חריגת השכר)</span>` : '(מלוא הסל הגמיש)'}</li>
          <li>העשרה: עד <b>₪${fmt(u.optionA.enrich)}</b>${u.optionA.enrichBonus > 0
            ? `<br><span class="soft">(תקציב ₪${fmt(u.enrichBudget)} + תוספת 25% בסך ₪${fmt(u.optionA.enrichBonus)}, המתאפשרת בזכות יתרת השכר)</span>`
            : ` <span class="soft">(לפי התקציב)</span>`}</li>
        </ul>
      </div>
      <div class="opt">
        <div class="opt-title">אופציה ב' — הסל הגמיש יישאר גמיש</div>
        <ul>
          <li>העשרה: עד <b>₪${fmt(u.optionB.enrich)}</b> <span class="soft">(לפי התקציב)</span></li>
          <li>יתרת סל גמיש זמינה: <b>₪${fmt(u.optionB.flexRemaining)}</b>${u.flexConsumed > 0 ? ` <span class="soft">(אחרי כיסוי חריגת השכר)</span>` : ''}</li>
        </ul>
      </div>
    </div>`;
    return `<h3>${title}</h3>
    <p class="salaryline">${salaryLine}</p>
    ${optionsBlock}`;
  }).join('');

  /* --- סעיף 5: טבלת יעדי הכרטסות --- */
  const anyBreakfast = d.units.some((u) => u.targets.breakfast > 0);
  const anyIncome = d.units.some((u) => u.targets.income > 0);
  // חריגת שכר לא מכוסה → שתי אופציות להעשרה: 100% מהתקציב או 75% (מומלץ —
  // 25% מנותבים לכיסוי החריגה)
  const anyShift = d.units.some((u) => u.enrichShift > 0);
  const enrichCols = anyShift ? ['העשרה — אופציה מומלצת: 75%', 'העשרה — 100%'] : ['העשרה'];
  const enrichCells = (u) => anyShift
    ? [`₪${fmt(u.targets.enrichmentReduced)}`, `₪${fmt(u.targets.enrichment)}`]
    : [`₪${fmt(u.targets.enrichment)}`];
  // כשיש שני משלמים (מתנ"ס/חברה + רשות) — עמודת שכר נפרדת לכל משלם,
  // כי הכרטסות מתנהלות בספרים נפרדים
  const multiPayer = (d.payers || []).length > 1;
  const salaryCols = multiPayer ? d.payers.map((p) => `שכר — ${esc(p)}`) : ['שכר'];
  const headCols = [...salaryCols, ...(anyBreakfast ? ['ארוחת בוקר'] : []), ...enrichCols, ...(anyIncome ? ['הכנסות משתתפים'] : [])];
  const salaryCells = (u) => multiPayer
    ? d.payers.map((p) => (u.targets.salaryByPayer[p] ? `₪${fmt(u.targets.salaryByPayer[p])}` : '—'))
    : [`₪${fmt(u.targets.salary)}`];
  const unitRow = (u) => {
    const cells = [
      ...salaryCells(u),
      ...(anyBreakfast ? [u.targets.breakfast > 0 ? `₪${fmt(u.targets.breakfast)}` : '—'] : []),
      ...enrichCells(u),
      ...(anyIncome ? [u.targets.income > 0 ? `₪${fmt(u.targets.income)}` : '—'] : []),
    ];
    const name = u.symbol ? `${esc(u.name)} <span class="soft">(${esc(u.symbol)})</span>` : esc(u.name);
    return `<tr><td>${name}</td>${cells.map((c) => `<td class="num">${c}</td>`).join('')}</tr>`;
  };
  let totalsRow = '';
  if (d.units.length > 1) {
    const t = d.units.reduce((a, u) => {
      (d.payers || []).forEach((p) => { a.byPayer[p] = (a.byPayer[p] || 0) + (u.targets.salaryByPayer[p] || 0); });
      return {
        byPayer: a.byPayer,
        salary: a.salary + u.targets.salary, breakfast: a.breakfast + u.targets.breakfast,
        enrichment: a.enrichment + u.targets.enrichment,
        enrichmentReduced: a.enrichmentReduced + u.targets.enrichmentReduced,
        income: a.income + u.targets.income,
      };
    }, { byPayer: {}, salary: 0, breakfast: 0, enrichment: 0, enrichmentReduced: 0, income: 0 });
    const sc = multiPayer ? d.payers.map((p) => `₪${fmt(t.byPayer[p] || 0)}`) : [`₪${fmt(t.salary)}`];
    const ec = anyShift ? [`₪${fmt(t.enrichmentReduced)}`, `₪${fmt(t.enrichment)}`] : [`₪${fmt(t.enrichment)}`];
    const cells = [...sc, ...(anyBreakfast ? [`₪${fmt(t.breakfast)}`] : []), ...ec, ...(anyIncome ? [`₪${fmt(t.income)}`] : [])];
    totalsRow = `<tr class="total"><td>סה"כ</td>${cells.map((c) => `<td class="num">${c}</td>`).join('')}</tr>`;
  }
  const targetsTable = `<table class="targets">
    <thead><tr><th>${d.units.length > 1 ? 'בית ספר' : 'מסגרת'}</th>${headCols.map((h) => `<th class="num">${h}</th>`).join('')}</tr></thead>
    <tbody>${d.units.map(unitRow).join('')}${totalsRow}</tbody>
  </table>
  <p class="note">שכר — בהתאם לדוח עלות השכר שנבדק${multiPayer ? ', בהפרדה לפי המשלם (כרטסת נפרדת בספרי כל משלם)' : ''}. ארוחת בוקר — התקציב בתוספת יתרת הסל הגמיש שנותרה אחרי בליעת חריגת השכר (בהנחת אופציה א'); אם יוחלט אחרת, ראו סעיף 4. העשרה — כולל תוספת 25% היכן שקיימת יתרת שכר${anyShift ? '; בשל חריגת השכר מוצגות שתי אופציות — 75% מהתקציב (מומלץ: 25% מנותבים לכיסוי חריגת השכר) או 100% מהתקציב (החריגה נותרת ללא כיסוי)' : ''}. הכנסות משתתפים — כמות הילדים בדוח הביצוע × תעריף המשרד${d.tariff ? ` (₪${fmt(d.tariff)} לילד)` : ''}.${d.hasVat ? ' <b>כל היעדים בטבלה רשומים נטו, ללא מע"מ</b> — כפי שנרשם בכרטסת; בדוח הביצוע למשרד הסכומים מדווחים בתוספת מע"מ 18%.' : ''}</p>`;

  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<title>מכתב שלב 1 — ${esc(to)} — ${esc(d.label)}</title>
<style>
  body{font-family:'Segoe UI',Arial,sans-serif;color:#182A33;max-width:880px;margin:0 auto;padding:30px;line-height:1.7;font-size:13.5px}
  h1{font-size:19px;margin:16px 0 4px}
  h2{font-size:15px;color:#17656D;margin-top:26px;margin-bottom:6px}
  h3{font-size:13.5px;margin:16px 0 4px;color:#17656D}
  .letterhead{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #17656D;padding-bottom:8px;font-size:12.5px;color:#4A5D66}
  .subject{background:#F5F7F6;border-radius:8px;padding:10px 16px;margin:14px 0;font-size:14px}
  table{width:100%;border-collapse:collapse;font-size:12.5px;margin:8px 0}
  th{background:#E3EFEF;text-align:right;padding:6px 10px;font-size:12px}
  td{border-bottom:1px solid #DCE4E2;padding:6px 10px;vertical-align:top}
  th.num,td.num{text-align:center}
  .center{text-align:center}
  table.targets th{background:#17656D;color:#fff}
  tr.total td{background:#E3EFEF;font-weight:700;border-top:2px solid #17656D}
  .okline{color:#1E6B3C;font-weight:600}
  .red{color:#B3261E;font-weight:600}.green{color:#1E6B3C}.soft{color:#4A5D66;font-size:11.5px;font-weight:400}
  .salaryline{margin:4px 0 8px}
  .opts{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
  .opt{flex:1 1 300px;border:1px solid #DCE4E2;border-radius:9px;padding:10px 16px;background:#F5F7F6}
  .opt-title{font-weight:700;color:#17656D;font-size:12.5px;border-bottom:1px solid #DCE4E2;padding-bottom:5px;margin-bottom:6px}
  .opt ul{margin:0;padding-inline-start:18px}
  .opt li{margin-bottom:5px}
  .note{font-size:11.5px;color:#4A5D66;background:#F5F7F6;border-radius:6px;padding:7px 11px;line-height:1.6}
  ul.points{margin:6px 0;padding-inline-start:22px}
  ul.points li{margin-bottom:4px}
  .closing{margin-top:26px}
  .footer{margin-top:26px;font-size:11px;color:#4A5D66;border-top:1px solid #DCE4E2;padding-top:8px}
  .printbtn{position:fixed;top:14px;left:14px;background:#17656D;color:#fff;border:none;border-radius:7px;padding:9px 16px;font-size:13px;cursor:pointer;font-family:inherit}
  @media print{.printbtn{display:none}body{padding:0;font-size:12.5px}}
</style></head><body>
<button class="printbtn" onclick="window.print()">🖨 הדפסה / שמירה כ-PDF</button>

<div class="letterhead"><span>לכבוד: <b>${esc(to)}</b></span><span>${today}</span></div>

<div class="subject"><b>הנדון: תוכנית החופש הגדול — ${esc(d.label)} — סיכום בדיקות שלב 1</b></div>

<p>שלום רב,</p>
<p>עברנו על <b>דוח הביצוע של משרד החינוך</b> (${d.units.length > 1 ? `${d.units.length} מוסדות` : 'נתוני המסגרת'}) ועל <b>דוח עלות השכר</b> שהעברתם אלינו (${fmt(d.cost.summary.workers)} עובדים, בעלות כוללת של ₪${fmt(d.cost.summary.totalCost)}).</p>
<p><b>מסגרת הבדיקות שביצענו בשלב זה:</b> בקרת שכר פרטנית לכל עובד (ברוטו לשעה ועלות לשעה מול תקרות המשרד), בדיקת כמות שעות, בדיקת תקציב מול ביצוע ברמת סלי התקציב, וחישוב היתרות העומדות לניצול.</p>
<p><b>להלן מספר נקודות חשובות שיש לשים לב אליהן:</b></p>
<ul class="points">${highlights.map((h) => `<li>${h}</li>`).join('')}</ul>

<h2>1. בקרת ברוטו לשעה ועלות לשעה</h2>
${sec1}

<h2>2. בדיקת כמות שעות</h2>
${sec2}

<h2>3. תקציב מול ביצוע${(d.recs && d.recs.relevant && (d.recs.moves || []).length) ? ' — המלצות ניוד' : ''}</h2>
${sec3}

<h2>4. יתרות לניצול — העשרה והסל הגמיש</h2>
<p>להלן מצב הסל הגמיש וההעשרה בכל מוסד (כשקיימת יתרה בסל הגמיש — שתי אופציות לניצולה):</p>
${unitOptions}

<h2>5. יעדי הכרטסות — על כמה צריכה לעמוד כל כרטסת</h2>
<p>לקראת השלב הבא, אלו הסכומים שהכרטסות בהנהלת החשבונות צריכות לשקף${d.units.length > 1 ? ', לכל בית ספר בנפרד' : ' (כל הגנים יחד)'}:</p>
${targetsTable}
${d.unassignedCost > 0 ? `<p class="note">⚠ עלות של ₪${fmt(d.unassignedCost)} טרם שויכה לסמל מוסד ואינה כלולה בפירוט.</p>` : ''}

<p class="closing">נשמח לקבל את התייחסותכם לנקודות שלעיל, ובפרט את אישורכם להמלצות הניוד (אם קיימות). לאחר קבלת הכרטסות נבצע את בדיקת ההתאמה מולן ונשלים את הכנת הדוח להגשה.</p>
<p>בברכה,<br><b>גוטליב את ביטון, רו"ח</b></p>

<div class="footer">המכתב הופק ממערכת בקרת והכנת דוחות החופש הגדול על בסיס דוח הביצוע ודוח העלות שהתקבלו · ${esc(to)} · ${esc(d.label)} · ${today}</div>
</body></html>`;
}

module.exports = { stage1Data, renderStage1Html };
