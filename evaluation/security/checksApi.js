'use strict';

// API checks: manual correction input, ids and routes, query parameters,
// SQL-like search text, rate limits, and error-message leaks.
// Rate-limit checks must run last because they block the client for about a minute.

const lib = require('./lib');

const JSON_HEADERS = { 'content-type': 'application/json' };

function patch(id, body) {
  return lib.req('PATCH', '/api/invoices/' + id, { json: body });
}

function patchRaw(id, raw) {
  return lib.req('PATCH', '/api/invoices/' + id, { body: raw, headers: JSON_HEADERS });
}

async function runCorrection() {
  const area = 'Correction';
  const ctx = lib.state.ctx;

  const idCases = [
    ['abc', [400]],
    ['-1', [400]],
    ['1e3', [400]],
    ['99999999999999999999', [400]],
    ['0', [400, 404]],
  ];
  const badIds = [];
  for (const [id, expected] of idCases) {
    const r = await patch(id, { supplier_name: 'x' });
    if (!expected.includes(r.status)) badIds.push(id + ' -> ' + r.status);
  }
  lib.check(
    area,
    'PATCH with bad invoice ids is rejected (' + idCases.length + ' ids)',
    badIds.length === 0,
    badIds.join('; ') || 'abc, -1, 1e3 and a huge number gave 400; 0 gave 400 or 404'
  );

  if (!ctx.invoiceId) {
    lib.info(area, 'No invoice was created by the AI checks', 'body and text checks skipped');
    return;
  }
  const id = ctx.invoiceId;

  const nasty = "<script>alert(1)</script>'; DROP TABLE invoices; --";
  const p = await patch(id, { supplier_name: nasty });
  const res = await lib.req('GET', '/api/documents/' + ctx.completedId + '/result');
  const stored = res.json && res.json.invoice ? res.json.invoice.supplier_name : null;
  lib.check(
    area,
    'HTML and SQL-like text in a correction is stored as plain text',
    p.status === 200 && stored === nasty,
    'PATCH status ' + p.status + ', stored text identical: ' + (stored === nasty)
  );

  const tooMany = Array.from({ length: 501 }, () => ({}));
  const bodies = [
    ['unknown key', () => patch(id, { hacked: 1 })],
    ['id key', () => patch(id, { id: 5 })],
    ['total is text', () => patch(id, { total: 'abc' })],
    ['total too large', () => patch(id, { total: 1e13 })],
    ['impossible date', () => patch(id, { invoice_date: '2026-02-30' })],
    ['date is text', () => patch(id, { invoice_date: 'tomorrow' })],
    ['currency 2 letters', () => patch(id, { currency: 'US' })],
    ['currency digits', () => patch(id, { currency: '1234' })],
    ['text over 200 chars', () => patch(id, { supplier_name: 'x'.repeat(201) })],
    ['line_items is text', () => patch(id, { line_items: 'x' })],
    ['line_items not objects', () => patch(id, { line_items: [1, 2] })],
    ['501 line items', () => patch(id, { line_items: tooMany })],
    ['broken JSON', () => patchRaw(id, '{bad json')],
    ['__proto__ key', () => patchRaw(id, '{"__proto__":{"admin":true}}')],
  ];
  const notRejected = [];
  for (const [name, send] of bodies) {
    const r = await send();
    if (r.status !== 400) notRejected.push(name + ' -> ' + r.status);
  }
  lib.check(
    area,
    bodies.length + ' invalid correction bodies are rejected with 400',
    notRejected.length === 0,
    notRejected.join('; ') || 'all answered 400'
  );

  const big = await patch(id, { supplier_name: 'x'.repeat(1300000) });
  lib.check(
    area,
    'A JSON body over 1 MB is rejected',
    big.status === 413 || big.status === 400,
    'status ' + big.status
  );
}

async function runRoutes() {
  const area = 'Routes';
  const ctx = lib.state.ctx;

  const cases = [
    ['GET', '/api/documents/abc', [400]],
    ['GET', '/api/documents/-1', [400]],
    ['GET', '/api/documents/1e3', [400]],
    ['GET', '/api/documents/0', [400, 404]],
    ['GET', '/api/documents/abc/result', [400]],
    ['POST', '/api/documents/abc/reprocess', [400]],
    ['POST', '/api/documents/-1/reprocess', [400]],
    ['GET', '/api/documents/99999999/result', [404]],
    ['POST', '/api/documents/99999999/reprocess', [404]],
    ['GET', '/api/nothing', [404]],
    ['GET', '/nothing', [404]],
    ['DELETE', '/api/documents/1', [404]],
    ['PUT', '/api/invoices/1', [404]],
  ];
  const wrong = [];
  for (const [method, url, expected] of cases) {
    const r = await lib.req(method, url);
    if (!expected.includes(r.status)) wrong.push(method + ' ' + url + ' -> ' + r.status);
  }
  lib.check(
    area,
    'Bad ids and unknown routes give the expected status (' + cases.length + ' cases)',
    wrong.length === 0,
    wrong.join('; ') || 'all as expected'
  );

  const huge = await lib.req('GET', '/api/documents/99999999999999999999');
  lib.check(
    area,
    'A huge numeric document id does not cause a server error',
    huge.status === 400 || huge.status === 404,
    'status ' + huge.status
  );

  if (ctx.completedId) {
    const r = await lib.req('POST', '/api/documents/' + ctx.completedId + '/reprocess');
    lib.check(
      area,
      'Reprocess of a completed document is refused with 409',
      r.status === 409,
      'status ' + r.status
    );
  } else {
    lib.info(area, 'Reprocess of a completed document', 'no completed document, skipped');
  }
}

async function runQuery() {
  const area = 'Query and search';
  const q = (s) => encodeURIComponent(s);

  const base = await lib.req('GET', '/api/documents');
  const totalBefore = base.json && typeof base.json.total === 'number' ? base.json.total : null;
  lib.info(area, 'Documents in the temporary database', 'total ' + totalBefore);

  const params = [
    'limit=abc', 'limit=-1', 'limit=0', 'limit=1e3', 'offset=-5', 'offset=abc',
    'status=bogus', 'needs_review=maybe', 'from=not-a-date', 'to=2026-13-45',
  ];
  const seen = [];
  const bad = [];
  for (const p of params) {
    const r = await lib.req('GET', '/api/documents?' + p);
    seen.push(p + ':' + r.status);
    if (r.status !== 200 && r.status !== 400) bad.push(p + ' -> ' + r.status);
  }
  lib.check(
    area,
    'Bad filter values give 200 or 400, never a server error (' + params.length + ' cases)',
    bad.length === 0,
    bad.length ? bad.join('; ') : seen.join(', ')
  );

  const big = await lib.req('GET', '/api/documents?limit=100000');
  const lim = big.json ? big.json.limit : undefined;
  if (big.status === 400) {
    lib.check(area, 'limit=100000 is rejected or capped at 100', true, 'status 400');
  } else if (big.status === 200 && typeof lim === 'number') {
    lib.check(area, 'limit=100000 is rejected or capped at 100', lim <= 100, 'status 200, limit used ' + lim);
  } else {
    lib.info(area, 'limit=100000 could not be judged', 'status ' + big.status + ', limit field ' + lim);
  }

  const sql = ["zzqx' OR 1=1 --", '"; DROP TABLE documents; --', "%' UNION SELECT * FROM jobs --"];
  const sqlBad = [];
  let matchedAll = false;
  for (const s of sql) {
    const a = await lib.req('GET', '/api/documents?q=' + q(s));
    const b = await lib.req('GET', '/api/search?q=' + q(s) + '&mode=keyword');
    for (const r of [a, b]) {
      if (r.status !== 200 && r.status !== 400) sqlBad.push(s.slice(0, 12) + ' -> ' + r.status);
    }
    if (totalBefore && a.json && a.json.total === totalBefore) matchedAll = true;
  }
  lib.check(
    area,
    sql.length + ' SQL-like search texts cause no server error',
    sqlBad.length === 0,
    sqlBad.join('; ') || 'all answered 200 or 400'
  );
  lib.check(
    area,
    'SQL-like search text does not match every document',
    !matchedAll,
    'matched all documents: ' + matchedAll
  );

  const after = await lib.req('GET', '/api/documents');
  lib.check(
    area,
    'Tables are intact after the DROP TABLE attempts',
    after.status === 200 && after.json && after.json.total === totalBefore,
    'status ' + after.status + ', total before ' + totalBefore + ', after ' + (after.json ? after.json.total : 'n/a')
  );

  const long = await lib.req('GET', '/api/documents?q=' + q('a'.repeat(5000)));
  lib.check(
    area,
    'A 5000-character search text causes no server error',
    long.status === 200 || long.status === 400,
    'status ' + long.status
  );

  for (const w of ['%', '_']) {
    const r = await lib.req('GET', '/api/documents?q=' + q(w));
    lib.info(
      area,
      'Wildcard character ' + w + ' in keyword search',
      'status ' + r.status + ', matched ' + (r.json ? r.json.total : 'n/a') + ' of ' + totalBefore + ' documents'
    );
  }

  const badMode = await lib.req('GET', '/api/search?q=a&mode=evil');
  const noQ = await lib.req('GET', '/api/search');
  lib.check(
    area,
    'Search with unknown mode or without q causes no server error',
    [200, 400].includes(badMode.status) && [200, 400].includes(noQ.status),
    'unknown mode: ' + badMode.status + ', no q: ' + noQ.status
  );
}

async function burst(send, max) {
  let first = 0;
  let last = null;
  for (let i = 1; i <= max; i++) {
    last = await send();
    if (last.status === 429) {
      first = i;
      break;
    }
  }
  return { first, last };
}

async function runRateLimit() {
  const area = 'Rate limit';

  const up = await burst(() => lib.req('POST', '/api/documents', { body: new FormData() }), 45);
  lib.check(
    area,
    'Upload burst is limited with 429 within 45 requests',
    up.first > 0,
    up.first ? 'first 429 on extra request ' + up.first : 'no 429 in 45 requests'
  );
  if (up.last && up.last.status === 429) {
    lib.info(
      area,
      '429 answer format',
      'content-type ' + (up.last.headers.get('content-type') || 'none') +
        ', retry-after ' + (up.last.headers.get('retry-after') || 'absent')
    );
  }

  const gen = await burst(() => lib.req('GET', '/api/health'), 450);
  lib.check(
    area,
    'General API burst is limited with 429 within 450 requests',
    gen.first > 0,
    gen.first ? 'first 429 on request ' + gen.first : 'no 429 in 450 requests'
  );
}

function runErrors() {
  const area = 'Errors';
  const leak = /node_modules|\.js:\d+:\d+|[A-Za-z]:\\|SQLITE_|better-sqlite3/;
  const leaks = lib.responses.filter((r) => leak.test(r.text));
  lib.check(
    area,
    'No stack trace, file path or SQL driver text in any response (' + lib.responses.length + ' responses)',
    leaks.length === 0,
    leaks.slice(0, 5).map((r) => r.label + ' -> ' + r.status).join('; ') || 'none found'
  );

  const five = lib.responses.filter((r) => r.status >= 500);
  lib.check(
    area,
    'No request got a 5xx response',
    five.length === 0,
    five.slice(0, 5).map((r) => r.label + ' -> ' + r.status).join('; ') || 'none'
  );

  const zero = lib.responses.filter((r) => r.status === 0);
  lib.info(area, 'Requests without any HTTP answer (connection errors)', String(zero.length));

  lib.check(
    area,
    'Backend process was still running at the end',
    !lib.state.exited,
    lib.state.exited ? 'process exited' : 'running'
  );
}

module.exports = { runCorrection, runRoutes, runQuery, runRateLimit, runErrors };