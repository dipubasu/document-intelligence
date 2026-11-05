const { parseSearchQuery, keywordSearch } = require('../models/searchQueries');
const { semanticSearch } = require('../models/semanticSearch');
const { EmbeddingError } = require('../services/embeddings');
const logger = require('../utils/logger');

async function search(req, res) {
  const { params, error } = parseSearchQuery(req.query);
  if (error) return res.status(400).json({ error });

  if (params.mode === 'semantic') {
    try {
      return res.json(await semanticSearch(params));
    } catch (err) {
      if (err instanceof EmbeddingError) {
        // The message is already safe: it never contains the provider's own text.
        logger.warn('semantic search failed', { code: err.code, status: err.status });
        const status = err.code === 'NOT_CONFIGURED' ? 503 : 502;
        return res.status(status).json({ error: err.message });
      }
      throw err;
    }
  }
  return res.json(keywordSearch(params));
}

module.exports = { search };