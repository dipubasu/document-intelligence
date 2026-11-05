// Hand test: read one image with the real OCR engine, twice, and print what came out.
const { parseImage, shutdownOcr } = require('../src/services/parsers/imageParser');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.log('Usage: node scripts/ocrTest.js <image path>');
    process.exitCode = 1;
    return;
  }

  for (let run = 1; run <= 2; run++) {
    const started = Date.now();
    const result = await parseImage(file);
    const ms = Date.now() - started;
    const page = result.pages[0];
    console.log(
      `--- run ${run}: ${ms} ms, confidence ${page.ocr_confidence}, ${page.text.length} characters`
    );
    if (run === 1) console.log(page.text);
  }
}

main()
  .catch((err) => {
    console.log('FAILED:', err.code || '', err.message);
    process.exitCode = 1;
  })
  .finally(() => shutdownOcr());