const ExcelJS = require('exceljs');

// take at most this many rows from each sheet
const MAX_ROWS_PER_SHEET = 5000;

// An Excel cell value can be of many kinds (number, date, formula, rich text, link)
function cellToText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('result' in value) return cellToText(value.result); // result of a formula
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
    if ('text' in value) return String(value.text); // hyperlink
    if ('error' in value) return String(value.error);
    return '';
  }
  return String(value);
}

async function parseExcel(filePath) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (err) {
    throw new Error(`Could not read Excel file: ${err.message}`);
  }

  const pages = [];
  let rowCount = 0;
  let truncated = false;

  workbook.worksheets.forEach((sheet, index) => {
    const lines = [];

    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (lines.length >= MAX_ROWS_PER_SHEET) {
        truncated = true;
        return;
      }
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cells[col - 1] = cellToText(cell.value);
      });
      const values = Array.from(cells, (c) => c ?? '');
      if (values.every((c) => c === '')) return;
      lines.push(values.join(' | '));
    });

    if (lines.length === 0) return; // skip an empty sheet
    rowCount += lines.length;
    pages.push({
      page_number: index + 1,
      sheet_name: sheet.name,
      text: lines.join('\n'),
    });
  });

  if (pages.length === 0) {
    throw new Error('Excel file has no data');
  }
  return { pages, rowCount, truncated };
}

module.exports = { parseExcel, MAX_ROWS_PER_SHEET };