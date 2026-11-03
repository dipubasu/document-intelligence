const db = require('../db/connection');
const config = require('../config');

const insertDocument = db.prepare(`
  INSERT INTO documents
    (original_name, stored_name, mime_type, detected_type, size_bytes, sha256, status)
  VALUES
    (@original_name, @stored_name, @mime_type, @detected_type, @size_bytes, @sha256, 'queued')
`);

const insertJob = db.prepare(`
  INSERT INTO jobs (document_id, type, status, max_attempts)
  VALUES (?, 'process', 'queued', ?)
`);

const insertHistory = db.prepare(`
  INSERT INTO processing_history
    (document_id, event, from_status, to_status, detail, duration_ms)
  VALUES
    (@document_id, @event, @from_status, @to_status, @detail, @duration_ms)
`);

// document + job + history are written together; if one fails, all three are rolled back (transaction)
const createWithJob = db.transaction((doc) => {
  const docInfo = insertDocument.run(doc);
  const documentId = Number(docInfo.lastInsertRowid);
  const jobInfo = insertJob.run(documentId, config.worker.maxAttempts);
  insertHistory.run({
    document_id: documentId,
    event: 'uploaded',
    from_status: null,
    to_status: 'queued',
    detail: doc.original_name,
    duration_ms: null,
  });
  return { documentId, jobId: Number(jobInfo.lastInsertRowid) };
});

function getById(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

function getLatestJob(documentId) {
  return db
    .prepare('SELECT * FROM jobs WHERE document_id = ? ORDER BY id DESC LIMIT 1')
    .get(documentId);
}

function getHistory(documentId) {
  return db
    .prepare('SELECT * FROM processing_history WHERE document_id = ? ORDER BY id ASC')
    .all(documentId);
}

function addHistory({ documentId, event, fromStatus, toStatus, detail, durationMs }) {
  insertHistory.run({
    document_id: documentId,
    event,
    from_status: fromStatus ?? null,
    to_status: toStatus ?? null,
    detail: detail ?? null,
    duration_ms: durationMs ?? null,
  });
}

// do not show the client the internal file name (stored_name)
function toPublic(doc) {
  if (!doc) return doc;
  const { stored_name, ...rest } = doc; // eslint-disable-line no-unused-vars
  return rest;
}

module.exports = {
  createWithJob,
  getById,
  getLatestJob,
  getHistory,
  addHistory,
  toPublic,
};