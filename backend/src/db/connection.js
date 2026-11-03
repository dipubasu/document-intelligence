const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const logger = require('../utils/logger');

// create the data/ folder if it does not exist
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);

// WAL: reads and writes can happen together (the API and the worker share this database)
db.pragma('journal_mode = WAL');
// SQLite has foreign keys off by default, so turn them on
db.pragma('foreign_keys = ON');
// if another connection is writing, wait up to 5 seconds instead of failing at once
db.pragma('busy_timeout = 5000');

// read schema.sql and create the tables (existing tables are left unchanged)
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

logger.info('database ready', { path: config.dbPath });

module.exports = db;