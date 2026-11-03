const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const logger = require('./utils/logger');
const db = require('./db/connection');

const app = express();

// security header (helmet), শুধু নির্দিষ্ট frontend থেকে অনুমতি (cors)
app.use(helmet());
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '1mb' }));

// প্রতি IP থেকে মিনিটে ৩০০ এর বেশি request এলে আটকাবে
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// health check: server ও database ঠিক আছে কিনা
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

// কোনো route না মিললে
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// যেকোনো error এখানে এসে পড়ে। ভেতরের বিস্তারিত client কে দেখানো হয় না
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  logger.error('request failed', { path: req.path, message: err.message, stack: err.stack });
  res.status(status).json({
    error: status < 500 ? err.message : 'Internal server error',
  });
});

module.exports = app;