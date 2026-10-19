/* פיצול כרטסת העשרה כללית (בלי שם בי"ס ובלי סמל באסמכתא) בין בתי הספר —
   כלל רעות 19.10 (לביא): קודם 75% מסל ההעשרה של כל בית ספר, ואת היתרה
   מוסיפים במקומות שבהם היא תוכר ("תרוויח מזה הכי הרבה"):
     1. השלמה ל-100% מסל ההעשרה בבתי ספר שחריגת השכר שלהם מכוסה (או שאין להם) —
        שם ההעשרה מוכרת במלואה;
     2. הסל הגמיש שנותר פנוי באותם בתי ספר (אחרי שבלע את חריגת השכר);
     3. השלמה ל-100% בבתי ספר עם חריגת שכר לא מכוסה — שם 25% מהסל ממילא
        מוצעים לכיסוי השכר (enrichShift במכתב), ולכן ההעשרה שם אחרונה;
     4. מה שנשאר (מעבר לכל התקרות) — יחסית לילדים, כמו קודם.
   כשסך הכרטסות קטן מ-75% מהסלים — כולם מקבלים אותו חלק יחסי מה-75%.
   משותף למילוי "דוח הוצאות בפועל" בייצוא ולדוח התאמת ההעשרה — אותם מספרים. */
const r2 = (n) => Math.round(n * 100) / 100;

/* חלוקה פרופורציונלית של amount לפי capacity (מפה סמל→קיבולת), עד הקיבולת */
function spread(amount, capacity) {
  const total = [...capacity.values()].reduce((s, v) => s + v, 0);
  const out = new Map();
  if (!(amount > 0) || !(total > 0)) return { out, used: 0 };
  const take = Math.min(amount, total);
  for (const [sym, cap] of capacity) if (cap > 0) out.set(sym, take * (cap / total));
  return { out, used: take };
}

/* insts: [{symbol, name, children_count}] · totalGross: סך הכרטסות הכלליות (כולל מע"מ ללקוח חייב)
   units: יחידות מכתב שלב 1 (symbol, enrichBudget, flexAvailable, uncovered) — תקציבים במונחי המשרד
   מחזיר { method, rows: [{symbol, name, children, budget, floor, fill, flex, rest, amount}] } */
/* mode: 'headroom' — כלל 75%+מיצוי (הגדרת לקוח, clients.enrich_split); אחרת — יחסית לילדים כמו קודם
   (רעות 19.10: "אל תשנה שום דוח חוץ מלביא") */
function allocateGeneralEnrichment(insts, totalGross, units, mode = 'children') {
  const G = r2(totalGross);
  const unitOf = new Map((units || []).filter((u) => u && u.symbol).map((u) => [String(u.symbol), u]));
  const totalChildren = insts.reduce((s, i) => s + (i.children_count || 0), 0);
  const hasBudgets = insts.some((i) => (unitOf.get(String(i.symbol)) || {}).enrichBudget > 0);

  const row = (i) => ({ symbol: i.symbol, name: i.name, children: i.children_count || 0, budget: 0, floor: 0, fill: 0, flex: 0, rest: 0, amount: 0 });
  const rows = new Map(insts.map((i) => [String(i.symbol), row(i)]));
  const add = (field, alloc) => { for (const [sym, v] of alloc) { const r = rows.get(sym); r[field] += v; r.amount += v; } };

  if (mode !== 'headroom' || !hasBudgets || !(G > 0)) {
    // לקוח בלי הכלל, או בלי תקציבי העשרה (קובץ משרד בלי סלים) — פיצול יחסי לילדים כמו קודם
    const cap = new Map(insts.map((i) => [String(i.symbol), (totalChildren > 0 ? (i.children_count || 0) : 1) * 1e9])); // משקלים — בלי תקרה
    add('rest', spread(G, cap).out);
    return finish('children', rows, G);
  }

  for (const r of rows.values()) r.budget = (unitOf.get(String(r.symbol)) || {}).enrichBudget || 0;
  // שלב 0: 75% מהסל לכולם (או חלק יחסי מה-75% כשהכרטסות קטנות מזה)
  const floors = new Map([...rows].map(([s, r]) => [s, 0.75 * r.budget]));
  const f = spread(G, floors);
  add('floor', f.out);
  let left = r2(G - f.used);
  if (left > 0) {
    const covered = (s) => !((unitOf.get(s) || {}).uncovered > 0);
    const pools = [
      ['fill', new Map([...rows].filter(([s]) => covered(s)).map(([s, r]) => [s, 0.25 * r.budget]))],
      ['flex', new Map([...rows].filter(([s]) => covered(s)).map(([s]) => [s, Math.max(0, (unitOf.get(s) || {}).flexAvailable || 0)]))],
      ['fill', new Map([...rows].filter(([s]) => !covered(s)).map(([s, r]) => [s, 0.25 * r.budget]))],
      ['rest', new Map(insts.map((i) => [String(i.symbol), totalChildren > 0 ? (i.children_count || 0) : 1]))],
    ];
    for (const [field, cap] of pools) {
      if (!(left > 0)) break;
      const p = spread(left, field === 'rest' ? new Map([...cap].map(([s, w]) => [s, w * 1e9])) : cap); // rest — בלי תקרה
      add(field, p.out);
      left = r2(left - p.used);
    }
  }
  return finish('headroom', rows, G);
}

/* עיגול לאגורות עם סגירת ההפרש בבית הספר הגדול ביותר — הסה"כ שווה בדיוק לכרטסת */
function finish(method, rows, G) {
  const list = [...rows.values()];
  for (const r of list) for (const k of ['floor', 'fill', 'flex', 'rest']) r[k] = r2(r[k]);
  for (const r of list) r.amount = r2(r.floor + r.fill + r.flex + r.rest);
  const diff = r2(G - list.reduce((s, r) => s + r.amount, 0));
  if (diff !== 0 && list.length) {
    const big = list.reduce((a, b) => (b.amount > a.amount ? b : a));
    big.amount = r2(big.amount + diff);
    const k = big.rest > 0 ? 'rest' : big.fill > 0 ? 'fill' : 'floor';
    big[k] = r2(big[k] + diff);
  }
  return { method, rows: list };
}

/* יחידות שלב 1 לדוח (תקציבי ההעשרה, הגמיש הפנוי וחריגת השכר הלא מכוסה פר בי"ס);
   כישלון → ריק (ואז הפיצול יחסי לילדים) */
async function enrichUnits(db, report, client, authority) {
  if (!client || client.enrich_split !== 'headroom') return []; // הכלל לא פעיל ללקוח — אין צורך ביחידות המכתב
  try {
    const { stage1Data } = require('./stage1');
    const s1 = await stage1Data(db, report, client, authority);
    return (s1.units || []).map((u) => ({ symbol: u.symbol, enrichBudget: u.enrichBudget || 0, flexAvailable: u.flexAvailable || 0, uncovered: u.uncovered || 0 }));
  } catch (e) {
    console.warn('enrichAlloc: stage1 units failed —', e.message);
    return [];
  }
}

module.exports = { allocateGeneralEnrichment, enrichUnits };
