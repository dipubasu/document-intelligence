// Keyword search over invoice fields AND the extracted text of every page or sheet.
// All values go into the SQL as parameters; only fixed text is built into the SQL string.
const db = require('../db/connection');

const MODES = ['keyword', 'semantic'];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 100;
const MAX_PAGES_PER_DOCUMENT = 3;
const SNIPPET_RADIUS = 60;
const DIGITS_RE = /^\d+$/;
const ESCAPE = " ESCAPE '\\'";

// "%" and "_" typed by a user must be searched as normal characters, not as wildcards.
const like = (text) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

// Check the raw query string. Returns { params } or { error }.
function parseSearchQuery(query = {}) {
  for (const name of ['q', 'mode', 'limit', 'offset']) {
    const v = query[name];
    if (v !== undefined && typeof v !== 'string') {
      return { error: `${name} must be a single text value` };
    }
  }

  const q = (query.q || '').trim().replace(/\s+/g, ' ');
  if (q.length < MIN_QUERY_LENGTH) {
    return { error: `q is required and must have at least ${MIN_QUERY_LENGTH} characters` };
  }
  if (q.length > MAX_QUERY_LENGTH) {
    return { error: `q must have at most ${MAX_QUERY_LENGTH} characters` };
  }

  const mode = (query.mode || 'keyword').trim();
  if (!MODES.includes(mode)) {
    return { error: `mode must be one of: ${MODES.join(', ')}` };
  }

  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined && query.limit.trim() !== '') {
    const v = query.limit.trim();
    if (!DIGITS_RE.test(v) || Number(v) < 1) {
      return { error: 'limit must be a whole number of at least 1' };
    }
    limit = Math.min(Number(v), MAX_LIMIT);
  }

  let offset = 0;
  if (query.offset !== undefined && query.offset.trim() !== '') {
    const v = query.offset.trim();
    if (!DIGITS_RE.test(v)) return { error: 'offset must be a whole number' };
    offset = Number(v);
  }

  return { params: { q, mode, limit, offset } };
}

// A short piece of text around the first match, so the user sees why the page matched.
// The text is plain text. The UI must escape it before showing it.
function makeSnippet(text, q) {
  const flat = String(text || '').replace(/\s+/g, ' ');
  const pos = flat.toLowerCase().indexOf(q.toLowerCase());
  const start = pos === -1 ? 0 : Math.max(0, pos - SNIPPET_RADIUS);
  const end = pos === -1 ? SNIPPET_RADIUS * 2 : pos + q.length + SNIPPET_RADIUS;
  const cut = flat.slice(start, Math.min(end, flat.length));
  return `${start > 0 ? '...' : ''}${cut}${end < flat.length ? '...' : ''}`;
}

function keywordSearch({ q, limit, offset }) {
  const pattern = like(q);
  const lowerQ = q.toLowerCase();

  const columns = ['d.original_name', 'i.invoice_number', 'i.supplier_name', 'i.customer_name'];
  const textMatch = `EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id AND p.text LIKE ?${ESCAPE})`;
  const whereSql = `WHERE ${columns.map((c) => `${c} LIKE ?${ESCAPE}`).join(' OR ')} OR ${textMatch}`;
  const fromSql = 'FROM documents d LEFT JOIN invoices i ON i.document_id = d.id';
  const params = Array(columns.length + 1).fill(pattern);

  const total = db.prepare(`SELECT COUNT(*) AS n ${fromSql} ${whereSql}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT d.id, d.original_name, d.status, d.needs_review,
              i.invoice_number, i.supplier_name, i.customer_name, i.total, i.currency
       ${fromSql} ${whereSql}
       ORDER BY d.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  const pagesStmt = db.prepare(
    `SELECT page_number, sheet_name, text FROM document_pages
     WHERE document_id = ? AND text LIKE ?${ESCAPE} ORDER BY id LIMIT ?`
  );
  const pageCountStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM document_pages WHERE document_id = ? AND text LIKE ?${ESCAPE}`
  );

  const items = rows.map((row) => {
    const matchedFields = [
      ['original_name', row.original_name],
      ['invoice_number', row.invoice_number],
      ['supplier_name', row.supplier_name],
      ['customer_name', row.customer_name],
    ]
      .filter(([, value]) => typeof value === 'string' && value.toLowerCase().includes(lowerQ))
      .map(([name]) => name);

    const pages = pagesStmt.all(row.id, pattern, MAX_PAGES_PER_DOCUMENT).map((p) => ({
      page_number: p.page_number,
      sheet_name: p.sheet_name,
      snippet: makeSnippet(p.text, q),
    }));

    return {
      document_id: row.id,
      original_name: row.original_name,
      status: row.status,
      needs_review: row.needs_review,
      invoice_number: row.invoice_number,
      supplier_name: row.supplier_name,
      customer_name: row.customer_name,
      total: row.total,
      currency: row.currency,
      matched_fields: matchedFields,
      matching_pages: pageCountStmt.get(row.id, pattern).n,
      pages,
    };
  });

  return { mode: 'keyword', query: q, items, total, limit, offset };
}

module.exports = { parseSearchQuery, keywordSearch, makeSnippet };