const { parseCsv } = require('./csvParser');
const { parseExcel } = require('./excelParser');
const { parsePdf } = require('./pdfParser');

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
};

const IMAGE_TYPES = ['jpeg', 'png', 'tiff', 'image'];

async function parseDocument(filePath, detectedType, options = {}) {
  const entry = PARSERS[detectedType];

  if (!entry) {
    if (IMAGE_TYPES.includes(detectedType)) {
      throw makeError('Image OCR is not available yet', 'OCR_NOT_AVAILABLE');
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