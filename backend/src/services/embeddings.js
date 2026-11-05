// Gemini embeddings: a small API client, plus helpers to store vectors and compare them.
// The key is read from config (backend/.env). It is never logged or returned.
const crypto = require('crypto');
const config = require('../config');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 30000;

// Only plain model names are allowed, because the name becomes part of the URL.
const MODEL_RE = /^[A-Za-z0-9._-]+$/;

// gemini-embedding-001 accepts at most 2048 tokens. 5000 characters of normal
// English text should be well below that (a rough estimate, not measured).
const MAX_EMBEDDING_CHARS = 5000;

const NOT_CONFIGURED_MESSAGE =
  'Semantic search is not configured. Set GEMINI_API_KEY and GEMINI_EMBEDDING_MODEL in backend/.env';

class EmbeddingError extends Error {
  constructor(message, { code = 'EMBEDDING_FAILED', status = null } = {}) {
    super(message);
    this.name = 'EmbeddingError';
    this.code = code;
    this.status = status;
  }
}

function isConfigured() {
  return Boolean(config.gemini.apiKey) && MODEL_RE.test(config.gemini.embeddingModel);
}

// Short, safe text for the user. The provider's own message is never passed on.
function describeStatus(status) {
  if (status === 429) return 'the embedding service is busy (rate limit)';
  if (status === 401 || status === 403) return 'the embedding key was rejected';
  if (status === 400) return 'the embedding request was rejected';
  if (status >= 500) return 'the embedding service has a temporary problem';
  return 'the embedding request failed';
}

// taskType is RETRIEVAL_DOCUMENT for stored texts and RETRIEVAL_QUERY for the user's question.
async function embed(text, taskType) {
  if (!isConfigured()) {
    throw new EmbeddingError(NOT_CONFIGURED_MESSAGE, { code: 'NOT_CONFIGURED' });
  }

  let res;
  try {
    res = await fetch(`${BASE_URL}/${config.gemini.embeddingModel}:embedContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': config.gemini.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: { parts: [{ text }] }, taskType }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new EmbeddingError('Could not reach the embedding service', { code: 'NETWORK' });
  }

  if (!res.ok) {
    throw new EmbeddingError(
      `Embedding API returned status ${res.status} (${describeStatus(res.status)})`,
      { status: res.status }
    );
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // the answer was not JSON
  }
  const values = body && body.embedding && body.embedding.values;
  if (!Array.isArray(values) || values.length === 0 || !values.every(Number.isFinite)) {
    throw new EmbeddingError('The embedding service returned an unexpected answer', {
      code: 'BAD_RESPONSE',
    });
  }
  return values;
}

// A vector is stored as 4-byte floats in one BLOB.
function toBlob(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

// The copy makes sure the bytes are aligned, which Float32Array needs.
function fromBlob(blob) {
  return new Float32Array(new Uint8Array(blob).buffer);
}

// 1 = same direction (very similar), 0 = unrelated, -1 = opposite.
function cosine(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// The text that represents one invoice in the vector index:
// the main fields, the line item names, and the start of the document text.
function buildEmbeddingText(invoice, items, pages) {
  const lines = [];
  const add = (label, value) => {
    if (value !== null && value !== undefined && value !== '') lines.push(`${label}: ${value}`);
  };

  add('File', invoice.original_name);
  add('Invoice number', invoice.invoice_number);
  add('Date', invoice.invoice_date);
  add('Supplier', invoice.supplier_name);
  add('Customer', invoice.customer_name);
  if (invoice.total !== null && invoice.total !== undefined) {
    add('Total', `${invoice.total} ${invoice.currency || ''}`.trim());
  }

  const names = (items || []).map((i) => i.description).filter(Boolean);
  if (names.length > 0) lines.push(`Items: ${names.join('; ')}`);

  const pageText = (pages || [])
    .map((p) => p.text || '')
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (pageText) lines.push(`Text: ${pageText}`);

  return lines.join('\n').slice(0, MAX_EMBEDDING_CHARS);
}

module.exports = {
  EmbeddingError,
  NOT_CONFIGURED_MESSAGE,
  MAX_EMBEDDING_CHARS,
  isConfigured,
  embed,
  toBlob,
  fromBlob,
  cosine,
  hashText,
  buildEmbeddingText,
};