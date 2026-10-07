/* כרטיס כרטסת מאוחד — פיצול לפי תנועות (רעות 7.10, ביתר): כשלתנועות של
   כרטיס כתוב סמל מוסד באסמכתא (אסמ'/אסמ'2/פרטים), הכרטיס מתחלק בין בתי
   הספר לפי התנועות, וכל חלק מתנהג כמו כרטסת נפרדת של אותו בית ספר.
   - סמל נחשב רק אם הוא קיים ברשימת המוסדות של הדוח (מספרי חשבונית
     בני 5–7 ספרות אינם סמלים).
   - תנועה בלי סמל בכרטיס מפוצל: ממתינה לשיוך ידני (symbol_override) —
     לא מחולקת ולא נזקפת; מוצגת כהתראה.
   - תנועת זכות עם סמל מפחיתה מאותו בית ספר.
   - כרטיס שאף תנועה שלו לא נושאת סמל אינו "מפוצל" — מתנהג כמו היום
     (שם הכרטיס / שיוך ידני / פיצול יחסי). שיוך ידני של הכרטיס כולו לבית
     ספר אחד גובר על הפיצול. */

const r2 = (n) => Math.round((n || 0) * 100) / 100;

async function loadTx(db, cardIds) {
  if (!cardIds.length) return new Map();
  const ph = cardIds.map(() => '?').join(',');
  const rows = await db.prepare(`SELECT * FROM ledger_card_tx WHERE card_id IN (${ph}) ORDER BY id`).all(...cardIds);
  const m = new Map();
  for (const t of rows) {
    if (!m.has(t.card_id)) m.set(t.card_id, []);
    m.get(t.card_id).push(t);
  }
  return m;
}

/* לכל כרטיס: { isSplit, bySymbol: {סמל: נטו}, unassignedNet, unassignedCount, txCount, tx: [...] }
   institutions — מוסדות הדוח ({symbol}); cards — שורות ledger_cards */
async function cardSplits(db, cards, institutions) {
  const valid = new Set((institutions || []).map((i) => String(i.symbol)));
  const txByCard = await loadTx(db, cards.map((c) => c.id));
  const out = new Map();
  for (const c of cards) {
    const tx = txByCard.get(c.id) || [];
    const txOut = tx.map((t) => {
      let refs = [];
      try { refs = JSON.parse(t.refs || '[]'); } catch { refs = []; }
      const inRefs = [...new Set(refs.map(String).filter((s) => valid.has(s)))];
      const auto = inRefs.length === 1 ? inRefs[0] : null;
      const manual = t.symbol_override && valid.has(String(t.symbol_override)) ? String(t.symbol_override) : null;
      return {
        id: t.id, details: t.details || '', debit: Number(t.debit) || 0, credit: Number(t.credit) || 0,
        net: r2((Number(t.debit) || 0) - (Number(t.credit) || 0)),
        symbol: manual || auto, method: manual ? 'manual' : auto ? 'ref' : null,
        ambiguous: inRefs.length > 1 ? inRefs : null,
      };
    });
    // שיוך ידני של הכרטיס כולו לבית ספר אחד גובר על הפיצול
    const wholeCardManual = c.symbol_override && c.symbol_override !== 'general' && valid.has(String(c.symbol_override));
    const isSplit = !wholeCardManual && valid.size > 0 && txOut.some((t) => t.method === 'ref');
    const bySymbol = {};
    let unassignedNet = 0, unassignedCount = 0;
    if (isSplit) {
      for (const t of txOut) {
        if (t.symbol) bySymbol[t.symbol] = r2((bySymbol[t.symbol] || 0) + t.net);
        else { unassignedNet = r2(unassignedNet + t.net); unassignedCount++; }
      }
    }
    out.set(c.id, { isSplit, bySymbol, unassignedNet, unassignedCount, txCount: txOut.length, tx: txOut });
  }
  return out;
}

module.exports = { cardSplits };
