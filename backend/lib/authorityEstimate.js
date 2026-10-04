/* הערכת עלות שכר רשות (כלל רעות 4.10.2026): כשהרשות לא מעבירה דוח עלות
   (סייעות רשות וכד'), נרשמת במסך הדוח הערכה — הסכום הסופי כפי שיופיע בדוח
   הביצוע (בלי תוספת מע"מ ובלי תקרת 140%). ההערכה משפיעה על המכתב בלבד (וכך
   גם על דוח שלב 2 שנבנה ממנו): ניצול השכר מול הסלים, הסל הגמיש, היתרות
   והמלצות הניוד. היא לא נכנסת לקובץ המשרד ולא ליעדי הכרטסות של המפעיל —
   דוח הביצוע מושפע רק כשמעלים דוח עלות אמיתי של הרשות.
   גנים: סכום אחד במרוכז. בתי"ס: סכום פר סמל מוסד שנבחר ידנית (בלי פיצול
   לפי ילדים). */

function parseSplit(raw) {
  if (!raw) return null;
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const clean = {};
    Object.entries(o || {}).forEach(([k, v]) => { const n = Number(v); if (String(k).trim() && n > 0) clean[String(k).trim()] = n; });
    return Object.keys(clean).length ? clean : null;
  } catch { return null; }
}

/* מחזיר null כשאין הערכה */
function authorityEstimate(report) {
  if (!report) return null;
  const basket = report.authority_estimate_basket === 'coordinator' ? 'coordinator' : 'instruction';
  const note = report.authority_estimate_note || '';
  if (report.framework === 'gardens') {
    const total = Number(report.authority_estimate) || 0;
    if (!(total > 0)) return null;
    return { total, basket, note, bySymbol: () => total };
  }
  const perSymbol = parseSplit(report.authority_estimate_split);
  if (!perSymbol) return null;
  const total = Object.values(perSymbol).reduce((s, v) => s + v, 0);
  return { total, basket, note, perSymbol, bySymbol: (symbol) => perSymbol[String(symbol)] || 0 };
}

module.exports = { authorityEstimate, parseSplit };
