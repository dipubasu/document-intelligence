'use strict';

// Measures semantic search quality with labeled queries.
// It starts its own backend (port 3101, temp database), uploads the
// evaluation dataset, runs the queries in semantic mode and writes
// evaluation/SEMANTIC_REPORT.md and evaluation/semantic-results.json.
// Everything is synthetic and the queries were written by the developer
// after seeing the corpus names, so this is not a blind test.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const DATASET = path.join(__dirname, 'dataset');
const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;

const EXCLUDE = new Set([
  'dup-copy-of-csv-2001.csv', // exact copy of another file
  'not-invoice.pdf', // no invoice data
  'img-very-poor.jpg', // OCR gave nothing, nothing to search
]);

// kind: name | customer | number | topic | negative
// relevant: files that a person would accept as a correct answer.
const QUERIES = [
  { kind: 'name', q: 'invoice from Riverside Catering Services', relevant: ['pdf-b-01.pdf'] },
  { kind: 'name', q: 'Kestrel Printing', relevant: ['pdf-b-02.pdf'] },
  { kind: 'name', q: 'Orchid Medical Supplies invoice', relevant: ['csv-kv-semicolon.csv'] },
  { kind: 'name', q: 'Tidewater Seafood', relevant: ['img-poor.jpg'] },
  { kind: 'name', q: 'Juniper Cloud Services', relevant: ['xlsx-multisheet.xlsx'] },
  { kind: 'name', q: 'Zenith Pet Supplies', relevant: ['err-total-mismatch.csv'] },
  { kind: 'customer', q: 'invoices billed to Delta Cafe', relevant: ['csv-kv-semicolon.csv', 'csv-flat.csv'] },
  { kind: 'customer', q: 'Maple Grove School', relevant: ['csv-kv-comma.csv'] },
  { kind: 'customer', q: 'Sparks Repair Shop', relevant: ['pair-a.pdf', 'pair-a.xlsx'] },
  { kind: 'customer', q: 'City Hospital Lab', relevant: ['pair-b.pdf', 'pair-b.xlsx'] },
  { kind: 'number', q: 'ALP-1001', relevant: ['pdf-a-01.pdf'] },
  { kind: 'number', q: 'PAIR-6002', relevant: ['pair-b.pdf', 'pair-b.xlsx'] },
  { kind: 'topic', q: 'catering and food supply', relevant: ['pdf-b-01.pdf', 'img-poor.jpg'] },
  { kind: 'topic', q: 'car and auto parts repair', relevant: ['xlsx-title.xlsx', 'err-lines-mismatch.xlsx'] },
  { kind: 'topic', q: 'software and cloud subscription', relevant: ['pdf-c-01.pdf', 'xlsx-multisheet.xlsx'] },
  { kind: 'topic', q: 'medical and laboratory equipment', relevant: ['csv-kv-semicolon.csv', 'pair-b.pdf', 'pair-b.xlsx'] },
  { kind: 'topic', q: 'school supplies', relevant: ['csv-kv-comma.csv', 'pdf-b-02.pdf'] },
  { kind: 'negative', q: 'quantum physics lecture notes', relevant: [] },
  { kind: 'negative', q: 'how to bake sourdough bread', relevant: [] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f3 = (n) => (typeof n === 'number' ? n.toFixed(3) : '-');
const pct = (n) => (n === null || n === undefined ? '-' : `${(n * 100).toFixed(1)}%`);

function loadCorpus() {
  const L = require('./labels.json');
  const arr = Array.isArray(L) ? L : L.labels || L.files || [];
  const files = arr
    .filter((x) => x.kind !== 'corrupt' && x.kind !== 'rejected' && !EXCLUDE.has(x.file))
    .map((x) => x.file);
  for (const f of files) {
    if (!fs.existsSync(path.join(DATASET, f))) throw new Error(`Dataset file missing: ${f}`);
  }
  return files;
}

function checkQueries(corpus) {
  for (const q of QUERIES) {
    for (const f of q.relevant) {
      if (!corpus.includes(f)) throw new Error(`Query "${q.q}" names a file that is not in the corpus: ${f}`);
    }
  }
}

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch (e) {
      // server not ready yet
    }
    await sleep(750);
  }
  throw new Error('Server did not become healthy in 30 seconds');
}

async function uploadBatch(files) {
  const form = new FormData();
  for (const f of files) {
    form.append('files', new Blob([fs.readFileSync(path.join(DATASET, f))]), f);
  }
  const res = await fetch(`${BASE}/api/documents`, { method: 'POST', body: form });
  if (res.status !== 202) {
    throw new Error(`Upload failed: HTTP ${res.status} ${await res.text()}`);
  }
}

async function waitForProcessing(corpus) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/api/documents?limit=100`);
    const body = await res.json();
    const items = Array.isArray(body) ? body : body.items || [];
    const byName = new Map(items.map((d) => [d.original_name, d.status]));
    const pending = corpus.filter((f) => {
      const s = byName.get(f);
      return s !== 'completed' && s !== 'failed';
    });
    if (pending.length === 0) {
      return corpus.filter((f) => byName.get(f) === 'failed');
    }
    await sleep(2000);
  }
  throw new Error('Processing did not finish in 10 minutes');
}

async function semanticSearch(q) {
  const url = `${BASE}/api/search?mode=semantic&limit=50&q=${encodeURIComponent(q)}`;
  const t0 = Date.now();
  const res = await fetch(url);
  const ms = Date.now() - t0;
  const body = await res.json().catch(() => null);
  return { status: res.status, ms, body };
}

async function indexEverything() {
  // The server indexes at most 20 new invoices per search, so repeat.
  for (let i = 0; i < 6; i++) {
    const r = await semanticSearch('invoice');
    if (r.status !== 200) {
      throw new Error(`Semantic search failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    }
    if (!r.body.not_indexed) return;
  }
  throw new Error('Some invoices are still not indexed after 6 searches');
}

function rankInfo(q) {
  const rel = new Set(q.relevant);
  const ranks = [];
  q.items.forEach((it, i) => {
    if (rel.has(it.name)) ranks.push(i + 1);
  });
  return ranks;
}

function pooled(results, retrieved) {
  let tp = 0;
  let ret = 0;
  let rel = 0;
  let negRet = 0;
  for (const q of results) {
    if (q.kind === 'negative') {
      negRet += q.items.filter((it) => retrieved(q, it)).length;
      continue;
    }
    rel += q.relevant.length;
    for (const it of q.items) {
      if (retrieved(q, it)) {
        ret++;
        if (q.relevant.includes(it.name)) tp++;
      }
    }
  }
  const precision = ret ? tp / ret : null;
  const recall = rel ? tp / rel : 0;
  const f1 = precision !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, ret, rel, negRet, precision, recall, f1 };
}

function kindStats(results, kind) {
  const qs = results.filter((q) => q.kind === kind);
  const n = qs.length;
  const top1 = qs.filter((q) => q.ranks[0] === 1).length;
  const top3 = qs.filter((q) => q.ranks[0] !== undefined && q.ranks[0] <= 3).length;
  const mrr = qs.reduce((s, q) => s + (q.ranks[0] ? 1 / q.ranks[0] : 0), 0) / n;
  const allInTopK = qs.filter((q) => q.ranks.every((r) => r <= q.relevant.length)).length;
  return { n, top1, top3, mrr, allInTopK };
}

function buildReport(ctx) {
  const { results, corpus, failed, latency } = ctx;
  const pos = results.filter((q) => q.kind !== 'negative');
  const lines = [];
  lines.push('# Semantic search evaluation');
  lines.push('');
  lines.push('This file is generated by evaluation/runSemanticEval.js. Every number was measured in one real run.');
  lines.push('');
  lines.push(`- Run started: ${ctx.startedAt}`);
  lines.push('- Embedding model: the one configured in backend/.env (gemini-embedding-001 at the time of writing)');
  lines.push(`- Corpus: ${corpus.length} synthetic invoices from the evaluation dataset (${failed.length} failed to process: ${failed.join(', ') || 'none'})`);
  lines.push(`- Queries: ${results.length} (${pos.length} with relevant documents, ${results.length - pos.length} negative)`);
  lines.push('- Excluded from the corpus: dup-copy-of-csv-2001.csv (exact copy), not-invoice.pdf (no invoice data), img-very-poor.jpg (OCR found nothing)');
  lines.push('');

  lines.push('## Ranking quality by query type');
  lines.push('');
  lines.push('| Query type | Queries | Correct file at rank 1 | Correct file in top 3 | MRR | All relevant files in top k (k = number of relevant) |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const kind of ['name', 'customer', 'number', 'topic']) {
    const s = kindStats(results, kind);
    lines.push(`| ${kind} | ${s.n} | ${s.top1}/${s.n} | ${s.top3}/${s.n} | ${f3(s.mrr)} | ${s.allInTopK}/${s.n} |`);
  }
  const all = { n: 0, top1: 0, top3: 0, mrrSum: 0, allInTopK: 0 };
  for (const q of pos) {
    all.n++;
    if (q.ranks[0] === 1) all.top1++;
    if (q.ranks[0] !== undefined && q.ranks[0] <= 3) all.top3++;
    all.mrrSum += q.ranks[0] ? 1 / q.ranks[0] : 0;
    if (q.ranks.every((r) => r <= q.relevant.length)) all.allInTopK++;
  }
  lines.push(`| all | ${all.n} | ${all.top1}/${all.n} | ${all.top3}/${all.n} | ${f3(all.mrrSum / all.n)} | ${all.allInTopK}/${all.n} |`);
  lines.push('');
  lines.push('MRR (mean reciprocal rank) is 1 when the first correct file is always at rank 1.');
  lines.push('');

  lines.push('## Search time');
  lines.push('');
  lines.push(`Per query (embedding the query and comparing with all vectors, after everything was indexed): average ${latency.avg} ms, min ${latency.min} ms, max ${latency.max} ms (${results.length} single runs).`);
  lines.push('');

  lines.push('## Scores: correct vs other files');
  lines.push('');
  const relScores = [];
  const otherScores = [];
  for (const q of pos) {
    for (const it of q.items) (q.relevant.includes(it.name) ? relScores : otherScores).push(it.score);
  }
  const mn = (a) => Math.min(...a);
  const mx = (a) => Math.max(...a);
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  lines.push('| Group | Count | Min | Average | Max |');
  lines.push('| --- | --- | --- | --- | --- |');
  lines.push(`| Correct files | ${relScores.length} | ${f3(mn(relScores))} | ${f3(avg(relScores))} | ${f3(mx(relScores))} |`);
  lines.push(`| Other files (same queries) | ${otherScores.length} | ${f3(mn(otherScores))} | ${f3(avg(otherScores))} | ${f3(mx(otherScores))} |`);
  const negTop = results.filter((q) => q.kind === 'negative').map((q) => q.items[0] ? q.items[0].score : 0);
  lines.push(`| Top score of negative queries | ${negTop.length} | ${f3(mn(negTop))} | ${f3(avg(negTop))} | ${f3(mx(negTop))} |`);
  lines.push('');

  lines.push('## Cutoff 1: fixed minimum score');
  lines.push('');
  lines.push('A result is kept when score >= threshold. Precision and recall are pooled over all queries that have relevant files. "Negative results" is how many results the two negative queries still return (the ideal is 0).');
  lines.push('');
  lines.push('| Threshold | Kept | Correct kept | Precision | Recall | F1 | Negative results |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  let bestAbs = null;
  for (let t = 0.4; t <= 0.9001; t += 0.02) {
    const th = Math.round(t * 100) / 100;
    const p = pooled(results, (q, it) => it.score >= th);
    if (!bestAbs || p.f1 > bestAbs.p.f1) bestAbs = { th, p };
    lines.push(`| ${th.toFixed(2)} | ${p.ret} | ${p.tp}/${p.rel} | ${pct(p.precision)} | ${pct(p.recall)} | ${f3(p.f1)} | ${p.negRet} |`);
  }
  lines.push('');
  lines.push(`Best F1 among these thresholds: ${bestAbs.th.toFixed(2)} (precision ${pct(bestAbs.p.precision)}, recall ${pct(bestAbs.p.recall)}, negative results ${bestAbs.p.negRet}).`);
  lines.push('');

  lines.push('## Cutoff 2: relative to the best result of the query');
  lines.push('');
  lines.push('A result is kept when score >= (top score of that query - delta). A negative query always keeps at least its top result with this rule.');
  lines.push('');
  lines.push('| Delta | Kept | Correct kept | Precision | Recall | F1 | Negative results |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  let bestRel = null;
  for (let d = 0.02; d <= 0.2001; d += 0.02) {
    const dd = Math.round(d * 100) / 100;
    const p = pooled(results, (q, it) => it.score >= q.items[0].score - dd);
    if (!bestRel || p.f1 > bestRel.p.f1) bestRel = { dd, p };
    lines.push(`| ${dd.toFixed(2)} | ${p.ret} | ${p.tp}/${p.rel} | ${pct(p.precision)} | ${pct(p.recall)} | ${f3(p.f1)} | ${p.negRet} |`);
  }
  lines.push('');
  lines.push(`Best F1 among these deltas: ${bestRel.dd.toFixed(2)} (precision ${pct(bestRel.p.precision)}, recall ${pct(bestRel.p.recall)}, negative results ${bestRel.p.negRet}).`);
  lines.push('');

  lines.push('## Every query');
  lines.push('');
  lines.push('Top 3 results per query. [OK] marks a relevant file.');
  lines.push('');
  lines.push('| Type | Query | Relevant | Ranks of relevant | Top 3 (score) |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const q of results) {
    const top3 = q.items
      .slice(0, 3)
      .map((it) => `${q.relevant.includes(it.name) ? '[OK] ' : ''}${it.name} (${f3(it.score)})`)
      .join('<br>');
    lines.push(`| ${q.kind} | ${q.q} | ${q.relevant.join(', ') || '(none)'} | ${q.ranks.join(', ') || '-'} | ${top3} |`);
  }
  lines.push('');

  lines.push('## Limits of this measurement');
  lines.push('');
  lines.push('- The corpus is small and synthetic. With more documents, ranking gets harder.');
  lines.push('- The queries and the list of correct files were written by the developer after seeing the supplier and customer names. This is not a blind test, so results are probably better than on real user queries.');
  lines.push('- For topic queries, "relevant" is a human judgment from supplier and customer names, so it is subjective.');
  lines.push('- Scores depend on the embedding model and on the text built for each invoice. A threshold chosen here may not fit another model or other data.');
  lines.push('- Single run, one embedding model, 20 or fewer queries. Do not treat the percentages as stable.');
  lines.push('- Only invoices are searched (not single pages), and only invoices with extracted fields or text are indexed.');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const startedAt = new Date().toISOString();
  const corpus = loadCorpus();
  checkQueries(corpus);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docint-sem-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: path.join(tmp, 'eval.db'),
      UPLOAD_DIR: path.join(tmp, 'uploads'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tail = '';
  const keep = (d) => {
    tail = (tail + d.toString()).slice(-2000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const exited = new Promise((resolve) => child.on('exit', resolve));

  try {
    await waitForHealth();
    console.log(`Server up. Uploading ${corpus.length} files...`);
    for (let i = 0; i < corpus.length; i += 5) {
      await uploadBatch(corpus.slice(i, i + 5));
    }
    console.log('Waiting for extraction (this uses Groq)...');
    const failed = await waitForProcessing(corpus);
    console.log(`Extraction finished. Failed: ${failed.length}. Indexing embeddings (uses Gemini)...`);
    await indexEverything();

    const results = [];
    for (const def of QUERIES) {
      const r = await semanticSearch(def.q);
      if (r.status !== 200) {
        throw new Error(`Query "${def.q}" failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
      }
      const items = (r.body.items || [])
        .map((it) => ({ name: it.original_name, score: it.score }))
        .sort((a, b) => b.score - a.score);
      const entry = { ...def, items, ms: r.ms, notIndexed: r.body.not_indexed || 0 };
      entry.ranks = rankInfo(entry);
      results.push(entry);
      console.log(`  ${def.kind.padEnd(8)} ${def.q} -> ${items.length} results, ${r.ms} ms`);
    }

    const times = results.map((q) => q.ms);
    const latency = {
      avg: Math.round(times.reduce((s, x) => s + x, 0) / times.length),
      min: Math.min(...times),
      max: Math.max(...times),
    };
    const report = buildReport({ results, corpus, failed, latency, startedAt });
    fs.writeFileSync(path.join(__dirname, 'SEMANTIC_REPORT.md'), report);
    fs.writeFileSync(
      path.join(__dirname, 'semantic-results.json'),
      JSON.stringify({ startedAt, corpus, failed, latency, results }, null, 2)
    );
    console.log('Done. Wrote evaluation/SEMANTIC_REPORT.md and evaluation/semantic-results.json');
  } catch (err) {
    console.error(`Semantic evaluation failed: ${err.message}`);
    if (tail) console.error(`Last server output:\n${tail}`);
    process.exitCode = 1;
  } finally {
    child.kill();
    await Promise.race([exited, sleep(5000)]);
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (e) {
      console.error(`Could not delete temp folder ${tmp}`);
    }
  }
}

main();