/* קליטת כרטסות הנהלת חשבונות (README §14 צעד 6) — פורמט חשבשבת:
   כל כרטיס נפתח בשורת [שם | מפתח חשבון | קוד מיון], אחריה תנועות
   (חובה/זכות), ונסגר ב"סה"כ מפתח חשבון". ההוצאה נטו = חובה − זכות.
   השיוך לסל נגזר משם הכרטסת (מילות מפתח) + מיפוי נלמד לכל לקוח. */

const XLSX = require('xlsx');
const { norm } = require('./budgetFile');

const num = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/,/g, '');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null; // טקסט כמו "36,170.00 חובה" נפסל
  return Number(s);
};

/* שיוך סל לפי שם הכרטסת. "שכר מורים+רכז" = כרטיס שכר משולב → סל השכר
   המשולב (כלל רעות 24.9) — נספר בהשוואות השכר יחד עם הדרכה וריכוז. */
function basketForCardName(name) {
  const n = norm(name);
  if (!n) return null;
  if (/הכנסות|גביה|גבייה|תשלומי הורים/.test(n)) return 'income';
  // סלי המכינות — לפני כלל ה"פעילות" הכללי (פעילות חוץ = יום סיור, לא העשרה);
  // בבתי"ס/גנים אין הסלים האלה — המסנן בהעלאה מאפס אותם שם
  if (/סיור|טיול|פעילות חוץ/.test(n)) return 'trip';
  if (/בינה מלאכותית/.test(n) || /(^|[^a-zA-Z])ai([^a-zA-Z]|$)/i.test(n)) return 'ai';
  if (/העשרה|פעילות/.test(n)) return 'enrichment'; // "פעילות" בשם כרטסת = העשרה
  // חומרי יצירה והדפסות = העשרה (כלל רעות 6.10)
  if (/יצירה|הדפס/.test(n)) return 'enrichment';
  if (/אבטחה/.test(n)) return 'security';
  if (/ארוחת/.test(n)) return 'breakfast';
  if (/מלגות/.test(n)) return 'scholarships';
  if (/ניהול|תקורה|תפעול|הנהלה/.test(n)) return 'management';
  // כרטסת "סל גמיש" משויכת כברירת מחדל לארוחות בוקר (כלל רעות 6.10) — זה
  // הייעוד שלה בקובץ המשרד; אפשר לשנות ידנית והשינוי נלמד
  if (/גמיש/.test(n)) return 'breakfast';
  if (/סג[נן]/.test(n)) return 'deputy'; // נו"ן רגילה וסופית — "סגן" וגם "סגני/סגנית"
  // כרטסת משולבת: גם רכז וגם מילת צוות באותו שם ("שכר מורים+רכז", "שכר גננות
  // ורכזות") — "שכר רכזים" לבדו נשאר סל ריכוז
  if (/רכז/.test(n) && /מור|מוביל|סייע|גננ|צוות/.test(n)) return 'salary_combined';
  if (/רכז/.test(n)) return 'coordinator';
  if (/שכר|משכורת|מוביל|סייע|גננ|מור/.test(n)) return 'instruction';
  return null;
}

/* תוויות הסלים לתצוגה */
const BASKET_HE = {
  instruction: 'שכר הדרכה (מובילות/מורים)',
  coordinator: 'שכר רכזים/רכזות',
  salary_combined: 'שכר הדרכה + ריכוז (כרטסת משולבת)', // כרטסת שכר אחת לצוות ולרכזים
  deputy: 'שכר סגני רכזים',
  enrichment: 'העשרה',
  flexible: 'סל גמיש',
  security: 'אבטחה',
  breakfast: 'ארוחת בוקר',
  scholarships: 'מלגות',
  management: 'ניהול ותפעול',
  overhead: 'תקורה',
  trip: 'פעילות חוץ (יום סיור)', // מכינות: "סל פעילות חוץ (1 יום סיור לימודי/חברתי)"
  ai: 'סל AI',                    // מכינות: "סל AI (ארבעה ימי פעילות)"
  income: 'הכנסות משתתפים (גבייה מהורים)', // ללשונית תשלומי ההורים — לא נכלל בהתאמת ההוצאות
};
const SALARY_BASKET_TYPES = ['instruction', 'coordinator', 'deputy', 'salary_combined'];

/* רשימת השיוך במסך שלב 2 לפי סוג הפרויקט (כלל רעות 22.9): הרשימה של כל
   פרויקט = הרשימה הנפתחת בלשונית "דוח הוצאות בפועל" של תבנית המשרד + סלי
   השכר. במכינות (לשונית "סיווג התפקידים והעלויות"): העשרה, מלגות להורים,
   ניהול ותפעול, פעילות חוץ (יום סיור), AI — ושכר הדרכה/רכזים/סגנים. */
const PREP_BASKET_HE = {
  instruction: 'שכר הדרכה (צוות חינוכי)',
  coordinator: 'שכר רכזים (סל ריכוז)',
  salary_combined: 'שכר הדרכה + ריכוז (כרטסת משולבת)',
  deputy: 'שכר סגני רכזים',
  enrichment: 'העשרה',
  scholarships: 'מלגות להורים',
  management: 'ניהול ותפעול',
  trip: 'פעילות חוץ (יום סיור)',
  ai: 'סל AI',
  income: BASKET_HE.income,
};
// בתי"ס/גנים — הרשימה כפי שהייתה (בלי סלי המכינות)
const SCHOOLS_GARDENS_KEYS = ['instruction', 'coordinator', 'salary_combined', 'deputy', 'enrichment',
  'flexible', 'security', 'breakfast', 'scholarships', 'management', 'overhead', 'income'];
function basketOptionsFor(framework) {
  if (framework === 'prep') return Object.entries(PREP_BASKET_HE).map(([value, label]) => ({ value, label }));
  return SCHOOLS_GARDENS_KEYS.map((k) => ({ value: k, label: BASKET_HE[k] }));
}

/* מספרים שיכולים להיות סמל מוסד (5–7 ספרות) בתוך תא — "112102", "סמל 484402" */
const symbolCandidates = (v) => (String(v ?? '').match(/(?<!\d)\d{5,7}(?!\d)/g) || []);

/* מפענח קובץ כרטסת → [{key, name, debit, credit, net, txCount, tx}]
   tx — התנועות של הכרטיס: { refs: מועמדי סמל מעמודות אסמ'/אסמ'2/פרטים,
   details, debit, credit } — לכרטיס מאוחד שבו סמל בית הספר כתוב באסמכתא
   של כל תנועה (ביתר 7.10: "העשרה - רישמי" עם 5 בתי ספר) */
function parseLedgerFile(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const cards = [];
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null });
    // עמודות חובה/זכות (+אסמכתאות/פרטים) משורת הכותרות
    let debitCol = -1, creditCol = -1;
    const refCols = [];
    let detailsCol = -1;
    for (let i = 0; i < Math.min(rows.length, 15) && debitCol < 0; i++) {
      (rows[i] || []).forEach((c, j) => {
        const n = norm(c);
        if (/חובה/.test(n) && !/זכות$/.test(n) && debitCol < 0 && n.includes('חובה')) debitCol = j;
        if (n.endsWith('זכות') && creditCol < 0) creditCol = j;
        if (/^אסמ/.test(n)) refCols.push(j); // "אסמ'", "אסמ'2", "אסמכתא" — לא "ת.אסמכ"
        if (n === 'פרטים' && detailsCol < 0) detailsCol = j;
      });
    }
    if (debitCol < 0 || creditCol < 0) continue; // לא לשונית כרטסת

    let cur = null;
    const pushCur = () => { if (cur && cur.txCount > 0) { cur.net = cur.debit - cur.credit; cards.push(cur); } };
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || [];
      const c0 = norm(row[0]), c1 = norm(row[1]);
      // סוף כרטיס
      if (c0.includes('סהכ מפתח חשבון')) { pushCur(); cur = null; continue; }
      // תחילת כרטיס: [0] שם, [1] מפתח חשבון מספרי
      if (c0 && /^\d{3,12}$/.test(c1) && !c0.includes('סהכ')) {
        pushCur();
        cur = { key: c1, name: c0, debit: 0, credit: 0, net: 0, txCount: 0, tx: [] };
        continue;
      }
      if (!cur) continue;
      const d = num(row[debitCol]), c = num(row[creditCol]);
      if (d === null && c === null) continue; // יתרת פתיחה / שורות טקסט
      cur.debit += d || 0;
      cur.credit += c || 0;
      cur.txCount++;
      const details = detailsCol >= 0 ? norm(row[detailsCol]) : '';
      const refs = [...new Set([...refCols.flatMap((j) => symbolCandidates(row[j])), ...symbolCandidates(details)])];
      cur.tx.push({ refs, details, debit: d || 0, credit: c || 0 });
    }
    pushCur();
  }
  return { cards };
}

module.exports = { symbolCandidates, parseLedgerFile, basketForCardName, BASKET_HE, SALARY_BASKET_TYPES, basketOptionsFor };
