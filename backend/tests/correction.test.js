// Tests for manual correction: model rules and the real HTTP endpoint.
// A temporary database is used, there is no worker and no LLM.
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-correction-'));
process.env.DB_PATH = path.join(tmp, 'test.sqlite');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db/connection');
const app = require('../src/app');
const documentModel = require('../src/models/documentModel');
const invoiceModel = require('../src/models/invoiceModel');
const queries = require('../src/models/documentQueries');
const correctionModel = require('../src/models/correctionModel');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
});

function invoiceOf(overrides = {}) {
  return {
    invoice_number: 'X-1',
    invoice_date: '2026-01-15',
    supplier_name: 'Acme Ltd',
    customer_name: 'Beta Corp',
    subtotal: 100,
    tax: 10.5,
    total: 110.5,
    currency: 'USD',
    line_items: [{ description: 'Widget', quantity: 2, unit_price: 50, amount: 100 }],
    confidence: {},
    uncertain_fields: [],
    ...overrides,
  };
}

let counter = 0;
function addInvoice(overrides = {}, extraIssues = []) {
  counter += 1;
  const { documentId } = documentModel.createWithJob({
    original_name: `c${counter}.csv`,
    stored_name: `c${counter}.csv`,
    mime_type: 'text/csv',
    detected_type: 'csv',
    size_bytes: 10,
    sha256: `corr${counter}`,
  });
  const { invoiceId } = invoiceModel.saveExtraction(documentId, invoiceOf(overrides), {
    rawJson: '{}',
    model: 'mock',
    promptVersion: 'v1',
    extraIssues,
  });
  return { documentId, invoiceId };
}

const rulesOf = (documentId) => queries.getResult(documentId).issues.map((i) => i.rule);
const needsReview = (documentId) => documentModel.getById(documentId).needs_review;

async function patch(url, body) {
  const res = await fetch(`${base}${url}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { res, body: await res.json() };
}

test('correction: fixing a wrong total removes the error, clears review and writes an audit row', () => {
  const { documentId, invoiceId } = addInvoice({ invoice_number: 'C-1', total: 115 });
  assert.ok(rulesOf(documentId).includes('total_mismatch'));
  assert.strictEqual(needsReview(documentId), 1);

  const out = correctionModel.applyCorrection(invoiceId, { total: 110.5 });
  assert.deepStrictEqual(out.changed, ['total']);

  const result = queries.getResult(documentId);
  assert.ok(!rulesOf(documentId).includes('total_mismatch'));
  assert.strictEqual(needsReview(documentId), 0);
  assert.strictEqual(result.invoice.total, 110.5);
  assert.strictEqual(result.invoice.is_corrected, 1);
  assert.strictEqual(result.corrections.length, 1);
  assert.strictEqual(result.corrections[0].field, 'total');
  assert.strictEqual(result.corrections[0].old_value, '115');
  assert.strictEqual(result.corrections[0].new_value, '110.5');
});

test('correction: a wrong new value is caught by the validator again', () => {
  const { documentId, invoiceId } = addInvoice({ invoice_number: 'C-2' });
  assert.strictEqual(needsReview(documentId), 0);
  correctionModel.applyCorrection(invoiceId, { total: 120 });
  assert.ok(rulesOf(documentId).includes('total_mismatch'));
  assert.strictEqual(needsReview(documentId), 1);
});

test('correction: sending an uncertain field confirms it, even with the same value', () => {
  const { documentId, invoiceId } = addInvoice({
    invoice_number: 'C-3',
    uncertain_fields: ['currency'],
  });
  assert.strictEqual(needsReview(documentId), 1);
  assert.ok(rulesOf(documentId).includes('uncertain_value'));

  const out = correctionModel.applyCorrection(invoiceId, { currency: 'USD' });
  assert.deepStrictEqual(out.changed, []);

  const result = queries.getResult(documentId);
  assert.deepStrictEqual(result.invoice.uncertain_fields, []);
  assert.ok(!rulesOf(documentId).includes('uncertain_value'));
  assert.strictEqual(needsReview(documentId), 0);
  assert.strictEqual(result.corrections.length, 0);
  assert.strictEqual(result.invoice.is_corrected, 0);
});

test('correction: changing a duplicate invoice number removes the duplicate error', () => {
  addInvoice({ invoice_number: 'DUP-1' });
  const second = addInvoice({ invoice_number: 'DUP-1' });
  assert.ok(rulesOf(second.documentId).includes('duplicate_invoice'));

  correctionModel.applyCorrection(second.invoiceId, { invoice_number: 'DUP-2' });
  assert.ok(!rulesOf(second.documentId).includes('duplicate_invoice'));
  assert.strictEqual(needsReview(second.documentId), 0);
});

test('correction: line items can be replaced and the change is recorded', () => {
  const { documentId, invoiceId } = addInvoice({ invoice_number: 'C-5' });
  const items = [{ description: 'Gadget', quantity: 1, unit_price: 100, amount: 100 }];
  const out = correctionModel.applyCorrection(invoiceId, { line_items: items });
  assert.deepStrictEqual(out.changed, ['line_items']);

  const result = queries.getResult(documentId);
  assert.strictEqual(result.invoice.line_items.length, 1);
  assert.strictEqual(result.invoice.line_items[0].description, 'Gadget');
  assert.ok(result.corrections.some((c) => c.field === 'line_items'));
});

test('correction: document-level issues from the pipeline stay after a correction', () => {
  const { documentId, invoiceId } = addInvoice(
    { invoice_number: 'C-6', total: 115 },
    [{ rule: 'duplicate_file', severity: 'error', field: 'document', message: 'same file' }]
  );
  correctionModel.applyCorrection(invoiceId, { total: 110.5 });
  assert.ok(rulesOf(documentId).includes('duplicate_file'));
  assert.ok(!rulesOf(documentId).includes('total_mismatch'));
  assert.strictEqual(needsReview(documentId), 1);
});

test('correction: a history entry is written', () => {
  const { documentId, invoiceId } = addInvoice({ invoice_number: 'C-7', total: 115 });
  correctionModel.applyCorrection(invoiceId, { total: 110.5 });
  const events = documentModel.getHistory(documentId).map((h) => h.event);
  assert.strictEqual(events[events.length - 1], 'corrected');
});

test('parseCorrectionBody: values are trimmed, currency is upper-cased, empty text becomes null', () => {
  const out = correctionModel.parseCorrectionBody({
    supplier_name: '  Acme  ',
    currency: 'usd',
    customer_name: '   ',
    total: 5,
  });
  assert.deepStrictEqual(out.changes, {
    supplier_name: 'Acme',
    currency: 'USD',
    customer_name: null,
    total: 5,
  });
});

test('api: PATCH corrects an invoice and returns the new result', async () => {
  const { documentId, invoiceId } = addInvoice({ invoice_number: 'H-1', total: 115 });
  const out = await patch(`/api/invoices/${invoiceId}`, { total: 110.5 });
  assert.strictEqual(out.res.status, 200);
  assert.deepStrictEqual(out.body.changed, ['total']);
  assert.strictEqual(out.body.invoice.total, 110.5);
  assert.strictEqual(out.body.invoice.is_corrected, 1);
  assert.strictEqual(out.body.document.needs_review, 0);
  assert.strictEqual(out.body.corrections.length, 1);
  assert.strictEqual(needsReview(documentId), 0);
});

test('api: bad correction bodies give 400 and change nothing', async () => {
  const { documentId, invoiceId } = addInvoice({ invoice_number: 'H-2' });
  const bad = [
    { foo: 1 },
    { invoice_date: '15/01/2026' },
    { invoice_date: '2026-02-30' },
    { currency: 'US' },
    { total: '110' },
    { line_items: 'x' },
    {},
    [1, 2],
  ];
  for (const body of bad) {
    const out = await patch(`/api/invoices/${invoiceId}`, body);
    assert.strictEqual(out.res.status, 400, JSON.stringify(body));
    assert.ok(out.body.error);
  }
  assert.strictEqual(queries.getResult(documentId).corrections.length, 0);
});

test('api: unknown id, invalid id and broken JSON are refused', async () => {
  assert.strictEqual((await patch('/api/invoices/999999', { total: 1 })).res.status, 404);
  assert.strictEqual((await patch('/api/invoices/abc', { total: 1 })).res.status, 400);
  const { invoiceId } = addInvoice({ invoice_number: 'H-3' });
  assert.strictEqual((await patch(`/api/invoices/${invoiceId}`, '{bad json')).res.status, 400);
});