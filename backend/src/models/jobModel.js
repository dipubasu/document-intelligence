const db = require('../db/connection');
const { addHistory } = require('./documentModel');

const MAX_ERROR_LENGTH = 500;

function shortMessage(err) {
  const msg = err && err.message ? err.message : String(err);
  return msg.slice(0, MAX_ERROR_LENGTH);
}

const selectNextQueued = db.prepare(
  "SELECT * FROM jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1"
);
const setJobProcessing = db.prepare(
  "UPDATE jobs SET status = 'processing', attempts = attempts + 1, locked_at = datetime('now') WHERE id = ?"
);
const setDocProcessing = db.prepare(
  "UPDATE documents SET status = 'processing', error_message = NULL, updated_at = datetime('now') WHERE id = ?"
);

// সবচেয়ে পুরোনো queued job তুলে নেয়। select আর update একই transaction এ,
// তাই দুই worker একই job পাবে না
const claimNextJob = db.transaction(() => {
  const job = selectNextQueued.get();
  if (!job) return null;
  setJobProcessing.run(job.id);
  setDocProcessing.run(job.document_id);
  addHistory({
    documentId: job.document_id,
    event: 'processing_started',
    fromStatus: 'queued',
    toStatus: 'processing',
    detail: `attempt ${job.attempts + 1} of ${job.max_attempts}`,
  });
  return { ...job, status: 'processing', attempts: job.attempts + 1 };
});

const setJobDone = db.prepare(
  "UPDATE jobs SET status = 'done', finished_at = datetime('now'), last_error = NULL WHERE id = ?"
);
const setDocCompleted = db.prepare(
  "UPDATE documents SET status = 'completed', page_count = ?, error_message = NULL, updated_at = datetime('now') WHERE id = ?"
);

const completeJob = db.transaction((job, { pageCount, durationMs, detail }) => {
  setJobDone.run(job.id);
  setDocCompleted.run(pageCount, job.document_id);
  addHistory({
    documentId: job.document_id,
    event: 'completed',
    fromStatus: 'processing',
    toStatus: 'completed',
    detail,
    durationMs,
  });
});

const setJobQueuedAgain = db.prepare(
  "UPDATE jobs SET status = 'queued', last_error = ?, locked_at = NULL WHERE id = ?"
);
const setDocQueued = db.prepare(
  "UPDATE documents SET status = 'queued', updated_at = datetime('now') WHERE id = ?"
);
const setJobFailed = db.prepare(
  "UPDATE jobs SET status = 'failed', last_error = ?, finished_at = datetime('now') WHERE id = ?"
);
const setDocFailed = db.prepare(
  "UPDATE documents SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?"
);

// ব্যর্থ হলে: সাময়িক সমস্যা আর চেষ্টা বাকি থাকলে আবার queued, নইলে failed
// ফেরত দেয় 'retry' অথবা 'failed'
const failJob = db.transaction((job, err, { permanent, durationMs }) => {
  const message = shortMessage(err);
  const willRetry = !permanent && job.attempts < job.max_attempts;

  if (willRetry) {
    setJobQueuedAgain.run(message, job.id);
    setDocQueued.run(job.document_id);
    addHistory({
      documentId: job.document_id,
      event: 'retry_scheduled',
      fromStatus: 'processing',
      toStatus: 'queued',
      detail: message,
      durationMs,
    });
    return 'retry';
  }

  setJobFailed.run(message, job.id);
  setDocFailed.run(message, job.document_id);
  addHistory({
    documentId: job.document_id,
    event: 'failed',
    fromStatus: 'processing',
    toStatus: 'failed',
    detail: message,
    durationMs,
  });
  return 'failed';
});

// server বন্ধ বা crash হলে processing এ আটকে থাকা job গুলো ঠিক করে।
// অনেকবার চেষ্টা হয়ে গেলে failed, নইলে আবার queued
const recoverStuckJobs = db.transaction(() => {
  const tooMany = "status = 'processing' AND attempts >= max_attempts";
  db.prepare(
    `UPDATE documents SET status = 'failed',
       error_message = 'Processing was interrupted too many times',
       updated_at = datetime('now')
     WHERE id IN (SELECT document_id FROM jobs WHERE ${tooMany})`
  ).run();
  const failed = db
    .prepare(
      `UPDATE jobs SET status = 'failed',
         last_error = 'Processing was interrupted too many times',
         finished_at = datetime('now')
       WHERE ${tooMany}`
    )
    .run().changes;

  db.prepare(
    `UPDATE documents SET status = 'queued', updated_at = datetime('now')
     WHERE id IN (SELECT document_id FROM jobs WHERE status = 'processing')`
  ).run();
  const requeued = db
    .prepare("UPDATE jobs SET status = 'queued', locked_at = NULL WHERE status = 'processing'")
    .run().changes;

  return { requeued, failed };
});

const deletePages = db.prepare('DELETE FROM document_pages WHERE document_id = ?');
const insertPage = db.prepare(`
  INSERT INTO document_pages
    (document_id, page_number, sheet_name, text, ocr_used, ocr_confidence)
  VALUES
    (@document_id, @page_number, @sheet_name, @text, @ocr_used, @ocr_confidence)
`);

// আগের পেজ মুছে নতুন পেজ লেখে (reprocess করলে দুবার জমবে না)
const savePages = db.transaction((documentId, pages) => {
  deletePages.run(documentId);
  for (const p of pages) {
    insertPage.run({
      document_id: documentId,
      page_number: p.page_number,
      sheet_name: p.sheet_name ?? null,
      text: p.text,
      ocr_used: p.ocr_used ? 1 : 0,
      ocr_confidence: p.ocr_confidence ?? null,
    });
  }
});

module.exports = { claimNextJob, completeJob, failJob, recoverStuckJobs, savePages };