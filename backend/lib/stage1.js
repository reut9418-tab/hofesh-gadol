/* מכתב שלב 1 ללקוח — מופק לכל פרויקט (דוח) בנפרד:
   פתיחה (מה נבדק ומסגרת הבדיקות) → נקודות חשובות → פירוט הבקרות →
   טבלת יעדי כרטסות ברורה: שכר / ארוחת בוקר / העשרה / הכנסות משתתפים —
   בתי"ס פר סמל מוסד, גנים במרוכז. מוגש כדף HTML להדפסה/PDF. */

const { costDataForReport } = require('./reportCosts');
const { salaryCheck, suggestRole, basketForStaff, schoolsRoleByHours, demoteExtraSchoolRoles, coordHoursCapFor, isCoordType } = require('./salaryCheck');
const { recommendations } = require('./recommend');
const { matchDeptsToInstitutions } = require('./nameMatch');
const { reportLabel } = require('./domain');
const { recognizedRowCost, COST_MARKUP_LIMIT } = require('./ingest');

const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('he-IL'));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clientName = (client, authority) => (authority && authority.name) || (client && client.name) || 'המפעיל';

/* מוסדות קובץ המשרד (לשונית ההרשמה) + מפת ההפניות של בתי ספר מאוחדים —
   כדי ששיוך הסמלים במכתב יהיה זהה במדויק לזה של הייצוא (resolveSymbol) */
const { extractInstitutions, extractWorkerAssignments } = require('./fillMinistry');
const { parseGardenExecKids, parseDeputyEntitlement } = require('./budgetFile');
const { parseXlsxOffloaded } = require('./xlsxOffload');
const XLSX = require('xlsx');
const fileMetaCache = new Map(); // reportId -> { fileName, insts, redirect, depEntitled, gardensExec }

async function fileMeta(db, report) {
  const fn = report.budget_file_name || '';
  const cached = fileMetaCache.get(report.id);
  if (cached && cached.fileName === fn) return cached;
  const entry = { fileName: fn, insts: [], redirect: new Map(), depEntitled: {}, gardensExec: null, workerSyms: {} };
  try {
    const row = await db.prepare('SELECT data FROM report_files WHERE report_id = ?').get(report.id);
    if (row && row.data) {
      const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
      // הפענוח (שניות של CPU) רץ ב-worker thread כדי לא לחסום את השרת;
      // נפילה חזרה לנתיב סינכרוני אם ה-worker לא זמין
      let parsed = null;
      try { parsed = await parseXlsxOffloaded({ mode: 'letter', framework: report.framework, buf }); } catch { /* סינכרוני */ }
      if (!parsed) {
        const wb = XLSX.read(buf, { type: 'buffer' });
        parsed = {
          insts: extractInstitutions(wb),
          depEntitled: report.framework !== 'gardens' ? parseDeputyEntitlement(wb) : {},
          gardensExec: report.framework === 'gardens' ? parseGardenExecKids(wb) : null,
          workerSyms: extractWorkerAssignments(wb),
        };
      }
      entry.insts = parsed.insts || [];
      entry.depEntitled = parsed.depEntitled || {};
      entry.gardensExec = parsed.gardensExec || null;
      entry.workerSyms = parsed.workerSyms || {};
      entry.redirect = new Map(entry.insts.filter((i) => i.activitySymbol).map((i) => [String(i.symbol), String(i.activitySymbol)]));
    }
  } catch { /* אין קובץ — שיוך לפי מוסדות המסד בלבד */ }
  fileMetaCache.set(report.id, entry);
  return entry;
}

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
  // שיוך זהה לזה של הייצוא: התאמת שמות מול מוסדות קובץ המשרד (לשונית
  // ההרשמה — שמות מלאים), סמל גולמי מדוח העלות כשהוא מוכר, והפניית
  // בתי ספר מאוחדים לסמל מקום הפעילות
  const meta = await fileMeta(db, report);
  const matchInsts = meta.insts.length ? meta.insts : insts;
  const deptSymbol = report.framework !== 'gardens' && matchInsts.length
    ? matchDeptsToInstitutions(matchInsts, [...new Set(rows.map((r) => r.dept))])
    : {};
  const nameSymbol = matchInsts.length
    ? matchDeptsToInstitutions(matchInsts, [...new Set(rows.map((r) => r.inst_name).filter(Boolean))])
    : {};
  const validSyms = new Set(matchInsts.map((i) => String(i.symbol)));
  const toActivity = (s) => (s ? (meta.redirect.get(String(s)) || String(s)) : null);
  // שיוך ידני מחלקה→סמל שאושר ע"י המשתמשת (כלל 17.9: דו-משמעי = שאלה,
  // והתשובה נלמדת) — גובר על כל שיוך אוטומטי ושורד קליטה מחדש של דוח העלות
  const deptManual = {};
  (await db.prepare("SELECT map_key, map_value FROM client_mappings WHERE client_id = ? AND mapping_type = 'dept_symbol'")
    .all(report.client_id)).forEach((r) => { deptManual[r.map_key] = r.map_value; });
  // שיוך שמולא בלשונית כח האדם של הקובץ שהועלה (ת"ז→סמל) — נשמר בעדכונים
  const fileSym = (r) => {
    const a = meta.workerSyms && meta.workerSyms[String(r.emp_id || '').replace(/\D/g, '')];
    return a && validSyms.has(a.symbol) ? a.symbol : null;
  };
  const rowSymbol = (r) => toActivity(r.symbol_override
    || deptManual[r.dept]
    || (r.inst_symbol && validSyms.has(String(r.inst_symbol)) ? String(r.inst_symbol) : null)
    || fileSym(r)
    || (r.inst_name && nameSymbol[r.inst_name])
    || deptSymbol[r.dept] || null);

  // פיצול הניצול המוכר של יחידה לסל הדרכה מול סל הריכוז (רכז+סגן) —
  // ההשוואה במכתב היא סל-מול-סל, לא סך שכר מול סך תקציבים
  const splitRecognized = (unitRows, deputyEntitled = true) => {
    let instr = 0, coord = 0;
    // בבתי הספר קובץ המשרד מזהה את דיווח הסגן ב-VLOOKUP — נתפסת רק שורת
    // הסגן הראשונה בסדר הכתיבה (סמל ואז שם עובד); סגנים נוספים באותו מוסד
    // נשארים ב"שכר צוות חינוכי". רכזים נספרים כולם (SUMIFS). במוסד ללא
    // זכאות לסגן (קטן) — דיווח הסגן מוחסר מהצוות אך אינו מוכר בריכוז:
    // העלות אינה נזקפת לאף סל, בדיוק כמו בקובץ. משחזרים במדויק
    const ordered = report.framework === 'gardens' ? unitRows : [...unitRows].sort((a, b) => {
      const ka = String(a.symbol_override || a.inst_symbol || ''), kb = String(b.symbol_override || b.inst_symbol || '');
      if (ka !== kb) return ka < kb ? -1 : 1;
      const na = String(a.emp_name || ''), nb = String(b.emp_name || '');
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
    // כלל רעות 23.9 (בתי"ס): רכזים עד תקרת שעות 7.6×ימי הפרויקט, סגן 0 או 1 —
    // מסווגי-שעות עודפים יורדים למורה; שיוך ידני לא נדרס (שעותיו נספרות)
    const demoted = report.framework !== 'gardens' ? demoteExtraSchoolRoles(ordered, coordHoursCapFor(report)) : new Set();
    const staffOf = (r) => {
      const byHours = report.framework !== 'gardens' && !demoted.has(r.id) ? schoolsRoleByHours(r.hours) : null;
      // תפקיד שמולא בקובץ שהועלה (ת"ז): בגנים קודם לניחוש (יבנה 16.9);
      // בבתי"ס כלל השעות המאומת (90/93) גובר — הקובץ רק כשאין שעות מסווגות
      // (עובד עם כמה שורות בקובץ נלכד לפי הראשונה — לא אמין כדריסה)
      const ws = meta.workerSyms && meta.workerSyms[String(r.emp_id || '').replace(/\D/g, '')];
      if (demoted.has(r.id)) return 'מורה';
      return report.framework === 'gardens'
        ? (r.staff_type || (ws && ws.staffType) || suggestRole(r.dept).staffType)
        : (r.staff_type || (byHours && byHours.staffType) || (ws && ws.staffType) || suggestRole(r.dept).staffType);
    };
    // דיווח הסגן מוכר רק כשמדווח גם רכז (תנאי הנוסחה בלשונית האיוש)
    const hasCoordRow = ordered.some((r) => basketForStaff(staffOf(r)) === 'coordinator');
    let depTaken = false;
    let coordHours = 0; // סך שעות הרכזים — לבקרת תקרת 7.6×ימים במכתב
    for (const r of ordered) {
      const v = recognizedRowCost(r, vatFactor);
      const st = staffOf(r);
      const basket = basketForStaff(st);
      if (basket === 'coordinator') { coord += v; if (isCoordType(String(st || ''))) coordHours += r.hours || 0; }
      else if (basket === 'deputy' && report.framework === 'gardens') coord += v;
      else if (basket === 'deputy' && !depTaken) { depTaken = true; if (deputyEntitled && hasCoordRow) coord += v; }
      else instr += v;
    }
    return { instr, coord, coordHours };
  };

  // סלי המכינות הייעודיים (פעילות חוץ=יום סיור / AI): הקצאת הכרטסות המשויכות
  // פר מוסד — תואמת-שם למוסד שלה, כללית — פיצול יחסי לילדים (כמו במילוי הייצוא)
  const extraAlloc = { trip: {}, ai: {} }; // symbol -> נטו מוקצה
  if (report.framework === 'prep') {
    const extraCards = (await db.prepare(
      "SELECT * FROM ledger_cards WHERE report_id = ? AND basket_type IN ('trip','ai')"
    ).all(report.id)).filter((c) => (c.net || 0) > 0);
    if (extraCards.length) {
      const cardSyms = matchDeptsToInstitutions(insts, [...new Set(extraCards.map((c) => c.card_name))]);
      const totKids = insts.reduce((s, i) => s + (i.children_count || 0), 0);
      for (const c of extraCards) {
        const m = extraAlloc[c.basket_type];
        const sym = cardSyms[c.card_name];
        if (sym) m[String(sym)] = (m[String(sym)] || 0) + c.net;
        else if (totKids > 0) insts.forEach((i) => {
          m[String(i.symbol)] = (m[String(i.symbol)] || 0) + c.net * ((i.children_count || 0) / totKids);
        });
      }
    }
  }

  const mkUnit = (name, symbol, baskets, salaryNet, split, children, salaryByPayer) => {
    // מול התקציב משווים את הניצול המוכר: עלות + מע"מ ללקוח חייב, מוגבל
    // פר-עובד לתקרת 140% (כמו בדיווח). ההשוואה סל-מול-סל: הדרכה לבד,
    // ריכוז (רכז+סגן) לבד; יתרה בסל אחד אינה מכסה חריגה באחר — רק הסל
    // הגמיש בולע חריגות. יעד הכרטסת נשאר נטו מלא — כך בהנהלת החשבונות.
    const instrBudget = baskets.instruction || 0;
    const coordBudget = (baskets.coordinator || 0) + (baskets.deputy || 0);
    const instrActual = split.instr, coordActual = split.coord;
    const salaryActual = instrActual + coordActual;
    const salaryBudget = instrBudget + coordBudget;
    const enrichB = baskets.enrichment || 0;
    const flexB = baskets.flexible || 0;
    const breakfastB = baskets.breakfast || 0;
    // סלי המכינות הייעודיים — תקציב מהקובץ מול ההוצאה שהוקצתה מהכרטסות
    const tripBudget = baskets.trip || 0, aiBudget = baskets.ai || 0;
    const allocOf = (m) => (symbol == null ? Object.values(m).reduce((s, v) => s + v, 0) : (m[String(symbol)] || 0));
    const tripAllocated = Math.round(allocOf(extraAlloc.trip) * vatFactor * 100) / 100;
    const aiAllocated = Math.round(allocOf(extraAlloc.ai) * vatFactor * 100) / 100;
    /* מטריצת הניוד בין הסלים (עד 25% מתקציב סל המקור בכל ניוד):
       שכר → העשרה / גמיש / רכזות / ניהול; רכזות → שכר בלבד;
       גמיש → ארוחות בוקר / שכר / חריגת רכזות; העשרה ↔ ניהול (ומקבלים משכר) */
    const instrOver0 = Math.max(0, instrActual - instrBudget);
    const coordOver0 = Math.max(0, coordActual - coordBudget);
    let instrUnused = Math.max(0, instrBudget - instrActual);
    let coordUnused = Math.max(0, coordBudget - coordActual);
    // ניודים פנימיים בין סלי השכר לפני שהגמיש בולע: יתרת רכזות מכסה חריגת
    // שכר (רכזות→שכר), ויתרת שכר מכסה חריגת רכזות (שכר→רכזות)
    const coordToSalary = Math.min(coordUnused, 0.25 * coordBudget, instrOver0);
    const salaryToCoord = Math.min(instrUnused, 0.25 * instrBudget, coordOver0);
    const instrOver = instrOver0 - coordToSalary;
    const coordOver = coordOver0 - salaryToCoord;
    instrUnused -= salaryToCoord;
    coordUnused -= coordToSalary;
    const salaryUnused = instrUnused + coordUnused;
    const overflow = instrOver + coordOver; // החריגות שנותרו — אותן בולע הגמיש
    // דוח הביצוע של המשרד בולע חריגת שכר בסל הגמיש אוטומטית — היתרה הזמינה
    // באמת לניצול (ארוחות בוקר/מלגות/גמיש) היא מה שנשאר אחרי הבליעה
    const flexConsumed = Math.min(overflow, flexB);
    const flexAvailable = Math.max(0, flexB - flexConsumed);
    // שורת "ארוחת בוקר" בקובץ המשרד היא ייעוד של הסל הגמיש (אותו סכום בדיוק),
    // לא תקציב נפרד — אין לספור פעמיים, והיתרה לארוחות בוקר = יתרת הסל הגמיש
    const breakfastPot = Math.abs(breakfastB - flexB) < 1 ? flexB : breakfastB + flexB;
    const breakfastAvailable = Math.max(0, breakfastPot - flexConsumed);
    // אופציה א: להעשרה מנוידת יתרת סל השכר (הדרכה) בלבד — יתרת רכזות
    // אינה ניתנת לניוד להעשרה (רכזות → שכר בלבד)
    const enrichBonus = overflow === 0 && instrUnused > 0
      ? Math.min(instrUnused, 0.25 * instrBudget)
      : 0;
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
      instrBudget, instrActual, coordBudget, coordActual,
      // ניצול הדרכה מתחת ל-75% מהסל (ללא הגמיש) — המשרד צפוי לקזז
      instrUnderCut: instrBudget > 0 && instrActual < instrBudget * 0.75,
      enrichBudget: enrichB, flexBudget: flexB, breakfastBudget: breakfastB,
      flexConsumed, flexAvailable, uncovered, enrichShift,
      coordToSalary, salaryToCoord, // ניודים פנימיים בין סלי השכר (רכזות↔שכר)
      // תקרת שעות הריכוז (כלל רעות 23.9): 7.6 ש' × ימי הפרויקט; בגנים לא רלוונטי
      coordHours: split.coordHours || 0,
      coordHoursCap: report.framework !== 'gardens' ? coordHoursCapFor(report) : null,
      management: baskets.management || 0,
      // מכינות: פעילות חוץ (יום סיור) ו-AI — ההכרה עד תקרת הסל
      tripBudget, tripAllocated, tripRecognized: Math.min(tripAllocated, tripBudget),
      aiBudget, aiAllocated, aiRecognized: Math.min(aiAllocated, aiBudget),
      optionA: { enrich: enrichB + enrichBonus, enrichBonus, flexForFood: flexAvailable },
      optionB: { enrich: enrichB, flexRemaining: flexAvailable },
      // יעדי הכרטסות (הטבלה המסכמת): שכר = דוח העלות (נטו); ארוחת בוקר = תקציב +
      // יתרת הסל הגמיש שנותרה אחרי בליעת חריגת השכר (בהנחת אופציה א');
      // העשרה = כולל התוספת; הכנסות = ילדים × תעריף. ללקוח חייב מע"מ — הכול נטו.
      targets: {
        // כלל רעות 23.9: יעד כרטסת השכר = דוח העלות בדיוק — הכרטסת חייבת
        // להיות זהה לדוח העלות. המע"מ ותקרת ה-140% חלים על הדיווח למשרד
        // בלבד (salaryActual) ולא על יעד הכרטסת
        salary: Math.round(salaryNet * 100) / 100,
        booksNet: salaryNet, // העלות בספרים (דוח העלות)
        salaryByPayer: Object.fromEntries(Object.entries(salaryByPayer || {}).map(([p, v]) =>
          [p, Math.round(v * 100) / 100])), // פיצול הכרטסות = דוח העלות פר משלם
        breakfast: net(breakfastAvailable),
        // יתרת הסל הגמיש (אחרי בליעת חריגות השכר) — עמודה נפרדת בסעיף 5
        flexRemain: net(flexAvailable),
        enrichment: net(enrichB + enrichBonus),
        // אופציית 75% — הכרה מופחתת בהעשרה כשקיימת חריגת שכר לא מכוסה
        enrichmentReduced: net(enrichB - enrichShift),
        // מכינות: יעד הכרטסת = תקציב הסל הייעודי (תקרת ההכרה של המשרד)
        trip: net(tripBudget), ai: net(aiBudget),
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
    // כמות הילדים לתקצוב = "מס ילדים לחישוב התקציב" מקובץ דוח הביצוע כפי
    // שהוא (כלל רעות 17.9) — בלי שער איוש משלנו על בסיס שורות השכר; הכמות
    // בקובץ כבר מגלמת את ימי ההפעלה בפועל (ימים/7 פר גן), ולכן גם שינוי
    // ימי ההרחבה מטופל דרך הקובץ ולא דרך שדה הימים של הדוח
    units = [mkUnit('כל הגנים (במרוכז)', null, baskets, cost.summary.totalCost, splitRecognized(rows), kids, payerSplit(rows))];
  } else {
    for (const i of insts) {
      const unitRows = rows.filter((r) => rowSymbol(r) === String(i.symbol));
      const actual = unitRows.reduce((s, r) => s + (r.cost || 0), 0);
      const bkts = await basketsOf(i.id);
      // זכאות לסגן — עמודת "זכאות לסגן/נית" בלשונית האיוש; גיבוי: תקציב סגן קיים
      const ent = meta.depEntitled[String(i.symbol)];
      let split = splitRecognized(unitRows, ent != null ? ent : (bkts.deputy || 0) > 0);
      // דוח הביצוע מפצל את הניצול לפי לשונית איוש המשרות: "שכר רכזים/סגנים" =
      // התקציב המוכר מהלשונית, ו"שכר צוות חינוכי" = כלל העלות בניכוי הדיווח —
      // לא לפי סיווג התפקידים בדוח העלות. כשקיימים דיווחי איוש, מיישרים אליהם
      const stRep = (i.staff_coord_reported || 0) + (i.staff_dep_reported || 0);
      const stBud = (i.staff_coord_budget || 0) + (i.staff_dep_budget || 0);
      if (stRep > 0 || stBud > 0) {
        const total = split.instr + split.coord;
        split = { instr: Math.max(0, total - stRep), coord: stBud, coordHours: split.coordHours };
      }
      units.push(mkUnit(i.name || i.symbol, String(i.symbol), bkts, actual, split, i.children_count || 0, payerSplit(unitRows)));
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
  const overCapUnits = d.units.filter((u) => u.coordHoursCap != null && u.coordHours > u.coordHoursCap + 0.01 && u.uncovered > 1).length;
  if (overCapUnits > 0) highlights.push(`ב-<b>${overCapUnits} ${overCapUnits === 1 ? 'מוסד' : 'מוסדות'}</b> שעות הריכוז חורגות מתקרת השעות (7.6 ש' × ימי הפרויקט) — העודף צפוי לא להיות מוכר (פירוט בסעיף 4).`);
  const cutUnits = d.units.filter((u) => u.instrUnderCut).length;
  if (cutUnits > 0) highlights.push(`ב-<b>${cutUnits} ${cutUnits === 1 ? 'מוסד' : 'מוסדות'}</b> ניצול סל ההדרכה נמוך מ-75% מהתקציב — <b>צפוי קיזוז מהמשרד</b> (פירוט בסעיף 4).`);
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
    // ללקוח מע"מ — מציגים גם את הדיווח למשרד כדי שיהיה ברור מקור הפער:
    // יעד הכרטסת = דוח העלות (כלל רעות 23.9); הדיווח = מע"מ + תקרת 140%
    const booksNote = d.hasVat
      ? ` <span class="soft">(יעד הכרטסת = דוח העלות: ₪${fmt(u.targets.salary)}; בדוח הביצוע דווח, כולל מע"מ ותקרת 140%: ₪${fmt(u.salaryActual)})</span>`
      : '';
    // השוואה סל-מול-סל: הדרכה לבד, ריכוז לבד; רק הסל הגמיש בולע חריגות
    const basketLine = (label, actual, budget) => {
      if (!(budget > 0) && !(actual > 0)) return '';
      const diff = budget - actual;
      const stat = diff >= 0
        ? (diff > 0 ? `יתרה <b class="green">₪${fmt(diff)}</b>` : 'נוצל במלואו')
        : `<span class="red">חריגה ₪${fmt(-diff)}</span>`;
      return `<div>${label}: נוצלו <b>₪${fmt(actual)}</b> מתוך ₪${fmt(budget)} — ${stat}.</div>`;
    };
    const flexLine = !(u.flexBudget > 0) ? '' : `<div>סל גמיש (₪${fmt(u.flexBudget)}): ${
      u.flexConsumed > 0
        ? `₪${fmt(u.flexConsumed)} מכסים את חריגות השכר${u.uncovered > 0 ? ` <span class="red">(₪${fmt(u.uncovered)} נותרים ללא כיסוי ולא יוכרו)</span>` : ''}; `
        : ''
    }יתרה <b>₪${fmt(u.flexAvailable)}</b> — לשכר או למלגות/ארוחות בוקר (האופציות למטה).</div>`;
    const instrCutNote = u.instrUnderCut
      ? ` <span class="red">ניצול ${Math.round((u.instrActual / u.instrBudget) * 100)}% בלבד מסל ההדרכה (מתחת ל-75%) — צפוי קיזוז מהמשרד.</span>`
      : '';
    // ניודים פנימיים בין סלי השכר (רכזות ↔ שכר, עד 25% מסל המקור)
    const transferLines = `${u.coordToSalary > 0
      ? `<div>ניוד מסל הרכזות לשכר: <b>₪${fmt(u.coordToSalary)}</b> מיתרת הריכוז מכסים חלק מחריגת ההדרכה <span class="soft">(רכזות מתניידות לשכר בלבד, עד 25% מסל הרכזות)</span>.</div>` : ''}${u.salaryToCoord > 0
      ? `<div>ניוד מסל השכר לרכזות: <b>₪${fmt(u.salaryToCoord)}</b> מיתרת ההדרכה מכסים חלק מחריגת הריכוז <span class="soft">(עד 25% מסל השכר)</span>.</div>` : ''}`;
    // סלי המכינות הייעודיים — הוצאות הכרטסות המיוחסות מול תקציב הסל
    const extraBasketLines = `${basketLine('סל פעילות חוץ (יום סיור)', u.tripAllocated, u.tripBudget)}
      ${basketLine('סל AI', u.aiAllocated, u.aiBudget)}`;
    // תקרת שעות הריכוז (כלל רעות 23.9): 7.6 ש' × ימי הפרויקט — מותר יותר
    // מרכז/ת אחד/ת. אזהרה רק כשהחריגה בשעות גם עולה כסף (ניצול מעל תקציב
    // הריכוז) — סלים שמלאים במדויק (ביתר) לא מוצפים באזהרות סרק
    const coordHoursNote = u.coordHoursCap != null && u.coordHours > u.coordHoursCap + 0.01 && u.uncovered > 1
      ? ` <span class="red">שעות הריכוז: ${fmt(u.coordHours)} מתוך תקרת ${fmt(u.coordHoursCap)} (7.6 ש' × ימי הפרויקט) — העודף צפוי לא להיות מוכר.</span>`
      : '';
    const salaryLine = `${basketLine('סל הדרכה — שכר הצוות החינוכי', u.instrActual, u.instrBudget).replace('</div>', instrCutNote + '</div>')}
      ${basketLine(u.symbol == null ? 'סל ריכוז — רכזות גנים' : 'סל ריכוז — רכז/ת וסגן/ית', u.coordActual, u.coordBudget).replace('</div>', coordHoursNote + '</div>')}
      ${transferLines}${flexLine}${extraBasketLines}${booksNote ? `<div>${booksNote}</div>` : ''}`;
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
      // כל עוד נותרה יתרה בסל הגמיש — מציגים את שתי האופציות (גנים ובתי"ס)
      : `<div class="opts">
      <div class="opt">
        <div class="opt-title">אופציה א' — הסל הגמיש ינוצל לארוחות בוקר ומלגות</div>
        <ul>
          <li>ארוחות בוקר ומלגות: עד <b>₪${fmt(u.optionA.flexForFood)}</b> ${u.flexConsumed > 0 ? `<span class="soft">(יתרת הסל הגמיש אחרי כיסוי חריגת השכר)</span>` : '(מלוא הסל הגמיש)'}</li>
          <li>העשרה: עד <b>₪${fmt(u.optionA.enrich)}</b>${u.optionA.enrichBonus > 0
            ? `<br><span class="soft">(תקציב ₪${fmt(u.enrichBudget)} + ניוד יתרת שכר בסך ₪${fmt(u.optionA.enrichBonus)} — עד 25% מתקציב סל השכר ניתן לניוד)</span>`
            : ` <span class="soft">(לפי התקציב)</span>`}</li>
        </ul>
      </div>
      <div class="opt">
        <div class="opt-title">אופציה ב' — הסל הגמיש יישאר גמיש</div>
        <ul>
          <li>העשרה: עד <b>₪${fmt(u.optionB.enrich)}</b> <span class="soft">(לפי התקציב)</span></li>
          <li>יתרת סל גמיש זמינה: <b>₪${fmt(u.optionB.flexRemaining)}</b>${u.flexConsumed > 0 ? ` <span class="soft">(אחרי כיסוי חריגת השכר של ₪${fmt(u.flexConsumed)})</span>` : ''} — לשכר, למלגות או לארוחות בוקר לפי הצורך</li>
        </ul>
      </div>
    </div>`;
    return `<h3>${title}</h3>
    <div class="salaryline">${salaryLine}</div>
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
  const salaryLabel = d.report.framework === 'gardens' ? 'שכר מובילות + רכזים' : 'שכר מורים + רכזים';
  const salaryCols = multiPayer ? d.payers.map((p) => `${salaryLabel} — ${esc(p)}`) : [salaryLabel];
  // עמודת "סל גמיש" הוסרה (בקשת רעות 23.9) — היא הייתה כפילות של "ארוחת
  // בוקר": שתיהן יתרת הסל הגמיש שנותרה אחרי בליעת חריגות השכר
  // סלי המכינות הייעודיים — עמודות רק כשקיים תקציב (בבתי"ס/גנים אין אותם)
  const anyTrip = d.units.some((u) => u.targets.trip > 0);
  const anyAi = d.units.some((u) => u.targets.ai > 0);
  const headCols = [...salaryCols, ...(anyBreakfast ? ['ארוחת בוקר'] : []), ...enrichCols, ...(anyTrip ? ['פעילות חוץ (יום סיור)'] : []), ...(anyAi ? ['סל AI'] : []), ...(anyIncome ? ['הכנסות משתתפים'] : [])];
  const salaryCells = (u) => multiPayer
    ? d.payers.map((p) => (u.targets.salaryByPayer[p] ? `₪${fmt(u.targets.salaryByPayer[p])}` : '—'))
    : [`₪${fmt(u.targets.salary)}`];
  const unitRow = (u) => {
    const cells = [
      ...salaryCells(u),
      ...(anyBreakfast ? [u.targets.breakfast > 0 ? `₪${fmt(u.targets.breakfast)}` : '—'] : []),
      ...enrichCells(u),
      ...(anyTrip ? [u.targets.trip > 0 ? `₪${fmt(u.targets.trip)}` : '—'] : []),
      ...(anyAi ? [u.targets.ai > 0 ? `₪${fmt(u.targets.ai)}` : '—'] : []),
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
        trip: a.trip + u.targets.trip, ai: a.ai + u.targets.ai,
        flexRemain: a.flexRemain + u.targets.flexRemain,
        income: a.income + u.targets.income,
      };
    }, { byPayer: {}, salary: 0, breakfast: 0, enrichment: 0, enrichmentReduced: 0, trip: 0, ai: 0, flexRemain: 0, income: 0 });
    const sc = multiPayer ? d.payers.map((p) => `₪${fmt(t.byPayer[p] || 0)}`) : [`₪${fmt(t.salary)}`];
    const ec = anyShift ? [`₪${fmt(t.enrichmentReduced)}`, `₪${fmt(t.enrichment)}`] : [`₪${fmt(t.enrichment)}`];
    const cells = [...sc, ...(anyBreakfast ? [`₪${fmt(t.breakfast)}`] : []), ...ec, ...(anyTrip ? [`₪${fmt(t.trip)}`] : []), ...(anyAi ? [`₪${fmt(t.ai)}`] : []), ...(anyIncome ? [`₪${fmt(t.income)}`] : [])];
    totalsRow = `<tr class="total"><td>סה"כ</td>${cells.map((c) => `<td class="num">${c}</td>`).join('')}</tr>`;
  }
  // אין מוסדות (טרם הועלה קובץ המשרד) או שכל השכר טרם שויך לסמלים —
  // הודעה ברורה במקום טבלה ריקה/חסרת משמעות
  const totalAssignedSalary = d.units.reduce((s, u) => s + (u.targets.salary || 0), 0);
  const targetsMissing = d.units.length === 0
    ? `<p class="note">⚠ טרם הועלה קובץ דוח הביצוע של המשרד לדוח זה — טבלת יעדי הכרטסות תיבנה אוטומטית לאחר העלאתו.</p>`
    : totalAssignedSalary <= 0 && d.unassignedCost > 0
      ? `<p class="note">⚠ כל עלות השכר (₪${fmt(d.unassignedCost)}) טרם שויכה לסמלי המוסדות — היעדים בטבלה יתמלאו לאחר שיוך העובדים במסך ההכנה (אפשר בשיוך קבוצתי לפי מחלקה).</p>`
      : '';
  const targetsTable = `${targetsMissing}<table class="targets">
    <thead><tr><th>${d.units.length > 1 ? 'בית ספר' : 'מסגרת'}</th>${headCols.map((h) => `<th class="num">${h}</th>`).join('')}</tr></thead>
    <tbody>${d.units.map(unitRow).join('')}${totalsRow}</tbody>
  </table>
  <p class="note">שכר — יעד הכרטסת זהה לדוח העלות${multiPayer ? ', בהפרדה לפי המשלם (כרטסת נפרדת בספרי כל משלם)' : ''}; הדיווח למשרד בדוח הביצוע מחושב בנפרד (${d.hasVat ? 'בתוספת מע"מ ו' : ''}לפי כלל הנמוך-מבין מול ברוטו+40%). ארוחת בוקר — התקציב בתוספת יתרת הסל הגמיש שנותרה אחרי בליעת חריגת השכר (בהנחת אופציה א'); אם יוחלט אחרת, ראו סעיף 4. העשרה — כולל ניוד יתרת שכר היכן שקיימת (עד 25% מתקציב סל המקור ניתן לניוד; הסל המקבל אינו מוגבל)${anyShift ? '; בשל חריגת השכר מוצגות שתי אופציות — 75% מהתקציב (מומלץ: 25% מנותבים לכיסוי חריגת השכר) או 100% מהתקציב (החריגה נותרת ללא כיסוי)' : ''}.${anyTrip || anyAi ? ' פעילות חוץ (יום סיור) וסל AI — תקציב הסל הייעודי בקובץ המשרד (תקרת ההכרה להוצאות אלו).' : ''} הכנסות משתתפים — כמות הילדים בדוח הביצוע × תעריף המשרד${d.tariff ? ` (₪${fmt(d.tariff)} לילד)` : ''}.${d.hasVat ? ' <b>כל היעדים בטבלה רשומים נטו, ללא מע"מ</b> — כפי שנרשם בכרטסת; בדוח הביצוע למשרד הסכומים מדווחים בתוספת מע"מ 18%.' : ''}</p>`;

  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<title>מכתב שלב 1 — ${esc(to)} — ${esc(d.label)}</title>
<style>
  body{font-family:'Segoe UI',Arial,sans-serif;color:#37322A;max-width:880px;margin:0 auto;padding:30px;line-height:1.7;font-size:13.5px}
  h1{font-size:19px;margin:16px 0 4px}
  h2{font-size:15px;color:#9A7B2F;margin-top:26px;margin-bottom:6px}
  h3{font-size:13.5px;margin:16px 0 4px;color:#9A7B2F}
  .letterhead{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #9A7B2F;padding-bottom:8px;font-size:12.5px;color:#7A7062}
  .subject{background:#FAF6EE;border-radius:8px;padding:10px 16px;margin:14px 0;font-size:14px}
  table{width:100%;border-collapse:collapse;font-size:12.5px;margin:8px 0}
  th{background:#F4ECDA;text-align:right;padding:6px 10px;font-size:12px}
  td{border-bottom:1px solid #EAE1CF;padding:6px 10px;vertical-align:top}
  th.num,td.num{text-align:center}
  .center{text-align:center}
  table.targets th{background:#9A7B2F;color:#fff}
  tr.total td{background:#F4ECDA;font-weight:700;border-top:2px solid #9A7B2F}
  .okline{color:#4C7A45;font-weight:600}
  .red{color:#B3261E;font-weight:600}.green{color:#4C7A45}.soft{color:#7A7062;font-size:11.5px;font-weight:400}
  .salaryline{margin:4px 0 8px}
  .opts{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
  .opt{flex:1 1 300px;border:1px solid #EAE1CF;border-radius:9px;padding:10px 16px;background:#FAF6EE}
  .opt-title{font-weight:700;color:#9A7B2F;font-size:12.5px;border-bottom:1px solid #EAE1CF;padding-bottom:5px;margin-bottom:6px}
  .opt ul{margin:0;padding-inline-start:18px}
  .opt li{margin-bottom:5px}
  .note{font-size:11.5px;color:#7A7062;background:#FAF6EE;border-radius:6px;padding:7px 11px;line-height:1.6}
  ul.points{margin:6px 0;padding-inline-start:22px}
  ul.points li{margin-bottom:4px}
  .closing{margin-top:26px}
  .footer{margin-top:26px;font-size:11px;color:#7A7062;border-top:1px solid #EAE1CF;padding-top:8px}
  .printbtn{position:fixed;top:14px;left:14px;background:#9A7B2F;color:#fff;border:none;border-radius:7px;padding:9px 16px;font-size:13px;cursor:pointer;font-family:inherit}
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
<p>להלן מצב הסל הגמיש וההעשרה בכל מוסד:</p>
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

const invalidateFileMeta = (reportId) => { fileMetaCache.delete(reportId); };
module.exports = { stage1Data, renderStage1Html, invalidateFileMeta };
