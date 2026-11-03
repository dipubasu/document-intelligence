// Read queries for the API (list, result) and the manual reprocess request.
// All values go into the SQL as parameters; only fixed text is built into the SQL string.
const db = require('../db/connection');
const config = require('../config');
const { toPublic, addHistory } = require('./documentModel');

const STATUSES = ['queued', 'processing', 'completed', 'failed'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS_RE = /^\d+$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_TEXT_LENGTH = 100;
const ESCAPE = " ESCAPE '\\'";

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// Turn the raw query string values into checked filters.
// Returns { filters } or { error }.
function parseListQuery(query = {}) {
  const names = ['q', 'status', 'supplier', 'from', 'to', 'needs_review', 'limit', 'offset'];
  for (const name of names) {
    const v = query[name];
    if (v !== undefined && typeof v !== 'string') {
      return { error: `${name} must be a single text value` };
    }
  }
  const get = (name) => {
    const v = query[name];
    return v === undefined || v.trim() === '' ? null : v.trim();
  };

  const filters = {
    q: null,
    status: null,
    supplier: null,
    from: null,
    to: null,
    needsReview: null,
    limit: DEFAULT_LIMIT,
    offset: 0,
  };

  const q = get('q');
  if (q) filters.q = q.slice(0, MAX_TEXT_LENGTH);
  const supplier = get('supplier');
  if (supplier) filters.supplier = supplier.slice(0, MAX_TEXT_LENGTH);

  const status = get('status');
  if (status) {
    if (!STATUSES.includes(status)) {
      return { error: `status must be one of: ${STATUSES.join(', ')}` };
    }
    filters.status = status;
  }

  for (const [name, key] of [['from', 'from'], ['to', 'to']]) {
    const v = get(name);
    if (v) {
      if (!DATE_RE.test(v)) return { error: `${name} must be a date like 2026-01-31` };
      filters[key] = v;
    }
  }

  const review = get('needs_review');
  if (review) {
    if (review === 'true' || review === '1') filters.needsReview = 1;
    else if (review === 'false' || review === '0') filters.needsReview = 0;
    else return { error: 'needs_review must be true or false' };
  }

  const limit = get('limit');
  if (limit) {
    if (!DIGITS_RE.test(limit) || Number(limit) < 1) {
      return { error: 'limit must be a whole number of at least 1' };
    }
    filters.limit = Math.min(Number(limit), MAX_LIMIT);
  }

  const offset = get('offset');
  if (offset) {
    if (!DIGITS_RE.test(offset)) return { error: 'offset must be a whole number' };
    filters.offset = Number(offset);
  }

  return { filters };
}

// "%" and "_" typed by a user must be searched as normal characters, not as wildcards.
const like = (text) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

function listDocuments(filters) {
  const where = [];
  const params = [];

  if (filters.status) {
    where.push('d.status = ?');
    params.push(filters.status);
  }
  if (filters.needsReview !== null) {
    where.push('d.needs_review = ?');
    params.push(filters.needsReview);
  }
  if (filters.supplier) {
    where.push(`i.supplier_name LIKE ?${ESCAPE}`);
    params.push(like(filters.supplier));
  }
  // Date filters use the invoice date, so documents without an invoice are left out.
  if (filters.from) {
    where.push('i.invoice_date >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    where.push('i.invoice_date <= ?');
    params.push(filters.to);
  }
  if (filters.q) {
    const columns = ['d.original_name', 'i.invoice_number', 'i.supplier_name', 'i.customer_name'];
    where.push(`(${columns.map((c) => `${c} LIKE ?${ESCAPE}`).join(' OR ')})`);
    for (let n = 0; n < columns.length; n += 1) params.push(like(filters.q));
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const fromSql = 'FROM documents d LEFT JOIN invoices i ON i.document_id = d.id';

  const total = db.prepare(`SELECT COUNT(*) AS n ${fromSql} ${whereSql}`).get(...params).n;
  const items = db
    .prepare(
      `SELECT d.id, d.original_name, d.detected_type, d.size_bytes, d.page_count,
              d.status, d.needs_review, d.error_message, d.created_at, d.updated_at,
              i.id AS invoice_id, i.invoice_number, i.invoice_date, i.supplier_name,
              i.customer_name, i.total, i.currency, i.is_corrected,
              (SELECT COUNT(*) FROM validation_issues v
                 WHERE v.invoice_id = i.id AND v.severity = 'error') AS error_count,
              (SELECT COUNT(*) FROM validation_issues v
                 WHERE v.invoice_id = i.id AND v.severity = 'warning') AS warning_count
       ${fromSql} ${whereSql}
       ORDER BY d.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, filters.limit, filters.offset);

  return { items, total, limit: filters.limit, offset: filters.offset };
}

// The full result of one document: invoice, line items, issues and corrections.
// Returns null when the document does not exist. "invoice" is null when nothing was extracted.
function getResult(documentId) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  if (!doc) return null;

  const row = db
    .prepare('SELECT * FROM invoices WHERE document_id = ? ORDER BY segment_index LIMIT 1')
    .get(documentId);
  if (!row) return { document: toPublic(doc), invoice: null, issues: [], corrections: [] };

  const lineItems = db
    .prepare(
      'SELECT id, description, quantity, unit_price, amount FROM invoice_line_items WHERE invoice_id = ? ORDER BY id'
    )
    .all(row.id);
  const issues = db
    .prepare(
      'SELECT id, rule, severity, field, message FROM validation_issues WHERE invoice_id = ? ORDER BY id'
    )
    .all(row.id);
  const corrections = db
    .prepare(
      'SELECT field, old_value, new_value, created_at FROM corrections WHERE invoice_id = ? ORDER BY id'
    )
    .all(row.id);

  return {
    document: toPublic(doc),
    invoice: {
      id: row.id,
      invoice_number: row.invoice_number,
      invoice_date: row.invoice_date,
      supplier_name: row.supplier_name,
      customer_name: row.customer_name,
      subtotal: row.subtotal,
      tax: row.tax,
      total: row.total,
      currency: row.currency,
      confidence: safeJson(row.confidence_json, {}),
      uncertain_fields: safeJson(row.uncertain_fields_json, []),
      is_corrected: row.is_corrected,
      model: row.model,
      prompt_version: row.prompt_version,
      line_items: lineItems,
    },
    issues,
    corrections,
  };
}

// Queue a new job for a FAILED document. Check and update run in one transaction,
// so a double click cannot create two jobs.
const requestReprocess = db.transaction((documentId) => {
  const doc = db.prepare('SELECT id, status FROM documents WHERE id = ?').get(documentId);
  if (!doc) return { ok: false, reason: 'not_found' };
  if (doc.status !== 'failed') return { ok: false, reason: 'not_failed', status: doc.status };

  const info = db
    .prepare("INSERT INTO jobs (document_id, type, status, max_attempts) VALUES (?, 'process', 'queued', ?)")
    .run(documentId, config.worker.maxAttempts);
  db.prepare(
    "UPDATE documents SET status = 'queued', error_message = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(documentId);
  addHistory({
    documentId,
    event: 'reprocess_requested',
    fromStatus: 'failed',
    toStatus: 'queued',
    detail: 'manual reprocess',
  });
  return { ok: true, jobId: Number(info.lastInsertRowid) };
});

module.exports = { parseListQuery, listDocuments, getResult, requestReprocess };