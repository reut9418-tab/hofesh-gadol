require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initDatabase } = require('./db');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5273', exposedHeaders: ['Content-Disposition'] }));
app.use(express.json());
// כל בקשת שינוי מרוקנת את מטמון בריאות-הדוחות — אבל רק לדוחות הלקוח שנגעו
// בו (ניודים בין דוחות נשארים בתוך אותו לקוח). כשהנתיב לא מזוהה — ריקון מלא.
app.use('/api', async (req, _res, next) => {
  if (req.method === 'GET') return next();
  const { bustHealthCache } = require('./lib/status');
  try {
    const db = require('./db').getDB();
    const url = (req.originalUrl || req.url).split('?')[0];
    const idOf = (re) => { const x = re.exec(url); return x ? parseInt(x[1]) : null; };
    let clientId = idOf(/^\/api\/clients\/(\d+)/);
    let rid;
    if (clientId == null && (rid = idOf(/^\/api\/reports\/(\d+)/)) != null) {
      clientId = ((await db.prepare('SELECT client_id FROM reports WHERE id = ?').get(rid)) || {}).client_id;
    }
    if (clientId == null && (rid = idOf(/^\/api\/cost-files\/(\d+)/)) != null) {
      clientId = ((await db.prepare('SELECT client_id FROM cost_files WHERE id = ?').get(rid)) || {}).client_id;
    }
    if (clientId == null && (rid = idOf(/^\/api\/ledger-files\/(\d+)/)) != null) {
      clientId = ((await db.prepare('SELECT r.client_id FROM ledger_files lf JOIN reports r ON r.id = lf.report_id WHERE lf.id = ?').get(rid)) || {}).client_id;
    }
    if (clientId == null && (rid = idOf(/^\/api\/ledger-cards\/(\d+)/)) != null) {
      clientId = ((await db.prepare('SELECT r.client_id FROM ledger_cards c JOIN reports r ON r.id = c.report_id WHERE c.id = ?').get(rid)) || {}).client_id;
    }
    if (clientId == null && (rid = idOf(/^\/api\/authorities\/(\d+)/)) != null) {
      clientId = ((await db.prepare('SELECT client_id FROM authorities WHERE id = ?').get(rid)) || {}).client_id;
    }
    if (clientId == null && /^\/api\/clients\/?$/.test(url)) return next(); // יצירת לקוח — אין עדיין דוחות במטמון
    if (clientId == null) bustHealthCache();
    else bustHealthCache((await db.prepare('SELECT id FROM reports WHERE client_id = ?').all(clientId)).map((r) => r.id));
  } catch { bustHealthCache(); }
  next();
});

// בענן: השרת מגיש גם את הממשק הבנוי (frontend/dist) — שירות אחד לדומיין
const DIST = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(DIST)) app.use(express.static(DIST));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'chofesh-gadol-reports', time: new Date().toISOString() }));

initDatabase().then(() => {
  app.use('/api/clients', require('./routes/clients'));
  app.use('/api', require('./routes/authorities')); // /api/clients/:id/authorities, /api/authorities/:id
  app.use('/api/reports', require('./routes/reports'));
  app.use('/api', require('./routes/costFiles')); // /api/clients/:id/cost-files, /api/cost-files/:id[/route]
  app.use('/api', require('./routes/ledger'));    // /api/reports/:id/ledger[-file], /api/ledger-cards/:id, /api/ledger-files/:id

  // כל נתיב שאינו API — הממשק (SPA fallback), כשקיים build
  if (fs.existsSync(DIST)) {
    app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
  }

  app.use((err, req, res, _next) => {
    console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, err.stack || err.message);
    // כלי פנימי — מחזירים את סיבת השגיאה האמיתית גם בענן כדי שאפשר יהיה לאבחן מרחוק
    res.status(err.status || 500).json({ error: `שגיאת שרת: ${err.message}` });
  });

  const PORT = process.env.PORT || 3101;
  app.listen(PORT, () => console.log(`Chofesh-Gadol reports backend on http://localhost:${PORT}`));
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
