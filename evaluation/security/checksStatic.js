'use strict';

// Checks that read the source code (no server needed) and basic HTTP checks:
// headers, CORS and exposed paths.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib');

const KEY_RE = /gsk_[A-Za-z0-9]{10}|AIza[A-Za-z0-9_-]{10}/;
const BINARY = [
  '.png', '.jpg', '.jpeg', '.pdf', '.xlsx', '.xls', '.tif', '.tiff',
  '.traineddata', '.ico', '.woff', '.woff2',
];

function walk(dir, exts, out) {
  const list = out || [];
  if (!fs.existsSync(dir)) return list;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, list);
    else if (exts.some((x) => entry.name.endsWith(x))) list.push(full);
  }
  return list;
}

function scan(files, regex) {
  const hits = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (regex.test(line)) hits.push(path.relative(lib.ROOT, file) + ':' + (i + 1));
    });
  }
  return hits;
}

function runCode() {
  const area = 'Code';

  let fn = null;
  try {
    const m = require(path.join(lib.BACKEND, 'src', 'utils', 'sanitize.js'));
    fn = typeof m === 'function' ? m : m.sanitizeFilename;
  } catch (err) {
    fn = null;
  }
  if (typeof fn !== 'function') {
    lib.info(area, 'sanitizeFilename could not be loaded', 'check skipped');
  } else {
    const names = [
      '../../etc/passwd',
      '..\\..\\windows\\system32\\cmd.exe',
      '<script>alert(1)</script>.pdf',
      'a'.repeat(300) + '.pdf',
      '.htaccess',
      'name\u0000.pdf',
      '....//....//x.csv',
      'a;b|c&d$(x).csv',
      '',
      '   ',
    ];
    const bad = [];
    names.forEach((n, i) => {
      try {
        const out = fn(n);
        const ok =
          typeof out === 'string' &&
          out.length > 0 &&
          out.length <= 150 &&
          !/[\\/<>\u0000:*?"|;&$]/.test(out) &&
          !out.includes('..') &&
          !out.startsWith('.');
        if (!ok) bad.push('#' + (i + 1));
      } catch (err) {
        bad.push('#' + (i + 1) + ' threw');
      }
    });
    lib.check(
      area,
      'sanitizeFilename on ' + names.length + ' hostile names',
      bad.length === 0,
      bad.length ? 'unsafe result for ' + bad.join(', ') : 'all results safe'
    );
  }

  const feFiles = walk(path.join(lib.ROOT, 'frontend', 'src'), ['.js', '.jsx', '.ts', '.tsx']);
  const feHits = scan(
    feFiles,
    /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|document\.write|\beval\(|new Function\(/
  );
  lib.check(
    area,
    'Frontend source has no raw HTML insertion or eval (' + feFiles.length + ' files)',
    feHits.length === 0,
    feHits.join(', ') || 'none found'
  );

  const beFiles = walk(path.join(lib.BACKEND, 'src'), ['.js']);
  const beHits = scan(beFiles, /\beval\(|new Function\(|child_process/);
  lib.check(
    area,
    'Backend source has no eval, new Function or child_process (' + beFiles.length + ' files)',
    beHits.length === 0,
    beHits.join(', ') || 'none found'
  );

  let tracked = null;
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: lib.ROOT, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (err) {
    tracked = null;
  }
  if (!tracked) {
    lib.info(area, 'git ls-files could not be run', 'tracked-file checks skipped');
    return;
  }
  const envFiles = tracked.filter((f) => path.basename(f) === '.env');
  lib.check(
    area,
    'No .env file is tracked by git',
    envFiles.length === 0,
    envFiles.join(', ') || tracked.length + ' tracked files checked'
  );
  const hits = [];
  for (const f of tracked) {
    if (BINARY.includes(path.extname(f).toLowerCase())) continue;
    const p = path.join(lib.ROOT, f);
    try {
      if (fs.statSync(p).size > 2000000) continue;
      if (KEY_RE.test(fs.readFileSync(p, 'utf8'))) hits.push(f);
    } catch (err) {
      // file removed or unreadable
    }
  }
  lib.check(
    area,
    'No API key pattern in tracked text files (current files, not git history)',
    hits.length === 0,
    hits.join(', ') || 'none found'
  );
}

async function runHeaders() {
  const area = 'Headers';
  const r = await lib.req('GET', '/api/health');
  const h = r.headers;
  lib.check(area, 'Health endpoint answers 200', r.status === 200, 'status ' + r.status);
  lib.check(
    area,
    'X-Content-Type-Options is nosniff',
    h.get('x-content-type-options') === 'nosniff',
    'value: ' + (h.get('x-content-type-options') || 'absent')
  );
  lib.check(
    area,
    'Content-Security-Policy header is present',
    !!h.get('content-security-policy'),
    h.get('content-security-policy') ? 'present' : 'absent'
  );
  lib.check(
    area,
    'X-Powered-By is not sent',
    !h.get('x-powered-by'),
    h.get('x-powered-by') ? 'present' : 'absent'
  );
  for (const name of [
    'x-frame-options',
    'referrer-policy',
    'strict-transport-security',
    'cross-origin-resource-policy',
  ]) {
    lib.info(area, name + ' header', h.get(name) ? 'present' : 'absent');
  }
}

async function runCors() {
  const area = 'CORS';
  const evil = 'https://evil.example';
  const g = await lib.req('GET', '/api/health', { headers: { Origin: evil } });
  const a = g.headers.get('access-control-allow-origin');
  lib.check(
    area,
    'Evil origin is not allowed on a normal request',
    a !== '*' && a !== evil,
    'allow-origin: ' + (a || 'none')
  );
  const p = await lib.req('OPTIONS', '/api/invoices/1', {
    headers: { Origin: evil, 'Access-Control-Request-Method': 'PATCH' },
  });
  const pa = p.headers.get('access-control-allow-origin');
  lib.check(
    area,
    'Evil origin is not allowed on a PATCH preflight',
    pa !== '*' && pa !== evil,
    'status ' + p.status + ', allow-origin: ' + (pa || 'none')
  );
  const l = await lib.req('GET', '/api/health', { headers: { Origin: 'http://localhost:5173' } });
  lib.info(
    area,
    'Frontend dev origin localhost:5173 (if none, the evil-origin tests above prove nothing)',
    'allow-origin: ' + (l.headers.get('access-control-allow-origin') || 'none')
  );
}

async function runExposure() {
  const area = 'Exposure';
  const paths = [
    '/.env',
    '/backend/.env',
    '/package.json',
    '/backend/package.json',
    '/src/server.js',
    '/backend/src/config/index.js',
    '/uploads',
    '/uploads/x',
    '/api/uploads',
    '/data',
    '/.git/config',
    '/evaluation/labels.json',
    '/%2e%2e%2f%2e%2e%2f.env',
    '/..%2f..%2fpackage.json',
    '/api/%2e%2e%2f%2e%2e%2fbackend%2f.env',
  ];
  const bad = [];
  for (const p of paths) {
    const r = await lib.req('GET', p);
    const leaked = /GROQ_API_KEY|GEMINI_API_KEY|"dependencies"|require\(/.test(r.text);
    if (![400, 403, 404].includes(r.status) || leaked) bad.push(p + ' -> ' + r.status);
  }
  lib.check(
    area,
    'Secret and source paths are not served (' + paths.length + ' paths)',
    bad.length === 0,
    bad.join('; ') || 'all answered 400/403/404'
  );
}

module.exports = { runCode, runHeaders, runCors, runExposure };