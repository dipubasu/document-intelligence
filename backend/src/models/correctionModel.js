// Manual correction of an extracted invoice.
// A person can fix values or confirm uncertain ones. Every change is written to the
// corrections table (audit trail), then the invoice is validated again.
const db = require('../db/connection');
const { validateInvoice } = require('../services/validator');
const { addHistory } = require('./documentModel');

const TEXT_FIELDS = ['invoice_number', 'supplier_name', 'customer_name'];
const MONEY_FIELDS = ['subtotal', 'tax', 'total'];
const HEADER_FIELDS = [...TEXT_FIELDS, 'invoice_date', 'currency', ...MONEY_FIELDS];
const ALLOWED_KEYS = [...HEADER_FIELDS, 'line_items'];

const MAX_TEXT_LENGTH = 200;
const MAX_AMOUNT = 1e12;
const MAX_LINE_ITEMS = 500;

// ---------- checking the request body ----------

function cleanText(value, label) {
  if (value === null) return { value: null };
  if (typeof value !== 'string') return { error: `${label} must be text or null` };
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return { error: `${label} is too long (max ${MAX_TEXT_LENGTH} characters)` };
  }
  return { value: trimmed === '' ? null : trimmed };
}

function cleanNumber(value, label) {
  if (value === null) return { value: null };
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_AMOUNT) {
    return { error: `${label} must be a number or null` };
  }
  return { value };
}

function isRealDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function cleanDate(value) {
  if (value === null) return { value: null };
  if (typeof value !== 'string') return { error: 'invoice_date must be text like 2026-01-31 or null' };
  const trimmed = value.trim();
  if (trimmed === '') return { value: null };
  if (!isRealDate(trimmed)) return { error: 'invoice_date must be a real date like 2026-01-31' };
  return { value: trimmed };
}

function cleanCurrency(value) {
  if (value === null) return { value: null };
  if (typeof value !== 'string') return { error: 'currency must be a 3-letter code or null' };
  const trimmed = value.trim();
  if (trimmed === '') return { value: null };
  if (!/^[A-Za-z]{3}$/.test(trimmed)) return { error: 'currency must be a 3-letter code like USD' };
  return { value: trimmed.toUpperCase() };
}

function cleanLineItems(value) {
  if (!Array.isArray(value)) return { error: 'line_items must be a list' };
  if (value.length > MAX_LINE_ITEMS) return { error: `line_items has more than ${MAX_LINE_ITEMS} items` };

  const items = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: `line_items[${i}] must be an object` };
    }
    const parts = {
      description: cleanText(item.description ?? null, `line_items[${i}].description`),
      quantity: cleanNumber(item.quantity ?? null, `line_items[${i}].quantity`),
      unit_price: cleanNumber(item.unit_price ?? null, `line_items[${i}].unit_price`),
      amount: cleanNumber(item.amount ?? null, `line_items[${i}].amount`),
    };
    for (const part of Object.values(parts)) {
      if (part.error) return { error: part.error };
    }
    // The key order here must match the order of the SELECT below (used for comparing).
    items.push({
      description: parts.description.value,
      quantity: parts.quantity.value,
      unit_price: parts.unit_price.value,
      amount: parts.amount.value,
    });
  }
  return { value: items };
}

// Returns { changes } or { error }.
function parseCorrectionBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Send a JSON object with the fields to correct' };
  }
  const keys = Object.keys(body);
  if (keys.length === 0) return { error: 'Send at least one field to correct' };

  const unknown = keys.find((k) => !ALLOWED_KEYS.includes(k));
  if (unknown !== undefined) {
    return { error: `Unknown field: ${unknown.slice(0, 50)}. Allowed: ${ALLOWED_KEYS.join(', ')}` };
  }

  const changes = {};
  for (const key of keys) {
    let result;
    if (TEXT_FIELDS.includes(key)) result = cleanText(body[key], key);
    else if (MONEY_FIELDS.includes(key)) result = cleanNumber(body[key], key);
    else if (key === 'invoice_date') result = cleanDate(body[key]);
    else if (key === 'currency') result = cleanCurrency(body[key]);
    else result = cleanLineItems(body[key]);
    if (result.error) return { error: result.error };
    changes[key] = result.value;
  }
  return { changes };
}

// ---------- database ----------

// Issues written by the pipeline about the whole document. A person cannot fix them
// by editing a value, so they stay after a correction.
const selectInvoice = db.prepare('SELECT * FROM invoices WHERE id = ?');
const selectItems = db.prepare(
  'SELECT description, quantity, unit_price, amount FROM invoice_line_items WHERE invoice_id = ? ORDER BY id'
);
const findOthers = db.prepare(`
  SELECT document_id, supplier_name, invoice_number, total
  FROM invoices
  WHERE document_id != ? AND lower(trim(invoice_number)) = lower(trim(?))
`);
const deleteItems = db.prepare('DELETE FROM invoice_line_items WHERE invoice_id = ?');
const insertItem = db.prepare(
  'INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?)'
);
const insertCorrection = db.prepare(
  "INSERT INTO corrections (invoice_id, field, old_value, new_value, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
);
const deleteChecked = db.prepare(`
  DELETE FROM validation_issues
  WHERE invoice_id = ? AND rule NOT IN ('duplicate_file', 'text_truncated', 'low_text_pages')
`);
const insertIssue = db.prepare(`
  INSERT INTO validation_issues (invoice_id, rule, severity, field, message, created_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'))
`);
const countErrors = db.prepare(
  "SELECT COUNT(*) AS n FROM validation_issues WHERE invoice_id = ? AND severity = 'error'"
);
const setNeedsReview = db.prepare(
  "UPDATE documents SET needs_review = ?, updated_at = datetime('now') WHERE id = ?"
);

const toText = (value) => (value === null || value === undefined ? null : String(value));

function safeList(text) {
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Column names come only from HEADER_FIELDS (fixed list), values are bound parameters.
function updateInvoice(id, updates, uncertain, isCorrected) {
  const sets = Object.keys(updates).map((column) => `${column} = @${column}`);
  sets.push('uncertain_fields_json = @uncertain_json', 'is_corrected = @is_corrected');
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE invoices SET ${sets.join(', ')} WHERE id = @id`).run({
    ...updates,
    uncertain_json: JSON.stringify(uncertain),
    is_corrected: isCorrected,
    id,
  });
}

// One transaction: audit rows, update, re-validate, review flag.
// Every field that is sent counts as "checked by a person", even if the value is the same,
// so it is removed from uncertain_fields.
const applyCorrection = db.transaction((invoiceId, changes) => {
  const row = selectInvoice.get(invoiceId);
  if (!row) return { ok: false, reason: 'not_found' };

  const updates = {};
  const audit = [];
  for (const field of HEADER_FIELDS) {
    if (!Object.hasOwn(changes, field)) continue;
    if (changes[field] === row[field]) continue;
    updates[field] = changes[field];
    audit.push({ field, oldValue: row[field], newValue: changes[field] });
  }

  let newItems = null;
  if (Object.hasOwn(changes, 'line_items')) {
    const oldItems = selectItems.all(row.id);
    if (JSON.stringify(oldItems) !== JSON.stringify(changes.line_items)) {
      newItems = changes.line_items;
      audit.push({
        field: 'line_items',
        oldValue: JSON.stringify(oldItems),
        newValue: JSON.stringify(newItems),
      });
    }
  }

  const touched = Object.keys(changes);
  const uncertain = safeList(row.uncertain_fields_json).filter((f) => !touched.includes(f));
  const isCorrected = row.is_corrected || audit.length > 0 ? 1 : 0;

  for (const a of audit) {
    insertCorrection.run(row.id, a.field, toText(a.oldValue), toText(a.newValue));
  }
  if (newItems) {
    deleteItems.run(row.id);
    for (const item of newItems) {
      insertItem.run(row.id, item.description, item.quantity, item.unit_price, item.amount);
    }
  }
  updateInvoice(row.id, updates, uncertain, isCorrected);

  // Validate the corrected invoice again.
  const fresh = selectInvoice.get(row.id);
  const invoice = {
    invoice_number: fresh.invoice_number,
    invoice_date: fresh.invoice_date,
    supplier_name: fresh.supplier_name,
    customer_name: fresh.customer_name,
    subtotal: fresh.subtotal,
    tax: fresh.tax,
    total: fresh.total,
    currency: fresh.currency,
    line_items: selectItems.all(row.id),
  };
  const others = fresh.invoice_number ? findOthers.all(row.document_id, fresh.invoice_number) : [];
  const check = validateInvoice(invoice, { others });

  deleteChecked.run(row.id);
  for (const issue of check.issues) {
    insertIssue.run(row.id, issue.rule, issue.severity, issue.field ?? 'document', issue.message);
  }
  for (const field of uncertain) {
    insertIssue.run(
      row.id,
      'uncertain_value',
      'warning',
      field,
      `${field} could not be confirmed in the document text or the model was unsure`
    );
  }

  const needsReview = countErrors.get(row.id).n > 0 || uncertain.length > 0;
  setNeedsReview.run(needsReview ? 1 : 0, row.document_id);

  addHistory({
    documentId: row.document_id,
    event: 'corrected',
    detail:
      audit.length > 0
        ? `changed: ${audit.map((a) => a.field).join(', ')}`
        : `confirmed without changes: ${touched.join(', ')}`,
  });

  return { ok: true, documentId: row.document_id, changed: audit.map((a) => a.field) };
});

module.exports = { parseCorrectionBody, applyCorrection };