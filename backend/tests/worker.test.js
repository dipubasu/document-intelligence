const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// আসল database এ হাত না দিয়ে আলাদা temp database ব্যবহার (config require এর আগে)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-worker-'));
process.env.DB_PATH = path.join(tmpDir, 'test.sqlite');
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
fs.mkdirSync(process.env.UPLOAD_DIR);

const db = require('../src/db/connection');
const documentModel = require('../src/models/documentModel');
const jobModel = require('../src/models/jobModel');
const worker = require('../src/workers/jobWorker');

test.after(() => {
  db.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    // Windows এ ফাইল lock থাকলে temp ফোল্ডার থেকে যেতে পারে, ক্ষতি নেই
  }
});

let counter = 0;
function addDoc(content, detectedType, ext) {
  counter += 1;
  const stored = `file${counter}.${ext}`;
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, stored), content);
  return documentModel.createWithJob({
    original_name: stored,
    stored_name: stored,
    mime_type: 'application/octet-stream',
    detected_type: detectedType,
    size_bytes: Buffer.byteLength(content),
    sha256: `hash${counter}`,
  });
}

const getDoc = (id) => db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
const getJob = (id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
const countPages = (id) =>
  db.prepare('SELECT COUNT(*) AS c FROM document_pages WHERE document_id = ?').get(id).c;

const CSV = 'item,qty\nAcme Widget,2\n';

test('worker: a good csv job completes and its page is saved', async () => {
  const { documentId, jobId } = addDoc(CSV, 'csv', 'csv');
  const job = jobModel.claimNextJob();
  assert.equal(job.id, jobId);
  assert.equal(getDoc(documentId).status, 'processing');

  await worker.runJob(job);

  assert.equal(getDoc(documentId).status, 'completed');
  assert.equal(getDoc(documentId).page_count, 1);
  assert.equal(getJob(jobId).status, 'done');
  assert.equal(countPages(documentId), 1);
  const events = documentModel.getHistory(documentId).map((h) => h.event);
  assert.deepEqual(events, ['uploaded', 'processing_started', 'completed']);
});

test('worker: a corrupted pdf fails at once with a clear message (no retry)', async () => {
  const { documentId, jobId } = addDoc('not a real pdf', 'pdf', 'pdf');
  const job = jobModel.claimNextJob();
  await worker.runJob(job);

  assert.equal(getDoc(documentId).status, 'failed');
  assert.match(getDoc(documentId).error_message, /Could not read PDF/i);
  assert.equal(getJob(jobId).status, 'failed');
  assert.equal(getJob(jobId).attempts, 1);
});

test('worker: temporary errors are retried, then fail after max attempts', async () => {
  const { documentId, jobId } = addDoc(CSV, 'csv', 'csv');
  const boom = async () => {
    throw new Error('temporary glitch');
  };

  await worker.runJob(jobModel.claimNextJob(), boom);
  assert.equal(getJob(jobId).status, 'queued');
  assert.equal(getDoc(documentId).status, 'queued');
  assert.equal(getJob(jobId).attempts, 1);

  await worker.runJob(jobModel.claimNextJob(), boom);
  assert.equal(getJob(jobId).status, 'queued');

  await worker.runJob(jobModel.claimNextJob(), boom);
  assert.equal(getJob(jobId).status, 'failed');
  assert.equal(getJob(jobId).attempts, 3);
  assert.equal(getDoc(documentId).status, 'failed');
  assert.match(getDoc(documentId).error_message, /temporary glitch/);
});

test('worker: a job stuck in processing goes back to queued after a restart', async () => {
  const { documentId, jobId } = addDoc(CSV, 'csv', 'csv');
  jobModel.claimNextJob(); // server এখানে crash করল, job আটকে থাকল
  assert.equal(getJob(jobId).status, 'processing');

  const r = jobModel.recoverStuckJobs();
  assert.equal(r.requeued, 1);
  assert.equal(getJob(jobId).status, 'queued');
  assert.equal(getDoc(documentId).status, 'queued');

  await worker.runJob(jobModel.claimNextJob()); // queue ফাঁকা রাখি
  assert.equal(getDoc(documentId).status, 'completed');
});

test('worker: the polling loop picks up a queued job by itself', async () => {
  const { documentId } = addDoc(CSV, 'csv', 'csv');
  worker.start();
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && getDoc(documentId).status !== 'completed') {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(getDoc(documentId).status, 'completed');
  } finally {
    await worker.stop();
  }
});