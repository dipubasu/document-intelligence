const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const sharp = require('sharp');
const { parseDocument } = require('../src/services/parsers/parseDocument');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-dispatch-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('dispatcher: csv goes to the csv parser', async () => {
  const p = path.join(tmpDir, 'a.csv');
  fs.writeFileSync(p, 'item,qty\nAcme Widget,2\n');
  const r = await parseDocument(p, 'csv');
  assert.equal(r.parser, 'csv');
  assert.equal(r.pageCount, 1);
  assert.match(r.pages[0].text, /Acme Widget/);
  assert.deepEqual(r.lowTextPages, []);
});

test('dispatcher: xlsx goes to the excel parser', async () => {
  const p = path.join(tmpDir, 'a.xlsx');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Sheet1').addRow(['item', 'qty']);
  wb.getWorksheet('Sheet1').addRow(['Acme Widget', 2]);
  await wb.xlsx.writeFile(p);
  const r = await parseDocument(p, 'xlsx');
  assert.equal(r.parser, 'excel');
  assert.equal(r.pages[0].sheet_name, 'Sheet1');
  assert.match(r.pages[0].text, /Acme Widget/);
});

test('dispatcher: pdf goes to the pdf parser', async () => {
  const p = path.join(tmpDir, 'bad.pdf');
  fs.writeFileSync(p, 'this is not a real pdf');
  await assert.rejects(parseDocument(p, 'pdf'), /Could not read PDF/i);
});

test('dispatcher: old xls gives a clear error', async () => {
  await assert.rejects(parseDocument('x.xls', 'xls'), (err) => {
    assert.equal(err.code, 'XLS_NOT_SUPPORTED');
    return true;
  });
});

test('dispatcher: png and jpeg go to the image OCR parser', async () => {
  const p = path.join(tmpDir, 'pic.png');
  await sharp({ create: { width: 200, height: 100, channels: 3, background: '#ffffff' } })
    .png()
    .toFile(p);

  for (const t of ['png', 'jpeg']) {
    const r = await parseDocument(p, t, {
      recognize: async () => ({ text: 'Invoice No: A-1', confidence: 90 }),
    });
    assert.equal(r.parser, 'image-ocr');
    assert.equal(r.pageCount, 1);
    assert.equal(r.pages[0].ocr_used, true);
    assert.match(r.pages[0].text, /Invoice No: A-1/);
  }
});

test('dispatcher: tiff and unknown image types give a clear error', async () => {
  for (const t of ['tiff', 'image']) {
    await assert.rejects(parseDocument('x.img', t), (err) => {
      assert.equal(err.code, 'OCR_NOT_AVAILABLE');
      return true;
    });
  }
});

test('dispatcher: unknown type is rejected', async () => {
  await assert.rejects(parseDocument('x.bin', 'exe'), (err) => {
    assert.equal(err.code, 'UNSUPPORTED_TYPE');
    return true;
  });
});