const test = require('node:test');
const assert = require('node:assert/strict');
const { validateInvoice } = require('../src/services/validator');

const good = () => ({
  invoice_number: 'INV-001',
  invoice_date: '2026-10-01',
  supplier_name: 'Acme Ltd',
  customer_name: 'Beta Co',
  subtotal: 100,
  tax: 10,
  total: 110,
  currency: 'USD',
  line_items: [
    { description: 'A', quantity: 2, unit_price: 25, amount: 50 },
    { description: 'B', quantity: 1, unit_price: 50, amount: 50 },
  ],
});

const rules = (r) => r.issues.map((i) => i.rule);

test('validator: a correct invoice has no issues', () => {
  const r = validateInvoice(good());
  assert.deepEqual(r.issues, []);
  assert.equal(r.needsReview, false);
});

test('validator: missing required fields are errors and need review', () => {
  const inv = good();
  inv.invoice_number = null;
  inv.total = null;
  const r = validateInvoice(inv);
  const fields = r.issues
    .filter((i) => i.rule === 'missing_field' && i.severity === 'error')
    .map((i) => i.field)
    .sort();
  assert.deepEqual(fields, ['invoice_number', 'total']);
  assert.equal(r.needsReview, true);
});

test('validator: missing optional field is only a warning', () => {
  const inv = good();
  inv.customer_name = '';
  const r = validateInvoice(inv);
  assert.deepEqual(rules(r), ['missing_field']);
  assert.equal(r.issues[0].severity, 'warning');
  assert.equal(r.needsReview, false);
});

test('validator: text in a number field is an invalid number', () => {
  const inv = good();
  inv.total = 'abc';
  const r = validateInvoice(inv);
  assert.ok(rules(r).includes('invalid_number'));
  assert.ok(!rules(r).includes('total_mismatch'));
  assert.equal(r.needsReview, true);
});

test('validator: subtotal + tax not equal to total is flagged', () => {
  const inv = good();
  inv.total = 120;
  const r = validateInvoice(inv);
  assert.ok(rules(r).includes('total_mismatch'));
  assert.equal(r.needsReview, true);
});

test('validator: a tiny rounding difference is accepted', () => {
  const inv = good();
  inv.tax = 10.004;
  const r = validateInvoice(inv);
  assert.ok(!rules(r).includes('total_mismatch'));
});

test('validator: line items not adding up to subtotal is flagged', () => {
  const inv = good();
  inv.line_items[1].amount = 40;
  const r = validateInvoice(inv);
  assert.ok(rules(r).includes('line_items_mismatch'));
  assert.equal(r.needsReview, true);
});

test('validator: wrong quantity x price on one line is only a warning', () => {
  const inv = good();
  inv.line_items = [
    { description: 'A', quantity: 2, unit_price: 25, amount: 60 },
    { description: 'B', quantity: 1, unit_price: 40, amount: 40 },
  ];
  const r = validateInvoice(inv);
  assert.ok(rules(r).includes('line_item_math'));
  assert.ok(!rules(r).includes('line_items_mismatch'));
  assert.equal(r.needsReview, false);
});

test('validator: impossible or wrongly formatted dates are errors', () => {
  for (const d of ['2026-02-30', '01/10/2026']) {
    const inv = good();
    inv.invoice_date = d;
    assert.ok(rules(validateInvoice(inv)).includes('invalid_date'), d);
  }
});

test('validator: no line items is a warning and skips the sum check', () => {
  const inv = good();
  inv.line_items = [];
  const r = validateInvoice(inv);
  assert.ok(rules(r).includes('missing_line_items'));
  assert.ok(!rules(r).includes('line_items_mismatch'));
  assert.equal(r.needsReview, false);
});

test('validator: same supplier and number with same total is a duplicate', () => {
  const others = [{ document_id: 7, supplier_name: ' ACME ltd ', invoice_number: 'inv-001', total: 110 }];
  const r = validateInvoice(good(), { others });
  assert.ok(rules(r).includes('duplicate_invoice'));
  assert.equal(r.needsReview, true);
});

test('validator: same supplier and number but different total is a cross-document mismatch', () => {
  const others = [{ document_id: 7, supplier_name: 'Acme Ltd', invoice_number: 'INV-001', total: 125 }];
  const r = validateInvoice(good(), { others });
  assert.ok(rules(r).includes('cross_document_mismatch'));
  assert.ok(!rules(r).includes('duplicate_invoice'));
  assert.equal(r.needsReview, true);
});

test('validator: a different invoice number is not a duplicate', () => {
  const others = [{ document_id: 7, supplier_name: 'Acme Ltd', invoice_number: 'INV-002', total: 110 }];
  const r = validateInvoice(good(), { others });
  assert.deepEqual(r.issues, []);
});

test('validator: negative total is a warning (could be a credit note)', () => {
  const inv = good();
  inv.subtotal = -100;
  inv.tax = -10;
  inv.total = -110;
  inv.line_items = [];
  const r = validateInvoice(inv);
  assert.ok(rules(r).includes('negative_amount'));
  assert.equal(r.needsReview, false);
});

test('validator: never changes the invoice it checks', () => {
  const inv = good();
  inv.total = 999;
  const copy = JSON.parse(JSON.stringify(inv));
  validateInvoice(inv);
  assert.deepEqual(inv, copy);
});