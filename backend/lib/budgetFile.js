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
function parseAggregateSheet(rows, sheetName) {
  const firstNumAfter = (row, k) => numNear(row, k, 4);
  let authority = '', symbol = '';
  let reg = null, afterControl = null, spec = null, gardens = null, coordinators = null;
  let cols = null, total = 0, totalNet = null, totalActual = 0, netActual = null, totalUnused = 0;
  let totalNormative = 0; // גיבוי: "סה"כ תקציב נורמטיבי" ממקטע העלויות
  let flexMode = false, flexCols = null; // מקטע "בדיקת ניצול תקציב סל גמיש"
  const baskets = {}, actual = {}, unused = {};
  // גיבוי אחרון: התעריפים-לילד ממקטע "עלויות נורמטיביות"/"נתוני עזר" —
  // כשבקרת האיוש של המשרד מאפסת את החישוב, בונים תקציב = הרשמה × תעריף
  let tariffCol = -1, perChildShare = null;
  let rateCols = null, perChildRates = null;
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
    // מקור גיבוי לתקציב: "סה"כ תקציב נורמטיבי" ממקטע העלויות הנורמטיביות
    if ((k = li('סהכ תקציב נורמטיבי')) >= 0) { const v = firstNumAfter(row, k); if (v > 0 && !totalNormative) totalNormative = v; }
    if (gardens == null && (k = li('מספר מוסדות שפעלו')) >= 0) gardens = firstNumAfter(row, k);
    if (coordinators == null && (k = li('זכאות לרכזת')) >= 0) coordinators = firstNumAfter(row, k);

    // תעריף המשרד לילד (מקטע העלויות הנורמטיביות): הכותרת קובעת את העמודה,
    // והערך נלקח משורת "ילדים זכאים לסבסוד"
    if (tariffCol < 0 && (k = li('תעריף לתלמיד גן')) >= 0) tariffCol = k;
    if (perChildShare == null && tariffCol >= 0 && li('זכאים לסבסוד') >= 0) {
      const v = num(row[tariffCol]);
      if (v > 0) perChildShare = v;
    }
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
      if (labels.some((x) => x.includes('תקציב נורמטיבי'))) { flexCols = reconColumns(labels); continue; }
      if (flexCols && flexCols.normative >= 0) {
        const nb = num(row[flexCols.normative]);
        if (nb != null && nb > (baskets.flexible || 0)) {
          baskets.flexible = nb; // סכום הסל (מופיע בשורה הראשונה עם ערך)
          actual.flexible = flexCols.actual >= 0 ? (num(row[flexCols.actual]) || 0) : 0;
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

  // "סה"כ תקצוב" של הגנים = סה"כ נטו (אחרי השתתפות הורים); גיבוי: התקציב הנורמטיבי
  let budget = (totalNet != null && totalNet > 0 ? totalNet : 0) || total || totalNormative;
  // "לאחר בקרת איוש" יכול להיות 0 (אין רכזות מאוישות) בעוד המשרד מתקצב לפי ההרשמה —
  // לכן מעדיפים אותו רק כשהוא חיובי
  const kids = (afterControl > 0 ? afterControl : null) ?? reg;
  // בקרת האיוש של המשרד איפסה את כל החישוב אך ההרשמה מולאה — בונים את
  // התקציב בעצמנו: ילדים × תעריף המשרד לילד, והסלים לפי תעריפי-הסל לילד
  let ratesFallback = false;
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
    eligibleReg: kids, eligibleSpec: spec,
    gardensCount: gardens, coordinators,
    baskets, actual, unused,
    total: budget || 0, totalActual: netActual ?? totalActual, totalUnused,
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

  let inSchools = false, perCols = null, perChild = null, inSpecial = false;
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
    if (has('חנמ') >= 0 || has('חנ"מ') >= 0) inSpecial = true; // לא לוקחים תעריפי חינוך מיוחד
    if (perCols && !perChild && !inSpecial && has(daysNeedle) >= 0) {
      const vals = Object.fromEntries(Object.entries(perCols).map(([k, idx]) => [k, num(row[idx]) || 0]));
      if (vals.instruction > 0) perChild = vals;
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
  return { perChild, fixed };
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
  if (!hasInstBlocks) return parseAggregateSheet(rows, sheetName);

  const institutions = [];
  let cur = null;
  let cols = null; // עמודות מקטע ההתאמה (נקבעות מהכותרת האחרונה שנראתה)
  let flexMode = false, flexCols = null; // מקטע "בדיקת ניצול תקציב סל גמיש" בתוך הבלוק
  let blockCount = 0, validBlocks = 0; // אבחון: בלוקים קיימים אך בלי סמלים = קובץ לא חוּשב

  const pushCur = () => { if (cur && (cur.total > 0 || Object.keys(cur.baskets).length)) institutions.push(cur); };

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
        cur = { symbol: symVal, name: name.replace(/^בית הספר\s*/, ''), size: null, days: null, eligibleReg: null, eligibleSpec: null, baskets: {}, actual: {}, unused: {}, total: 0, totalActual: 0, totalUnused: 0 };
        cols = null; flexMode = false; flexCols = null; // בלוק חדש — לא יורשים עמודות מהבלוק הקודם
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
    // "דיווח הרשות" — כמות הילדים שהרשות דיווחה (גם כשהזכאות המחושבת 0)
    if ((k = li('דיווח הרשות')) >= 0 && cur.reported == null) cur.reported = num(row[k + 1]);

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

  // חישוב המשרד אופס (איוש משרות לא מולא) אך דווחו ילדים — בונים תקציב
  // מטבלת התעריפים הרשמית שבקובץ: לתלמיד × ילדים + קבוע למוסד (רכז/סגן/ניהול)
  if (institutions.length && institutions.every((i) => !(i.total > 0))) {
    const rates = parseSchoolRates(wb, opts.program);
    const regCounts = parseRegistrationCounts(wb);
    if (rates) {
      for (const inst of institutions) {
        const regInfo = regCounts[String(inst.symbol)] || null;
        // עדיפויות לכמות הילדים: דיווח בבלוק ← זכאים ← נרשמים מלשונית ההרשמה
        const kids = inst.reported > 0 ? inst.reported
          : inst.eligibleReg > 0 ? inst.eligibleReg
          : regInfo ? regInfo.reg : 0;
        if (!(kids > 0)) continue;
        if (regInfo && regInfo.large) inst.size = 'large';
        if (!(inst.eligibleSpec > 0) && regInfo && regInfo.spec > 0) inst.eligibleSpec = regInfo.spec;
        const fx = rates.fixed[inst.size === 'large' ? 'large' : 'small'] || rates.fixed.small || { coordinator: 0, deputy: 0, management: 0 };
        const b = inst.baskets;
        b.instruction = Math.round(rates.perChild.instruction * kids * 100) / 100;
        b.enrichment = Math.round(rates.perChild.enrichment * kids * 100) / 100;
        b.flexible = Math.round(rates.perChild.flexible * kids * 100) / 100;
        b.management = Math.round((rates.perChild.management * kids + fx.management) * 100) / 100;
        if (fx.coordinator > 0) b.coordinator = fx.coordinator;
        if (fx.deputy > 0) b.deputy = fx.deputy;
        inst.total = Math.round(Object.values(b).reduce((s, v) => s + (v || 0), 0) * 100) / 100;
        inst.eligibleReg = kids;
        inst.ratesFallback = true;
      }
    }
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

module.exports = { parseBudgetFile, findBudgetSheet, extractTariff, norm };
