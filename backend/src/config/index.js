const path = require('path');
const dotenv = require('dotenv');

// path of the backend/ folder (two levels above this file)
const backendRoot = path.resolve(__dirname, '..', '..');

// read backend/.env into process.env
// quiet: true turns off dotenv's extra messages
dotenv.config({ path: path.join(backendRoot, '.env'), quiet: true });

// turn a string like "50" into a number; fall back to the default if invalid
function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// turn a relative path from .env into an absolute path based on backend/
function fromRoot(value, fallback) {
  return path.resolve(backendRoot, value || fallback);
}

const maxFileSizeMb = toInt(process.env.MAX_FILE_SIZE_MB, 50);

const config = {
  env: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 3000),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  logLevel: process.env.LOG_LEVEL || 'info',

  backendRoot,
  dbPath: fromRoot(process.env.DB_PATH, './data/app.sqlite'),
  uploadDir: fromRoot(process.env.UPLOAD_DIR, './uploads'),
  logDir: fromRoot('./logs'),

  upload: {
    maxFileSizeMb,
    maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
    maxFilesPerUpload: toInt(process.env.MAX_FILES_PER_UPLOAD, 10),
  },

  pdf: {
    maxPages: toInt(process.env.MAX_PDF_PAGES, 1500),
  },

  worker: {
    concurrency: toInt(process.env.WORKER_CONCURRENCY, 2),
    pollIntervalMs: toInt(process.env.WORKER_POLL_MS, 1500),
    maxAttempts: toInt(process.env.JOB_MAX_ATTEMPTS, 3),
  },

  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || '',
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || '',
  },
};

module.exports = config;