const fs = require('fs');
const { parse } = require('csv-parse/sync');

// take at most this many rows from one CSV (more than that sets truncated: true)
const MAX_ROWS = 5000;

// look at the first line to guess the delimiter (comma, semicolon, tab or |)
function detectDelimiter(text) {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] || '';
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t', '|']) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

async function parseCsv(filePath) {
  const raw = await fs.promises.readFile(filePath, 'utf8');

  let rows;
  try {
    rows = parse(raw, {
      bom: true, // drop the invisible BOM mark at the start of the file
      delimiter: detectDelimiter(raw),
      skip_empty_lines: true,
      relax_column_count: true, // rows with fewer or more columns are fine
      trim: true,
    });
  } catch (err) {
    throw new Error(`Could not parse CSV: ${err.message}`);
  }

  const nonEmpty = rows.filter((row) => row.some((cell) => cell !== ''));
  if (nonEmpty.length === 0) {
    throw new Error('CSV file has no data');
  }

  const used = nonEmpty.slice(0, MAX_ROWS);
  return {
    pages: [
      {
        page_number: 1,
        sheet_name: null,
        text: used.map((row) => row.join(' | ')).join('\n'),
      },
    ],
    rowCount: used.length,
    truncated: nonEmpty.length > MAX_ROWS,
  };
}

module.exports = { parseCsv, MAX_ROWS };