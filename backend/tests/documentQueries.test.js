// Tests for the list, result and reprocess queries. A temporary database is used.
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-queries-'));
process.env.DB_PATH = path.join(tmp, 'test.sqlite');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const { test } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db/connection');
const documentModel = require('../src/models/documentModel');
const invoiceModel = require('../src/models/invoiceModel');
const queries = require('../src/models/documentQueries');

let counter = 0;
function addDoc(name) {
  counter += 1;
  return documentModel.createWithJob({
    original_name: name,
    stored_name: `s${counter}.csv`,
    mime_type: 'text/csv',
    detected_type: 'csv',
    size_bytes: 10,
    sha256: `h${counter}`,
  }).documentId;
}

function invoiceOf(overrides = {}) {
  return {
    invoice_number: 'INV-1',
    invoice_date: '2026-01-15',
    supplier_name: 'Acme Ltd',
    customer_name: 'Beta Corp',
    subtotal: 100,
    tax: 10.5,
    total: 110.5,
    currency: 'USD',
    line_items: [{ description: 'Widget', quantity: 2, unit_price: 50, amount: 100 }],
    confidence: { total: 0.9 },
    uncertain_fields: [],
    ...overrides,
  };
}

function addInvoice(name, overrides) {
  const id = addDoc(name);
  invoiceModel.saveExtraction(id, invoiceOf(overrides), {
    rawJson: '{}',
    model: 'mock',
    promptVersion: 'v1',
  });
  return id;
}

function setStatus(id, status) {
  db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(status, id);
}

function makeFailed(id) {
  db.prepare("UPDATE documents SET status = 'failed', error_message = 'boom' WHERE id = ?").run(id);
  db.prepare("UPDATE jobs SET status = 'failed' WHERE document_id = ?").run(id);
}

function list(query) {
  const parsed = queries.parseListQuery(query);
  assert.ok(parsed.filters, parsed.error);
  return queries.listDocuments(parsed.filters);
}

test('list: newest first, with invoice fields, issue counts and no internal file name', () => {
  addInvoice('a.csv', { invoice_number: 'L-1', supplier_name: 'ListCo' });
  addInvoice('b.csv', { invoice_number: 'L-2', supplier_name: 'ListCo', total: 115 });
  const out = list({ supplier: 'ListCo' });
  assert.strictEqual(out.total, 2);
  assert.strictEqual(out.items[0].invoice_number, 'L-2');
  assert.strictEqual(out.items[1].invoice_number, 'L-1');
  assert.ok(out.items[0].error_count > 0);
  assert.strictEqual(out.items[1].error_count, 0);
  assert.ok(!('stored_name' in out.items[0]));
});

test('list: needs_review filter separates good and suspicious documents', () => {
  addInvoice('c.csv', { invoice_number: 'R-1', supplier_name: 'ReviewCo' });
  addInvoice('d.csv', { invoice_number: 'R-2', supplier_name: 'ReviewCo', total: 115 });
  const yes = list({ supplier: 'ReviewCo', needs_review: 'true' });
  const no = list({ supplier: 'ReviewCo', needs_review: 'false' });
  assert.strictEqual(yes.total, 1);
  assert.strictEqual(yes.items[0].invoice_number, 'R-2');
  assert.strictEqual(no.total, 1);
  assert.strictEqual(no.items[0].invoice_number, 'R-1');
});

test('list: status filter', () => {
  const a = addInvoice('e.csv', { invoice_number: 'S-1', supplier_name: 'StatusCo' });
  addInvoice('f.csv', { invoice_number: 'S-2', supplier_name: 'StatusCo' });
  setStatus(a, 'failed');
  const out = list({ supplier: 'StatusCo', status: 'failed' });
  assert.strictEqual(out.total, 1);
  assert.strictEqual(out.items[0].id, a);
});

test('list: % and _ in the search text are not wildcards, and search ignores case', () => {
  addInvoice('g.csv', { invoice_number: 'W-1', supplier_name: 'WildCoTest' });
  assert.strictEqual(list({ q: '%' }).total, 0);
  assert.strictEqual(list({ q: '_' }).total, 0);
  assert.strictEqual(list({ q: 'wildcotest' }).total, 1);
  assert.strictEqual(list({ q: 'W-1' }).total, 1);
});

test('list: limit and offset page through the results and total stays the same', () => {
  for (let n = 1; n <= 3; n += 1) {
    addInvoice(`p${n}.csv`, { invoice_number: `P-${n}`, supplier_name: 'PageCo' });
  }
  const first = list({ supplier: 'PageCo', limit: '2', offset: '0' });
  const second = list({ supplier: 'PageCo', limit: '2', offset: '2' });
  assert.strictEqual(first.total, 3);
  assert.strictEqual(first.items.length, 2);
  assert.strictEqual(second.items.length, 1);
});

test('list: the date range uses the invoice date', () => {
  addInvoice('h.csv', { invoice_number: 'D-1', supplier_name: 'DateCo', invoice_date: '2026-03-01' });
  addInvoice('i.csv', { invoice_number: 'D-2', supplier_name: 'DateCo', invoice_date: '2026-04-01' });
  assert.strictEqual(list({ supplier: 'DateCo', from: '2026-03-15' }).total, 1);
  assert.strictEqual(list({ supplier: 'DateCo', to: '2026-03-15' }).total, 1);
  assert.strictEqual(list({ supplier: 'DateCo', from: '2026-03-01', to: '2026-04-01' }).total, 2);
});

test('parseListQuery: bad values are rejected with a message', () => {
  assert.ok(queries.parseListQuery({ status: 'bogus' }).error);
  assert.ok(queries.parseListQuery({ from: '15/01/2026' }).error);
  assert.ok(queries.parseListQuery({ needs_review: 'maybe' }).error);
  assert.ok(queries.parseListQuery({ limit: '0' }).error);
  assert.ok(queries.parseListQuery({ offset: '-1' }).error);
  assert.ok(queries.parseListQuery({ status: ['queued', 'failed'] }).error);
});

test('parseListQuery: defaults are applied and a huge limit is capped', () => {
  const defaults = queries.parseListQuery({}).filters;
  assert.strictEqual(defaults.limit, 20);
  assert.strictEqual(defaults.offset, 0);
  assert.strictEqual(queries.parseListQuery({ limit: '100000' }).filters.limit, 100);
});

test('result: invoice, line items, issues and parsed json fields are returned', () => {
  const id = addInvoice('j.csv', {
    invoice_number: 'RES-1',
    total: 115,
    uncertain_fields: ['currency'],
  });
  const out = queries.getResult(id);
  assert.strictEqual(out.document.id, id);
  assert.ok(!('stored_name' in out.document));
  assert.strictEqual(out.invoice.invoice_number, 'RES-1');
  assert.strictEqual(out.invoice.line_items.length, 1);
  assert.strictEqual(out.invoice.confidence.total, 0.9);
  assert.deepStrictEqual(out.invoice.uncertain_fields, ['currency']);
  assert.ok(out.issues.some((i) => i.rule === 'total_mismatch'));
  assert.deepStrictEqual(out.corrections, []);
});

test('result: unknown document gives null, a document without invoice gives invoice null', () => {
  assert.strictEqual(queries.getResult(999999), null);
  const id = addDoc('k.csv');
  const out = queries.getResult(id);
  assert.strictEqual(out.invoice, null);
  assert.deepStrictEqual(out.issues, []);
});

test('reprocess: a failed document gets a new queued job and a history entry', () => {
  const id = addDoc('l.csv');
  makeFailed(id);
  const out = queries.requestReprocess(id);
  assert.strictEqual(out.ok, true);

  const doc = documentModel.getById(id);
  assert.strictEqual(doc.status, 'queued');
  assert.strictEqual(doc.error_message, null);
  const job = documentModel.getLatestJob(id);
  assert.strictEqual(job.id, out.jobId);
  assert.strictEqual(job.status, 'queued');
  const events = documentModel.getHistory(id).map((h) => h.event);
  assert.strictEqual(events[events.length - 1], 'reprocess_requested');
});

test('reprocess: only failed documents, unknown ids, and a second click are refused', () => {
  const done = addDoc('m.csv');
  setStatus(done, 'completed');
  assert.deepStrictEqual(queries.requestReprocess(done), {
    ok: false,
    reason: 'not_failed',
    status: 'completed',
  });
  assert.strictEqual(queries.requestReprocess(999999).reason, 'not_found');

  const failed = addDoc('n.csv');
  makeFailed(failed);
  assert.strictEqual(queries.requestReprocess(failed).ok, true);
  assert.strictEqual(queries.requestReprocess(failed).reason, 'not_failed');
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE document_id = ? AND status = 'queued'").get(failed).n,
    1
  );
});