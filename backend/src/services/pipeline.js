const fs = require('fs');
const path = require('path');
const config = require('../config');
const { parseDocument } = require('./parsers/parseDocument');
const documentModel = require('../models/documentModel');
const jobModel = require('../models/jobModel');

// permanent = আবার চেষ্টা করে লাভ নেই (ফাইল তো বদলাবে না)
function permanentError(message) {
  const err = new Error(message);
  err.permanent = true;
  return err;
}

// একটা document এর পুরো কাজ। এখন: parse করে পেজ সংরক্ষণ।
// পরে এখানে LLM extraction আর validation যোগ হবে
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
    err.permanent = true; // নষ্ট বা অসমর্থিত ফাইল আবার পড়লেও একই ফল
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