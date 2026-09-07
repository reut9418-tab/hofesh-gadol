/* שיוך סמל מוסד לפי שם (בתי"ס): מציאת המילה המשותפת בין שם המחלקה בדוח
   העלות ("קייטנת רזיאל מורים+רכזת") לבין שם בית הספר בלשונית ההרשמה של
   קובץ המשרד ("רזיאל - נתניה") → הסמל של אותו בי"ס. */

const { norm } = require('./budgetFile');

// מילים גנריות שאינן מזהות מוסד
const STOP = new Set([
  'בית', 'ספר', 'ביס', 'ביהס', 'בי"ס', 'ממ', 'ממד', 'ממלכתי', 'דתי', 'עש', 'על', 'שם',
  'קייטנת', 'קיטנת', 'קייטנות', 'גן', 'גני', 'גנים', 'מורים', 'מורות', 'רכזת', 'רכז', 'שכר',
  'חינוך', 'משרד', 'החינוך', 'הרחבה', 'יום', 'חופש', 'גדול', 'אורות', 'חיים',
]);

const tokenize = (s) => norm(s).split(/[^א-תa-z0-9"']+/i).map((t) => t.replace(/["']/g, '')).filter((t) => t.length >= 2);

/* טוקנים מזהים של כל מוסד: מילות השם, בלי גנריות ובלי מילים שמופיעות
   בהרבה מוסדות (למשל שם העיר שמופיע בכולם). */
function institutionTokens(institutions) {
  const freq = new Map();
  const perInst = institutions.map((inst) => {
    const toks = [...new Set(tokenize(inst.name).filter((t) => !STOP.has(t)))];
    toks.forEach((t) => freq.set(t, (freq.get(t) || 0) + 1));
    return { inst, toks };
  });
  const cutoff = Math.max(2, Math.ceil(institutions.length / 3));
  return perInst.map(({ inst, toks }) => ({ inst, toks: toks.filter((t) => (freq.get(t) || 0) < cutoff) }));
}

/* dept → symbol (או null אם אין התאמה חד-משמעית) */
function matchDeptsToInstitutions(institutions, depts) {
  const indexed = institutionTokens(institutions);
  const out = {};
  for (const dept of depts) {
    const deptToks = new Set(tokenize(dept));
    let best = null, bestLen = 0, ambiguous = false;
    for (const { inst, toks } of indexed) {
      const hit = toks.filter((t) => deptToks.has(t));
      if (!hit.length) continue;
      const len = Math.max(...hit.map((t) => t.length));
      if (len > bestLen) { best = inst; bestLen = len; ambiguous = false; }
      else if (len === bestLen && best && inst.symbol !== best.symbol) ambiguous = true;
    }
    out[dept] = best && !ambiguous ? best.symbol : null;
  }
  return out;
}

module.exports = { matchDeptsToInstitutions, tokenize };
