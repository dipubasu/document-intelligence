// Handlers for: list documents, get result, reprocess a failed document.
const queries = require('../models/documentQueries');

// Only plain positive whole numbers are accepted as ids.
function parseId(raw) {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

// GET /api/documents
function list(req, res) {
  const parsed = queries.parseListQuery(req.query);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  return res.json(queries.listDocuments(parsed.filters));
}

// GET /api/documents/:id/result
function getResult(req, res) {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid document id' });

  const result = queries.getResult(id);
  if (!result) return res.status(404).json({ error: 'Document not found' });
  return res.json(result);
}

// POST /api/documents/:id/reprocess
function reprocess(req, res) {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid document id' });

  const out = queries.requestReprocess(id);
  if (out.ok) return res.status(202).json({ id, job_id: out.jobId, status: 'queued' });
  if (out.reason === 'not_found') return res.status(404).json({ error: 'Document not found' });
  return res
    .status(409)
    .json({ error: `Only failed documents can be reprocessed (this one is ${out.status})` });
}

module.exports = { list, getResult, reprocess };