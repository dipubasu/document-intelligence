const fs = require('fs');
const path = require('path');

// extension থেকে কোন "গ্রুপ" আশা করছি
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

// ফাইলের ভেতর দেখে পাওয়া ধরন থেকে গ্রুপ
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

// buffer এর শুরু নির্দিষ্ট byte দিয়ে কিনা
function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === bytes[i]);
}

// প্রথম কয়েক byte (magic bytes) দেখে আসল ধরন বলে
function sniff(buf) {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return 'xlsx'; // ZIP (xlsx আসলে একটা zip)
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'xls'; // পুরনো Excel
  // CSV এর কোনো magic byte নেই। তাই দেখি ভেতরে 0x00 byte আছে কিনা,
  // থাকলে সেটা সাধারণ লেখা না (binary), যেমন .exe
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

// ফাইল নিরাপদ ও সমর্থিত কিনা যাচাই করে
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