const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectFile } = require('../src/services/fileType');
const { sanitizeFilename } = require('../src/utils/sanitize');

// a temporary folder per run, deleted after the tests
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeFile(name, content) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

test('a real PDF header is accepted', async () => {
  const p = makeFile('a.pdf', Buffer.from('%PDF-1.4\n1 0 obj\n'));
  const r = await inspectFile(p, 'a.pdf');
  assert.equal(r.ok, true);
  assert.equal(r.detectedType, 'pdf');
});

test('a PNG header is accepted, and it also works with a .jpg name (both are images)', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const r = await inspectFile(makeFile('x.png', png), 'x.jpg');
  assert.equal(r.ok, true);
  assert.equal(r.detectedType, 'png');
});

test('a normal CSV is accepted', async () => {
  const p = makeFile('d.csv', 'invoice,total\nINV-1,100\n');
  const r = await inspectFile(p, 'd.csv');
  assert.equal(r.ok, true);
  assert.equal(r.detectedType, 'csv');
});

test('an .xlsx with a ZIP header is accepted', async () => {
  const p = makeFile('s.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
  const r = await inspectFile(p, 's.xlsx');
  assert.equal(r.ok, true);
  assert.equal(r.detectedType, 'xlsx');
});

test('a text file named .pdf is rejected', async () => {
  const p = makeFile('fake.pdf', 'this is just text');
  const r = await inspectFile(p, 'fake.pdf');
  assert.equal(r.ok, false);
});

test('a binary file (like an exe) named .csv is rejected', async () => {
  const p = makeFile('bad.csv', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]));
  const r = await inspectFile(p, 'bad.csv');
  assert.equal(r.ok, false);
});

test('an empty file is rejected', async () => {
  const p = makeFile('empty.pdf', '');
  const r = await inspectFile(p, 'empty.pdf');
  assert.equal(r.ok, false);
  assert.match(r.error, /empty/i);
});

test('an unsupported extension (.exe) is rejected', async () => {
  const p = makeFile('run.exe', 'hello');
  const r = await inspectFile(p, 'run.exe');
  assert.equal(r.ok, false);
});

test('sanitizeFilename removes dangerous parts of a name', () => {
  assert.equal(sanitizeFilename('..\\..\\evil.pdf'), 'evil.pdf');
  assert.equal(sanitizeFilename('../../etc/passwd.csv'), 'passwd.csv');
  assert.equal(sanitizeFilename('<script>.csv'), '_script_.csv');
  assert.equal(sanitizeFilename(''), 'file');
});