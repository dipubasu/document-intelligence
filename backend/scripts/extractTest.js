// One-off check: real Groq call through our extractor, then our validator.
// The sample has three deliberate traps:
//  1. the total is wrong on purpose (50 + 50 + 10 is not 115)
//  2. there is no customer name
//  3. the currency is only shown as "$" (not clear)
const { extractInvoice } = require('../src/services/extractor');
const { validateInvoice } = require('../src/services/validator');

const SAMPLE = `ACME SUPPLIES LTD
Invoice No: INV-2026-0042
Date: 15/01/2026

Description        Qty   Unit Price   Amount
Paper A4 box        10        5.00     50.00
Pens blue           25        2.00     50.00

Subtotal: $100.00
VAT: $10.00
Total Due: $115.00`;

async function main() {
  const result = await extractInvoice(SAMPLE);
  console.log('model:', result.model);
  console.log('time ms:', result.durationMs);
  console.log('usage:', JSON.stringify(result.usage));
  console.log('invoice:', JSON.stringify(result.invoice, null, 2));

  const check = validateInvoice(result.invoice, { others: [] });
  console.log('needsReview:', check.needsReview);
  console.log('issues:', JSON.stringify(check.issues, null, 2));
}

main().catch((err) => {
  console.log('failed:', err.code || '', err.message);
  process.exit(1);
});