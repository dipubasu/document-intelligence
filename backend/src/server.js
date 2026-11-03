const app = require('./app');
const config = require('./config');
const logger = require('./utils/logger');
const db = require('./db/connection');
const worker = require('./workers/jobWorker');

const server = app.listen(config.port, () => {
  logger.info(`server listening on http://localhost:${config.port}`);
  worker.start();
});

let shuttingDown = false;

// Ctrl+C বা বন্ধ করার সময়: নতুন job নেওয়া বন্ধ, চলমান job শেষ হওয়া পর্যন্ত অপেক্ষা,
// তারপর server ও database বন্ধ
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);

  // কোনো কিছু আটকে গেলে ১৫ সেকেন্ড পর জোর করে বন্ধ
  setTimeout(() => process.exit(1), 15000).unref();

  await worker.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// কোথাও error ধরা না পড়লে অন্তত log এ থাকবে
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) });
});