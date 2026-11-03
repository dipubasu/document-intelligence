const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePdf } = require('../src/services/parsers/pdfParser');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docint-pdf-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// builds a tiny valid PDF: each item of texts is one page (ASCII only, no parentheses)
function buildPdf(texts) {
  const objs = [];
  const n = texts.length;
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = texts.map((_, i) => `${4 + 2 * i} 0 R`).join(' ');
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  texts.forEach((t, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${t}) Tj ET`;
    objs[4 + 2 * i] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + 2 * i} 0 R ` +
      '/Resources << /Font << /F1 3 0 R >> >> >>';
    objs[5 + 2 * i] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function writePdf(name, texts) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, buildPdf(texts));
  return p;
}

test('pdf: text is extracted page by page without page markers', async () => {
  const p = writePdf('three.pdf', [
    'First page invoice number INV-001',
    'Second page supplier Acme Ltd',
    'Third page total amount 120.50',
  ]);
  const r = await parsePdf(p);
  assert.strictEqual(r.pageCount, 3);
  assert.strictEqual(r.pages.length, 3);
  assert.deepStrictEqual(r.pages.map((x) => x.page_number), [1, 2, 3]);
  assert.ok(r.pages[1].text.includes('Acme Ltd'));
  assert.ok(!/-- \d+ of \d+ --/.test(r.pages[0].text));
  assert.deepStrictEqual(r.lowTextPages, []);
});

test('pdf: reading in small chunks keeps page order and numbers', async () => {
  const texts = [1, 2, 3, 4, 5].map((i) => `Chunk test page number ${i} text`);
  const p = writePdf('five.pdf', texts);
  const r = await parsePdf(p, { chunkSize: 2 });
  assert.deepStrictEqual(r.pages.map((x) => x.page_number), [1, 2, 3, 4, 5]);
  assert.ok(r.pages[4].text.includes('number 5'));
  assert.ok(r.pages[2].text.includes('number 3'));
});

test('pdf: page limit is enforced before text extraction', async () => {
  const texts = [1, 2, 3, 4, 5].map((i) => `Limit test page number ${i} text`);
  const p = writePdf('limit.pdf', texts);
  await assert.rejects(parsePdf(p, { maxPages: 3 }), /limit/i);
});

test('pdf: page with almost no text is reported as low-text (scan candidate)', async () => {
  const p = writePdf('blank.pdf', ['Real text on the first page here', '']);
  const r = await parsePdf(p);
  assert.deepStrictEqual(r.lowTextPages, [2]);
});

test('pdf: corrupted file is rejected with a clear error', async () => {
  const p = path.join(tmpDir, 'bad.pdf');
  fs.writeFileSync(p, '%PDF-1.4\nthis is garbage, not a real pdf');
  await assert.rejects(parsePdf(p), /could not read pdf/i);
});