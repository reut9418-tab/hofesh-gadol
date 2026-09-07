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

/* שיוך סל לפי שם הכרטסת. "שכר מורים+רכז" הוא כרטיס שכר משולב → הדרכה. */
function basketForCardName(name) {
  const n = norm(name);
  if (!n) return null;
  if (/הכנסות|גביה|גבייה|תשלומי הורים/.test(n)) return 'income';
  if (/העשרה|פעילות/.test(n)) return 'enrichment'; // "פעילות" בשם כרטסת = העשרה
  if (/אבטחה/.test(n)) return 'security';
  if (/ארוחת/.test(n)) return 'breakfast';
  if (/מלגות/.test(n)) return 'scholarships';
  if (/ניהול|תקורה|תפעול|הנהלה/.test(n)) return 'management';
  if (/גמיש/.test(n)) return 'flexible';
  if (/סגן/.test(n)) return 'deputy';
  if (/רכז/.test(n) && !/מור|מוביל|סייע/.test(n)) return 'coordinator';
  if (/שכר|משכורת|מוביל|סייע|גננ|מור/.test(n)) return 'instruction';
  return null;
}

/* תוויות הסלים לתצוגה */
const BASKET_HE = {
  instruction: 'שכר הדרכה (מובילות/מורים)',
  coordinator: 'שכר רכזים/רכזות',
  deputy: 'שכר סגני רכזים',
  enrichment: 'העשרה',
  flexible: 'סל גמיש',
  security: 'אבטחה',
  breakfast: 'ארוחת בוקר',
  scholarships: 'מלגות',
  management: 'ניהול ותפעול',
  overhead: 'תקורה',
  income: 'הכנסות משתתפים (גבייה מהורים)', // ללשונית תשלומי ההורים — לא נכלל בהתאמת ההוצאות
};
const SALARY_BASKET_TYPES = ['instruction', 'coordinator', 'deputy'];

/* מפענח קובץ כרטסת → [{key, name, debit, credit, net, txCount}] */
function parseLedgerFile(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const cards = [];
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null });
    // עמודות חובה/זכות משורת הכותרות
    let debitCol = -1, creditCol = -1;
    for (let i = 0; i < Math.min(rows.length, 15) && debitCol < 0; i++) {
      (rows[i] || []).forEach((c, j) => {
        const n = norm(c);
        if (/חובה/.test(n) && !/זכות$/.test(n) && debitCol < 0 && n.includes('חובה')) debitCol = j;
        if (n.endsWith('זכות') && creditCol < 0) creditCol = j;
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
        cur = { key: c1, name: c0, debit: 0, credit: 0, net: 0, txCount: 0 };
        continue;
      }
      if (!cur) continue;
      const d = num(row[debitCol]), c = num(row[creditCol]);
      if (d === null && c === null) continue; // יתרת פתיחה / שורות טקסט
      cur.debit += d || 0;
      cur.credit += c || 0;
      cur.txCount++;
    }
    pushCur();
  }
  return { cards };
}

module.exports = { parseLedgerFile, basketForCardName, BASKET_HE, SALARY_BASKET_TYPES };
