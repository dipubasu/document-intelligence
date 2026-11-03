const app = require('./app');
const config = require('./config');
const logger = require('./utils/logger');
const db = require('./db/connection');

const server = app.listen(config.port, () => {
  logger.info(`server listening on http://localhost:${config.port}`);
});

// Ctrl+C বা বন্ধ করার সময়: নতুন request নেওয়া বন্ধ, database ঠিকমতো বন্ধ
function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);
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