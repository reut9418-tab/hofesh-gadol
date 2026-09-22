/* מנוע התקציב (README §9) — קורא את התקציב ש**המשרד עצמו חישב** בקובץ דוח הביצוע.
   הלקוח ממלא כמות ילדים ב"מצבת והרשמה", Excel של המשרד מחשב את התקציב לכל מוסד/סל,
   ואנחנו קוראים את הערכים המחושבים (לא משחזרים נוסחאות — ראו החלטת אפיון 2026-08-31).

   מבנה: לכל מוסד בלוק בגיליון "תקצוב לפי מוסד" (בי"ס/מכינות) או "ריכוז נתונים" (גנים).
   העוגן היציב בין גרסאות התבנית הוא מקטע ההתאמה: כל שורה מתויגת בעמודה אחת
   (שם הסל), עם "תקציב נורמטיבי" ו"אי ניצול תקציב" בעמודות קבועות יחסית לכותרת. */

const XLSX = require('xlsx');
const norm = (s) => String(s ?? '').replace(/["'״׳]/g, '').replace(/\s+/g, ' ').trim();
// חשוב: תא ריק/רווחים = "אין ערך" (null), לא 0 — אחרת תא ריק בין תווית למספר בולע את הערך
const num = (v) => { const s = String(v ?? '').trim(); if (!s) return null; const n = Number(s.replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
/* המספר הראשון בטווח קצר אחרי תווית (תאים ממוזגים משאירים תאים ריקים בין התווית לערך) */
const numNear = (row, k, span = 3) => { for (let j = k + 1; j <= k + span && j < row.length; j++) { const n = num(row[j]); if (n != null) return n; } return null; };

/* מיפוי תווית סל בקובץ → מפתח סל קנוני (סגן לפני רכז — הדפוס הרחב /שכר רכז/ תופס גם "רכזות גנים") */
const BASKET_BY_LABEL = [
  { re: /שכר צוות חינוכי/, key: 'instruction' },   // הדרכה (+ גמיש לשכר)
  { re: /מובילות וסייעות/, key: 'instruction' },   // גנים: "שכר מובילות וסייעות בגנים"
  { re: /שכר סגני רכזים/, key: 'deputy' },
  { re: /שכר רכז/, key: 'coordinator' },            // "שכר רכזים" / "שכר רכזות/י גנים"
  { re: /^העשרה/, key: 'enrichment' },
  { re: /אבטחה/, key: 'security' },
  { re: /ארוחת בוקר/, key: 'breakfast' },
  { re: /מלגות/, key: 'scholarships' },
  { re: /ניהול ותפעול/, key: 'management' },
  { re: /תקורה/, key: 'overhead' },
];
const basketForLabel = (label) => { const n = norm(label); const hit = BASKET_BY_LABEL.find((b) => b.re.test(n)); return hit ? hit.key : null; };

/* איתור גיליון התקצוב לפי שם (שונה בין מסגרות) */
function findBudgetSheet(wb) {
  const names = wb.SheetNames;
  return (
    names.find((n) => norm(n).includes('תקצוב לפי מוסד')) ||
    names.find((n) => norm(n).includes('ריכוז נתונים')) ||
    null
  );
}

/* מאתר את אינדקס עמודת "תקציב נורמטיבי" ו"אי ניצול" מתוך שורת כותרת המקטע */
function reconColumns(row) {
  let normative = -1, unused = -1, actual = -1, maxRec = -1;
  row.forEach((c, i) => {
    const n = norm(c);
    if (n.includes('תקציב נורמטיבי')) normative = i;
    else if (n.includes('אי ניצול')) unused = i;
    else if (n.includes('ביצוע בפועל')) actual = i;
    else if (n.includes('הסכום המירבי') || n.includes('הסכום המירבי המוכר')) maxRec = i;
  });
  return { normative, unused, actual, maxRec };
}

/* גיליון "ריכוז נתונים" של הגנים: אין בלוקים פר-גן — המשרד מתקצב את גני הרשות כמקשה אחת.
   נבנה "מוסד" מצרפי אחד לכל הרשות עם התקציב, הילדים והסלים מהריכוז. */
function parseAggregateSheet(rows, sheetName, wb = null, opts = {}) {
  const firstNumAfter = (row, k) => numNear(row, k, 4);
  let authority = '', symbol = '';
  let reg = null, afterControl = null, effectiveTotal = null, spec = null, gardens = null, coordinators = null;
  let cols = null, total = 0, totalNet = null, totalActual = 0, netActual = null, totalUnused = 0;
  let totalNormative = 0; // גיבוי: "סה"כ תקציב נורמטיבי" ממקטע העלויות
  let flexMode = false, flexCols = null; // מקטע "בדיקת ניצול תקציב סל גמיש"
  const baskets = {}, actual = {}, unused = {};
  // גיבוי אחרון: התעריפים-לילד ממקטע "עלויות נורמטיביות"/"נתוני עזר" —
  // כשבקרת האיוש של המשרד מאפסת את החישוב, בונים תקציב = הרשמה × תעריף
  let tariffCol = -1, perChildShare = null;
  let rateCols = null, perChildRates = null;
  let coordRatePerGarden = null, sawCoordHeader = false;
  // שורות התשלום בתחתית הריכוז (כלל רעות 16.9): "סה"כ לתשלום בתוספת גמישות
  // 25% במעבר בין הסלים" + "תוספת סייעות רפואיות או אישיות" — אלו הסכומים
  // שהמשרד ישלם בפועל, והם המקור ל"צפוי לקבל" בדוח שלב 2
  let paymentTotal = null, paymentAides = null, paymentNote = null;
  let flexAllocSalary = 0; // הקצאת הגמיש שנכללה בתקציב השכר (מקטע ג, "שימוש אפשרי")
  const RATE_KEYS = [['סל ניהול', 'management'], ['סל הדרכה', 'instruction'], ['סל העשרה', 'enrichment'], ['סל גמיש', 'flexible']];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const labels = row.map(norm);
    const li = (needle) => labels.findIndex((x) => x.includes(needle));
    let k;
    if (!authority && (k = li('שם הרשות המקומית')) >= 0)
      authority = row.slice(k + 1).map(norm).find((x) => x && !/^\d+$/.test(x)) || '';
    if (!symbol && /^\d{6,9}$/.test(norm(row[0]))) symbol = norm(row[0]); // סמל מוטב בעמודה A
    if (reg == null && (k = li('תלמידים ח.רגיל')) >= 0) reg = firstNumAfter(row, k);
    // וריאנט תבנית (גוש עציון, הרחבה): "מספר תלמידים הרשמה מעודכנת/ביצוע" — בלי "ח.רגיל"
    if (reg == null && (k = labels.findIndex((x) => x.includes('תלמידים') && x.includes('הרשמה'))) >= 0) reg = firstNumAfter(row, k);
    if (spec == null && (k = li('תלמידים ח.מיוחד')) >= 0) spec = firstNumAfter(row, k);
    if (afterControl == null && (k = li('תלמידים לתקצוב')) >= 0) afterControl = firstNumAfter(row, k);
    // הרחבה: "סה"כ תלמידים" = ההרשמה אחרי הפחתת ימי-תלמיד על ימים שלא עבדו —
    // זו הכמות הנכונה לתקצוב כשבקרת האיוש איפסה את התא הסופי
    if (effectiveTotal == null && (k = labels.findIndex((x) => x === 'סהכ תלמידים' || x === 'סה"כ תלמידים')) >= 0) effectiveTotal = firstNumAfter(row, k);
    // מקור גיבוי לתקציב: "סה"כ תקציב נורמטיבי" ממקטע העלויות הנורמטיביות
    if ((k = li('סהכ תקציב נורמטיבי')) >= 0) { const v = firstNumAfter(row, k); if (v > 0 && !totalNormative) totalNormative = v; }
    if (gardens == null && (k = li('מספר מוסדות שפעלו')) >= 0) gardens = firstNumAfter(row, k);
    if (coordinators == null && (k = li('זכאות לרכזת')) >= 0) coordinators = firstNumAfter(row, k);
    if (paymentTotal == null && (k = li('לתשלום בתוספת גמישות')) >= 0) {
      paymentTotal = firstNumAfter(row, k);
      if (paymentTotal == null && !paymentNote) paymentNote = row.slice(k + 1, k + 5).map(norm).find((x) => x) || null;
    }
    if (paymentAides == null && (k = li('תוספת סייעות רפואיות')) >= 0) paymentAides = firstNumAfter(row, k);

    // תעריף המשרד לילד (מקטע העלויות הנורמטיביות): הכותרת קובעת את העמודה,
    // והערך נלקח משורת "ילדים זכאים לסבסוד"
    if (tariffCol < 0 && (k = li('תעריף לתלמיד גן')) >= 0) tariffCol = k;
    if (perChildShare == null && tariffCol >= 0 && li('זכאים לסבסוד') >= 0) {
      const v = num(row[tariffCol]);
      if (v > 0) perChildShare = v;
    }
    // תעריף רכזת גנים לגן (מקטע העזר "רכזות גנים" → שורת "גנים") —
    // משמש לבניית תקציב הריכוז כשבקרת הזכאות בקובץ אופסה
    if (coordRatePerGarden == null && sawCoordHeader && (k = labels.findIndex((x) => x === 'גנים')) >= 0) {
      const v = num(row[k + 1]);
      if (v > 0) coordRatePerGarden = v;
    }
    if (labels.some((x) => x === 'רכזות גנים')) sawCoordHeader = true;

    // תעריפי הסלים לילד (מקטע "נתוני עזר"): שורת כותרות עם ≥3 שמות סלים,
    // ואחריה שורת המספרים ("גנים")
    if (!rateCols) {
      const found = RATE_KEYS.map(([lbl, key]) => [key, labels.findIndex((x) => x === norm(lbl))]).filter(([, idx]) => idx >= 0);
      if (found.length >= 3) rateCols = Object.fromEntries(found);
    } else if (!perChildRates) {
      const vals = Object.entries(rateCols).map(([key, idx]) => [key, num(row[idx])]).filter(([, v]) => v > 0);
      if (vals.length >= 3) perChildRates = Object.fromEntries(vals);
    }

    // מקטע הסל הגמיש: "בדיקת ניצול תקציב סל גמיש" — תקציבו נלכד כסל flexible
    if (labels.some((x) => x.includes('בדיקת ניצול') && x.includes('סל גמיש'))) { flexMode = true; flexCols = null; continue; }

    if (labels.some((x) => x.includes('אי ניצול')) && labels.some((x) => x.includes('תקציב נורמטיבי'))) {
      cols = reconColumns(labels);
      flexMode = false; // מקטע ההתאמה הראשי מסיים את מקטע הסל הגמיש
      continue;
    }

    if (flexMode) {
      if (labels.some((x) => x.includes('תקציב נורמטיבי'))) {
        flexCols = reconColumns(labels);
        flexCols.possible = labels.findIndex((x) => x.includes('שימוש אפשרי'));
        continue;
      }
      if (flexCols && flexCols.normative >= 0) {
        const nb = num(row[flexCols.normative]);
        if (nb != null && nb > (baskets.flexible || 0)) {
          baskets.flexible = nb; // סכום הסל (מופיע בשורה הראשונה עם ערך)
          actual.flexible = flexCols.actual >= 0 ? (num(row[flexCols.actual]) || 0) : 0;
        }
        // שורת "שכר": "שימוש אפשרי בסל" = כמה מהגמיש הוקצה לתוך תקציב השכר
        // (שורת ההתאמה "שכר מובילות" כוללת אותו — נחסיר כדי לא לספור פעמיים)
        if (labels.some((x) => x === 'שכר') && flexCols.possible >= 0) {
          const fa = num(row[flexCols.possible]);
          if (fa > 0) flexAllocSalary = fa;
        }
      }
      continue;
    }
    if (!cols || cols.normative < 0) continue;

    const isTotal = labels.some((x) => x === norm('סה"כ'));
    const isNet = labels.some((x) => x === norm('סה"כ נטו'));
    if (isNet) {
      totalNet = num(row[cols.normative]);
      netActual = cols.actual >= 0 ? num(row[cols.actual]) : null;
    } else if (isTotal && total === 0) {
      total = num(row[cols.normative]) || 0;
      totalActual = cols.actual >= 0 ? (num(row[cols.actual]) || 0) : 0;
      totalUnused = cols.unused >= 0 ? (num(row[cols.unused]) || 0) : 0;
    } else if (!labels.some((x) => x.startsWith('סהכ'))) {
      const labelIdx = labels.findIndex((x) => x && basketForLabel(x));
      if (labelIdx >= 0) {
        const key = basketForLabel(labels[labelIdx]);
        const nb = num(row[cols.normative]);
        if (nb != null && baskets[key] == null) {
          baskets[key] = nb;
          actual[key] = cols.actual >= 0 ? (num(row[cols.actual]) || 0) : 0;
          unused[key] = cols.unused >= 0 ? (num(row[cols.unused]) || 0) : 0;
        }
      }
    }
  }

  // הקצאת הגמיש שנכללה בתקציב השכר מופחתת ממנו — הסל הגמיש מוצג פעם אחת, בנפרד
  if (flexAllocSalary > 0 && baskets.instruction > flexAllocSalary) {
    baskets.instruction -= flexAllocSalary;
  }

  // "סה"כ תקצוב" של הגנים = סה"כ נטו (אחרי השתתפות הורים); גיבוי: התקציב הנורמטיבי
  let budget = (totalNet != null && totalNet > 0 ? totalNet : 0) || total || totalNormative;
  // סדר עדיפויות לכמות הילדים: "לתקצוב לאחר בקרת איוש" (מגלם גם הפחתת ימים
  // וגם בקרה) כשחיובי ← "סה"כ תלמידים" (אחרי הפחתת ימי-תלמיד על ימים שלא
  // עבדו — חשוב בהרחבה!) ← ההרשמה הגולמית. בדיקת סבירות: הפחתת ימים לא
  // מוחקת את רוב הילדים — תא שמחושב מתחת למחצית ההרשמה הוא שריד נוסחה שבורה
  const effOk = effectiveTotal > 0 && (!(reg > 0) || effectiveTotal >= reg * 0.5);
  // כשהתא המרוכז קפוא (0) — משחזרים אותו מלשונית "גנים - דוח ביצוע" (סכום
  // "מס ילדים לחישוב התקציב" פר גן, שמגלם את הפחתת ימי הפעילות בהרחבה)
  const execInfo = !(afterControl > 0) && wb ? parseGardenExecKids(wb) : null;
  const execOk = execInfo && execInfo.total > 0 && (!(reg > 0) || execInfo.total >= reg * 0.5);
  let kids = (afterControl > 0 ? afterControl : null)
    ?? (execOk ? execInfo.total : null)
    ?? (effOk ? effectiveTotal : null) ?? reg;
  // בקרת האיוש של המשרד איפסה את כל החישוב אך ההרשמה מולאה — בונים את
  // התקציב בעצמנו: ילדים × תעריף המשרד לילד, והסלים לפי תעריפי-הסל לילד
  let ratesFallback = false;
  // מסלול אחרון (אור עקיבא): גם תאי העזר בריכוז קפואים — סך הנרשמים מלשונית
  // ההרשמה × תעריפי "מבנה תקציבי גנים" הסטטיים
  if (!(budget > 0) && !(kids > 0 && perChildShare > 0) && wb) {
    const rates = parseGardenStructureRates(wb, opts.program);
    const regInfo = parseGardenRegistration(wb);
    const kidsReg = (kids > 0 ? kids : 0) || (regInfo ? regInfo.total : 0);
    if (rates && kidsReg > 0) {
      kids = kidsReg;
      budget = 0;
      for (const [key, rate] of Object.entries(rates.perChild)) {
        baskets[key] = Math.round(kidsReg * rate * 100) / 100;
        actual[key] = actual[key] || 0;
        budget += baskets[key];
      }
      // סל ריכוז: "שכר עבור ריכוז" הוא תעריף לגן (מוגדר בטבלה רק ל-15 ימים)
      // — כפול מספר הגנים במצבה; בהרחבה אין סל ריכוז (כמו בקבצים שכן חושבו)
      if (opts.program !== 'extension' && rates.perGarden > 0 && regInfo && regInfo.gardens > 0 && !(baskets.coordinator > 0)) {
        baskets.coordinator = Math.round(regInfo.gardens * rates.perGarden * 100) / 100;
        actual.coordinator = actual.coordinator || 0;
        budget += baskets.coordinator;
      }
      budget = Math.round(budget * 100) / 100;
      if (!(reg > 0)) reg = kidsReg;
      if (gardens == null && regInfo) gardens = regInfo.gardens;
      ratesFallback = true;
    }
  }
  if (!(budget > 0) && kids > 0 && perChildShare > 0) {
    budget = Math.round(kids * perChildShare * 100) / 100;
    ratesFallback = true;
    const noBaskets = Object.values(baskets).every((v) => !(v > 0));
    if (noBaskets && perChildRates) {
      for (const [key, rate] of Object.entries(perChildRates)) {
        baskets[key] = Math.round(kids * rate * 100) / 100;
        actual[key] = actual[key] || 0;
      }
    }
  }
  const inst = {
    symbol: symbol || '0', name: authority ? `גני ${authority}` : 'גני הרשות',
    size: 'small', days: null,
    reported: reg, // כמות שדווחה בהרשמה — משמשת להסבר כשהתקצוב אופס בבקרה
    afterControlZero: afterControl === 0 && reg > 0, // המשרד איפס את "לתקצוב לאחר בקרת איוש"
    ratesFallback, // התקציב חושב אצלנו מהרשמה×תעריף כי חישוב המשרד אופס
    coordRatePerGarden, // תעריף רכזת לגן — להשלמת תקציב הריכוז מלשונית הרכזות
    eligibleReg: kids, eligibleSpec: spec,
    gardensCount: gardens, coordinators,
    baskets, actual, unused,
    total: budget || 0, totalActual: netActual ?? totalActual, totalUnused,
    paymentTotal, paymentAides, paymentNote,
  };
  const institutions = (inst.total > 0 || Object.keys(baskets).length) ? [inst] : [];
  return { sheetName, authority, aggregate: true, institutions };
}

/* תעריפי בתי הספר מגיליון "גנים ובתי ספר- מבנה תקציב" — לבניית תקציב
   כשחישוב המשרד אופס (איוש משרות לא מולא). לתלמיד: סלי ניהול/הדרכה/
   העשרה/גמיש; קבוע למוסד: שכר רכז (+סגן בבי"ס גדול) + ניהול. */
function parseSchoolRates(wb, program) {
  const sn = wb.SheetNames.find((n) => norm(n).includes('מבנה תקציב'));
  if (!sn) return null;
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null });
  const daysNeedle = program === 'extension' ? 'ל- 7 ימים' : 'ל- 15 ימים';
  const wantExt = program === 'extension';

  let inSchools = false, perCols = null, perChild = null, perChildSpecial = null, inSpecial = false;
  let fixedCols = null, curSize = null, curExt = false;
  const fixed = {};
  for (const row of rows) {
    const labels = (row || []).map(norm);
    const has = (needle) => labels.findIndex((x) => x.includes(needle));
    if (has('מבנה תקציבי בתי ספר') >= 0) { inSchools = true; continue; }
    if (!inSchools) continue;

    // --- עלות לתלמיד ---
    if (!perCols && has('סל ניהול') >= 0 && has('סל הדרכה') >= 0) {
      perCols = {
        management: has('סל ניהול'), instruction: has('סל הדרכה'),
        enrichment: has('סל העשרה'), flexible: has('סל גמיש'),
      };
      continue;
    }
    if (has('חנמ') >= 0 || has('חנ"מ') >= 0) inSpecial = true; // מכאן — תעריפי חינוך מיוחד
    if (perCols && !perChild && !inSpecial && has(daysNeedle) >= 0) {
      const vals = Object.fromEntries(Object.entries(perCols).map(([k, idx]) => [k, num(row[idx]) || 0]));
      if (vals.instruction > 0) perChild = vals;
      continue;
    }
    // תלמידי חינוך מיוחד מתוקצבים בתעריף גבוה יותר — נדרש לזכאי ח.מיוחד
    if (perCols && inSpecial && !perChildSpecial && has(daysNeedle) >= 0) {
      const vals = Object.fromEntries(Object.entries(perCols).map(([k, idx]) => [k, num(row[idx]) || 0]));
      if (vals.instruction > 0) perChildSpecial = vals;
      continue;
    }

    // --- קבוע למוסד ---
    if (!fixedCols && has('שכר רכז') >= 0 && has('ניהול ותפעול') >= 0) {
      fixedCols = { coordinator: has('שכר רכז'), deputy: has('שכר סגן'), management: has('ניהול ותפעול') };
      continue;
    }
    if (fixedCols) {
      const sizeIdx = labels.findIndex((x) => x.includes('עד 150') || x.includes('מעל 150'));
      if (sizeIdx >= 0) {
        curSize = labels[sizeIdx].includes('מעל') ? 'large' : 'small';
        curExt = labels[sizeIdx].includes('הרחבה');
      }
      if (curSize && curExt === wantExt && !fixed[curSize] && has(daysNeedle) >= 0) {
        fixed[curSize] = {
          coordinator: num(row[fixedCols.coordinator]) || 0,
          deputy: fixedCols.deputy >= 0 ? (num(row[fixedCols.deputy]) || 0) : 0,
          management: num(row[fixedCols.management]) || 0,
        };
      }
    }
  }
  if (!perChild) return null;
  return { perChild, perChildSpecial, fixed };
}

/* טבלת "נתוני עזר" בגיליון התקצוב עצמו — התעריפים המדויקים שבהם הקובץ
   משתמש (בהרחבה: סה"כ מעוגל לש"ח שלם ומפוצל לפי חלקי הסלים, ולכן שונה
   מעט מטבלת המבנה). ערכים סטטיים — זמינים גם בקובץ קפוא. */
function parseHelperRates(rows) {
  for (let i = 0; i < rows.length; i++) {
    const labels = (rows[i] || []).map(norm);
    const hd = labels.findIndex((x) => x === 'תקציב לילד');
    if (hd < 0 || !labels.some((x) => x === 'סל הדרכה')) continue;
    const cols = {
      management: labels.findIndex((x) => x === 'סל ניהול'),
      instruction: labels.findIndex((x) => x === 'סל הדרכה'),
      enrichment: labels.findIndex((x) => x === 'סל העשרה'),
      flexible: labels.findIndex((x) => x === 'סל גמיש'),
    };
    const grab = (row) => Object.fromEntries(Object.entries(cols).map(([k, j]) => [k, j >= 0 ? (num(row[j]) || 0) : 0]));
    let perChild = null, perChildSpecial = null;
    for (let j = i + 1; j <= i + 4 && j < rows.length; j++) {
      const l2 = (rows[j] || []).map(norm);
      if (!perChild && l2.some((x) => x.includes('רגיל'))) perChild = grab(rows[j]);
      else if (!perChildSpecial && l2.some((x) => x.includes('חנמ'))) perChildSpecial = grab(rows[j]);
    }
    if (perChild && perChild.instruction > 0) return { perChild, perChildSpecial };
  }
  return null;
}

/* לשונית "איוש משרות (8)" — שכר הרכז/סגן שהרשות דיווחה ותקציבם המוכר.
   דוח הביצוע גוזר מהם את פיצול הניצול: "שכר רכזים/סגנים" = התקציב המוכר
   מהלשונית, ו"שכר צוות חינוכי" = כלל העלות בניכוי הדיווח — לא לפי סיווג
   התפקידים בדוח העלות. הערכים גולמיים וזמינים גם בקובץ קפוא. */
function parseStaffing(wb) {
  const sn = wb.SheetNames.find((n) => norm(n).includes('איוש משרות'));
  if (!sn) return {};
  const ws = wb.Sheets[sn];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const base = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s : { r: 0, c: 0 };
  let cols = null;
  const out = {};
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri] || [];
    const labels = row.map(norm);
    if (!cols) {
      const sym = labels.findIndex((x) => x.includes('סמל בית ספר'));
      const coordRep = labels.findIndex((x) => x.includes('דיווח שכר רכז'));
      if (sym >= 0 && coordRep >= 0) {
        cols = {
          sym, coordRep,
          depRep: labels.findIndex((x) => x.includes('דיווח שכר סגן')),
          coordBud: labels.findIndex((x) => x.includes('תקציב שכר רכז')),
          depBud: labels.findIndex((x) => x.includes('תקציב שכר סגן')),
        };
      }
      continue;
    }
    const s = norm(row[cols.sym]);
    if (!/^\d{4,7}$/.test(s)) continue;
    // יש תבניות (ביתר, חולון) שבהן "דיווח שכר רכז" הוא נוסחת SUMIFS על שורות
    // כח האדם לפי סימון "רכ"/"סג" — שם הפיצול נגזר מהסיווג שלנו וערכי הלשונית
    // ישתנו עם כל ייצוא; שומרים דיווחי איוש רק כשהם ערכים שהרשות הקלידה
    const cell = ws[XLSX.utils.encode_cell({ r: base.r + ri, c: base.c + cols.coordRep })];
    if (cell && cell.f) return {};
    out[s] = {
      coordReported: num(row[cols.coordRep]) || 0,
      depReported: cols.depRep >= 0 ? (num(row[cols.depRep]) || 0) : 0,
      coordBudget: cols.coordBud >= 0 ? (num(row[cols.coordBud]) || 0) : 0,
      depBudget: cols.depBud >= 0 ? (num(row[cols.depBud]) || 0) : 0,
    };
  }
  return out;
}

/* ---------- מכינות קיץ (program 'base') — גיבוי כשבקרת האיוש איפסה ----------
   נוסחאות הבלוק (פוענחו מאלעד, 22.9): סל-לילד = זכאים × תעריף נתוני-עזר
   (בלי יחס ימים); קבוע-למוסד (ניהול/ריכוז) = תעריף-ליום × ימי פעילות;
   הכול × "שיעור תקצוב בהתאם לבקרה" (ברירת מחדל 1). */

/* תעריפי המכינות מ"נתוני עזר" שבגיליון התקצוב: לילד (ניהול/הדרכה/העשרה,
   רגיל+חנ"מ) ותעריפי היום למוסד (ניהול/ריכוז, רגיל/גדול) */
function parsePrepRates(rows) {
  let perCols = null, perChild = null, perChildSpecial = null;
  let fixedCols = null, fixed = {};
  for (const row of rows) {
    const labels = (row || []).map(norm);
    const li = (t) => labels.findIndex((x) => x === t || x.includes(t));
    if (!perCols && li('תקציב לילד') >= 0 && li('סל הדרכה') >= 0) {
      perCols = { management: li('סל ניהול'), instruction: li('סל הדרכה'), enrichment: li('סל העשרה') };
      continue;
    }
    const grab = (cols) => Object.fromEntries(Object.entries(cols).map(([k, j]) => [k, j >= 0 ? (num(row[j]) || 0) : 0]));
    if (perCols && !fixedCols) {
      if (!perChild && labels.some((x) => x.includes('רגיל') && !x.includes('רגילים'))) { const v = grab(perCols); if (v.instruction > 0) perChild = v; }
      else if (!perChildSpecial && labels.some((x) => x.includes('חנמ'))) { const v = grab(perCols); if (v.instruction > 0) perChildSpecial = v; }
    }
    if (li('תקציב למוסד') >= 0 && li('סל שכר ריכוז') >= 0) {
      fixedCols = { management: li('סל ניהול'), coordinator: li('סל שכר ריכוז') };
      continue;
    }
    if (fixedCols) {
      if (!fixed.small && labels.some((x) => x.includes('רגילים'))) fixed.small = grab(fixedCols);
      else if (!fixed.large && labels.some((x) => x.includes('גדולים'))) fixed.large = grab(fixedCols);
    }
  }
  return perChild ? { perChild, perChildSpecial, fixed } : null;
}

/* נתוני התקצוב פר מכינה מ"דוח ביצוע (3)": זכאים לתקצוב (העמודות במקטע
   "נתונים לחישוב תקציב" — ההופעה האחרונה של הכותרת), ימים, בי"ס גדול */
function parsePrepExec(wb) {
  const sn = wb.SheetNames.find((n) => norm(n).includes('דוח ביצוע'));
  if (!sn) return {};
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null });
  let cols = null;
  const out = {};
  for (const row of rows) {
    const labels = (row || []).map(norm);
    if (!cols) {
      const sym = labels.findIndex((x) => x.includes('סמל בית ספר'));
      if (sym < 0) continue;
      const lastIdx = (needle) => { let k = -1; labels.forEach((x, j) => { if (x.includes(needle)) k = j; }); return k; };
      cols = {
        sym,
        days: labels.findIndex((x) => x.includes('ימי פעילות בפוע')),
        reg: lastIdx('תלמידים חינוך רגיל'),
        spec: lastIdx('תלמידים חינוך מיוחד'),
        large: labels.findIndex((x) => x.includes('גדולים')),
      };
      continue;
    }
    const s = norm(row[cols.sym]);
    if (!/^\d{4,7}$/.test(s)) continue;
    out[s] = {
      days: cols.days >= 0 ? (num(row[cols.days]) || 0) : 0,
      reg: cols.reg >= 0 ? (num(row[cols.reg]) || 0) : 0,
      spec: cols.spec >= 0 ? (num(row[cols.spec]) || 0) : 0,
      large: cols.large >= 0 && (num(row[cols.large]) || 0) > 0,
    };
  }
  return out;
}

/* "שיעור תקצוב בהתאם לבקרה" פר מוסד — לשונית "נתוני בקרות מוסדות" (ברירת מחדל 1) */
function parsePrepControlRates(wb) {
  const sn = wb.SheetNames.find((n) => norm(n).includes('נתוני בקרות'));
  if (!sn) return {};
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null });
  const out = {};
  for (const row of rows) {
    const s = norm((row || [])[0]);
    if (!/^\d{4,7}$/.test(s)) continue;
    const v = num((row || [])[2]);
    if (v != null && v >= 0 && v <= 1) out[s] = v;
  }
  return out;
}

/* ימי הפעילות בפועל פר בי"ס — עמודת "מספר ימי פעילות בפועל" בלשונית
   "דוח ביצוע (3)". בהרחבה זהו המקור ליחס הימים (התא בבלוק מאופס כשבקרת
   האיוש "לא תקין"); הערכים גולמיים וזמינים גם בקובץ קפוא */
function parseSchoolDays(wb) {
  const sn = wb.SheetNames.find((n) => norm(n).includes('דוח ביצוע'));
  if (!sn) return {};
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null });
  let cols = null;
  const out = {};
  for (const row of rows) {
    const labels = (row || []).map(norm);
    if (!cols) {
      const sym = labels.findIndex((x) => x.includes('סמל בית ספר'));
      const days = labels.findIndex((x) => x.includes('ימי פעילות בפועל'));
      if (sym >= 0 && days >= 0) cols = { sym, days };
      continue;
    }
    const s = norm(row[cols.sym]);
    if (!/^\d{4,7}$/.test(s)) continue;
    const v = num(row[cols.days]);
    if (v > 0) out[s] = v;
  }
  return out;
}

/* תוספת תקצוב רכז ד-ו פר בי"ס — עמודת "תוספת תקצוב רכז בית ספר ד-ו"
   בלשונית "דוח ביצוע (3)"; ערכיה סטטיים וזמינים גם בקובץ קפוא */
function parseCoordSupplements(wb) {
  const sn = wb.SheetNames.find((n) => norm(n).includes('דוח ביצוע'));
  if (!sn) return {};
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null });
  let cols = null;
  const out = {};
  for (const row of rows) {
    const labels = (row || []).map(norm);
    if (!cols) {
      const sup = labels.findIndex((x) => x.includes('תוספת תקצוב רכז') && !x.includes('תקורה'));
      const sym = labels.findIndex((x) => x.includes('סמל בית ספר'));
      if (sup >= 0 && sym >= 0) cols = { sym, sup };
      continue;
    }
    const s = norm(row[cols.sym]);
    if (!/^\d{4,7}$/.test(s)) continue;
    const v = num(row[cols.sup]);
    if (v > 0) out[s] = v;
  }
  return out;
}

/* גנים: תעריפי "מבנה תקציבי גנים" (סטטיים בכל קובץ) + סך הנרשמים מלשונית
   "גנים - מצבת והרשמה" — מסלול אחרון כשגם תאי העזר בריכוז קפואים (אור עקיבא) */
function parseGardenStructureRates(wb, program) {
  const sn = wb.SheetNames.find((n) => norm(n).includes('מבנה תקציב'));
  if (!sn) return null;
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null });
  const daysNeedle = program === 'extension' ? 'ל- 7 ימים' : 'ל- 15 ימים';
  const wantExt = program === 'extension';
  let inGardens = false, cols = null, inExtBlock = false, perChild = null, perGarden = null;
  for (const row of rows) {
    const labels = (row || []).map(norm);
    const has = (t) => labels.findIndex((x) => x.includes(t));
    if (has('מבנה תקציבי גנים') >= 0) { inGardens = true; continue; }
    if (has('מבנה תקציבי בתי ספר') >= 0) break;
    if (!inGardens) continue;
    if (!cols && has('סל ניהול') >= 0 && has('סל הדרכה') >= 0) {
      cols = { management: has('סל ניהול'), instruction: has('סל הדרכה'), enrichment: has('סל העשרה'), flexible: has('סל גמיש') };
      continue;
    }
    if (labels.some((x) => x === 'הרחבה')) inExtBlock = true;
    if (cols && !perChild && inExtBlock === wantExt && has(daysNeedle) >= 0) {
      const v = Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, num(row[i]) || 0]));
      if (v.instruction > 0) perChild = v;
    }
    if (perGarden == null && has('עלות לגן') >= 0) { /* כותרת — הערך בשורה הבאה */ }
    if (perGarden == null && has('שכר עבור ריכוז') >= 0) {
      const nums = row.map((c) => num(c)).filter((v) => v > 0);
      if (nums.length >= 2) perGarden = nums[nums.length - 1]; // "עלות לגן" — האחרון בשורה
    }
  }
  return perChild ? { perChild, perGarden: perGarden || 0 } : null;
}

/* לשונית "גנים - דוח ביצוע (5)": שחזור התא "סה"כ תלמידים לתקצוב לאחר בקרת
   איוש משרות" כשהוא קפוא — פר גן "מס ילדים לחישוב התקציב" (מגלם הפחתת
   ימי-פעילות: min(ביצוע, רשומים) × ימים/7); הערכים סטטיים וזמינים גם
   בקובץ שלא חושב. מחזיר גם את יחס-הימים לסל הרכזות. */
function parseGardenExecKids(wb) {
  const sn = wb.SheetNames.find((n) => norm(n).includes('גנים - דוח ביצוע') || (norm(n).includes('דוח ביצוע') && norm(n).includes('גנים')));
  if (!sn) return null;
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null });
  let cols = null;
  let total = 0, gardens = 0, daysSum = 0;
  const daysBySymbol = {};
  const kidsBySymbol = {};
  for (const row of rows) {
    const labels = (row || []).map(norm);
    if (!cols) {
      const sym = labels.findIndex((x) => x.includes('סמל גן'));
      const kids = labels.findIndex((x) => x.includes('מס ילדים לחישוב'));
      if (sym >= 0 && kids >= 0) {
        cols = {
          sym, kids,
          reg: labels.findIndex((x) => x.includes('תלמידים רשומים')),
          act: labels.findIndex((x) => x.includes('ביצוע בפועל')),
          days: labels.findIndex((x) => x.includes('ימי פעילות בפועל')),
        };
      }
      continue;
    }
    const s = norm(row[cols.sym]);
    if (!/^\d{4,7}$/.test(s)) continue;
    const days = cols.days >= 0 ? (num(row[cols.days]) || 7) : 7;
    let v = num(row[cols.kids]);
    if (!(v > 0)) {
      // התא קפוא — משחזרים מהגלם: min(ביצוע, רשומים) × ימים/7
      const reg = cols.reg >= 0 ? (num(row[cols.reg]) || 0) : 0;
      const act = cols.act >= 0 ? (num(row[cols.act]) || 0) : 0;
      const base = act > 0 && reg > 0 ? Math.min(act, reg) : (act || reg);
      v = base > 0 ? (base * Math.min(days, 7)) / 7 : 0;
    }
    if (v > 0) { total += v; gardens++; daysSum += Math.min(days, 7) / 7; }
    daysBySymbol[s] = Math.min(days, 7) / 7;
    kidsBySymbol[s] = v > 0 ? Math.round(v * 10000) / 10000 : 0;
  }
  if (!cols || !(total > 0)) return null;
  total = Math.round(total * 100) / 100;
  return { total, gardens, dayRatio: gardens > 0 ? daysSum / gardens : 1, daysBySymbol, kidsBySymbol };
}

function parseGardenRegistration(wb) {
  const sn = wb.SheetNames.find((n) => norm(n).includes('מצבת והרשמה') && norm(n).includes('גנים'));
  if (!sn) return null;
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null });
  let cols = null;
  let total = 0, gardens = 0;
  for (const row of rows) {
    const labels = (row || []).map(norm);
    if (!cols) {
      const sym = labels.findIndex((x) => x === 'סמל גן');
      const reg = labels.findIndex((x) => x.includes('שנרשמו'));
      if (sym >= 0 && reg >= 0) cols = { sym, reg };
      continue;
    }
    if (!/^\d{4,7}$/.test(norm(row[cols.sym]))) continue;
    total += num(row[cols.reg]) || 0;
    gardens++;
  }
  return cols ? { total, gardens } : null;
}

/* כמות הנרשמים פר בית ספר מלשונית "מצבת והרשמה" — גיבוי כשגם "דיווח
   הרשות" בבלוקים ריק (קרית מוצקין): המשרד מתקצב לפי הנרשמים. */
function parseRegistrationCounts(wb) {
  const sn = wb.SheetNames.find((n) => norm(n).includes('מצבת והרשמה'));
  if (!sn) return {};
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null });
  let cols = null;
  const out = {};
  for (const row of rows) {
    const labels = (row || []).map(norm);
    if (!cols) {
      const sym = labels.findIndex((x) => x === 'סמל בית ספר' || x === 'סמל גן' || x === 'סמל מוסד');
      const reg = labels.findIndex((x) => x.includes('חינוך רגיל שנרשמו') || x.includes('רגיל שנר'));
      if (sym >= 0 && reg >= 0) {
        cols = {
          sym, reg,
          spec: labels.findIndex((x) => x.includes('מיוחד שנרשמו') || x.includes('מיוחד שנ')),
          large: labels.findIndex((x) => x.includes('גדול')),
        };
      }
      continue;
    }
    const s = norm(row[cols.sym]);
    if (!/^\d{3,}$/.test(s)) continue;
    out[s] = {
      reg: num(row[cols.reg]) || 0,
      spec: cols.spec >= 0 ? (num(row[cols.spec]) || 0) : 0,
      large: cols.large >= 0 && norm(row[cols.large]).includes('כן'),
    };
  }
  return out;
}

/* מפענח קובץ דוח ביצוע → רשימת מוסדות עם תקציב מחושב לכל סל.
   opts.program ('base15'/'extension') משמש את תעריפי הגיבוי של בתי הספר. */
function parseBudgetFile(buf, opts = {}) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheetName = findBudgetSheet(wb);
  if (!sheetName) return { error: 'לא נמצא גיליון "תקצוב לפי מוסד" בקובץ — ודאי שזה קובץ דוח הביצוע של המשרד.' };
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null });

  // גנים: גיליון ריכוז ללא בלוקים פר-מוסד → מסלול מצרפי
  const hasInstBlocks = rows.some((r) => (r || []).some((c) => norm(c) === 'סמל המוסד'));
  if (!hasInstBlocks) return parseAggregateSheet(rows, sheetName, wb, opts);

  const institutions = [];
  let cur = null;
  let cols = null; // עמודות מקטע ההתאמה (נקבעות מהכותרת האחרונה שנראתה)
  let flexMode = false, flexCols = null; // מקטע "בדיקת ניצול תקציב סל גמיש" בתוך הבלוק
  let blockCount = 0, validBlocks = 0; // אבחון: בלוקים קיימים אך בלי סמלים = קובץ לא חוּשב
  let pendingFlexAlloc = null; // "תקצוב סל גמיש לשכר רגיל/רכזים" — הערך בשורה הבאה

  const seenSymbols = new Set();
  const pushCur = () => {
    if (!cur) return;
    // הפחתת הקצאות הגמיש-לשכר מהסלים (הן כלולות בשורות ההתאמה) — הגמיש מוצג בנפרד
    if (cur.flexAlloc) {
      for (const [key, v] of Object.entries(cur.flexAlloc)) {
        if (v > 0 && cur.baskets[key] > 0) cur.baskets[key] = Math.max(0, cur.baskets[key] - v);
      }
    }
    // תבניות מסוימות מכילות בלוקים כפולים ובלוקי-מילוי ריקים שמציגים את
    // הסמל האחרון — מוסד אחד לכל סמל, הבלוק הראשון (האמיתי) גובר
    if (seenSymbols.has(cur.symbol)) return;
    if (cur.total > 0 || Object.keys(cur.baskets).length) {
      seenSymbols.add(cur.symbol);
      institutions.push(cur);
    }
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const labels = row.map(norm);

    // תחילת בלוק מוסד: שורה עם "סמל המוסד" והסמל בתא הסמוך
    const symIdx = labels.findIndex((x) => x === 'סמל המוסד');
    if (symIdx >= 0) {
      blockCount++;
      const symVal = row.slice(symIdx + 1).map((x) => norm(x)).find((x) => /^\d{4,7}$/.test(x));
      if (symVal) {
        validBlocks++;
        pushCur();
        // שם המוסד — התא הטקסטואלי הראשון באותה שורה (לרוב לפני "סמל המוסד")
        const name = row.slice(0, symIdx).map(norm).filter((x) => x && !/^\d+$/.test(x)).pop() || '';
        cur = { symbol: symVal, name: name.replace(/^בית הספר\s*/, ''), size: null, days: null, eligibleReg: null, eligibleSpec: null, baskets: {}, actual: {}, unused: {}, total: 0, totalActual: 0, totalUnused: 0, flexAlloc: { instruction: 0, coordinator: 0 } };
        cols = null; flexMode = false; flexCols = null; pendingFlexAlloc = null; // בלוק חדש — לא יורשים מהקודם
        continue;
      }
    }
    if (!cur) continue;

    // מטא-נתונים
    const li = (needle) => labels.findIndex((x) => x.includes(needle));
    let k;
    if ((k = li('גודל בית הספר')) >= 0) cur.size = norm(row[k + 1]).includes('גדול') ? 'large' : 'small';
    if ((k = li('ימי פעילות')) >= 0 && cur.days == null) cur.days = numNear(row, k);
    if ((k = li('ילדים זכאים ח.רגיל')) >= 0 && cur.eligibleReg == null) cur.eligibleReg = numNear(row, k);
    if ((k = li('ילדים זכאים ח.מיוחד')) >= 0 && cur.eligibleSpec == null) cur.eligibleSpec = numNear(row, k);
    // תבנית ההרחבה: המשרד מסמן "לא תקין" כשגיליון איוש המשרות לא מולא → הזכאות מתאפסת
    if ((k = li('איוש משרות')) >= 0 && norm(row[k + 1]).includes('לא תקין')) cur.staffingInvalid = true;
    // שורות התשלום בתחתית הבלוק (כלל רעות 16.9): "סה"כ לתשלום בתוספת גמישות 25%"
    // + "תוספת סייעות רפואיות או אישיות"; בקובץ קפוא במקום מספר יש טקסט הסבר
    if (cur.paymentTotal == null && (k = li('לתשלום בתוספת גמישות')) >= 0) {
      cur.paymentTotal = numNear(row, k);
      if (cur.paymentTotal == null && !cur.paymentNote) cur.paymentNote = row.slice(k + 1, k + 5).map(norm).find((x) => x) || null;
    }
    if (cur.paymentAides == null && (k = li('תוספת סייעות רפואיות')) >= 0) cur.paymentAides = numNear(row, k);

    // "תקצוב סל גמיש לשכר רגיל/רכזים": שורת ההתאמה "שכר צוות חינוכי" כוללת
    // כבר את הקצאת הגמיש — נחסיר אותה כדי לא לספור את הסל הגמיש פעמיים
    if (pendingFlexAlloc && row[pendingFlexAlloc.col] != null) {
      const v = num(row[pendingFlexAlloc.col]);
      if (v != null) cur.flexAlloc[pendingFlexAlloc.key] += v;
      pendingFlexAlloc = null;
    }
    {
      const jInstr = labels.findIndex((x) => x.includes('תקצוב סל גמיש לשכר רגיל'));
      const jCoord = labels.findIndex((x) => x.includes('תקצוב סל גמיש לשכר רכזים'));
      if (jInstr >= 0) pendingFlexAlloc = { col: jInstr, key: 'instruction' };
      else if (jCoord >= 0) pendingFlexAlloc = { col: jCoord, key: 'coordinator' };
    }
    // "דיווח הרשות" — כמות הילדים שהרשות דיווחה (גם כשהזכאות המחושבת 0);
    // העמודה השנייה — תלמידי חינוך מיוחד (מתוקצבים בתעריף גבוה יותר)
    if ((k = li('דיווח הרשות')) >= 0 && cur.reported == null) {
      cur.reported = num(row[k + 1]);
      cur.reportedSpec = num(row[k + 2]);
    }
    // "ממוצע בקרה" — לתקרת התקצוב: המשרד מתקצב את הנמוך מבין הדיווח לבין בקרה+25%
    if ((k = li('ממוצע בקרה')) >= 0 && cur.controlReg == null) {
      cur.controlReg = num(row[k + 1]);
      cur.controlSpec = num(row[k + 2]);
    }

    // מקטע הסל הגמיש: "בדיקת ניצול תקציב סל גמיש" — תקציבו נלכד כסל flexible
    if (labels.some((x) => x.includes('בדיקת ניצול') && x.includes('סל גמיש'))) { flexMode = true; flexCols = null; continue; }

    // כותרת מקטע ההתאמה הראשי — מזוהה ע"י "אי ניצול תקציב" (המקטע "בדיקת ניצול סל גמיש"
    // מכיל גם "תקציב נורמטיבי" אך לא "אי ניצול", ואין לקלוט ממנו סלים)
    if (labels.some((x) => x.includes('אי ניצול')) && labels.some((x) => x.includes('תקציב נורמטיבי'))) {
      cols = reconColumns(labels);
      flexMode = false;
      continue;
    }

    if (flexMode) {
      if (labels.some((x) => x.includes('תקציב נורמטיבי'))) { flexCols = reconColumns(labels); continue; }
      if (flexCols && flexCols.normative >= 0) {
        const nb = num(row[flexCols.normative]);
        if (nb != null && nb > (cur.baskets.flexible || 0)) {
          cur.baskets.flexible = nb; // סכום הסל
          cur.actual.flexible = flexCols.actual >= 0 ? (num(row[flexCols.actual]) || 0) : 0;
        }
      }
      continue;
    }

    // שורות הסלים במקטע ההתאמה
    if (cols && cols.normative >= 0) {
      // שורת "סה"כ הבלוק" (בדיוק 'סהכ', לא 'סהכ הוצאות לפעילות' ולא 'סהכ נטו')
      const isTotal = labels.some((x) => x === norm('סה"כ'));
      const isSubtotal = labels.some((x) => x.startsWith('סהכ') && x !== norm('סה"כ')); // 'סהכ הוצאות'/'סהכ נטו'/'סהכ סל גמיש'
      // "סה"כ נטו" (אחרי השתתפות הורים) — זה התקציב והניצול שמוצגים במסך
      // הדוח (כלל רעות 16.9): התצוגה זהה לשורה התחתונה של קובץ המשרד
      const isNetRow = labels.some((x) => x === norm('סה"כ נטו'));
      if (isNetRow && cur.totalNet == null) {
        cur.totalNet = num(row[cols.normative]);
        cur.netActual = cols.actual >= 0 ? num(row[cols.actual]) : null;
      }
      if (isTotal && cur.total === 0) {
        const tn = num(row[cols.normative]);
        if (tn != null) {
          cur.total = tn;
          cur.totalActual = cols.actual >= 0 ? (num(row[cols.actual]) || 0) : 0;
          cur.totalUnused = cols.unused >= 0 ? (num(row[cols.unused]) || 0) : 0;
        }
      } else if (!isSubtotal) {
        const labelIdx = labels.findIndex((x) => x && basketForLabel(x));
        if (labelIdx >= 0) {
          const key = basketForLabel(labels[labelIdx]);
          const nb = num(row[cols.normative]);
          if (nb != null && cur.baskets[key] == null) {
            cur.baskets[key] = nb;
            cur.actual[key] = cols.actual >= 0 ? (num(row[cols.actual]) || 0) : 0;
            cur.unused[key] = cols.unused >= 0 ? (num(row[cols.unused]) || 0) : 0;
          }
        }
      }
    }
  }
  pushCur();

  // מטא של הרשות מהגיליון
  let authority = '';
  for (let i = 0; i < 15; i++) {
    const row = rows[i] || [];
    const idx = row.findIndex((x) => norm(x).includes('שם הרשות'));
    if (idx >= 0) { authority = row.slice(idx + 1).map(norm).find((x) => x && x !== '0') || ''; break; }
  }

  // בלוקים קיימים אך אף אחד בלי סמל אמיתי — הקובץ לא חוּשב (נוסחאות קפואות
  // או שלא נבחרה רשות בגיליון "נתונים כלליים")
  const schoolsNotComputed = blockCount > 0 && validBlocks === 0;

  // מכינות קיץ: חישוב המשרד אופס (איוש משרות "לא תקין") — משחזרים לפי
  // נוסחאות הבלוק: זכאים × תעריף-לילד + ימים × תעריף-ליום למוסד, × שיעור
  // הבקרה (כלל רעות 22.9: הגיבוי חל על כל הפרויקטים)
  if (opts.program === 'base' && institutions.length && institutions.every((i) => !(i.total > 0))) {
    const rates = parsePrepRates(rows);
    const exec = parsePrepExec(wb);
    const ctrl = parsePrepControlRates(wb);
    if (rates) {
      for (const inst of institutions) {
        const ex = exec[String(inst.symbol)];
        if (!ex || !(ex.reg > 0 || ex.spec > 0)) continue;
        const q = ctrl[String(inst.symbol)] ?? 1;
        const days = ex.days || inst.days || 0;
        if (ex.large) inst.size = 'large';
        const fx = rates.fixed[ex.large ? 'large' : 'small'] || rates.fixed.small || { management: 0, coordinator: 0 };
        const spec = rates.perChildSpecial;
        const per = (key) => (rates.perChild[key] * ex.reg + (ex.spec > 0 && spec ? spec[key] * ex.spec : 0)) * q;
        const b = inst.baskets;
        b.instruction = Math.round(per('instruction') * 100) / 100;
        b.enrichment = Math.round(per('enrichment') * 100) / 100;
        b.management = Math.round((per('management') + days * (fx.management || 0) * q) * 100) / 100;
        if (fx.coordinator > 0) b.coordinator = Math.round(days * fx.coordinator * q * 100) / 100;
        inst.total = Math.round(Object.values(b).reduce((s, v) => s + (v || 0), 0) * 100) / 100;
        inst.eligibleReg = ex.reg;
        inst.eligibleSpec = ex.spec;
        inst.days = days;
        inst.ratesFallback = true;
      }
    }
  }

  // חישוב המשרד אופס (איוש משרות לא מולא) אך דווחו ילדים — בונים תקציב
  // מטבלת התעריפים הרשמית שבקובץ: לתלמיד × ילדים + קבוע למוסד (רכז/סגן/ניהול)
  if (institutions.length && institutions.every((i) => !(i.total > 0))) {
    const rates = parseSchoolRates(wb, opts.program);
    const regCounts = parseRegistrationCounts(wb);
    const coordSup = parseCoordSupplements(wb);
    // "נתוני עזר" שבגיליון התקצוב — התעריפים המדויקים של הקובץ (עדיף על טבלת המבנה)
    const helper = parseHelperRates(rows);
    if (helper && rates) {
      rates.perChild = helper.perChild;
      if (helper.perChildSpecial && helper.perChildSpecial.instruction > 0) rates.perChildSpecial = helper.perChildSpecial;
    }
    if (rates) {
      // הרחבה: נוסחאות הבלוק בקובץ (פוענחו מאור עקיבא, 17.9) מכפילות פעמיים
      // ביחס הימים: (א) תקרת הבקרה = ממוצע בקרה × ימים/7 × 1.25 (הדיווח בבלוק
      // כבר יחסי-ימים); (ב) כל סל-לתלמיד מוכפל שוב ב-ימים/7; (ג) הקבוע למוסד
      // (ריכוז/ניהול) הוא תעריף-ליום × ימים (ערכי המבנה הם ל-7 ימים).
      const isExt = opts.program === 'extension';
      const daysBySym = isExt ? parseSchoolDays(wb) : {};
      for (const inst of institutions) {
        const regInfo = regCounts[String(inst.symbol)] || null;
        const days = isExt ? (daysBySym[String(inst.symbol)] || inst.days || opts.extensionDays || 7) : 7;
        const df = isExt ? Math.min(days, 7) / 7 : 1;
        // עדיפויות לכמות הילדים: זכאים לאחר בקרה (מגלם הפחתת ימים בהרחבה!)
        // ← דיווח הרשות בבלוק ← נרשמים מלשונית ההרשמה
        let kids = inst.eligibleReg > 0 ? inst.eligibleReg
          : inst.reported > 0 ? inst.reported
          : regInfo ? regInfo.reg : 0;
        if (!(kids > 0)) continue;
        // המשרד מתקצב את הנמוך מבין הדיווח לבין ממוצע הבקרה בתוספת 25%
        // (בהרחבה תקרת הבקרה מוכפלת גם היא ביחס הימים — נוסחת N18 בבלוק)
        if (inst.controlReg > 0) kids = Math.min(kids, inst.controlReg * df * 1.25);
        // תלמידי חינוך מיוחד — מתוקצבים בנפרד בתעריף הגבוה של חנ"מ.
        // "דיווח הרשות" מפורש של 0 נשאר 0 — המשרד מזכה רק את מה שדווח,
        // גם אם בלשונית ההרשמה רשומים תלמידי חנ"מ (מזכרת בתיה)
        let kidsSpec = inst.eligibleSpec > 0 ? inst.eligibleSpec
          : inst.reportedSpec != null ? inst.reportedSpec
          : regInfo ? regInfo.spec : 0;
        if (kidsSpec > 0 && inst.controlSpec > 0) kidsSpec = Math.min(kidsSpec, inst.controlSpec * df * 1.25);
        if (regInfo && regInfo.large) inst.size = 'large';
        inst.eligibleSpec = kidsSpec;
        const fx = rates.fixed[inst.size === 'large' ? 'large' : 'small'] || rates.fixed.small || { coordinator: 0, deputy: 0, management: 0 };
        const spec = rates.perChildSpecial;
        const per = (key) => (rates.perChild[key] * kids + (kidsSpec > 0 && spec ? spec[key] * kidsSpec : 0)) * df;
        const b = inst.baskets;
        b.instruction = Math.round(per('instruction') * 100) / 100;
        b.enrichment = Math.round(per('enrichment') * 100) / 100;
        b.flexible = Math.round(per('flexible') * 100) / 100;
        b.management = Math.round((per('management') + fx.management * df) * 100) / 100;
        if (fx.coordinator > 0) b.coordinator = Math.round(fx.coordinator * df * 100) / 100;
        if (fx.deputy > 0) b.deputy = Math.round(fx.deputy * df * 100) / 100;
        // תוספת תקצוב רכז ד-ו (קיץ פלוס) — ערך פר בי"ס מלשונית "דוח ביצוע (3)"
        const sup = coordSup[String(inst.symbol)];
        if (sup > 0) b.coordinator = Math.round(((b.coordinator || 0) + sup) * 100) / 100;
        inst.total = Math.round(Object.values(b).reduce((s, v) => s + (v || 0), 0) * 100) / 100;
        inst.eligibleReg = kids;
        inst.ratesFallback = true;
      }
    }
  }

  // דיווחי שכר רכז/סגן מלשונית איוש המשרות — לפיצול הניצול במכתב כמו בקובץ
  const staffing = parseStaffing(wb);
  for (const inst of institutions) {
    const st = staffing[String(inst.symbol)];
    if (st && (st.coordReported > 0 || st.depReported > 0 || st.coordBudget > 0 || st.depBudget > 0)) inst.staffing = st;
  }

  return { sheetName, authority, institutions, schoolsNotComputed };
}

/* תעריף לילד חלק ההורים — מופיע בכותרות של כמה לשוניות בקובץ המשרד */
function extractTariff(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', sheetRows: 12 });
  for (const n of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null });
    for (const row of rows) {
      const labels = (row || []).map(norm);
      const k = labels.findIndex((x) => x.includes('תעריף לילד'));
      if (k >= 0) {
        const v = numNear(row, k, 4);
        if (v > 0) return v;
      }
    }
  }
  return null;
}

/* עמודת "זכאות לסגן/נית רכז/ת" בלשונית איוש המשרות — קובעת אם דיווח
   הסגן מוכר בסל הריכוז (מוסד קטן: לא זכאי — העלות לא נזקפת לאף סל) */
function parseDeputyEntitlement(wb) {
  const sn = wb.SheetNames.find((n) => norm(n).includes('איוש משרות'));
  if (!sn) return {};
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null });
  let cols = null;
  const out = {};
  for (const row of rows) {
    const labels = (row || []).map(norm);
    if (!cols) {
      const s = labels.findIndex((x) => x.includes('סמל בית ספר'));
      const z = labels.findIndex((x) => x.includes('זכאות לסגן'));
      if (s >= 0 && z >= 0) cols = { s, z };
      continue;
    }
    const sym = norm(row[cols.s]);
    if (!/^\d{4,7}$/.test(sym)) continue;
    out[sym] = norm(row[cols.z]) === 'זכאי';
  }
  return out;
}

module.exports = { parseBudgetFile, findBudgetSheet, extractTariff, parseGardenExecKids, parseDeputyEntitlement, norm };
