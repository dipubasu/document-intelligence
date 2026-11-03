const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const logger = require('../utils/logger');

// data/ ফোল্ডার না থাকলে বানায়
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);

// WAL: পড়া ও লেখা একসাথে চলতে পারে (API ও worker একই database ব্যবহার করবে)
db.pragma('journal_mode = WAL');
// SQLite এ foreign key ডিফল্টে বন্ধ থাকে, চালু করতে হয়
db.pragma('foreign_keys = ON');
// অন্য কেউ লিখছে থাকলে সাথে সাথে error না দিয়ে ৫ সেকেন্ড অপেক্ষা
db.pragma('busy_timeout = 5000');

// schema.sql পড়ে table বানায় (আগে থেকে থাকলে কিছু বদলায় না)
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

logger.info('database ready', { path: config.dbPath });

module.exports = db;