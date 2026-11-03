// API tests: a real HTTP server on a free port, a temporary database, no worker, no LLM.
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-api-'));
process.env.DB_PATH = path.join(tmp, 'test.sqlite');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const db = require('../src/db/connection');
const app = require('../src/app');

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

async function uploadCsv(name) {
  const form = new FormData();
  form.append('files', new Blob(['item,qty\nWidget,2\n'], { type: 'text/csv' }), name);
  const res = await fetch(`${base}/api/documents`, { method: 'POST', body: form });
  return { res, body: await res.json() };
}

const get = async (url) => {
  const res = await fetch(`${base}${url}`);
  return { res, body: await res.json() };
};
const post = async (url) => {
  const res = await fetch(`${base}${url}`, { method: 'POST' });
  return { res, body: await res.json() };
};

test('api: an uploaded csv is accepted and shows up in the list without internal fields', async () => {
  const up = await uploadCsv('api-first.csv');
  assert.strictEqual(up.res.status, 202);
  assert.strictEqual(up.body.accepted.length, 1);

  const list = await get('/api/documents?limit=5');
  assert.strictEqual(list.res.status, 200);
  assert.ok(list.body.total >= 1);
  const found = list.body.items.find((d) => d.id === up.body.accepted[0].id);
  assert.ok(found);
  assert.strictEqual(found.original_name, 'api-first.csv');
  assert.strictEqual(found.status, 'queued');
  assert.ok(!('stored_name' in found));
});

test('api: bad list filters give 400 with a message', async () => {
  for (const url of [
    '/api/documents?status=bogus',
    '/api/documents?from=15-01-2026',
    '/api/documents?limit=0',
    '/api/documents?needs_review=maybe',
  ]) {
    const out = await get(url);
    assert.strictEqual(out.res.status, 400, url);
    assert.ok(out.body.error);
  }
});

test('api: result of a not yet processed document has invoice null', async () => {
  const up = await uploadCsv('api-result.csv');
  const id = up.body.accepted[0].id;
  const out = await get(`/api/documents/${id}/result`);
  assert.strictEqual(out.res.status, 200);
  assert.strictEqual(out.body.document.id, id);
  assert.strictEqual(out.body.invoice, null);
  assert.ok(!('stored_name' in out.body.document));
});

test('api: result with an unknown or invalid id gives 404 or 400', async () => {
  assert.strictEqual((await get('/api/documents/999999/result')).res.status, 404);
  assert.strictEqual((await get('/api/documents/abc/result')).res.status, 400);
  assert.strictEqual((await get('/api/documents/1;DROP/result')).res.status, 400);
});

test('api: reprocess of a queued document is refused with 409', async () => {
  const up = await uploadCsv('api-queued.csv');
  const id = up.body.accepted[0].id;
  const out = await post(`/api/documents/${id}/reprocess`);
  assert.strictEqual(out.res.status, 409);
  assert.strictEqual((await post('/api/documents/999999/reprocess')).res.status, 404);
  assert.strictEqual((await post('/api/documents/abc/reprocess')).res.status, 400);
});

test('api: reprocess of a failed document returns 202 and queues it again', async () => {
  const up = await uploadCsv('api-failed.csv');
  const id = up.body.accepted[0].id;
  db.prepare("UPDATE documents SET status = 'failed', error_message = 'boom' WHERE id = ?").run(id);

  const out = await post(`/api/documents/${id}/reprocess`);
  assert.strictEqual(out.res.status, 202);
  assert.ok(out.body.job_id);

  const status = await get(`/api/documents/${id}`);
  assert.strictEqual(status.body.document.status, 'queued');
  assert.strictEqual(status.body.document.error_message, null);
  const events = status.body.history.map((h) => h.event);
  assert.strictEqual(events[events.length - 1], 'reprocess_requested');

  // a second click is refused
  assert.strictEqual((await post(`/api/documents/${id}/reprocess`)).res.status, 409);
});

test('api: an unknown route gives 404 json', async () => {
  const out = await get('/api/nothing-here');
  assert.strictEqual(out.res.status, 404);
  assert.strictEqual(out.body.error, 'Not found');
});