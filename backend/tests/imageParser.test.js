const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { parseImage } = require('../src/services/parsers/imageParser');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-image-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function makeImage(name, width, height) {
  const p = path.join(tmpDir, name);
  await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .png()
    .toFile(p);
  return p;
}

// A fake OCR engine: no internet and no real tesseract. It remembers what it received.
function fakeOcr(text, confidence) {
  const fn = async (buffer) => {
    fn.calls.push(buffer);
    return { text, confidence };
  };
  fn.calls = [];
  return fn;
}

test('image parser: returns one OCR page with trimmed text and rounded confidence', async () => {
  const p = await makeImage('a.png', 1500, 60);
  const ocr = fakeOcr('  Invoice No: NW-1\nTotal: 99.00  \n', 93.46);
  const r = await parseImage(p, { recognize: ocr });

  assert.equal(r.pageCount, 1);
  assert.deepEqual(r.lowTextPages, []);
  assert.equal(r.pages.length, 1);
  assert.equal(r.pages[0].page_number, 1);
  assert.equal(r.pages[0].sheet_name, null);
  assert.equal(r.pages[0].ocr_used, true);
  assert.equal(r.pages[0].ocr_confidence, 93.5);
  assert.equal(r.pages[0].text, 'Invoice No: NW-1\nTotal: 99.00');
});

test('image parser: a missing confidence stays null', async () => {
  const p = await makeImage('b.png', 1500, 60);
  const r = await parseImage(p, { recognize: fakeOcr('text', null) });
  assert.equal(r.pages[0].ocr_confidence, null);
});

test('image parser: a small image is enlarged before OCR', async () => {
  const p = await makeImage('small.png', 400, 50);
  const ocr = fakeOcr('x', 80);
  await parseImage(p, { recognize: ocr });
  const meta = await sharp(ocr.calls[0]).metadata();
  assert.equal(meta.width, 1800);
});

test('image parser: a huge image is shrunk before OCR', async () => {
  const p = await makeImage('huge.png', 4200, 50);
  const ocr = fakeOcr('x', 80);
  await parseImage(p, { recognize: ocr });
  const meta = await sharp(ocr.calls[0]).metadata();
  assert.equal(meta.width, 4000);
});

test('image parser: a normal-size image keeps its width', async () => {
  const p = await makeImage('normal.png', 1500, 50);
  const ocr = fakeOcr('x', 80);
  await parseImage(p, { recognize: ocr });
  const meta = await sharp(ocr.calls[0]).metadata();
  assert.equal(meta.width, 1500);
});

test('image parser: a corrupted image gives IMAGE_UNREADABLE and OCR is not called', async () => {
  const p = path.join(tmpDir, 'broken.png');
  fs.writeFileSync(p, 'this is not an image at all');
  const ocr = fakeOcr('x', 80);
  await assert.rejects(parseImage(p, { recognize: ocr }), (err) => {
    assert.equal(err.code, 'IMAGE_UNREADABLE');
    return true;
  });
  assert.equal(ocr.calls.length, 0);
});

test('image parser: an OCR error is passed on with its code', async () => {
  const p = await makeImage('c.png', 1500, 50);
  const failing = async () => {
    const err = new Error('OCR failed while reading the image');
    err.code = 'OCR_FAILED';
    throw err;
  };
  await assert.rejects(parseImage(p, { recognize: failing }), (err) => {
    assert.equal(err.code, 'OCR_FAILED');
    return true;
  });
});