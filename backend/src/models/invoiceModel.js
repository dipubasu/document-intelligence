// Database access for extracted invoices.
// saveExtraction does everything in ONE synchronous transaction:
// find other documents with the same invoice number, validate, and save.
// Because nothing can run in between, two documents processed at the same time
// cannot both miss each other as duplicates.
const db = require('../db/connection');
const { validateInvoice } = require('../services/validator');

const dbNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const dbText = (v) => (typeof v === 'string' ? v : null);

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

const findOthersStmt = db.prepare(`
  SELECT document_id, supplier_name, invoice_number, total
  FROM invoices
  WHERE document_id != ? AND lower(trim(invoice_number)) = lower(trim(?))
`);

const findSameFileStmt = db.prepare(`
  SELECT d.id AS document_id
  FROM documents d JOIN invoices i ON i.document_id = d.id
  WHERE d.sha256 = ? AND d.id != ?
  ORDER BY d.id ASC LIMIT 1
`);

const selectInvoiceIds = db.prepare('SELECT id FROM invoices WHERE document_id = ?');
const deleteIssues = db.prepare('DELETE FROM validation_issues WHERE invoice_id = ?');
const deleteItems = db.prepare('DELETE FROM invoice_line_items WHERE invoice_id = ?');
const deleteCorrections = db.prepare('DELETE FROM corrections WHERE invoice_id = ?');
const deleteEmbedding = db.prepare('DELETE FROM embeddings WHERE invoice_id = ?');
const deleteInvoices = db.prepare('DELETE FROM invoices WHERE document_id = ?');

const insertInvoice = db.prepare(`
  INSERT INTO invoices
    (document_id, segment_index, page_start, page_end, invoice_number, invoice_date,
     supplier_name, customer_name, subtotal, tax, total, currency,
     confidence_json, uncertain_fields_json, raw_llm_json, model, prompt_version,
     is_corrected, created_at, updated_at)
  VALUES
    (@document_id, 0, @page_start, @page_end, @invoice_number, @invoice_date,
     @supplier_name, @customer_name, @subtotal, @tax, @total, @currency,
     @confidence_json, @uncertain_fields_json, @raw_llm_json, @model, @prompt_version,
     0, datetime('now'), datetime('now'))
`);
const insertItem = db.prepare(`
  INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, amount)
  VALUES (?, ?, ?, ?, ?)
`);
const insertIssue = db.prepare(`
  INSERT INTO validation_issues (invoice_id, rule, severity, field, message, created_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'))
`);
const setNeedsReview = db.prepare(
  "UPDATE documents SET needs_review = ?, updated_at = datetime('now') WHERE id = ?"
);

function findSameFile(sha256, excludeDocumentId) {
  return findSameFileStmt.get(sha256, excludeDocumentId) || null;
}

// Rebuild the extractor-shaped object from the database (used to reuse a result).
function getFullByDocument(documentId) {
  const row = db
    .prepare('SELECT * FROM invoices WHERE document_id = ? ORDER BY segment_index LIMIT 1')
    .get(documentId);
  if (!row) return null;
  const items = db
    .prepare(
      'SELECT description, quantity, unit_price, amount FROM invoice_line_items WHERE invoice_id = ? ORDER BY id'
    )
    .all(row.id);
  return {
    invoice: {
      invoice_number: row.invoice_number,
      invoice_date: row.invoice_date,
      supplier_name: row.supplier_name,
      customer_name: row.customer_name,
      subtotal: row.subtotal,
      tax: row.tax,
      total: row.total,
      currency: row.currency,
      line_items: items,
      confidence: safeJson(row.confidence_json, {}),
      uncertain_fields: safeJson(row.uncertain_fields_json, []),
    },
    rawJson: row.raw_llm_json,
    model: row.model,
    promptVersion: row.prompt_version,
  };
}

// Delete the old extraction of a document (so reprocessing never duplicates rows).
function clearForDocument(documentId) {
  for (const { id } of selectInvoiceIds.all(documentId)) {
    deleteIssues.run(id);
    deleteItems.run(id);
    deleteCorrections.run(id);
    deleteEmbedding.run(id);
  }
  deleteInvoices.run(documentId);
}

const saveExtraction = db.transaction((documentId, invoice, meta) => {
  clearForDocument(documentId);

  const others = invoice.invoice_number ? findOthersStmt.all(documentId, invoice.invoice_number) : [];
  const check = validateInvoice(invoice, { others });

  const uncertainIssues = invoice.uncertain_fields.map((field) => ({
    rule: 'uncertain_value',
    severity: 'warning',
    field,
    message: `${field} could not be confirmed in the document text or the model was unsure`,
  }));
  const issues = [...check.issues, ...(meta.extraIssues || []), ...uncertainIssues];

  const needsReview =
    check.needsReview ||
    invoice.uncertain_fields.length > 0 ||
    issues.some((i) => i.severity === 'error');

  const info = insertInvoice.run({
    document_id: documentId,
    page_start: meta.pageStart ?? null,
    page_end: meta.pageEnd ?? null,
    invoice_number: dbText(invoice.invoice_number),
    invoice_date: dbText(invoice.invoice_date),
    supplier_name: dbText(invoice.supplier_name),
    customer_name: dbText(invoice.customer_name),
    // A non-number (the validator already flagged it) is stored as NULL.
    // The original answer stays in raw_llm_json.
    subtotal: dbNumber(invoice.subtotal),
    tax: dbNumber(invoice.tax),
    total: dbNumber(invoice.total),
    currency: dbText(invoice.currency),
    confidence_json: JSON.stringify(invoice.confidence || {}),
    uncertain_fields_json: JSON.stringify(invoice.uncertain_fields || []),
    raw_llm_json: meta.rawJson ?? null,
    model: meta.model ?? null,
    prompt_version: meta.promptVersion ?? null,
  });
  const invoiceId = Number(info.lastInsertRowid);

  for (const item of invoice.line_items || []) {
    insertItem.run(
      invoiceId,
      dbText(item.description),
      dbNumber(item.quantity),
      dbNumber(item.unit_price),
      dbNumber(item.amount)
    );
  }
  for (const issue of issues) {
    insertIssue.run(invoiceId, issue.rule, issue.severity, issue.field ?? 'document', issue.message);
  }
  setNeedsReview.run(needsReview ? 1 : 0, documentId);

  return { invoiceId, issues, needsReview };
});

module.exports = { saveExtraction, findSameFile, getFullByDocument };