// Tests for the "uncertain fields" rule of the extractor. The model is replaced by a mock.
const { test } = require('node:test');
const assert = require('node:assert');
const { extractInvoice } = require('../src/services/extractor');

function mockLlm(answer) {
  return {
    chatJson: async () => ({
      content: JSON.stringify(answer),
      model: 'mock-model',
      usage: null,
      durationMs: 1,
    }),
  };
}

const EMPTY = {
  invoice_number: null,
  invoice_date: null,
  supplier_name: null,
  customer_name: null,
  subtotal: null,
  tax: null,
  total: null,
  currency: null,
  line_items: [],
  confidence: {},
  uncertain_fields: [],
};

test('extractor: empty fields are not listed as uncertain (no duplicate warnings)', async () => {
  const llm = mockLlm({
    ...EMPTY,
    uncertain_fields: ['invoice_number', 'total', 'line_items', 'invoice_date'],
  });
  const out = await extractInvoice('Just a normal note, not an invoice.', { llm });
  assert.deepStrictEqual(out.invoice.uncertain_fields, []);
});

test('extractor: a filled field that the model doubts stays uncertain', async () => {
  const llm = mockLlm({
    ...EMPTY,
    supplier_name: 'Acme',
    total: 50,
    uncertain_fields: ['supplier_name'],
  });
  const out = await extractInvoice('Invoice from Acme. Total 50', { llm });
  assert.deepStrictEqual(out.invoice.uncertain_fields, ['supplier_name']);
});

test('extractor: a value that is not in the document text is still marked uncertain', async () => {
  const llm = mockLlm({ ...EMPTY, invoice_number: 'INV-9', total: 50 });
  const out = await extractInvoice('Invoice INV-7 from Acme. Total 50', { llm });
  assert.ok(out.invoice.uncertain_fields.includes('invoice_number'));
  assert.ok(!out.invoice.uncertain_fields.includes('total'));
});