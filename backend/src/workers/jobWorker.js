const config = require('../config');
const logger = require('../utils/logger');
const jobModel = require('../models/jobModel');
const { processDocument } = require('../services/pipeline');

let running = false;
let timer = null;
let active = 0;

// Run one job. Never throws, so the loop never dies.
// the processor can be passed in, which makes testing easy
async function runJob(job, processor = processDocument) {
  const started = Date.now();
  try {
    const result = await processor(job);
    const durationMs = Date.now() - started;

    const notes = [`${result.parser}: ${result.pageCount} page(s)`];
    if (result.lowTextPages && result.lowTextPages.length > 0) {
      notes.push(`low-text pages: ${result.lowTextPages.length}`);
    }
    if (result.truncated) notes.push('content truncated');

    jobModel.completeJob(job, {
      pageCount: result.pageCount,
      durationMs,
      detail: notes.join(', '),
    });
    logger.info('job completed', { jobId: job.id, documentId: job.document_id, durationMs });
  } catch (err) {
    const durationMs = Date.now() - started;
    try {
      const outcome = jobModel.failJob(job, err, {
        permanent: Boolean(err.permanent),
        durationMs,
      });
      logger.warn('job failed', {
        jobId: job.id,
        documentId: job.document_id,
        outcome,
        error: err.message,
      });
    } catch (dbErr) {
      logger.error('could not record job failure', { jobId: job.id, error: String(dbErr) });
    }
  }
}

function tick() {
  if (!running) return;
  while (active < config.worker.concurrency) {
    let job;
    try {
      job = jobModel.claimNextJob();
    } catch (err) {
      logger.error('claim failed', { error: String(err) });
      break;
    }
    if (!job) break;
    active += 1;
    runJob(job).finally(() => {
      active -= 1;
      if (running) {
        clearTimeout(timer);
        tick(); // when a job finishes, look for the next one right away
      }
    });
  }
  timer = setTimeout(tick, config.worker.pollIntervalMs);
}

function start() {
  if (running) return;
  const recovered = jobModel.recoverStuckJobs();
  if (recovered.requeued > 0 || recovered.failed > 0) {
    logger.warn('recovered stuck jobs', recovered);
  }
  running = true;
  logger.info('worker started', { concurrency: config.worker.concurrency });
  tick();
}

// stop taking new jobs and wait until the running jobs finish
function stop() {
  running = false;
  clearTimeout(timer);
  return new Promise((resolve) => {
    const check = () => (active === 0 ? resolve() : setTimeout(check, 100));
    check();
  });
}

module.exports = { start, stop, runJob };