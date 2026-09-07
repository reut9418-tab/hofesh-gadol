require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { initDatabase } = require('./db');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5273' }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'chofesh-gadol-reports', time: new Date().toISOString() }));

initDatabase().then(() => {
  app.use('/api/clients', require('./routes/clients'));
  app.use('/api', require('./routes/authorities')); // /api/clients/:id/authorities, /api/authorities/:id
  app.use('/api/reports', require('./routes/reports'));
  app.use('/api', require('./routes/costFiles')); // /api/clients/:id/cost-files, /api/cost-files/:id[/route]
  app.use('/api', require('./routes/ledger'));    // /api/reports/:id/ledger[-file], /api/ledger-cards/:id, /api/ledger-files/:id

  app.use((err, req, res, _next) => {
    console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, err.stack || err.message);
    const isDev = process.env.NODE_ENV !== 'production';
    res.status(err.status || 500).json({ error: isDev ? err.message : 'שגיאת שרת פנימית' });
  });

  const PORT = process.env.PORT || 3101;
  app.listen(PORT, () => console.log(`Chofesh-Gadol reports backend on http://localhost:${PORT}`));
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
