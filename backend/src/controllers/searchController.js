const { parseSearchQuery, keywordSearch } = require('../models/searchQueries');

function search(req, res) {
  const { params, error } = parseSearchQuery(req.query);
  if (error) return res.status(400).json({ error });

  if (params.mode === 'semantic') {
    return res
      .status(501)
      .json({ error: 'Semantic search is not available yet. Use mode=keyword.' });
  }
  return res.json(keywordSearch(params));
}

module.exports = { search };