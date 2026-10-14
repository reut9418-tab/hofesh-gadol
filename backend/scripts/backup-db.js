#!/usr/bin/env node
/* גיבוי יומי של המסד מחוץ ל-Supabase (רעות אישרה 14.10.2026).
   Supabase Free שומר גיבוי ל-7 ימים בלבד ובלי שחזור לנקודת זמן — כאן נשמר
   עותק מקומי של כל הטבלאות (בלי שתי טבלאות הקבצים הבינאריים: report_files
   ו-cost_file_blobs, שמשקלן מאות MB; שאר הנתונים — כ-15MB לפני דחיסה).

   פלט: <תיקיית בקרה יומית>\גיבויים\YYYY-MM-DD.json.gz
         { savedAt, engine, tables: { <שם>: { columns, rows: [[...], ...] } } }
   שמירה: 30 הגיבויים האחרונים (הישנים נמחקים). עותק נוסף (למשל Google Drive)
   כשמוגדר BACKUP_COPY_DIR ב-.env או --copy <תיקייה>.

   שימוש:
     node backend/scripts/backup-db.js                 # גיבוי לתיקיית ברירת המחדל
     node backend/scripts/backup-db.js --out <dir>     # תיקיית בקרה אחרת (הגיבוי ב-<dir>\גיבויים)
     node backend/scripts/backup-db.js --copy <dir>    # עותק נוסף לתיקייה (Google Drive וכד')
     node backend/scripts/backup-db.js --restore-sql <file.json.gz> > restore.sql
                                                       # הפקת SQL לשחזור (לא מריץ כלום)
   הסקריפט קורא בלבד מהמסד; כותב רק לתיקיית הגיבויים. */

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const BACKEND = path.join(__dirname, '..');
const ROOT = path.join(BACKEND, '..');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env') });

const args = process.argv.slice(2);
const argVal = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const OUT_DIR = argVal('--out', path.join(ROOT, '..', 'בקרה יומית'));
const BACKUP_DIR = path.join(OUT_DIR, 'גיבויים');
const COPY_DIR = argVal('--copy', process.env.BACKUP_COPY_DIR || '');
const KEEP = Number(argVal('--keep', 30));
const RESTORE = argVal('--restore-sql', '');

const SKIP_TABLES = new Set(['report_files', 'cost_file_blobs']); // קבצים בינאריים — לא בגיבוי היומי

const ymd = (d) => d.toISOString().slice(0, 10);

/* ----------------------------------------------------------- הפקת SQL לשחזור */
function restoreSql(file) {
  const dump = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  const lit = (v) => v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  const out = [`-- שחזור מגיבוי ${dump.savedAt} (${dump.engine}) — להריץ בתוך טרנזקציה אחרי בדיקה`, 'BEGIN;'];
  for (const [name, t] of Object.entries(dump.tables)) {
    out.push(`DELETE FROM ${name};`);
    for (const row of t.rows) out.push(`INSERT INTO ${name} (${t.columns.join(', ')}) VALUES (${row.map(lit).join(', ')});`);
  }
  out.push('COMMIT;');
  return out.join('\n');
}

/* --------------------------------------------------------------------- גיבוי */
async function backup() {
  const { initDatabase } = require(path.join(BACKEND, 'db.js'));
  const db = await initDatabase();
  const pg = db.kind === 'postgres';
  const q = async (sql, ...p) => db.prepare(sql).all(...p);

  const tables = pg
    ? (await q("SELECT tablename name FROM pg_tables WHERE schemaname='public' ORDER BY 1")).map((r) => r.name)
    : (await q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY 1")).map((r) => r.name);

  const dump = { savedAt: new Date().toISOString(), engine: pg ? 'postgres' : 'sqlite', skipped: [...SKIP_TABLES], tables: {} };
  let totalRows = 0;
  for (const name of tables) {
    if (SKIP_TABLES.has(name)) continue;
    const rows = await q(`SELECT * FROM ${name}${pg ? ' ORDER BY 1' : ''}`);
    const columns = rows.length ? Object.keys(rows[0]) : [];
    dump.tables[name] = { columns, rows: rows.map((r) => columns.map((c) => (r[c] instanceof Date ? r[c].toISOString() : r[c]))) };
    totalRows += rows.length;
  }
  if (db.pool) await db.pool.end().catch(() => {});

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `${ymd(new Date())}.json.gz`);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(dump)), { level: 9 });
  fs.writeFileSync(file, gz);
  const mb = (gz.length / 1024 / 1024).toFixed(1);
  console.log(`✓ גיבוי: ${file} — ${Object.keys(dump.tables).length} טבלאות, ${totalRows} שורות, ${mb}MB`);

  // עותק נוסף (Google Drive וכד') — אם התיקייה קיימת
  if (COPY_DIR) {
    if (fs.existsSync(COPY_DIR)) { fs.copyFileSync(file, path.join(COPY_DIR, path.basename(file))); console.log(`✓ עותק: ${COPY_DIR}`); }
    else console.log(`⚠ תיקיית העותק לא קיימת: ${COPY_DIR}`);
  }

  // ניקוי ישנים — שומרים KEEP אחרונים
  const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  return { file, tables: Object.keys(dump.tables).length, rows: totalRows, bytes: gz.length };
}

if (require.main === module) {
  if (RESTORE) { process.stdout.on('error', () => process.exit(0)); process.stdout.write(restoreSql(RESTORE)); } // EPIPE כשמצנרים ל-head
  else backup().then(() => process.exit(0)).catch((e) => { console.error('✗ הגיבוי נכשל:', e.message); process.exit(2); });
}

module.exports = { backup, BACKUP_DIR };
