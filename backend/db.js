/* שכבת מסד הנתונים — שני מנועים באותו API:
   - ללא DATABASE_URL: SQLite מקומי (sql.js) — כמו עד היום (backend/chofesh.db)
   - עם DATABASE_URL (Supabase Postgres): חיבור לענן
   ה-API אחיד ואסינכרוני: await db.prepare(sql).get/all/run(params), await db.exec(sql).
   (במנוע ה-SQLite הפעולות סינכרוניות בפועל — await עליהן שקוף.) */

const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'chofesh.db');

let dbInstance = null;
function getDB() { return dbInstance; }

/* ---------- SQLite (sql.js) — עטיפה סינכרונית בסגנון better-sqlite3 ---------- */
class SqliteDB {
  constructor(sqlJsDb, saveFn) {
    this._db = sqlJsDb;
    this._save = saveFn;
    this.kind = 'sqlite';
  }
  exec(sql) { this._db.run(sql); return this; }
  prepare(sql) {
    const db = this._db;
    const save = this._save;
    return {
      run(...params) {
        db.run(sql, params.flat());
        const idRes = db.exec('SELECT last_insert_rowid() as id');
        const changesRes = db.exec('SELECT changes() as c');
        save();
        return {
          lastInsertRowid: idRes[0]?.values[0]?.[0] ?? 0,
          changes: changesRes[0]?.values[0]?.[0] ?? 0,
        };
      },
      get(...params) {
        const stmt = db.prepare(sql);
        stmt.bind(params.flat());
        if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
        stmt.free();
        return undefined;
      },
      all(...params) {
        const results = db.exec(sql, params.flat());
        if (!results.length) return [];
        const cols = results[0].columns;
        return results[0].values.map((row) => {
          const obj = {};
          cols.forEach((c, i) => { obj[c] = row[i]; });
          return obj;
        });
      },
    };
  }
}

/* ---------- Postgres (Supabase) — אותו API, מבוסס pg Pool ---------- */
class PostgresDB {
  constructor(pool) {
    this.pool = pool;
    this.kind = 'postgres';
  }
  _translate(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }
  prepare(sql) {
    const pool = this.pool;
    const text = this._translate(sql);
    const isInsert = /^\s*insert\b/i.test(text) && !/returning/i.test(text);
    return {
      async run(...params) {
        const p = params.flat();
        if (isInsert) {
          try {
            const r = await pool.query(`${text} RETURNING id`, p);
            return { lastInsertRowid: r.rows[0]?.id ?? 0, changes: r.rowCount ?? 0 };
          } catch (e) {
            if (!/column "id" does not exist/i.test(e.message)) throw e;
          }
        }
        const r = await pool.query(text, p);
        return { lastInsertRowid: 0, changes: r.rowCount ?? 0 };
      },
      async get(...params) {
        const r = await pool.query(text, params.flat());
        return r.rows[0];
      },
      async all(...params) {
        const r = await pool.query(text, params.flat());
        return r.rows;
      },
    };
  }
  async exec(sql) { await this.pool.query(sql); return this; }
}

/* ---------- סכימה (README §13) — היררכיה: לקוח → (רשות) → דוח → מוסד → סל → תנועה ----------
   serialPk/now מותאמים למנוע; שאר הטיפוסים משותפים. */
function schemaSQL(pg) {
  const PK = pg ? 'id SERIAL PRIMARY KEY' : 'id INTEGER PRIMARY KEY AUTOINCREMENT';
  const NOW = pg ? 'created_at timestamptz DEFAULT now()' : "created_at TEXT DEFAULT (datetime('now'))";
  return `
    CREATE TABLE IF NOT EXISTS clients (
      ${PK}, name TEXT NOT NULL,
      has_vat INTEGER NOT NULL DEFAULT 0,
      cluster_number INTEGER, notes TEXT, ${NOW}
    );
    CREATE TABLE IF NOT EXISTS authorities (
      ${PK}, client_id INTEGER NOT NULL, name TEXT NOT NULL, ${NOW}
    );
    CREATE TABLE IF NOT EXISTS reports (
      ${PK}, client_id INTEGER NOT NULL, authority_id INTEGER,
      framework TEXT NOT NULL, program TEXT NOT NULL DEFAULT 'base15',
      extension_days INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft',
      has_cost_report INTEGER DEFAULT 0, has_ledger INTEGER DEFAULT 0, has_participants INTEGER DEFAULT 0,
      budget_file_name TEXT, budget_file_path TEXT, parent_tariff REAL DEFAULT 0, ${NOW}
    );
    CREATE TABLE IF NOT EXISTS institutions (
      ${PK}, report_id INTEGER NOT NULL, symbol TEXT NOT NULL, name TEXT DEFAULT '',
      size_type TEXT DEFAULT 'small', status TEXT DEFAULT 'muchshar',
      children_count INTEGER DEFAULT 0, children_regular INTEGER DEFAULT 0, children_special INTEGER DEFAULT 0,
      budget_total REAL DEFAULT 0, actual_total REAL DEFAULT 0, ${NOW}
    );
    CREATE TABLE IF NOT EXISTS baskets (
      ${PK}, institution_id INTEGER NOT NULL, basket_type TEXT NOT NULL,
      budget_amount REAL DEFAULT 0, actual_amount REAL DEFAULT 0, ${NOW}
    );
    CREATE TABLE IF NOT EXISTS transactions (
      ${PK}, basket_id INTEGER NOT NULL, source_type TEXT NOT NULL, source_ref TEXT,
      employee_id TEXT, amount REAL NOT NULL DEFAULT 0, hours REAL, description TEXT, ${NOW}
    );
    CREATE TABLE IF NOT EXISTS client_mappings (
      ${PK}, client_id INTEGER NOT NULL, mapping_type TEXT NOT NULL,
      map_key TEXT NOT NULL, map_value TEXT NOT NULL, ${NOW},
      UNIQUE(client_id, mapping_type, map_key)
    );
    CREATE TABLE IF NOT EXISTS cost_files (
      ${PK}, client_id INTEGER NOT NULL, filename TEXT NOT NULL, software TEXT,
      sheets_used TEXT, row_count INTEGER DEFAULT 0, routed INTEGER DEFAULT 0, payer TEXT, ${NOW}
    );
    CREATE TABLE IF NOT EXISTS ledger_files (
      ${PK}, report_id INTEGER NOT NULL, filename TEXT NOT NULL,
      card_count INTEGER DEFAULT 0, payer TEXT, ${NOW}
    );
    CREATE TABLE IF NOT EXISTS ledger_cards (
      ${PK}, ledger_file_id INTEGER NOT NULL, report_id INTEGER NOT NULL,
      card_key TEXT, card_name TEXT, debit REAL DEFAULT 0, credit REAL DEFAULT 0, net REAL DEFAULT 0,
      basket_type TEXT, ${NOW}
    );
    CREATE TABLE IF NOT EXISTS cost_rows (
      ${PK}, cost_file_id INTEGER NOT NULL, client_id INTEGER NOT NULL, report_id INTEGER,
      emp_id TEXT, emp_name TEXT, first_name TEXT, last_name TEXT,
      dept TEXT, inst_symbol TEXT, component_names TEXT,
      gross REAL, cost REAL, hours REAL,
      symbol_override TEXT, staff_type TEXT, role TEXT,
      moved_from_dept TEXT, moved_from_symbol TEXT, move_declined INTEGER DEFAULT 0, ${NOW}
    );
  `;
}

/* מיגרציות עדינות למסדים קיימים (עמודות שנוספו אחרי הסכימה הראשונית) */
async function migrate(db) {
  const pg = db.kind === 'postgres';
  const add = async (table, col) => {
    try { await db.exec(`ALTER TABLE ${table} ADD COLUMN ${pg ? 'IF NOT EXISTS ' : ''}${col}`); }
    catch { /* קיים כבר (sqlite) */ }
  };
  for (const c of ['children_regular INTEGER DEFAULT 0', 'children_special INTEGER DEFAULT 0',
    'budget_total REAL DEFAULT 0', 'actual_total REAL DEFAULT 0']) await add('institutions', c);
  for (const c of ['budget_file_name TEXT', 'budget_file_path TEXT', 'parent_tariff REAL DEFAULT 0']) await add('reports', c);
  for (const c of ['symbol_override TEXT', 'staff_type TEXT', 'role TEXT',
    'moved_from_dept TEXT', 'moved_from_symbol TEXT', 'move_declined INTEGER DEFAULT 0']) await add('cost_rows', c);
  await add('cost_files', 'payer TEXT');
  await add('ledger_files', 'payer TEXT');
  // לשונית ניהול הלקוח: דריסת שלב ידנית + הערות (NULL = שלב אוטומטי)
  await add('clients', 'manage_status TEXT');
  await add('clients', 'manage_notes TEXT');
  // צ'ק-ליסט הניהול המלא (JSON): הצעת מחיר/חשבון/מייל/חומר/מי מטפל/אנשי קשר...
  await add('clients', 'manage_data TEXT');
}

/* זריעת דמו קלה — רק במסד SQLite מקומי ריק (הענן מתמלא ממיגרציית הנתונים) */
async function seedDB(db) {
  const existing = await db.prepare('SELECT COUNT(*) as c FROM clients').get();
  if (existing && Number(existing.c) > 0) return;
  const c1 = (await db.prepare('INSERT INTO clients (name, has_vat, cluster_number) VALUES (?, ?, ?)').run('עמותת כנפיים', 1, 6)).lastInsertRowid;
  const c2 = (await db.prepare('INSERT INTO clients (name, has_vat, cluster_number) VALUES (?, ?, ?)').run('רשת מוסדות הצפון', 0, 4)).lastInsertRowid;
  const a0 = (await db.prepare('INSERT INTO authorities (client_id, name) VALUES (?, ?)').run(c1, 'נתניה')).lastInsertRowid;
  await db.prepare("INSERT INTO reports (client_id, authority_id, framework, program) VALUES (?, ?, 'gardens', 'base15')").run(c1, a0);
  const a1 = (await db.prepare('INSERT INTO authorities (client_id, name) VALUES (?, ?)').run(c2, 'מעלה אדומים')).lastInsertRowid;
  await db.prepare("INSERT INTO reports (client_id, authority_id, framework, program) VALUES (?, ?, 'gardens', 'base15')").run(c2, a1);
  await db.prepare("INSERT INTO reports (client_id, authority_id, framework, program, extension_days) VALUES (?, ?, 'schools', 'extension', 6)").run(c2, a1);
}

async function initDatabase() {
  if (process.env.DATABASE_URL) {
    // ---- Supabase Postgres ----
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
    const db = new PostgresDB(pool);
    await db.exec(schemaSQL(true));
    await migrate(db);
    dbInstance = db;
    console.log('DB: Supabase Postgres');
    return db;
  }

  // ---- SQLite מקומי (כמו עד היום) ----
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const sqlJsDb = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
  const saveFn = () => fs.writeFileSync(DB_PATH, Buffer.from(sqlJsDb.export()));
  const db = new SqliteDB(sqlJsDb, saveFn);
  db.exec(schemaSQL(false));
  await migrate(db);
  await seedDB(db);
  saveFn();
  dbInstance = db;
  console.log('DB: SQLite מקומי (chofesh.db)');
  return db;
}

module.exports = { initDatabase, getDB, schemaSQL };
