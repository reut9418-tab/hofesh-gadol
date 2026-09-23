/* קליטת כרטסת הנהלת חשבונות מקובץ PDF (בקשת רעות 23.9) — אותו מבנה חשבשבת
   כמו האקסל: כותרת כרטיס [שם | מפתח חשבון | קוד מיון], תנועות, ואז
   "סה"כ מפתח חשבון" ושורות "חובה <סכום>" / "זכות <סכום>".
   הטקסט מחולץ עם pdfjs ומקובץ לשורות לפי קואורדינטת Y (סבילות ±2),
   והתאים ממוינים מימין לשמאל (RTL). הסכומים נלקחים משורות הסיכום של
   כל כרטיס — לא מסכימת התנועות (בעמודת "חובה / זכות" המשולבת של ה-PDF
   אי אפשר להבחין בין חובה לזכות ברמת התנועה). */

const norm = (s) => String(s ?? '').replace(/["'״׳]/g, '').replace(/\s+/g, ' ').trim();

/* סכום כספי מתוך תא: "69,857.10" / "-150,311.50" / "1,000" */
const money = (s) => {
  const m = String(s ?? '').replace(/\s/g, '').match(/^-?[\d,]+(?:\.\d{1,2})?$/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/* עמודי ה-PDF → מערך שורות, כל שורה מערך תאים מימין לשמאל */
async function pdfLines(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true }).promise;
  const lines = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const rows = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const y = it.transform[5], x = it.transform[4];
        let row = rows.find((r) => Math.abs(r.y - y) <= 2);
        if (!row) { row = { y, items: [] }; rows.push(row); }
        row.items.push({ x, s: it.str.trim() });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) lines.push(r.items.sort((a, b) => b.x - a.x).map((i) => i.s));
    }
  } finally { await doc.destroy(); }
  return lines;
}

/* מפענח PDF של כרטסת → { cards: [{key, name, debit, credit, net, txCount}] }
   בפריסת ה-PDF שורת "חובה <סה"כ>" מופיעה לפני שורת "סה"כ מפתח חשבון"
   ו"זכות" אחריה — לכן הסכומים נלכדים בכל שלב, והכרטיס נסגר ב"הפרש"/כותרת
   כרטיס חדש/סוף הקובץ. כרטיס שנמשך לעמוד הבא (הכותרת חוזרת) — ממוזג. */
async function parseLedgerPdf(buf) {
  const lines = await pdfLines(buf);
  const cards = [];
  let cur = null;
  const pushCur = () => {
    if (cur && cur.txCount > 0) { cur.net = cur.debit - cur.credit; cards.push(cur); }
    cur = null;
  };
  for (const cells of lines) {
    if (!cells.length) continue;
    const c0 = norm(cells[0]), c1 = norm(cells[1] ?? '');
    // תחילת כרטיס: [שם עברי | מפתח חשבון מספרי | (קוד מיון)]
    if (/[א-ת]/.test(c0) && /^\d{3,12}$/.test(c1) && !c0.includes('סהכ') && !c0.includes('יתרת פתיחה')) {
      // המשך אותו כרטיס אחרי מעבר עמוד — הכותרת חוזרת, לא כרטיס חדש
      if (cur && cur.key === c1) continue;
      pushCur();
      cur = { key: c1, name: c0, debit: 0, credit: 0, net: 0, txCount: 0 };
      continue;
    }
    if (!cur) continue;
    // שורות הסיכום של הכרטיס: "חובה <סכום>" / "זכות <סכום>"
    const amt = money(norm(cells[1] ?? '')) ?? money(norm(cells[2] ?? ''));
    if (c0 === 'חובה') { if (amt != null) cur.debit = amt; continue; }
    if (c0 === 'זכות') { if (amt != null) cur.credit = amt; continue; }
    if (c0.includes('הפרש')) { pushCur(); continue; }
    if (c0.includes('סהכ מפתח חשבון') || c0.includes('יתרת פתיחה') || c0.includes('כותרת')) continue;
    // שורת תנועה: מכילה סכום כספי
    if (cells.some((c) => money(norm(c)) !== null)) cur.txCount++;
  }
  pushCur();
  // מיזוג כרטיסים כפולים (כרטיס שנפרס על כמה עמודים ונסגר בתווך)
  const byKey = new Map();
  for (const c of cards) {
    const prev = byKey.get(c.key);
    if (!prev) { byKey.set(c.key, { ...c }); continue; }
    prev.txCount += c.txCount;
    if (c.debit || c.credit) { prev.debit = c.debit; prev.credit = c.credit; }
    prev.net = prev.debit - prev.credit;
  }
  return { cards: [...byKey.values()] };
}

const isPdfBuffer = (buf) => Buffer.isBuffer(buf) && buf.slice(0, 5).toString('latin1') === '%PDF-';

module.exports = { parseLedgerPdf, isPdfBuffer };
