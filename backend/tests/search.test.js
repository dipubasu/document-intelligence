// Tests for keyword search: page text, invoice fields, wildcards, paging and the HTTP endpoint.
// A temporary database is used, there is no worker and no LLM.
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-search-'));
process.env.DB_PATH = path.join(tmp, 'test.sqlite');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db/connection');
const app = require('../src/app');
const { parseSearchQuery, keywordSearch, makeSnippet } = require('../src/models/searchQueries');

let server;
let base;
const ids = {};

function addDocument(name, pages, invoice = null) {
  const info = db
    .prepare('INSERT INTO documents (original_name, stored_name) VALUES (?, ?)')
    .run(name, `stored-${name}`);
  const documentId = Number(info.lastInsertRowid);

  pages.forEach((p) => {
    db.prepare(
      'INSERT INTO document_pages (document_id, page_number, sheet_name, text) VALUES (?, ?, ?, ?)'
    ).run(documentId, p.page ?? null, p.sheet ?? null, p.text);
  });

  if (invoice) {
    db.prepare(
      `INSERT INTO invoices (document_id, invoice_number, supplier_name, customer_name, total, currency)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      documentId,
      invoice.number,
      invoice.supplier,
      invoice.customer ?? null,
      invoice.total ?? null,
      invoice.currency ?? null
    );
  }
  return documentId;
}

before(async () => {
  // oldest first, so a higher id means a newer document
  ids.alpha = addDocument(
    'alpha.csv',
    [{ page: 1, text: 'Notebook 20 pcs. Discount 50% applied. Ref A_B' }],
    { number: 'NW-1', supplier: 'Northwind Traders Ltd', customer: 'Bright Future School', total: 99, currency: 'USD' }
  );
  ids.beta = addDocument('beta.pdf', [
    { page: 1, text: 'Cover page only' },
    { page: 2, text: 'Payment terms: net 30 days. Order of 500 units. Ref AxB' },
    { page: 3, text: 'Payment terms repeated here' },
  ]);
  ids.gamma = addDocument(
    'gamma.xlsx',
    [{ sheet: 'Summary', text: 'Quarterly summary' }],
    { number: 'GM-7', supplier: 'Gamma Supplies' }
  );
  ids.delta = addDocument(
    'delta.pdf',
    [1, 2, 3, 4, 5].map((n) => ({ page: n, text: `zebra stripes ${n}` }))
  );
  ids.epsilon = addDocument('epsilon.pdf', [{ page: 1, text: 'zebra herd' }]);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
});

const search = (q, extra = {}) => keywordSearch({ q, limit: 20, offset: 0, ...extra });

test('search: text inside a page is found with page number and snippet', () => {
  const r = search('net 30');
  assert.strictEqual(r.total, 1);
  const item = r.items[0];
  assert.strictEqual(item.document_id, ids.beta);
  assert.deepStrictEqual(item.matched_fields, []);
  assert.strictEqual(item.matching_pages, 1);
  assert.strictEqual(item.pages[0].page_number, 2);
  assert.match(item.pages[0].snippet, /net 30 days/);
});

test('search: an invoice field matches, ignoring upper and lower case', () => {
  const r = search('NORTHWIND');
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.items[0].document_id, ids.alpha);
  assert.deepStrictEqual(r.items[0].matched_fields, ['supplier_name']);
  assert.strictEqual(r.items[0].matching_pages, 0);
  assert.strictEqual(r.items[0].total, 99);
});

test('search: file name and supplier are both reported as matched fields', () => {
  const r = search('gamma');
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.items[0].document_id, ids.gamma);
  assert.deepStrictEqual(r.items[0].matched_fields, ['original_name', 'supplier_name']);
});

test('search: a sheet name is returned for spreadsheet text', () => {
  const r = search('quarterly');
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.items[0].pages[0].sheet_name, 'Summary');
  assert.strictEqual(r.items[0].pages[0].page_number, null);
});

test('search: % is a normal character, not a wildcard', () => {
  const r = search('50%');
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.items[0].document_id, ids.alpha);
});

test('search: _ is a normal character, not a wildcard', () => {
  const r = search('A_B');
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.items[0].document_id, ids.alpha);
});

test('search: matching pages are counted, and only the first 3 are listed', () => {
  const beta = search('payment terms').items[0];
  assert.strictEqual(beta.matching_pages, 2);
  assert.strictEqual(beta.pages.length, 2);

  const delta = search('zebra').items.find((i) => i.document_id === ids.delta);
  assert.strictEqual(delta.matching_pages, 5);
  assert.strictEqual(delta.pages.length, 3);
  assert.deepStrictEqual(delta.pages.map((p) => p.page_number), [1, 2, 3]);
});

test('search: no match gives an empty list', () => {
  const r = search('this text is nowhere');
  assert.strictEqual(r.total, 0);
  assert.deepStrictEqual(r.items, []);
});

test('search: newest first, limit and offset page through the results', () => {
  const first = search('zebra', { limit: 1, offset: 0 });
  const second = search('zebra', { limit: 1, offset: 1 });
  assert.strictEqual(first.total, 2);
  assert.strictEqual(second.total, 2);
  assert.strictEqual(first.items[0].document_id, ids.epsilon);
  assert.strictEqual(second.items[0].document_id, ids.delta);
});

test('parseSearchQuery: bad values are rejected with a message', () => {
  assert.match(parseSearchQuery({}).error, /q is required/);
  assert.match(parseSearchQuery({ q: 'a' }).error, /at least 2/);
  assert.match(parseSearchQuery({ q: 'x'.repeat(101) }).error, /at most 100/);
  assert.match(parseSearchQuery({ q: ['a', 'b'] }).error, /single text value/);
  assert.match(parseSearchQuery({ q: 'abc', mode: 'fuzzy' }).error, /mode must be/);
  assert.match(parseSearchQuery({ q: 'abc', limit: '0' }).error, /limit/);
  assert.match(parseSearchQuery({ q: 'abc', limit: 'abc' }).error, /limit/);
  assert.match(parseSearchQuery({ q: 'abc', offset: '-1' }).error, /offset/);
});

test('parseSearchQuery: defaults are applied, spaces are tidied and a huge limit is capped', () => {
  assert.deepStrictEqual(parseSearchQuery({ q: '  hello   world ' }).params, {
    q: 'hello world',
    mode: 'keyword',
    limit: 20,
    offset: 0,
  });
  assert.strictEqual(parseSearchQuery({ q: 'abc', limit: '500' }).params.limit, 100);
});

test('makeSnippet: long text is cut around the match, short text is kept whole', () => {
  const long = `${'x'.repeat(200)} needle ${'y'.repeat(200)}`;
  const cut = makeSnippet(long, 'needle');
  assert.ok(cut.startsWith('...'));
  assert.ok(cut.endsWith('...'));
  assert.ok(cut.includes('needle'));
  assert.ok(cut.length < 200);

  assert.strictEqual(makeSnippet('hello needle there', 'needle'), 'hello needle there');
});

test('api: GET /api/search finds page text and refuses semantic mode for now', async () => {
  const ok = await fetch(`${base}/api/search?q=${encodeURIComponent('net 30')}`);
  assert.strictEqual(ok.status, 200);
  const body = await ok.json();
  assert.strictEqual(body.mode, 'keyword');
  assert.strictEqual(body.items.length, 1);
  assert.strictEqual(body.items[0].pages[0].page_number, 2);

  const semantic = await fetch(`${base}/api/search?q=invoice&mode=semantic`);
  assert.strictEqual(semantic.status, 501);
  assert.match((await semantic.json()).error, /not available/);
});

test('api: GET /api/search with bad parameters gives 400', async () => {
  for (const url of ['/api/search', '/api/search?q=a', '/api/search?q=abc&mode=bogus', '/api/search?q=abc&limit=0']) {
    const res = await fetch(`${base}${url}`);
    assert.strictEqual(res.status, 400, url);
    assert.ok((await res.json()).error);
  }
});