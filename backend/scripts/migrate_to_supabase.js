/* העברת כל הנתונים מהמסד המקומי (chofesh.db) ל-Supabase Postgres — חד-פעמי.
   הרצה (אחרי הגדרת DATABASE_URL ב-backend/.env):
     node scripts/migrate_to_supabase.js
   הסקריפט מרוקן את הטבלאות בענן, מעתיק את כל הנתונים כולל המזהים,
   ומכוון את רצפי ה-id להמשך תקין. אין להריץ בזמן שהשרת המקומי כותב. */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const { schemaSQL } = require('../db');

const TABLES = [
  'clients', 'authorities', 'reports', 'institutions', 'baskets', 'transactions',
  'client_mappings', 'cost_files', 'cost_rows', 'ledger_files', 'ledger_cards',
];

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('חסר DATABASE_URL ב-backend/.env — יש להדביק את מחרוזת החיבור של Supabase.');
    process.exit(1);
  }
  const DB_PATH = path.join(__dirname, '..', 'chofesh.db');
  if (!fs.existsSync(DB_PATH)) { console.error('לא נמצא chofesh.db'); process.exit(1); }

  // קריאת המסד המקומי
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const local = new SQL.Database(fs.readFileSync(DB_PATH));
  const readAll = (table) => {
    const res = local.exec(`SELECT * FROM ${table}`);
    if (!res.length) return [];
    const cols = res[0].columns;
    return res[0].values.map((v) => { const o = {}; cols.forEach((c, i) => { o[c] = v[i]; }); return o; });
  };

  // חיבור לענן
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pool.query(schemaSQL(true));

  // ריקון (בסדר הפוך לתלות) והעתקה
  for (const t of [...TABLES].reverse()) await pool.query(`DELETE FROM ${t}`);
  let total = 0;
  for (const t of TABLES) {
    const rows = readAll(t);
    for (const row of rows) {
      const cols = Object.keys(row);
      const params = cols.map((_, i) => `$${i + 1}`).join(', ');
      await pool.query(
        `INSERT INTO ${t} (${cols.join(', ')}) OVERRIDING SYSTEM VALUE VALUES (${params})`,
        cols.map((c) => row[c])
      ).catch(async (e) => {
        // SERIAL אינו identity — ניסיון שני בלי OVERRIDING
        if (/OVERRIDING/i.test(e.message) || /syntax/i.test(e.message)) {
          await pool.query(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${params})`, cols.map((c) => row[c]));
        } else throw e;
      });
      total++;
    }
    // כיוון רצף ה-id להמשך תקין
    await pool.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`).catch(() => {});
    console.log(`${t}: ${rows.length} שורות`);
  }
  console.log(`\nהועברו ${total} שורות. המערכת מוכנה לעבוד מול Supabase.`);
  await pool.end();
})().catch((e) => { console.error('שגיאה:', e.message); process.exit(1); });
