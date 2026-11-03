const fs = require('fs');
const path = require('path');

// which "group" we expect from the extension
const EXT_TO_GROUP = {
  '.pdf': 'pdf',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.tif': 'image',
  '.tiff': 'image',
  '.xlsx': 'xlsx',
  '.xls': 'xls',
  '.csv': 'csv',
};

// group derived from the type detected inside the file
const GROUP_OF_TYPE = {
  pdf: 'pdf',
  jpeg: 'image',
  png: 'image',
  tiff: 'image',
  xlsx: 'xlsx',
  xls: 'xls',
  csv: 'csv',
};

const MIME = {
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
  png: 'image/png',
  tiff: 'image/tiff',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
};

const ALLOWED_EXTENSIONS = Object.keys(EXT_TO_GROUP);

// does the buffer start with these specific bytes
function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === bytes[i]);
}

// look at the first few bytes (magic bytes) to tell the real type
function sniff(buf) {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return 'xlsx'; // ZIP (an xlsx is really a zip)
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'xls'; // old Excel
  // CSV has no magic bytes. So check whether the content contains a 0x00 byte;
  // if it does, it is not plain text (binary), for example an .exe
  if (!buf.includes(0x00)) return 'csv';
  return null;
}

async function readHead(filePath, size = 8192) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// check that the file is safe and supported
async function inspectFile(filePath, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  const expectedGroup = EXT_TO_GROUP[ext];
  if (!expectedGroup) {
    return { ok: false, error: `Unsupported file extension: ${ext.slice(0, 10) || '(none)'}` };
  }

  let head;
  try {
    head = await readHead(filePath);
  } catch {
    return { ok: false, error: 'File could not be read' };
  }

  if (head.length === 0) return { ok: false, error: 'File is empty' };

  const detectedType = sniff(head);
  if (!detectedType) return { ok: false, error: 'File content is not a supported format' };

  if (GROUP_OF_TYPE[detectedType] !== expectedGroup) {
    return {
      ok: false,
      error: `File content (${detectedType}) does not match its extension (${ext})`,
    };
  }

  return { ok: true, detectedType, ext, mime: MIME[detectedType] };
}

module.exports = { inspectFile, sniff, ALLOWED_EXTENSIONS };