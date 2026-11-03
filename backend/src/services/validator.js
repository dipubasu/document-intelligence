// Invoice validation: খাঁটি function, database বা LLM লাগে না।
// কোনো মান ঠিক করে না, বানায়ও না। শুধু সমস্যা জানায়।

const TOLERANCE = 0.01; // টাকার তুলনায় এই পর্যন্ত পার্থক্য মেনে নেওয়া হয়
const EPS = 1e-9;

const REQUIRED_ERROR = ['invoice_number', 'invoice_date', 'supplier_name', 'total'];
const REQUIRED_WARNING = ['customer_name', 'currency'];

const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round2 = (n) => Math.round(n * 100) / 100;
const differs = (a, b) => Math.abs(a - b) > TOLERANCE + EPS;
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

function isRealIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// invoice: { invoice_number, invoice_date, supplier_name, customer_name,
//            subtotal, tax, total, currency, line_items: [...] }
// context.others: DB তে থাকা অন্য invoice এর তালিকা
//   [{ document_id, supplier_name, invoice_number, total }]
//   (যে invoice যাচাই হচ্ছে সেটা এখানে থাকবে না, caller বাদ দেবে)
function validateInvoice(invoice, context = {}) {
  const inv = invoice || {};
  const issues = [];
  const add = (rule, severity, field, message) => issues.push({ rule, severity, field, message });

  // ১. দরকারি field আছে কিনা
  for (const f of REQUIRED_ERROR) {
    if (isBlank(inv[f])) add('missing_field', 'error', f, `${f} is missing`);
  }
  for (const f of REQUIRED_WARNING) {
    if (isBlank(inv[f])) add('missing_field', 'warning', f, `${f} is missing`);
  }

  // ২. সংখ্যা ঠিক কিনা
  for (const f of ['subtotal', 'tax', 'total']) {
    const v = inv[f];
    if (isBlank(v)) continue;
    if (!isNum(v)) add('invalid_number', 'error', f, `${f} is not a valid number`);
    else if (v < 0) add('negative_amount', 'warning', f, `${f} is negative`);
  }

  // ৩. তারিখ ও currency
  if (!isBlank(inv.invoice_date) && !isRealIsoDate(inv.invoice_date)) {
    add('invalid_date', 'error', 'invoice_date', 'invoice_date is not a real date (expected YYYY-MM-DD)');
  }
  if (!isBlank(inv.currency) && !/^[A-Z]{3}$/.test(String(inv.currency))) {
    add('invalid_currency', 'warning', 'currency', 'currency should be a 3-letter code such as USD');
  }

  // ৪. subtotal + tax = total
  if (isNum(inv.subtotal) && isNum(inv.tax) && isNum(inv.total)) {
    const expected = round2(inv.subtotal + inv.tax);
    if (differs(expected, inv.total)) {
      add('total_mismatch', 'error', 'total', `subtotal + tax = ${expected}, but total is ${inv.total}`);
    }
  }

  // ৫. line item
  const items = Array.isArray(inv.line_items) ? inv.line_items : [];
  if (items.length === 0) {
    add('missing_line_items', 'warning', 'line_items', 'no line items found');
  } else {
    items.forEach((it, i) => {
      const row = it || {};
      for (const f of ['quantity', 'unit_price', 'amount']) {
        if (!isBlank(row[f]) && !isNum(row[f])) {
          add('invalid_number', 'error', `line_items[${i}].${f}`, `line item ${i + 1}: ${f} is not a valid number`);
        }
      }
      if (isNum(row.quantity) && isNum(row.unit_price) && isNum(row.amount)) {
        const expected = round2(row.quantity * row.unit_price);
        if (differs(expected, row.amount)) {
          add(
            'line_item_math',
            'warning',
            `line_items[${i}].amount`,
            `line item ${i + 1}: quantity x unit_price = ${expected}, but amount is ${row.amount}`
          );
        }
      }
    });

    // line item এর যোগফল তুলনা (সব amount সংখ্যা হলেই)
    if (items.every((it) => it && isNum(it.amount))) {
      const sum = round2(items.reduce((s, it) => s + it.amount, 0));
      let reference = null;
      let refName = '';
      if (isNum(inv.subtotal)) {
        reference = inv.subtotal;
        refName = 'subtotal';
      } else if (isNum(inv.total) && isNum(inv.tax)) {
        reference = round2(inv.total - inv.tax);
        refName = 'total - tax';
      }
      if (reference !== null && differs(sum, reference)) {
        add('line_items_mismatch', 'error', 'line_items', `line items add up to ${sum}, but ${refName} is ${reference}`);
      }
    }
  }

  // ৬. duplicate এবং অন্য document এর সাথে মিল
  if (!isBlank(inv.invoice_number) && !isBlank(inv.supplier_name)) {
    const key = `${norm(inv.supplier_name)}|${norm(inv.invoice_number)}`;
    const others = Array.isArray(context.others) ? context.others : [];
    for (const o of others) {
      if (isBlank(o.supplier_name) || isBlank(o.invoice_number)) continue;
      if (`${norm(o.supplier_name)}|${norm(o.invoice_number)}` !== key) continue;

      if (isNum(inv.total) && isNum(o.total)) {
        if (!differs(inv.total, o.total)) {
          add('duplicate_invoice', 'error', 'invoice_number',
            `same supplier and invoice number already exist in document #${o.document_id} with the same total`);
        } else {
          add('cross_document_mismatch', 'error', 'total',
            `same supplier and invoice number exist in document #${o.document_id}, but total differs (${inv.total} vs ${o.total})`);
        }
      } else {
        add('duplicate_invoice', 'error', 'invoice_number',
          `same supplier and invoice number already exist in document #${o.document_id} (total could not be compared)`);
      }
    }
  }

  return { issues, needsReview: issues.some((i) => i.severity === 'error') };
}

module.exports = { validateInvoice, TOLERANCE };