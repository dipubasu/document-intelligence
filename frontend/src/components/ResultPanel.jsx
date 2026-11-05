import { useEffect, useState } from 'react';
import { api } from '../api.js';
import CorrectionForm from './CorrectionForm.jsx';

const DASH = '\u2014';
const SEP = ' \u00b7 ';

const FIELDS = [
  ['invoice_number', 'Invoice number'],
  ['invoice_date', 'Date'],
  ['supplier_name', 'Supplier'],
  ['customer_name', 'Customer'],
  ['subtotal', 'Subtotal'],
  ['tax', 'Tax'],
  ['total', 'Total'],
  ['currency', 'Currency'],
];

const isEmpty = (v) => v === null || v === undefined || v === '';
const show = (v) => (isEmpty(v) ? DASH : String(v));

// true when the extraction found at least one value or one line item
function hasData(invoice) {
  if (!invoice) return false;
  const anyField = FIELDS.some(([key]) => !isEmpty(invoice[key]));
  const anyItem = Array.isArray(invoice.line_items) && invoice.line_items.length > 0;
  return anyField || anyItem;
}

function IssueList({ title, items }) {
  if (items.length === 0) return null;
  return (
    <>
      <h3>
        {title} ({items.length})
      </h3>
      <ul className="issues">
        {items.map((issue, index) => (
          <li key={issue.id ?? index}>
            <strong>{issue.rule}</strong> ({show(issue.field)}): {issue.message}
          </li>
        ))}
      </ul>
    </>
  );
}

// Shows the full result of one document: status, extracted values, line items,
// errors and warnings, the correction form and the correction history.
// All values are shown as React text, so React escapes them (no XSS).
export default function ResultPanel({ documentId, version, onClose, onCorrected = () => {} }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');

  // Load again when the document changes or its status/issue counts change (version).
  useEffect(() => {
    let cancelled = false;
    api(`/api/documents/${documentId}/result`)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError('');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, version]);

  // The server answers a correction with the new full result.
  function handleSaved(result) {
    setData(result);
    setEditing(false);
    const changed = Array.isArray(result.changed) ? result.changed : [];
    setSavedMessage(
      changed.length > 0
        ? `Saved. Changed: ${changed.join(', ')}`
        : 'Saved. No value changed (the ticked fields were confirmed).'
    );
    onCorrected();
  }

  const doc = data ? data.document : null;
  const invoice = data ? data.invoice : null;
  const issues = data && Array.isArray(data.issues) ? data.issues : [];
  const corrections = data && Array.isArray(data.corrections) ? data.corrections : [];
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity !== 'error');
  const uncertain = invoice && Array.isArray(invoice.uncertain_fields) ? invoice.uncertain_fields : [];
  const lineItems = invoice && Array.isArray(invoice.line_items) ? invoice.line_items : [];
  const canCorrect = Boolean(doc && doc.status === 'completed' && invoice && invoice.id);

  return (
    <section className="card">
      <div className="panel-head">
        <h2>Document #{documentId}</h2>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>

      {loading && !data && <p className="muted">Loading...</p>}
      {error && <p className="error">{error}</p>}

      {doc && (
        <p className="muted">
          {doc.original_name}
          {SEP}
          {doc.detected_type}
          {SEP}
          {show(doc.page_count)} page(s){SEP}
          {doc.size_bytes} bytes{SEP}status: {doc.status}
        </p>
      )}
      {doc && doc.status === 'failed' && doc.error_message && (
        <p className="error">{doc.error_message}</p>
      )}
      {doc && (doc.status === 'queued' || doc.status === 'processing') && (
        <p className="notice">This document is still being processed.</p>
      )}
      {doc && doc.status === 'completed' && !hasData(invoice) && (
        <p className="notice">
          No invoice data was extracted. The document may not be an invoice. Nothing was guessed.
        </p>
      )}

      {savedMessage && <p className="ok">{savedMessage}</p>}

      {canCorrect && !editing && (
        <button
          type="button"
          onClick={() => {
            setSavedMessage('');
            setEditing(true);
          }}
        >
          Correct values
        </button>
      )}
      {canCorrect && editing && (
        <CorrectionForm
          invoice={invoice}
          onSaved={handleSaved}
          onCancel={() => setEditing(false)}
        />
      )}

      {hasData(invoice) && (
        <>
          <h3>
            Extracted values{' '}
            {invoice.is_corrected === 1 && <span className="badge badge-review">corrected by a person</span>}
          </h3>
          <table>
            <tbody>
              {FIELDS.map(([key, label]) => (
                <tr key={key}>
                  <th>{label}</th>
                  <td>
                    {show(invoice[key])}{' '}
                    {!isEmpty(invoice[key]) && uncertain.includes(key) && (
                      <span className="badge badge-review">unsure</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Line items ({lineItems.length})</h3>
          {lineItems.length === 0 ? (
            <p className="muted">No line items.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Qty</th>
                  <th>Unit price</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((item, index) => (
                  <tr key={index}>
                    <td>{show(item.description)}</td>
                    <td>{show(item.quantity)}</td>
                    <td>{show(item.unit_price)}</td>
                    <td>{show(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <IssueList title="Errors" items={errors} />
      <IssueList title="Warnings" items={warnings} />

      {corrections.length > 0 && (
        <>
          <h3>Correction history ({corrections.length})</h3>
          <ul className="issues">
            {corrections.map((c, index) => (
              <li key={c.id ?? index}>
                <strong>{show(c.field)}</strong>: {show(c.old_value)} {'\u2192'} {show(c.new_value)}
                {c.created_at ? `${SEP}${c.created_at}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}