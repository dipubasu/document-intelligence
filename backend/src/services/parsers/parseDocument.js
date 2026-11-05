const { parseCsv } = require('./csvParser');
const { parseExcel } = require('./excelParser');
const { parsePdf } = require('./pdfParser');
const { parseImage } = require('./imageParser');

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// type -> parser (like an n8n Switch node)
const PARSERS = {
  pdf: { name: 'pdf', run: parsePdf },
  csv: { name: 'csv', run: parseCsv },
  xlsx: { name: 'excel', run: parseExcel },
  jpeg: { name: 'image-ocr', run: parseImage },
  png: { name: 'image-ocr', run: parseImage },
};

// Image types that have no OCR support yet.
const UNSUPPORTED_IMAGE_TYPES = ['tiff', 'image'];

async function parseDocument(filePath, detectedType, options = {}) {
  const entry = PARSERS[detectedType];

  if (!entry) {
    if (UNSUPPORTED_IMAGE_TYPES.includes(detectedType)) {
      throw makeError(
        'This image format is not supported yet. Please convert it to PNG or JPG',
        'OCR_NOT_AVAILABLE'
      );
    }
    if (detectedType === 'xls') {
      throw makeError(
        'Old .xls format is not supported. Please save the file as .xlsx',
        'XLS_NOT_SUPPORTED'
      );
    }
    throw makeError(`Unsupported file type: ${detectedType}`, 'UNSUPPORTED_TYPE');
  }

  const result = await entry.run(filePath, options);

  // every parser's output has the same shape
  return {
    parser: entry.name,
    pages: result.pages,
    pageCount: result.pageCount ?? result.pages.length,
    lowTextPages: result.lowTextPages || [],
    rowCount: result.rowCount ?? null,
    truncated: Boolean(result.truncated),
  };
}

module.exports = { parseDocument };