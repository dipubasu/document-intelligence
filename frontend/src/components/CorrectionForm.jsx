import { useState } from 'react';
import { api } from '../api.js';

// [field name, label, kind]
const FIELDS = [
  ['invoice_number', 'Invoice number', 'text'],
  ['invoice_date', 'Date (YYYY-MM-DD)', 'text'],
  ['supplier_name', 'Supplier', 'text'],
  ['customer_name', 'Customer', 'text'],
  ['subtotal', 'Subtotal', 'money'],
  ['tax', 'Tax', 'money'],
  ['total', 'Total', 'money'],
  ['currency', 'Currency (3 letters)', 'text'],
];

const MONEY_RE = /^-?\d+(\.\d+)?$/;
const asText = (v) => (v === null || v === undefined ? '' : String(v));

// A form to fix the extracted values of one invoice.
// Only changed fields are sent. A field that is marked "unsure" can also be confirmed
// without a change (tick the box). The server checks everything again and
// writes an audit row for every change.
export default function CorrectionForm({ invoice, onSaved, onCancel }) {
  const uncertain = Array.isArray(invoice.uncertain_fields) ? invoice.uncertain_fields : [];
  const [values, setValues] = useState(() =>
    Object.fromEntries(FIELDS.map(([key]) => [key, asText(invoice[key])]))
  );
  const [checked, setChecked] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(event) {
    event.preventDefault();
    const body = {};

    for (const [key, label, kind] of FIELDS) {
      const text = values[key].trim();
      const changed = text !== asText(invoice[key]).trim();
      if (!changed && checked[key] !== true) continue;

      if (kind === 'money') {
        if (text === '') body[key] = null;
        else if (MONEY_RE.test(text)) body[key] = Number(text);
        else {
          setError(`${label} must be a plain number like 12.50`);
          return;
        }
      } else {
        body[key] = text === '' ? null : text;
      }
    }

    if (Object.keys(body).length === 0) {
      setError('Nothing to save. Change a value or tick "I checked this value".');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const result = await api(`/api/invoices/${invoice.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      onSaved(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="correction">
      <h3>Correct values</h3>
      <p className="muted small">
        Empty means "no value". Every change is saved in the correction history and the invoice is
        checked again.
      </p>
      <div className="form-grid">
        {FIELDS.map(([key, label]) => (
          <label key={key} className="field">
            <span>{label}</span>
            <input
              type="text"
              value={values[key]}
              onChange={(e) => setValues({ ...values, [key]: e.target.value })}
            />
            {uncertain.includes(key) && asText(invoice[key]) !== '' && (
              <span className="small">
                <input
                  type="checkbox"
                  checked={checked[key] === true}
                  onChange={(e) => setChecked({ ...checked, [key]: e.target.checked })}
                />{' '}
                unsure value: I checked this value
              </span>
            )}
          </label>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="submit" disabled={busy}>
          {busy ? 'Saving...' : 'Save'}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}