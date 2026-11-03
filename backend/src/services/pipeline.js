const fs = require('fs');
const path = require('path');
const config = require('../config');
const { parseDocument } = require('./parsers/parseDocument');
const documentModel = require('../models/documentModel');
const jobModel = require('../models/jobModel');

// permanent = retrying is pointless (the file will not change)
function permanentError(message) {
  const err = new Error(message);
  err.permanent = true;
  return err;
}

// The full job for one document. Now: parse and save the pages.
// LLM extraction and validation will be added here later
async function processDocument(job) {
  const doc = documentModel.getById(job.document_id);
  if (!doc) throw permanentError('Document record not found');

  const filePath = path.join(config.uploadDir, doc.stored_name);
  if (!fs.existsSync(filePath)) throw permanentError('Stored file is missing');

  let parsed;
  try {
    parsed = await parseDocument(filePath, doc.detected_type, {
      maxPages: config.pdf.maxPages,
    });
  } catch (err) {
    err.permanent = true; // a corrupt or unsupported file gives the same result if read again
    throw err;
  }

  jobModel.savePages(doc.id, parsed.pages);

  return {
    pageCount: parsed.pageCount,
    parser: parsed.parser,
    lowTextPages: parsed.lowTextPages,
    truncated: parsed.truncated,
  };
}

module.exports = { processDocument };