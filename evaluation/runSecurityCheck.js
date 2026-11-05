'use strict';

// Security self-check. Starts its own backend copy (port 3102, temporary database
// and upload folder), runs the checks in ./security/*.js and writes
// evaluation/SECURITY_REPORT.md and evaluation/security-results.json.
// Uses 2 real Groq calls (two small CSV files).

const lib = require('./security/lib');
const stat = require('./security/checksStatic');
const upl = require('./security/checksUpload');
const api = require('./security/checksApi');

const GAPS = [
  'There is no login or authentication: anyone who can reach the API can read and change all data.',
  'A zip bomb (small .xlsx that expands hugely) was NOT tested because it could exhaust memory. The 50 MB limit counts the compressed size only. This is a known untested risk.',
  'Files are checked by extension and first bytes only. There is no antivirus scan. A .csv is any text without a NUL byte, so HTML or script text is accepted as CSV and stays plain data.',
  'Only one prompt-injection example was tried. Passing it does not prove the model cannot be misled.',
  'HTTPS must be provided by a reverse proxy in production. The HSTS header has no effect over plain HTTP.',
  'The rate limiter keeps counters in memory, per process and per IP. Behaviour behind a proxy or with several server processes was not checked.',
  'Semantic search and the Gemini call were not part of this check. Document text is sent to Groq (extraction) and Gemini (embeddings).',
  'CORS was tested with one foreign origin only.',
  '`npm audit` shows 2 moderate warnings in a dependency of exceljs (uuid). They are not fixed; `npm audit fix --force` would downgrade exceljs.',
  'The source-code checks are text-pattern searches, not a full code review. Git history was not scanned for keys, only current tracked files.',
  'Single run on localhost. Not tested over a network, under load, or against a deployed server.',
];

async function main() {
  const started = Date.now();
  console.log('Security check started. This takes a few minutes. Do not press Ctrl+C.');

  stat.runCode();
  console.log('Starting own backend on port ' + lib.PORT + ' ...');
  await lib.startServer();

  try {
    await stat.runHeaders();
    await stat.runCors();
    await stat.runExposure();
    await upl.runUploadChecks();
    console.log('Waiting for two real AI extractions (Groq) ...');
    await upl.runAiChecks();
    await api.runCorrection();
    await api.runRoutes();
    await api.runQuery();
    await api.runRateLimit();
    api.runErrors();
  } finally {
    await lib.stopServer();
  }

  const meta = {
    date: new Date().toISOString(),
    node: process.version,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  const counts = lib.writeReports(meta, GAPS);

  console.log('');
  console.log('Done. PASS ' + counts.PASS + ', FAIL ' + counts.FAIL + ', INFO ' + counts.INFO);
  const failed = lib.results.filter((r) => r.status === 'FAIL');
  for (const f of failed) {
    console.log('FAILED: ' + f.area + ' - ' + f.name + ' (' + f.detail + ')');
  }
  console.log('Reports written: evaluation/SECURITY_REPORT.md and evaluation/security-results.json');
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch(async (err) => {
  console.error('Security check failed: ' + lib.mask(err && err.message ? err.message : err));
  if (lib.state.log) {
    console.error('Last server output:\n' + lib.mask(lib.state.log));
  }
  await lib.stopServer();
  process.exit(1);
});