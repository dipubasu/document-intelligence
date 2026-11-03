const fs = require('fs');
const { PDFParse, PasswordException, InvalidPDFException, FormatError } = require('pdf-parse');
const config = require('../../config');

// a page with fewer characters than this is treated as a scanned image (needs OCR)
const MIN_TEXT_CHARS = 20;
// read this many pages at a time so a big PDF does not run out of memory
const DEFAULT_CHUNK_SIZE = 50;

function describeError(err) {
  const name = err && err.name;
  if (err instanceof PasswordException || name === 'PasswordException') {
    return 'PDF is password protected';
  }
  if (
    err instanceof InvalidPDFException ||
    err instanceof FormatError ||
    name === 'InvalidPDFException' ||
    name === 'FormatError'
  ) {
    return 'Could not read PDF: file is corrupted or invalid';
  }
  return `Could not read PDF: ${err && err.message ? err.message : 'unknown error'}`;
}

// the library may append a "-- 1 of 3 --" marker at the end of a page; remove it
function cleanPageText(text) {
  return String(text || '').replace(/\n?-- \d+ of \d+ --\s*$/, '');
}

async function parsePdf(filePath, options = {}) {
  const maxPages = options.maxPages ?? config.pdf.maxPages;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;

  // safer to give the pdf library a Uint8Array instead of a Buffer
  const data = new Uint8Array(await fs.promises.readFile(filePath));

  let parser;
  try {
    parser = new PDFParse({ data });

    // first learn only the page count; if over the limit, no text is extracted at all
    const info = await parser.getInfo();
    const total = info.total;
    if (!total || total < 1) {
      throw new Error('PDF has no pages');
    }
    if (total > maxPages) {
      const limitError = new Error(`PDF has ${total} pages, limit is ${maxPages}`);
      limitError.code = 'PAGE_LIMIT';
      throw limitError;
    }

    const pages = [];
    for (let start = 1; start <= total; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, total);
      const partial = [];
      for (let n = start; n <= end; n++) partial.push(n);

      const result = await parser.getText({ partial, pageJoiner: '' });
      for (const p of result.pages) {
        pages.push({
          page_number: p.num,
          sheet_name: null,
          text: cleanPageText(p.text),
        });
      }
    }

    const lowTextPages = pages
      .filter((p) => p.text.trim().length < MIN_TEXT_CHARS)
      .map((p) => p.page_number);

    return { pages, pageCount: total, lowTextPages };
  } catch (err) {
    if (err.code === 'PAGE_LIMIT') throw err;
    throw new Error(describeError(err));
  } finally {
    if (parser) {
      await parser.destroy().catch(() => {});
    }
  }
}

module.exports = { parsePdf, MIN_TEXT_CHARS };