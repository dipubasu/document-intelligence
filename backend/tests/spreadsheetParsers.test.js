const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { parseCsv, MAX_ROWS } = require('../src/services/parsers/csvParser');
const { parseExcel } = require('../src/services/parsers/excelParser');

// test শেষে মুছে ফেলার জন্য temp ফোল্ডার
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docint-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeTemp(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

// ---------- CSV ----------

test('csv: basic file becomes one page of text', async () => {
  const p = writeTemp('basic.csv', 'invoice_number,supplier,total\nINV-001,Acme Ltd,120.50\n');
  const r = await parseCsv(p);
  assert.strictEqual(r.pages.length, 1);
  assert.strictEqual(r.rowCount, 2);
  assert.ok(r.pages[0].text.includes('INV-001 | Acme Ltd | 120.50'));
});

test('csv: semicolon delimiter is detected', async () => {
  const p = writeTemp('semi.csv', 'a;b;c\n1;2;3\n');
  const r = await parseCsv(p);
  assert.ok(r.pages[0].text.includes('1 | 2 | 3'));
});

test('csv: BOM is removed and quoted comma is kept', async () => {
  const p = writeTemp('bom.csv', '\uFEFFname,note\n"Smith, John",ok\n');
  const r = await parseCsv(p);
  assert.ok(r.pages[0].text.startsWith('name | note'));
  assert.ok(r.pages[0].text.includes('Smith, John | ok'));
});

test('csv: empty file is rejected', async () => {
  const p = writeTemp('empty.csv', '\n\n');
  await assert.rejects(parseCsv(p), /no data/i);
});

test('csv: broken quote is rejected with a clear error', async () => {
  const p = writeTemp('broken.csv', 'a,b\n"unclosed,1\n');
  await assert.rejects(parseCsv(p), /could not parse csv/i);
});

test('csv: very large file is truncated', async () => {
  let content = 'id,name\n';
  for (let i = 0; i < MAX_ROWS + 100; i++) content += `${i},row${i}\n`;
  const p = writeTemp('big.csv', content);
  const r = await parseCsv(p);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.rowCount, MAX_ROWS);
});

// ---------- Excel ----------

test('excel: multi-sheet workbook gives one page per sheet', async () => {
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet('Invoice');
  s1.addRow(['invoice_number', 'supplier', 'total']);
  s1.addRow(['INV-001', 'Acme Ltd', 120.5]);
  s1.addRow(['date', new Date(Date.UTC(2026, 10, 3))]);
  s1.addRow(['calc', { formula: '2*5', result: 10 }]);
  const s2 = wb.addWorksheet('Items');
  s2.addRow(['description', 'qty']);
  s2.addRow(['Pen', 2]);
  const p = path.join(tmpDir, 'multi.xlsx');
  await wb.xlsx.writeFile(p);

  const r = await parseExcel(p);
  assert.strictEqual(r.pages.length, 2);
  assert.strictEqual(r.pages[0].sheet_name, 'Invoice');
  assert.strictEqual(r.pages[1].sheet_name, 'Items');
  assert.ok(r.pages[0].text.includes('INV-001 | Acme Ltd | 120.5'));
  assert.ok(r.pages[0].text.includes('2026-11-03'));
  assert.ok(r.pages[0].text.includes('calc | 10'));
  assert.ok(r.pages[1].text.includes('Pen | 2'));
});

test('excel: workbook with only an empty sheet is rejected', async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Empty');
  const p = path.join(tmpDir, 'empty.xlsx');
  await wb.xlsx.writeFile(p);
  await assert.rejects(parseExcel(p), /no data/i);
});

test('excel: corrupted file is rejected with a clear error', async () => {
  const p = writeTemp('bad.xlsx', 'this is not a real xlsx file');
  await assert.rejects(parseExcel(p), /could not read excel/i);
});