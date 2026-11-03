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

// On Ctrl+C or stop: stop taking new jobs, wait for running jobs to finish,
// then close the server and the database
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);

  // if anything hangs, force exit after 15 seconds
  setTimeout(() => process.exit(1), 15000).unref();

  await worker.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// anything not caught elsewhere will at least be in the log
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) });
});