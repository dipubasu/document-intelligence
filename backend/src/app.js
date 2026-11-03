const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const logger = require('./utils/logger');
const db = require('./db/connection');
const documentRoutes = require('./routes/documents');
const invoiceRoutes = require('./routes/invoices');
const searchRoutes = require('./routes/search');

const app = express();

// security headers (helmet), and allow only the configured frontend origin (cors)
app.use(helmet());
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '1mb' }));

// block an IP that sends more than 300 requests per minute
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// health check: is the server up and the database reachable
app.get('/api/health', (req, res) => {
  const sqlite = db.prepare('SELECT sqlite_version() AS v').get();
  const tables = db
    .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get();
  res.json({
    status: 'ok',
    sqlite: sqlite.v,
    tables: tables.c,
    time: new Date().toISOString(),
  });
});

// mount all routes
app.use('/api/documents', documentRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/search', searchRoutes);

// no route matched
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// any error ends up here; internal details are not shown to the client
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  logger.error('request failed', { path: req.path, message: err.message, stack: err.stack });
  res.status(status).json({
    error: status < 500 ? err.message : 'Internal server error',
  });
});

module.exports = app;