'use strict';

// Shared helpers for the security check:
// own backend process, HTTP helper, result list and report writer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND = path.join(ROOT, 'backend');
const PORT = 3102;
const BASE = 'http://127.0.0.1:' + PORT;
const MAX_MB = 1;

const results = [];
const responses = [];
const state = { tmpDir: null, uploadDir: null, proc: null, log: '', exited: false, ctx: {} };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mask(text) {
  return String(text).replace(
    /gsk_[A-Za-z0-9]{10}[A-Za-z0-9]*|AIza[A-Za-z0-9_-]{10}[A-Za-z0-9_-]*/g,
    '[hidden]'
  );
}

function record(area, name, status, detail) {
  const d = detail ? String(detail).slice(0, 300) : '';
  results.push({ area, name, status, detail: d });
  console.log('[' + status + '] ' + area + ' - ' + name + (d ? ' (' + d + ')' : ''));
}

function check(area, name, ok, detail) {
  record(area, name, ok ? 'PASS' : 'FAIL', detail);
}

function info(area, name, detail) {
  record(area, name, 'INFO', detail);
}

async function startServer() {
  state.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-check-'));
  state.uploadDir = path.join(state.tmpDir, 'uploads');
  fs.mkdirSync(state.uploadDir);

  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    DB_PATH: path.join(state.tmpDir, 'security.db'),
    UPLOAD_DIR: state.uploadDir,
    MAX_FILE_SIZE_MB: String(MAX_MB),
  });

  state.proc = spawn(process.execPath, ['src/server.js'], {
    cwd: BACKEND,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.proc.on('exit', () => {
    state.exited = true;
  });
  const keep = (chunk) => {
    state.log = (state.log + chunk.toString()).slice(-3000);
  };
  state.proc.stdout.on('data', keep);
  state.proc.stderr.on('data', keep);

  for (let i = 0; i < 60; i++) {
    if (state.exited) throw new Error('Backend process exited during start');
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return;
    } catch (err) {
      // server not ready yet
    }
    await sleep(500);
  }
  throw new Error('Backend did not start within 30 seconds');
}

async function stopServer() {
  if (state.proc && !state.exited) {
    const done = new Promise((resolve) => state.proc.once('exit', resolve));
    state.proc.kill();
    await Promise.race([done, sleep(5000)]);
  }
  if (state.tmpDir) {
    try {
      fs.rmSync(state.tmpDir, { recursive: true, force: true });
    } catch (err) {
      // temp folder cleanup is best effort
    }
  }
}

async function req(method, urlPath, opts) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers || {});
  let body = o.body;
  if (o.json !== undefined) {
    body = JSON.stringify(o.json);
    headers['content-type'] = 'application/json';
  }
  const label = method + ' ' + urlPath.slice(0, 80);
  let res;
  try {
    res = await fetch(BASE + urlPath, { method, headers, body });
  } catch (err) {
    responses.push({ label, status: 0, text: '' });
    return { status: 0, headers: new Headers(), text: '', json: null };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    json = null;
  }
  responses.push({ label, status: res.status, text });
  return { status: res.status, headers: res.headers, text, json };
}

function makeForm(files, field) {
  const form = new FormData();
  for (const f of files) {
    form.append(
      field || 'files',
      new Blob([f.data], { type: f.type || 'application/octet-stream' }),
      f.name
    );
  }
  return form;
}

function upload(files, field) {
  return req('POST', '/api/documents', { body: makeForm(files, field) });
}

function listUploads() {
  return fs.readdirSync(state.uploadDir);
}

function findKey(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const value of Object.values(obj)) {
    const found = findKey(value, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findIds(obj, out) {
  const list = out || [];
  if (!obj || typeof obj !== 'object') return list;
  for (const [key, value] of Object.entries(obj)) {
    if ((key === 'id' || key === 'document_id') && Number.isInteger(value)) {
      if (!list.includes(value)) list.push(value);
    } else if (value && typeof value === 'object') {
      findIds(value, list);
    }
  }
  return list;
}

async function waitDone(id, maxMs) {
  const end = Date.now() + (maxMs || 150000);
  let last = { status: 'timeout', json: null };
  while (Date.now() < end) {
    const r = await req('GET', '/api/documents/' + id);
    if (r.status === 404) return { status: 'notfound', json: r.json };
    const j = r.json || {};
    const st = j.status || (j.document && j.document.status) || findKey(j, 'status');
    last = { status: st || 'unknown', json: j };
    if (['completed', 'failed', 'done'].includes(st)) return last;
    await sleep(1500);
  }
  return last;
}

function writeReports(meta, gaps) {
  const counts = { PASS: 0, FAIL: 0, INFO: 0 };
  for (const r of results) counts[r.status] += 1;
  const cell = (s) => String(s).replace(/\|/g, '/').replace(/\r?\n/g, ' ');

  const out = [];
  out.push('# Security check report', '');
  out.push(
    'Generated by `evaluation/runSecurityCheck.js` on ' + meta.date + ' (Node ' + meta.node + ').'
  );
  out.push(
    'Single run on localhost against its own copy of the backend (own port, temporary database and upload folder).'
  );
  out.push(
    'This is an automated self-check, not a penetration test and not a security certificate.',
    ''
  );
  out.push('## Summary', '');
  out.push('- PASS: ' + counts.PASS);
  out.push('- FAIL: ' + counts.FAIL);
  out.push('- INFO: ' + counts.INFO + ' (observations, not pass/fail)', '');
  out.push('## Results', '');

  const areas = [...new Set(results.map((r) => r.area))];
  for (const area of areas) {
    out.push('### ' + area, '', '| Result | Check | Detail |', '|---|---|---|');
    for (const r of results.filter((x) => x.area === area)) {
      out.push('| ' + r.status + ' | ' + cell(r.name) + ' | ' + cell(r.detail) + ' |');
    }
    out.push('');
  }

  out.push('## Not covered or known gaps', '');
  for (const g of gaps) out.push('- ' + g);
  out.push('');

  fs.writeFileSync(path.join(ROOT, 'evaluation', 'SECURITY_REPORT.md'), out.join('\n'), 'utf8');
  fs.writeFileSync(
    path.join(ROOT, 'evaluation', 'security-results.json'),
    JSON.stringify({ meta, counts, results }, null, 2),
    'utf8'
  );
  return counts;
}

module.exports = {
  ROOT,
  BACKEND,
  PORT,
  BASE,
  MAX_MB,
  results,
  responses,
  state,
  sleep,
  mask,
  record,
  check,
  info,
  startServer,
  stopServer,
  req,
  upload,
  listUploads,
  findKey,
  findIds,
  waitDone,
  writeReports,
};