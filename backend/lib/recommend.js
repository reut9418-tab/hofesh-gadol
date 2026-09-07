/* מנוע ההמלצות (README §5, צעד 8) — ניוד דיווח עובדים בין סמלי מוסד בבתי ספר
   למיצוי מלא של התקציב. כל מוסד הוא משק כספים סגור (§1): תקרת השכר שלו =
   סל שכר הצוות (מובילות/מורים) + הסל הגמיש שלו. כשמוסד אחד חורג מהתקרה
   ומוסד אחר בתת-ביצוע — מציעים להעביר עובדים מהחורג אל הפנוי.
   ההמלצה היא על שורת הדיווח בלבד; ההחלטה המקצועית נשארת בידי המשתמשת. */

const { suggestRole, basketForStaff } = require('./salaryCheck');

/* הלוגיקה הטהורה — ניתנת לבדיקה בנפרד.
   insts: [{symbol, name, cap}] ; workers: [{rowId, name, cost, symbol}] (רק צוות הדרכה, עם סמל) */
function computeMoves(insts, workers) {
  const bySym = new Map();
  insts.forEach((i) => bySym.set(String(i.symbol), { ...i, symbol: String(i.symbol), actual: 0 }));
  const pool = workers.filter((w) => w.symbol && bySym.has(String(w.symbol)) && (w.cost || 0) > 0)
    .map((w) => ({ ...w, symbol: String(w.symbol) }));
  pool.forEach((w) => { bySym.get(w.symbol).actual += w.cost; });

  const state = [...bySym.values()];
  const over = (i) => Math.max(0, i.actual - i.cap);
  const slack = (i) => Math.max(0, i.cap - i.actual);
  const overflowBefore = state.reduce((s, i) => s + over(i), 0);

  const moves = [];
  const moved = new Set();
  // חמדני: בכל צעד — ההעברה עם הרווח-נטו הגבוה ביותר
  // (הקטנת החריגה במקור פחות חריגה חדשה שנוצרת ביעד); בשוויון — העובד הקטן יותר.
  for (let guard = 0; guard < 500; guard++) {
    const sources = state.filter((i) => over(i) > 0);
    if (!sources.length) break;
    let best = null;
    for (const src of sources) {
      const candidates = pool.filter((w) => w.symbol === src.symbol && !moved.has(w.rowId));
      for (const w of candidates) {
        const reduction = Math.min(w.cost, over(src));
        if (reduction <= 0) continue;
        for (const t of state) {
          if (t.symbol === src.symbol || slack(t) <= 0) continue;
          const penalty = Math.max(0, w.cost - slack(t)); // חריגה חדשה שתיווצר ביעד
          const gain = reduction - penalty;
          if (gain <= 0) continue;
          if (!best || gain > best.gain || (gain === best.gain && w.cost < best.w.cost)) {
            best = { src, w, t, gain, reduction };
          }
        }
      }
    }
    if (!best) break; // אין העברה שמקטינה את החריגה הכוללת
    const { src, w, t, reduction } = best;
    moves.push({ rowId: w.rowId, name: w.name, cost: w.cost, from: src.symbol, fromName: src.name, to: t.symbol, toName: t.name, reduces: reduction });
    src.actual -= w.cost;
    t.actual += w.cost;
    w.symbol = t.symbol;
    moved.add(w.rowId);
  }

  const overflowAfter = state.reduce((s, i) => s + over(i), 0);
  return {
    perInst: state.map((i) => ({ symbol: i.symbol, name: i.name, cap: i.cap, actual: i.actual, over: over(i), slack: slack(i) }))
      .sort((a, b) => b.over - a.over || b.actual - a.actual),
    moves, overflowBefore, overflowAfter,
    recovered: overflowBefore - overflowAfter, // הכסף שההמלצות מחזירות להכרה
  };
}

/* עטיפת ה-DB: בונה תקרות פר-מוסד ועובדי-הדרכה משויכים, ומריץ את הלוגיקה */
async function recommendations(db, report) {
  if (report.framework === 'gardens') {
    return { relevant: false, reason: 'בגנים התקצוב הוא סל אחד לכל הרשות — אין ניוד בין סמלים.' };
  }
  const instRows = await db.prepare('SELECT id, symbol, name FROM institutions WHERE report_id = ?').all(report.id);
  if (instRows.length < 2) {
    return { relevant: false, reason: 'נדרשים לפחות שני מוסדות עם תקציב (מקובץ דוח הביצוע) כדי להציע ניוד.' };
  }
  const insts = [];
  for (const i of instRows) {
    const cap = Number((await db.prepare(
      `SELECT COALESCE(SUM(budget_amount),0) a FROM baskets
       WHERE institution_id = ? AND basket_type IN ('instruction','flexible')`
    ).get(i.id)).a);
    if (cap > 0) insts.push({ symbol: i.symbol, name: i.name, cap });
  }
  if (insts.length < 2) {
    return { relevant: false, reason: 'לא נמצאו תקציבי סלי שכר פר-מוסד — ודאי שקובץ דוח הביצוע נקלט.' };
  }

  // רק עובדי סל ההדרכה (מורים/מובילות/סייעות) — רכז/סגן צמודים למוסד ולא מנוידים.
  // עובדים שהלקוח דחה עבורם ניוד (move_declined) לא מוצעים שוב.
  const workers = (await db.prepare(
    'SELECT id, emp_name, dept, staff_type, symbol_override, cost FROM cost_rows WHERE report_id = ? AND COALESCE(move_declined,0) = 0'
  ).all(report.id))
    .filter((r) => basketForStaff(r.staff_type || suggestRole(r.dept).staffType) === 'instruction')
    .map((r) => ({ rowId: r.id, name: r.emp_name || '', cost: r.cost || 0, symbol: r.symbol_override }));

  const unassigned = workers.filter((w) => !w.symbol).length;
  const result = computeMoves(insts, workers);
  return { relevant: true, unassigned, ...result };
}

module.exports = { recommendations, computeMoves };
