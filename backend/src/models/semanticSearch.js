// Semantic search: rank invoices by meaning, using Gemini embeddings and cosine similarity.
// Vectors are made on demand: at most MAX_NEW_PER_SEARCH new or changed invoices per search.
const db = require('../db/connection');
const config = require('../config');
const embeddings = require('../services/embeddings');

const MAX_NEW_PER_SEARCH = 20;
const MAX_PAGES_FOR_TEXT = 3;

const candidatesStmt = db.prepare(`
  SELECT i.id AS invoice_id, i.document_id, i.invoice_number, i.invoice_date,
         i.supplier_name, i.customer_name, i.total, i.currency,
         d.original_name, d.status, d.needs_review
  FROM invoices i JOIN documents d ON d.id = i.document_id
  ORDER BY i.id
`);
const itemsStmt = db.prepare(
  'SELECT description FROM invoice_line_items WHERE invoice_id = ? ORDER BY id'
);
const pagesStmt = db.prepare(
  `SELECT substr(text, 1, ${embeddings.MAX_EMBEDDING_CHARS}) AS text
   FROM document_pages WHERE document_id = ? ORDER BY id LIMIT ${MAX_PAGES_FOR_TEXT}`
);
const storedStmt = db.prepare('SELECT text_hash, vector FROM embeddings WHERE invoice_id = ?');
const saveStmt = db.prepare(`
  INSERT INTO embeddings (invoice_id, model, vector, text_hash, created_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(invoice_id) DO UPDATE SET
    model = excluded.model, vector = excluded.vector,
    text_hash = excluded.text_hash, created_at = excluded.created_at
`);

async function semanticSearch({ q, limit, offset }) {
  // The question first: if this fails, nothing else is worth doing.
  const queryVector = await embeddings.embed(q, 'RETRIEVAL_QUERY');
  const model = config.gemini.embeddingModel;

  // Split the invoices into "vector is up to date" and "needs a new vector".
  // The hash covers the model name and the text, so a correction or a model change is noticed.
  const ready = [];
  const stale = [];
  for (const row of candidatesStmt.all()) {
    const text = embeddings.buildEmbeddingText(
      row,
      itemsStmt.all(row.invoice_id),
      pagesStmt.all(row.document_id)
    );
    const hash = embeddings.hashText(`${model}\n${text}`);
    const stored = storedStmt.get(row.invoice_id);
    if (stored && stored.text_hash === hash) {
      ready.push({ row, vector: embeddings.fromBlob(stored.vector) });
    } else {
      stale.push({ row, text, hash });
    }
  }

  // Make the missing vectors one by one (gentle on the free-tier rate limit).
  let indexedNow = 0;
  for (const s of stale.slice(0, MAX_NEW_PER_SEARCH)) {
    let values;
    try {
      values = await embeddings.embed(s.text, 'RETRIEVAL_DOCUMENT');
    } catch (err) {
      if (err instanceof embeddings.EmbeddingError) break; // for example a rate limit: stop here
      throw err;
    }
    try {
      saveStmt.run(s.row.invoice_id, model, embeddings.toBlob(values), s.hash);
    } catch {
      // the invoice may have been deleted while we waited; the vector is still usable now
    }
    ready.push({ row: s.row, vector: Float32Array.from(values) });
    indexedNow += 1;
  }

  const scored = ready
    .map(({ row, vector }) => ({
      document_id: row.document_id,
      original_name: row.original_name,
      status: row.status,
      needs_review: row.needs_review,
      invoice_number: row.invoice_number,
      supplier_name: row.supplier_name,
      customer_name: row.customer_name,
      total: row.total,
      currency: row.currency,
      score: Math.round(embeddings.cosine(queryVector, vector) * 1000) / 1000,
      matched_fields: [],
      matching_pages: 0,
      pages: [],
    }))
    .sort((a, b) => b.score - a.score || b.document_id - a.document_id);

  return {
    mode: 'semantic',
    query: q,
    items: scored.slice(offset, offset + limit),
    total: scored.length,
    limit,
    offset,
    not_indexed: stale.length - indexedNow,
  };
}

module.exports = { semanticSearch, MAX_NEW_PER_SEARCH };