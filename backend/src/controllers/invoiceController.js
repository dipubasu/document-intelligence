// Handler for: manual correction of an invoice.
const correctionModel = require('../models/correctionModel');
const queries = require('../models/documentQueries');

function parseId(raw) {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

// PATCH /api/invoices/:id
function correct(req, res) {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid invoice id' });

  const parsed = correctionModel.parseCorrectionBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const out = correctionModel.applyCorrection(id, parsed.changes);
  if (!out.ok) return res.status(404).json({ error: 'Invoice not found' });

  return res.json({ changed: out.changed, ...queries.getResult(out.documentId) });
}

module.exports = { correct };