const fs = require('fs');
const path = require('path');
const winston = require('winston');
const config = require('../config');

// logs/ ফোল্ডার না থাকলে বানায়
fs.mkdirSync(config.logDir, { recursive: true });

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    // ফাইলে JSON log, পরে খুঁজে দেখার জন্য
    new winston.transports.File({
      filename: path.join(config.logDir, 'app.log'),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
    // terminal এ পড়ার মতো সহজ log
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
          return `${timestamp} ${level}: ${message}${extra}`;
        })
      ),
    }),
  ],
});

module.exports = logger;