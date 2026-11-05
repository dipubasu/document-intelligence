// Runs the real system on the synthetic dataset and measures the results.
// It starts its own backend (port 3100, temporary database and upload folder),
// uploads every file, waits, compares the answers with labels.json and writes
// evaluation/REPORT.md and evaluation/results.json.
// Every number in the report is computed here from this run. Nothing is typed by hand.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const DATASET_DIR = path.join(__dirname, 'dataset');
const LABELS_FILE = path.join(__dirname, 'labels.json');
const RESULTS_FILE = path.join(__dirname, 'results.json');
const REPORT_FILE = path.join(__dirname, 'REPORT.md');

const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const POLL_MS = 2000;
const PHASE_TIMEOUT_MS = 15 * 60 * 1000;

const FIELDS = [
  'invoice_number', 'invoice_date', 'supplier_name', 'customer_name',
  'subtotal', 'tax', 'total', 'currency',
];

// Rules that must be reported for these files. labels.json has no rule list for them.
const MORE_REQUIRED_RULES = {
  'err-missing-number.pdf': ['missing_field'],
  'err-lines-mismatch.xlsx': ['line_items_mismatch'],
  'not-invoice.pdf': ['missing_field'],
};

const MIME = {
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
const pct = (a, b) => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(1)}%`);
const ms = (n) => (n === null || n === undefined ? 'n/a' : `${Math.round(n)} ms`);

// ---------- own backend ----------

function startServer(workDir) {
  const uploadDir = path.join(workDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: path.join(workDir, 'eval.sqlite'),
      UPLOAD_DIR: uploadDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const jobMs = new Map(); // document id -> job duration from the server log
  const tail = [];
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  process.on('exit', () => {
    if (!exited) child.kill();
  });

  const attach = (stream) => {
    let rest = '';
    stream.on('data', (chunk) => {
      rest += chunk.toString();
      const lines = rest.split(/\r?\n/);
      rest = lines.pop();
      for (const raw of lines) {
        const line = stripAnsi(raw);
        tail.push(line);
        if (tail.length > 30) tail.shift();
        const m = line.match(/job completed (\{.*\})/);
        if (m) {
          try {
            const d = JSON.parse(m[1]);
            if (typeof d.documentId === 'number' && typeof d.durationMs === 'number') {
              jobMs.set(d.documentId, d.durationMs);
            }
          } catch {
            // not JSON, ignore
          }
        }
      }
    });
  };
  attach(child.stdout);
  attach(child.stderr);

  async function waitReady() {
    const start = Date.now();
    while (Date.now() - start < 60000) {
      if (exited) throw new Error(`Backend stopped early. Last log lines:\n${tail.join('\n')}`);
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await sleep(500);
    }
    throw new Error(`Backend did not start in 60 seconds. Last log lines:\n${tail.join('\n')}`);
  }

  function stop() {
    return new Promise((resolve) => {
      if (exited) return resolve();
      child.once('exit', () => resolve());
      child.kill();
      setTimeout(resolve, 5000);
    });
  }

  return { waitReady, stop, jobMs };
}

// ---------- HTTP helpers ----------

async function api(pathname, options) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(BASE + pathname, options);
    if (res.status === 429) {
      await sleep(3000);
      continue;
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      // no JSON body
    }
    return { status: res.status, body };
  }
  throw new Error(`Too many 429 answers for ${pathname}`);
}

async function upload(file) {
  const buf = fs.readFileSync(path.join(DATASET_DIR, file));
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const form = new FormData();
  form.append('files', new Blob([buf], { type }), file);
  const r = await api('/api/documents', { method: 'POST', body: form });
  const accepted = r.body && Array.isArray(r.body.accepted) ? r.body.accepted : [];
  if (accepted.length === 1) return { accepted: true, id: accepted[0].id, httpStatus: r.status };
  return { accepted: false, id: null, httpStatus: r.status };
}

async function waitForDone(ids, label) {
  const start = Date.now();
  let lastDone = -1;
  while (true) {
    const r = await api('/api/documents?limit=100');
    const items = r.body && Array.isArray(r.body.items) ? r.body.items : [];
    const statuses = {};
    for (const it of items) statuses[it.id] = it.status;
    const done = ids.filter((id) => statuses[id] === 'completed' || statuses[id] === 'failed').length;
    if (done !== lastDone) {
      console.log(`  ${label}: ${done}/${ids.length} finished`);
      lastDone = done;
    }
    if (done === ids.length) return { timedOut: false };
    if (Date.now() - start > PHASE_TIMEOUT_MS) return { timedOut: true };
    await sleep(POLL_MS);
  }
}

// ---------- scoring ----------

function fieldCorrect(expected, actual) {
  if (actual === undefined) return false; // nothing was extracted
  if (expected === null) return actual === null;
  if (actual === null) return false;
  if (typeof expected === 'number') {
    return typeof actual === 'number' && Math.abs(actual - expected) < 0.005;
  }
  return norm(actual) === norm(expected);
}

function evaluate(label, up, result, jobMs) {
  const e = label.expect;
  const rec = {
    file: label.file,
    kind: label.kind,
    group: label.group,
    phase: label.phase,
    note: label.note,
    expectedUpload: e.upload,
    expectedStatus: e.status || null,
    uploadAccepted: up.accepted,
    docId: up.id,
    jobMs: jobMs ?? null,
    status: null,
    errorMessage: null,
  };

  if (e.upload === 'rejected') {
    rec.handledOk = !up.accepted;
    return rec;
  }

  const doc = result && result.document ? result.document : null;
  rec.status = up.accepted ? (doc ? doc.status : 'unknown') : 'not_accepted';
  rec.errorMessage = doc && doc.error_message ? doc.error_message : null;

  if (e.status === 'failed') {
    rec.handledOk = rec.status === 'failed';
    return rec;
  }

  // a document that should be extracted
  const invoice = result && result.invoice ? result.invoice : null;
  const rules = result && Array.isArray(result.issues) ? [...new Set(result.issues.map((i) => i.rule))] : [];
  const required = [...new Set([...(e.issues || []), ...(MORE_REQUIRED_RULES[label.file] || [])])];

  rec.needsReview = doc ? Boolean(doc.needs_review) : null;
  rec.expectedNeedsReview = e.needs_review;
  rec.reviewOk = doc ? Boolean(doc.needs_review) === e.needs_review : false;
  rec.rules = rules;
  rec.requiredRules = required;
  rec.missingRules = required.filter((r) => !rules.includes(r));
  rec.model = invoice ? invoice.model : null;
  rec.promptVersion = invoice ? invoice.prompt_version : null;

  rec.fieldResults = {};
  let correct = 0;
  for (const f of FIELDS) {
    const expected = e.fields[f];
    const actual = invoice ? invoice[f] : undefined;
    const ok = fieldCorrect(expected, actual);
    if (ok) correct++;
    rec.fieldResults[f] = { expected, actual: actual === undefined ? null : actual, ok, extracted: Boolean(invoice) };
  }
  rec.fieldsCorrect = correct;
  rec.lineItemsExpected = e.line_item_count;
  rec.lineItemsActual = invoice && Array.isArray(invoice.line_items) ? invoice.line_items.length : null;
  rec.lineItemsOk = rec.lineItemsActual === e.line_item_count;
  return rec;
}

function stats(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const mid = Math.floor(s.length / 2);
  return {
    n: s.length,
    avg: sum / s.length,
    median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
    min: s[0],
    max: s[s.length - 1],
  };
}

function summarize(records) {
  const ext = records.filter((r) => r.expectedStatus === 'completed');
  const s = { extractionDocs: ext.length };

  s.fieldsTotal = ext.length * FIELDS.length;
  s.fieldsCorrect = ext.reduce((a, r) => a + r.fieldsCorrect, 0);
  s.exactDocs = ext.filter((r) => r.fieldsCorrect === FIELDS.length).length;
  s.lineItemsOk = ext.filter((r) => r.lineItemsOk).length;

  s.byField = FIELDS.map((f) => ({
    field: f,
    correct: ext.filter((r) => r.fieldResults[f].ok).length,
    total: ext.length,
  }));

  const kinds = [...new Set(ext.map((r) => r.kind))];
  s.byKind = kinds.map((k) => {
    const rs = ext.filter((r) => r.kind === k);
    const times = rs.filter((r) => r.status === 'completed' && r.jobMs !== null).map((r) => r.jobMs);
    return {
      kind: k,
      docs: rs.length,
      correct: rs.reduce((a, r) => a + r.fieldsCorrect, 0),
      total: rs.length * FIELDS.length,
      exact: rs.filter((r) => r.fieldsCorrect === FIELDS.length).length,
      time: stats(times),
    };
  });

  s.invented = [];
  s.mistakes = [];
  for (const r of ext) {
    for (const f of FIELDS) {
      const fr = r.fieldResults[f];
      if (fr.ok) continue;
      s.mistakes.push({ file: r.file, field: f, expected: fr.expected, actual: fr.extracted ? fr.actual : '(nothing extracted)' });
      if (fr.expected === null && fr.extracted && fr.actual !== null) {
        s.invented.push({ file: r.file, field: f, value: fr.actual });
      }
    }
  }

  const done = ext.filter((r) => r.status === 'completed');
  s.review = {
    tp: done.filter((r) => r.expectedNeedsReview && r.needsReview).length,
    fn: done.filter((r) => r.expectedNeedsReview && !r.needsReview).length,
    fp: done.filter((r) => !r.expectedNeedsReview && r.needsReview).length,
    tn: done.filter((r) => !r.expectedNeedsReview && !r.needsReview).length,
  };

  s.rules = [];
  for (const r of ext) {
    for (const rule of r.requiredRules) {
      s.rules.push({ file: r.file, rule, found: r.rules.includes(rule) });
    }
  }

  s.completed = ext.filter((r) => r.status === 'completed').length;
  s.failedUnexpected = ext.filter((r) => r.status === 'failed').length;
  s.otherOutcome = ext.length - s.completed - s.failedUnexpected;

  const bad = records.filter((r) => r.expectedStatus === 'failed' || r.expectedUpload === 'rejected');
  s.badFiles = bad.length;
  s.badHandled = bad.filter((r) => r.handledOk).length;

  const completedJobs = done.filter((r) => r.jobMs !== null);
  s.timeAll = stats(completedJobs.map((r) => r.jobMs));
  s.timeNoReuse = stats(completedJobs.filter((r) => !r.rules.includes('duplicate_file')).map((r) => r.jobMs));
  s.reusedCount = completedJobs.filter((r) => r.rules.includes('duplicate_file')).length;
  return s;
}

// ---------- report ----------

function table(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

function timeRow(name, t) {
  if (!t) return [name, '0', 'n/a', 'n/a', 'n/a', 'n/a'];
  return [name, String(t.n), ms(t.avg), ms(t.median), ms(t.min), ms(t.max)];
}

function buildReport(labels, records, s, meta) {
  const kinds = {};
  for (const l of labels) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
  const models = [...new Set(records.map((r) => r.model).filter(Boolean))];
  const prompts = [...new Set(records.map((r) => r.promptVersion).filter(Boolean))];
  const out = [];

  out.push('# Evaluation report');
  out.push('');
  out.push('This file is generated by evaluation/runEvaluation.js. Every number below was measured in one real run of the system.');
  out.push('');
  out.push(`- Run started: ${meta.startedAt}`);
  out.push(`- Node: ${process.version}`);
  out.push(`- LLM model reported by the system: ${models.join(', ') || 'n/a'} (prompt version ${prompts.join(', ') || 'n/a'})`);
  out.push(`- Dataset: ${labels.length} files (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ')})`);
  out.push(`- Total wall time: phase 1 (${meta.phase1Count} files together) ${ms(meta.phase1Ms)}, phase 2 (${meta.phase2Count} files one by one) ${ms(meta.phase2Ms)}`);
  out.push('');

  out.push('## Headline numbers');
  out.push('');
  out.push(table(['Measure', 'Result'], [
    ['Field-level extraction accuracy (8 fields per document)', `${s.fieldsCorrect}/${s.fieldsTotal} = ${pct(s.fieldsCorrect, s.fieldsTotal)}`],
    ['Documents with all 8 fields correct', `${s.exactDocs}/${s.extractionDocs} = ${pct(s.exactDocs, s.extractionDocs)}`],
    ['Line item count correct', `${s.lineItemsOk}/${s.extractionDocs} = ${pct(s.lineItemsOk, s.extractionDocs)}`],
    ['Invented values (field is empty in the document, system filled it)', String(s.invented.length)],
    ['Processing success rate (documents that should be extracted and ended completed)', `${s.completed}/${s.extractionDocs} = ${pct(s.completed, s.extractionDocs)}`],
    ['Failure rate (same documents, ended failed)', `${s.failedUnexpected}/${s.extractionDocs} = ${pct(s.failedUnexpected, s.extractionDocs)}`],
    ['Corrupted or fake files handled as expected (failed or rejected)', `${s.badHandled}/${s.badFiles} = ${pct(s.badHandled, s.badFiles)}`],
    ['Average job time (completed jobs)', s.timeAll ? ms(s.timeAll.avg) : 'n/a'],
  ]));
  out.push('');
  out.push('Documents that should be extracted include the deliberate-error files and the "not an invoice" file. A document that did not produce a result counts all its fields as wrong.');
  out.push('');

  out.push('## Accuracy by file type');
  out.push('');
  out.push(table(['Type', 'Documents', 'Fields correct', 'Accuracy', 'All 8 correct'],
    s.byKind.map((k) => [k.kind, String(k.docs), `${k.correct}/${k.total}`, pct(k.correct, k.total), `${k.exact}/${k.docs}`])));
  out.push('');

  out.push('## Accuracy by field');
  out.push('');
  out.push(table(['Field', 'Correct', 'Accuracy'],
    s.byField.map((f) => [f.field, `${f.correct}/${f.total}`, pct(f.correct, f.total)])));
  out.push('');

  out.push('## Validation');
  out.push('');
  const r = s.review;
  out.push(`needs_review flag compared with the label (completed documents only): correctly flagged ${r.tp}, correctly not flagged ${r.tn}, wrongly flagged (false alarm) ${r.fp}, missed ${r.fn}.`);
  out.push('');
  if (s.rules.length > 0) {
    out.push(table(['File', 'Required rule', 'Reported'],
      s.rules.map((x) => [x.file, x.rule, x.found ? 'yes' : 'NO'])));
    out.push('');
    out.push(`Required rules found: ${s.rules.filter((x) => x.found).length}/${s.rules.length}. A rule that is reported but not required is not counted. The required rules for err-missing-number.pdf, err-lines-mismatch.xlsx and not-invoice.pdf are defined in runEvaluation.js, the others in labels.json.`);
    out.push('');
  }

  out.push('## Processing time (server-side job time per document)');
  out.push('');
  out.push(table(['Set', 'Jobs', 'Average', 'Median', 'Min', 'Max'], [
    timeRow('All completed jobs', s.timeAll),
    timeRow(`Without reused results (${s.reusedCount} reused)`, s.timeNoReuse),
    ...s.byKind.map((k) => timeRow(`Type: ${k.kind}`, k.time)),
  ]));
  out.push('');
  out.push('Job time covers reading the file (including OCR), the LLM call and saving. It does not include waiting in the queue. The first image job also includes starting the OCR engine. Reused results (an identical file) skip the LLM and are very fast.');
  out.push('');

  out.push('## Every wrong field');
  out.push('');
  if (s.mistakes.length === 0) {
    out.push('None.');
  } else {
    out.push(table(['File', 'Field', 'Expected', 'Got'],
      s.mistakes.map((m) => [m.file, m.field, JSON.stringify(m.expected), JSON.stringify(m.actual)])));
  }
  out.push('');

  const unexpected = records.filter((r2) =>
    (r2.expectedStatus === 'completed' && r2.status !== 'completed') ||
    (r2.expectedStatus === 'failed' && !r2.handledOk) ||
    (r2.expectedUpload === 'rejected' && !r2.handledOk));
  out.push('## Unexpected outcomes');
  out.push('');
  if (unexpected.length === 0) {
    out.push('None.');
  } else {
    out.push(table(['File', 'Expected', 'Got', 'Error message'],
      unexpected.map((u) => [
        u.file,
        u.expectedUpload === 'rejected' ? 'rejected' : u.expectedStatus,
        u.expectedUpload === 'rejected' ? (u.uploadAccepted ? 'accepted' : 'rejected') : u.status,
        u.errorMessage || '',
      ])));
  }
  out.push('');

  out.push('## Limits of this measurement');
  out.push('');
  out.push('- The dataset is synthetic. Every file was generated by evaluation/generateDataset.js. These are not real invoices.');
  out.push('- The three images are generated from text (SVG turned into PNG/JPG with some blur and rotation). They are not real photos or scans, so the OCR numbers say little about real scans.');
  out.push('- Documents were generated from a few layouts. Real documents are more varied, so real accuracy can be lower.');
  out.push(`- The sample is small (${s.extractionDocs} documents to extract). One wrong field changes the percentages noticeably.`);
  out.push('- This is a single run. LLM answers can differ between runs, so a second run can give slightly different numbers.');
  out.push('- A failure caused by an LLM rate limit counts as a failure here. The error message column shows the cause.');
  out.push('- Scanned PDFs, TIFF and old .xls files are not supported and are not in this dataset.');
  out.push('- The 1000-page case and semantic search quality are not part of this report.');
  out.push('');
  return out.join('\n');
}

// ---------- main ----------

async function main() {
  const labels = JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8'));
  for (const l of labels) {
    if (!fs.existsSync(path.join(DATASET_DIR, l.file))) {
      throw new Error(`Missing dataset file ${l.file}. Run: node evaluation\\generateDataset.js`);
    }
  }

  const startedAt = new Date().toISOString();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docint-eval-'));
  const server = startServer(workDir);
  const uploads = new Map();
  const meta = { startedAt };

  try {
    console.log('Starting backend on port ' + PORT + ' ...');
    await server.waitReady();
    console.log('Backend is ready.');

    // phase 1: everything that does not depend on earlier documents
    const phase1 = labels.filter((l) => l.phase === 1);
    const t1 = Date.now();
    console.log(`Phase 1: uploading ${phase1.length} files`);
    for (const l of phase1) {
      const up = await upload(l.file);
      uploads.set(l.file, up);
      console.log(`  ${l.file}: ${up.accepted ? 'accepted as document ' + up.id : 'rejected (HTTP ' + up.httpStatus + ')'}`);
    }
    const ids1 = phase1.map((l) => uploads.get(l.file).id).filter((id) => id !== null);
    const w1 = await waitForDone(ids1, 'phase 1');
    if (w1.timedOut) console.log('  WARNING: phase 1 timed out, some documents are not finished');
    meta.phase1Ms = Date.now() - t1;
    meta.phase1Count = phase1.length;

    // phase 2: duplicates and pairs, one by one in the label order
    const phase2 = labels.filter((l) => l.phase === 2);
    const t2 = Date.now();
    console.log(`Phase 2: ${phase2.length} files, one by one`);
    for (const l of phase2) {
      const up = await upload(l.file);
      uploads.set(l.file, up);
      console.log(`  ${l.file}: ${up.accepted ? 'accepted as document ' + up.id : 'rejected (HTTP ' + up.httpStatus + ')'}`);
      if (up.accepted) await waitForDone([up.id], l.file);
    }
    meta.phase2Ms = Date.now() - t2;
    meta.phase2Count = phase2.length;

    // collect the results
    console.log('Reading results ...');
    const records = [];
    for (const l of labels) {
      const up = uploads.get(l.file) || { accepted: false, id: null };
      let result = null;
      if (up.accepted) {
        const r = await api(`/api/documents/${up.id}/result`);
        result = r.body;
      }
      records.push(evaluate(l, up, result, up.accepted ? server.jobMs.get(up.id) : null));
    }

    const summary = summarize(records);
    fs.writeFileSync(RESULTS_FILE, JSON.stringify({ meta, summary, records }, null, 2) + '\n');
    fs.writeFileSync(REPORT_FILE, buildReport(labels, records, summary, meta));

    console.log('');
    console.log(`Field accuracy: ${summary.fieldsCorrect}/${summary.fieldsTotal} = ${pct(summary.fieldsCorrect, summary.fieldsTotal)}`);
    console.log(`All 8 fields correct: ${summary.exactDocs}/${summary.extractionDocs}`);
    console.log(`Completed: ${summary.completed}/${summary.extractionDocs}, failed: ${summary.failedUnexpected}`);
    console.log(`Bad files handled: ${summary.badHandled}/${summary.badFiles}`);
    console.log(`Written: ${REPORT_FILE}`);
    console.log(`Written: ${RESULTS_FILE}`);
  } finally {
    await server.stop();
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      console.log(`Could not delete the temporary folder ${workDir} (safe to delete by hand)`);
    }
  }
}

main().catch((err) => {
  console.error('Evaluation failed:', err.message);
  process.exit(1);
});