// Tests for the full pipeline (parse -> extract -> validate -> save).
// A temporary database is used and the LLM is replaced by a mock: no network.
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pipeline-'));
process.env.DB_PATH = path.join(tmp, 'test.sqlite');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.GROQ_API_KEY = 'test-key';
process.env.GROQ_MODEL = 'test-model';

const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const db = require('../src/db/connection');
const documentModel = require('../src/models/documentModel');
const llm = require('../src/services/llm');
const { processDocument } = require('../src/services/pipeline');

fs.mkdirSync(config.uploadDir, { recursive: true });

let llmCalls = 0;
let llmAnswer = {};
llm.chatJson = async () => {
  llmCalls += 1;
  if (llmAnswer instanceof Error) throw llmAnswer;
  return {
    content: typeof llmAnswer === 'string' ? llmAnswer : JSON.stringify(llmAnswer),
    model: 'mock-model',
    usage: null,
    durationMs: 1,
  };
};

let counter = 0;
function addCsvDocument(content) {
  counter += 1;
  const storedName = `t${counter}.csv`;
  fs.writeFileSync(path.join(config.uploadDir, storedName), content);
  const { documentId, jobId } = documentModel.createWithJob({
    original_name: storedName,
    stored_name: storedName,
    mime_type: 'text/csv',
    detected_type: 'csv',
    size_bytes: Buffer.byteLength(content),
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  });
  return { documentId, job: { id: jobId, document_id: documentId } };
}

function csvFor(number, total, extra = '') {
  return (
    'invoice_number,date,supplier,customer,subtotal,tax,total,currency\n' +
    `${number},2026-01-15,Acme Ltd,Beta Corp,100.00,10.50,${total},USD\n${extra}`
  );
}

function answerFor(number, total) {
  return {
    invoice_number: number,
    invoice_date: '2026-01-15',
    supplier_name: 'Acme Ltd',
    customer_name: 'Beta Corp',
    subtotal: 100,
    tax: 10.5,
    total,
    currency: 'USD',
    line_items: [{ description: 'Widget', quantity: 2, unit_price: 50, amount: 100 }],
    confidence: {},
    uncertain_fields: [],
  };
}

const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const issuesOf = (documentId) =>
  db
    .prepare(
      `SELECT v.rule, v.severity FROM validation_issues v
       JOIN invoices i ON i.id = v.invoice_id WHERE i.document_id = ?`
    )
    .all(documentId);

test('pipeline: a correct invoice is saved and does not need review', async () => {
  llmAnswer = answerFor('INV-100', 110.5);
  const { documentId, job } = addCsvDocument(csvFor('INV-100', '110.50'));
  const result = await processDocument(job);

  assert.strictEqual(result.needsReview, false);
  const row = db.prepare('SELECT * FROM invoices WHERE document_id = ?').get(documentId);
  assert.strictEqual(row.invoice_number, 'INV-100');
  assert.strictEqual(row.total, 110.5);
  assert.strictEqual(row.model, 'mock-model');
  assert.strictEqual(count('SELECT COUNT(*) AS n FROM invoice_line_items WHERE invoice_id = ?', row.id), 1);
  assert.strictEqual(issuesOf(documentId).filter((i) => i.severity === 'error').length, 0);
  assert.strictEqual(documentModel.getById(documentId).needs_review, 0);
});

test('pipeline: a wrong total is saved with an error and needs review', async () => {
  llmAnswer = answerFor('INV-200', 115);
  const { documentId, job } = addCsvDocument(csvFor('INV-200', '115.00'));
  const result = await processDocument(job);

  assert.strictEqual(result.needsReview, true);
  assert.ok(issuesOf(documentId).some((i) => i.rule === 'total_mismatch'));
  assert.strictEqual(documentModel.getById(documentId).needs_review, 1);
});

test('pipeline: the same file again reuses the result without calling the LLM', async () => {
  llmAnswer = answerFor('INV-300', 110.5);
  const content = csvFor('INV-300', '110.50');
  const first = addCsvDocument(content);
  await processDocument(first.job);
  const callsBefore = llmCalls;

  const second = addCsvDocument(content);
  const result = await processDocument(second.job);

  assert.strictEqual(llmCalls, callsBefore);
  assert.strictEqual(result.needsReview, true);
  assert.ok(issuesOf(second.documentId).some((i) => i.rule === 'duplicate_file'));
});

test('pipeline: same invoice number in a different file is flagged as a duplicate invoice', async () => {
  llmAnswer = answerFor('INV-400', 110.5);
  const first = addCsvDocument(csvFor('INV-400', '110.50'));
  await processDocument(first.job);
  const callsBefore = llmCalls;

  const second = addCsvDocument(csvFor('INV-400', '110.50', 'note\n'));
  await processDocument(second.job);

  assert.strictEqual(llmCalls, callsBefore + 1);
  assert.ok(issuesOf(second.documentId).some((i) => i.rule === 'duplicate_invoice'));
  assert.ok(!issuesOf(first.documentId).some((i) => i.rule === 'duplicate_invoice'));
});

test('pipeline: processing a document twice keeps only one invoice row', async () => {
  llmAnswer = answerFor('INV-500', 110.5);
  const { documentId, job } = addCsvDocument(csvFor('INV-500', '110.50'));
  await processDocument(job);
  await processDocument(job);
  assert.strictEqual(count('SELECT COUNT(*) AS n FROM invoices WHERE document_id = ?', documentId), 1);
  assert.strictEqual(
    count(
      `SELECT COUNT(*) AS n FROM invoice_line_items WHERE invoice_id IN
       (SELECT id FROM invoices WHERE document_id = ?)`,
      documentId
    ),
    1
  );
});

test('pipeline: a non-JSON LLM answer fails with a clear code and may be retried', async () => {
  llmAnswer = 'this is not json';
  const { job } = addCsvDocument(csvFor('INV-600', '110.50'));
  await assert.rejects(processDocument(job), (err) => err.code === 'BAD_LLM_JSON' && !err.permanent);
});

test('pipeline: a non-retryable LLM error (for example a wrong key) is permanent', async () => {
  llmAnswer = new llm.LlmError('bad key', { retryable: false, status: 401 });
  const { job } = addCsvDocument(csvFor('INV-700', '110.50'));
  await assert.rejects(processDocument(job), (err) => err.permanent === true);
});