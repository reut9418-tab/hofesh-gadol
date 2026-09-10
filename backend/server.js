require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initDatabase } = require('./db');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5273', exposedHeaders: ['Content-Disposition'] }));
app.use(express.json());

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
