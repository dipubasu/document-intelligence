// Tests for semantic search with a fake embedding service: no real network, no real key.
// The fake vector has 3 numbers: "notebook" in the text, "weather" in the text, and a constant.
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-semantic-'));
process.env.DB_PATH = path.join(tmp, 'test.sqlite');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const db = require('../src/db/connection');
const { semanticSearch, MAX_NEW_PER_SEARCH } = require('../src/models/semanticSearch');
const { EmbeddingError } = require('../src/services/embeddings');

config.gemini.apiKey = 'test-key';
config.gemini.embeddingModel = 'test-model';

const savedFetch = global.fetch;
const ids = {};
let calls = 0;

function vectorFor(text) {
  const t = text.toLowerCase();
  return [t.includes('notebook') ? 1 : 0, t.includes('weather') ? 1 : 0, 0.1];
}

function installFakeFetch() {
  calls = 0;
  global.fetch = async (url, options) => {
    calls += 1;
    const text = JSON.parse(options.body).content.parts[0].text;
    return {
      ok: true,
      status: 200,
      json: async () => ({ embedding: { values: vectorFor(text) } }),
    };
  };
}

function addInvoice(fileName, supplier, itemName, pageText) {
  const doc = db
    .prepare('INSERT INTO documents (original_name, stored_name) VALUES (?, ?)')
    .run(fileName, `stored-${fileName}`);
  const documentId = Number(doc.lastInsertRowid);
  db.prepare('INSERT INTO document_pages (document_id, page_number, text) VALUES (?, 1, ?)').run(
    documentId,
    pageText
  );
  const inv = db
    .prepare('INSERT INTO invoices (document_id, supplier_name, total, currency) VALUES (?, ?, 10, ?)')
    .run(documentId, supplier, 'USD');
  const invoiceId = Number(inv.lastInsertRowid);
  db.prepare('INSERT INTO invoice_line_items (invoice_id, description) VALUES (?, ?)').run(
    invoiceId,
    itemName
  );
  return { documentId, invoiceId };
}

before(() => {
  ids.a = addInvoice('a.csv', 'Alpha Supplies', 'Notebook', 'Quantity 20');
  ids.b = addInvoice('b.csv', 'Beta Traders', 'Weather report', 'Quantity 5');
});

afterEach(() => {
  global.fetch = savedFetch;
});

after(() => {
  db.close();
});

const run = (q, extra = {}) => semanticSearch({ q, limit: 20, offset: 0, ...extra });

test('semantic: the closest invoice comes first and vectors are stored', async () => {
  installFakeFetch();
  const r = await run('notebook');
  assert.equal(r.mode, 'semantic');
  assert.equal(r.total, 2);
  assert.equal(r.not_indexed, 0);
  assert.equal(r.items[0].document_id, ids.a.documentId);
  assert.ok(r.items[0].score > r.items[1].score);
  assert.equal(calls, 3); // 1 question + 2 invoices
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM embeddings').get().n, 2);
});

test('semantic: a second search only embeds the question', async () => {
  installFakeFetch();
  const r = await run('notebook');
  assert.equal(calls, 1);
  assert.equal(r.items[0].document_id, ids.a.documentId);
});

test('semantic: a changed invoice gets a new vector', async () => {
  installFakeFetch();
  db.prepare('UPDATE invoice_line_items SET description = ? WHERE invoice_id = ?').run(
    'Weather report',
    ids.a.invoiceId
  );
  const r = await run('notebook');
  assert.equal(calls, 2); // 1 question + 1 changed invoice
  const a = r.items.find((i) => i.document_id === ids.a.documentId);
  assert.ok(a.score < 0.1);
});

test('semantic: limit and offset page through the ranked list', async () => {
  installFakeFetch();
  const first = await run('notebook', { limit: 1, offset: 0 });
  const second = await run('notebook', { limit: 1, offset: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.equal(first.total, 2);
  assert.notEqual(first.items[0].document_id, second.items[0].document_id);
});

test('semantic: a failing embedding service gives an EmbeddingError without provider text', async () => {
  global.fetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: { message: 'secret provider details' } }),
  });
  await assert.rejects(run('notebook'), (err) => {
    assert.ok(err instanceof EmbeddingError);
    assert.equal(err.status, 429);
    assert.ok(!err.message.includes('secret provider details'));
    return true;
  });
});

test('semantic: at most MAX_NEW_PER_SEARCH new vectors per search, the rest next time', async () => {
  installFakeFetch();
  for (let n = 1; n <= MAX_NEW_PER_SEARCH + 3; n += 1) {
    addInvoice(`extra-${n}.csv`, 'Extra Co', 'Notebook', `Extra ${n}`);
  }
  const first = await run('notebook', { limit: 100 });
  assert.equal(first.not_indexed, 3);
  assert.equal(first.total, 2 + MAX_NEW_PER_SEARCH);
  assert.equal(calls, 1 + MAX_NEW_PER_SEARCH);

  installFakeFetch();
  const second = await run('notebook', { limit: 100 });
  assert.equal(second.not_indexed, 0);
  assert.equal(second.total, 2 + MAX_NEW_PER_SEARCH + 3);
  assert.equal(calls, 1 + 3);
});