const fs = require('fs');
const path = require('path');
const config = require('../config');
const { parseDocument } = require('./parsers/parseDocument');
const extractor = require('./extractor');
const documentModel = require('../models/documentModel');
const jobModel = require('../models/jobModel');
const invoiceModel = require('../models/invoiceModel');

// permanent = retrying is pointless (the result would be the same)
function permanentError(message) {
  const err = new Error(message);
  err.permanent = true;
  return err;
}

// One text for the whole document. Spreadsheet pages get their sheet name as a header.
function buildText(pages) {
  return pages
    .map((p) => (p.sheet_name ? `[Sheet: ${p.sheet_name}]\n${p.text}` : p.text))
    .filter((t) => typeof t === 'string' && t.trim() !== '')
    .join('\n\n');
}

async function runExtraction(text) {
  try {
    return await extractor.extractInvoice(text);
  } catch (err) {
    if (err.code === 'NO_TEXT') {
      err.message =
        'No readable text found. Scanned PDFs are not supported yet, and a blurry image may give no text';
      err.permanent = true;
    } else if (err.name === 'LlmError' && !err.retryable) {
      err.permanent = true; // for example a missing or wrong API key
    }
    throw err;
  }
}

// The full job for one document: parse, extract, validate, save.
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

  // The same file was already processed: reuse its result, no LLM call (saves cost and time).
  const sameFile = doc.sha256 ? invoiceModel.findSameFile(doc.sha256, doc.id) : null;
  let extraction;
  let reusedFrom = null;
  if (sameFile) {
    extraction = { ...invoiceModel.getFullByDocument(sameFile.document_id), truncated: false };
    reusedFrom = sameFile.document_id;
  } else {
    extraction = await runExtraction(buildText(parsed.pages));
  }

  const extraIssues = [];
  if (reusedFrom) {
    extraIssues.push({
      rule: 'duplicate_file',
      severity: 'error',
      field: 'document',
      message: `This exact file was already uploaded as document ${reusedFrom}`,
    });
  }
  if (parsed.truncated || extraction.truncated) {
    extraIssues.push({
      rule: 'text_truncated',
      severity: 'error',
      field: 'document',
      message: 'The document text was too long and was cut. The result may be incomplete',
    });
  }
  const lowText = parsed.lowTextPages || [];
  if (lowText.length > 0) {
    extraIssues.push({
      rule: 'low_text_pages',
      severity: 'warning',
      field: 'document',
      message: `Pages with almost no text (possible scans, not read): ${lowText.slice(0, 20).join(', ')}`,
    });
  }

  const saved = invoiceModel.saveExtraction(doc.id, extraction.invoice, {
    pageStart: 1,
    pageEnd: parsed.pageCount,
    rawJson: extraction.rawJson,
    model: extraction.model,
    promptVersion: extraction.promptVersion,
    extraIssues,
  });

  documentModel.addHistory({
    documentId: doc.id,
    event: reusedFrom ? 'result_reused' : 'extracted',
    detail:
      `model=${extraction.model}, prompt=${extraction.promptVersion}, ` +
      `issues=${saved.issues.length}, needs_review=${saved.needsReview ? 'yes' : 'no'}` +
      (reusedFrom ? `, same file as document ${reusedFrom}` : ''),
    durationMs: extraction.durationMs ?? null,
  });

  return {
    pageCount: parsed.pageCount,
    parser: parsed.parser,
    lowTextPages: parsed.lowTextPages,
    truncated: parsed.truncated,
    invoiceId: saved.invoiceId,
    needsReview: saved.needsReview,
  };
}

module.exports = { processDocument };