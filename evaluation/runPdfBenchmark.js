'use strict';

// Measures PDF parsing only (no LLM). It builds synthetic PDFs of different
// sizes, parses them with the real parsePdf(), and records time and memory.
// Usage (from the repo root): node evaluation/runPdfBenchmark.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const mod = require('../backend/src/services/parsers/pdfParser');
const parsePdf = mod.parsePdf || mod;

const SIZES = [100, 500, 1000];
const LINES_PER_PAGE = 15;
const MAX_PAGES = 1500;
const CHUNK_SIZE = 50;

function buildPdf(pageLines) {
  const n = pageLines.length;
  const objs = [];
  const kids = pageLines.map((_, i) => `${4 + 2 * i} 0 R`).join(' ');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pageLines.forEach((lines, i) => {
    const body = lines.map((l) => `(${l}) Tj T*`).join(' ');
    const stream = `BT /F1 11 Tf 50 780 Td 14 TL ${body} ET`;
    objs[4 + 2 * i] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`;
    objs[5 + 2 * i] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i += 1) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function makePages(count) {
  const pages = [];
  for (let p = 1; p <= count; p += 1) {
    const lines = [`Page ${p} of ${count}`];
    for (let l = 1; l < LINES_PER_PAGE; l += 1) {
      lines.push(`Invoice INV-${p}-${l} supplier Test Supplier item ${l} amount ${(p * l) % 997}.00`);
    }
    pages.push(lines);
  }
  return pages;
}

const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

async function runOne(count, tmpDir) {
  const file = path.join(tmpDir, `bench-${count}.pdf`);
  fs.writeFileSync(file, buildPdf(makePages(count)));
  const sizeBytes = fs.statSync(file).size;

  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 20);
  timer.unref();

  const started = performance.now();
  let result;
  try {
    result = await parsePdf(file, { maxPages: MAX_PAGES, chunkSize: CHUNK_SIZE });
  } finally {
    clearInterval(timer);
  }
  const ms = performance.now() - started;
  peak = Math.max(peak, process.memoryUsage().rss);

  const pages = result.pages || [];
  let correct = 0;
  pages.forEach((p, i) => {
    const text = typeof p === 'string' ? p : (p && p.text) || '';
    if (text.includes(`Page ${i + 1} of ${count}`)) correct += 1;
  });

  return {
    pages: count,
    fileSizeMB: mb(sizeBytes),
    parseMs: Math.round(ms),
    pagesPerSecond: Math.round((count / (ms / 1000)) * 10) / 10,
    pagesReturned: pages.length,
    pageCountReported: result.pageCount,
    pagesWithCorrectText: correct,
    lowTextPages: (result.lowTextPages || []).length,
    peakRssMB: mb(peak),
  };
}

async function runLimitCheck(tmpDir) {
  const count = MAX_PAGES + 1;
  const file = path.join(tmpDir, 'bench-over-limit.pdf');
  fs.writeFileSync(file, buildPdf(makePages(count)));
  const started = performance.now();
  try {
    await parsePdf(file, { maxPages: MAX_PAGES, chunkSize: CHUNK_SIZE });
    return { pages: count, rejected: false };
  } catch (err) {
    return {
      pages: count,
      rejected: true,
      code: err.code || null,
      message: String(err.message || err).slice(0, 120),
      ms: Math.round(performance.now() - started),
    };
  }
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfbench-'));
  const runs = [];
  try {
    for (const size of SIZES) {
      const r = await runOne(size, tmpDir);
      runs.push(r);
      console.log(JSON.stringify(r));
    }
    const limit = await runLimitCheck(tmpDir);
    console.log(JSON.stringify(limit));

    const data = {
      generatedAt: new Date().toISOString(),
      node: process.version,
      machine: `${os.cpus().length} CPU threads, ${mb(os.totalmem())} MB RAM, ${os.platform()}`,
      settings: { maxPages: MAX_PAGES, chunkSize: CHUNK_SIZE, linesPerPage: LINES_PER_PAGE },
      runs,
      limit,
    };
    fs.writeFileSync(path.join(__dirname, 'pdf-benchmark.json'), JSON.stringify(data, null, 2));

    const rows = runs
      .map(
        (r) =>
          `| ${r.pages} | ${r.fileSizeMB} | ${r.parseMs} | ${r.pagesPerSecond} | ` +
          `${r.pagesWithCorrectText}/${r.pages} | ${r.peakRssMB} |`
      )
      .join('\n');
    const md = [
      '# PDF parsing benchmark',
      '',
      `Run: ${data.generatedAt}. Node ${data.node}. ${data.machine}.`,
      '',
      'This measures **parsing only** (text extraction with `parsePdf`), one run per size. No LLM was called.',
      `Settings: maxPages ${MAX_PAGES}, chunk size ${CHUNK_SIZE} pages.`,
      '',
      '| Pages | File size (MB) | Parse time (ms) | Pages per second | Pages with correct text | Peak RSS (MB) |',
      '|---|---|---|---|---|---|',
      rows,
      '',
      `Over-limit check: a ${limit.pages}-page PDF was ${limit.rejected ? 'rejected' : 'NOT rejected'}` +
        (limit.rejected ? ` (code ${limit.code}, ${limit.ms} ms).` : '.'),
      '',
      '## How to read this',
      '',
      `- The test PDFs are simple: made by code, ${LINES_PER_PAGE} short text lines per page, one font, no images. Real PDFs with images, many fonts or complex layout can be slower and use more memory.`,
      '- Peak RSS is the memory of the whole Node process, sampled every 20 ms, and it includes earlier runs in the same process, so it is not the cost of one run alone.',
      '- One run per size on one machine. These are not averages.',
      '- Only parsing was measured. Sending a 1000-page document through extraction is not built (see docs/ASSUMPTIONS_AND_LIMITATIONS.md).',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(__dirname, 'PDF_BENCHMARK.md'), md);
    console.log('Wrote evaluation/PDF_BENCHMARK.md and evaluation/pdf-benchmark.json');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err && err.message ? err.message : err);
  process.exit(1);
});